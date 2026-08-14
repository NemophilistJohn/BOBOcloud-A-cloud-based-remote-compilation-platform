package runner

import (
	"context"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/session"
)

// RunTaskExecution executes a validated task DAG in one managed Docker
// container. Independent dependency branches share a topological wave and run
// concurrently, matching VS Code's default dependsOn behavior. Sequence edges
// have already been made explicit by the client resolver.
func (r *DockerRunner) RunTaskExecution(ctx context.Context, task *model.TaskExecution, hostWorkDir string, output session.OutputWriter, stdinReader io.Reader) *model.RunResult {
	if task == nil || len(task.Steps) == 0 {
		return &model.RunResult{Success: false, ReturnCode: 1, Stderr: "task contains no steps"}
	}
	r.setupPassed = false
	acquireStarted := time.Now()
	output.WriteStatus("docker", "Acquiring execution container for project task")
	containerID, err := r.pool.AcquireForUser(ctx, r.userID, r.runtime.DockerImage, output)
	if err != nil {
		output.WriteError(fmt.Sprintf("Failed to acquire container: %v", err))
		return &model.RunResult{Success: false, ReturnCode: 1}
	}
	output.WriteStatus("docker", fmt.Sprintf("Container acquired in %d ms", time.Since(acquireStarted).Milliseconds()))
	defer func() {
		cleanupStarted := time.Now()
		pruneCtx, cancelPrune := context.WithTimeout(context.Background(), 15*time.Second)
		_, pruneStderr, pruneCode, pruneErr := r.pool.Exec(pruneCtx, containerID, []string{
			"sh", "-c", `find . -type d \( -name .git -o -name .bobocloud -o -name node_modules -o -name target -o -name __pycache__ \) -prune -exec rm -rf -- {} \;`,
		}, containerWorkDir)
		cancelPrune()
		if pruneErr != nil || pruneCode != 0 {
			output.WriteStderr(fmt.Sprintf("Warning: failed to prune task cache directories before artifact collection: %s %v", pruneStderr, pruneErr), "setup")
		}
		copyCtx, cancelCopy := context.WithTimeout(context.Background(), 45*time.Second)
		if copyErr := r.copyFromContainer(copyCtx, containerID, hostWorkDir, containerWorkDir); copyErr != nil {
			output.WriteStderr(fmt.Sprintf("Warning: failed to copy task artifacts: %v", copyErr), "setup")
		}
		cancelCopy()
		r.pool.ReleaseForUser(containerID, r.userID)
		output.WriteStatus("docker", fmt.Sprintf("Task artifacts collected and container recycled in %d ms", time.Since(cleanupStarted).Milliseconds()))
	}()

	copyStarted := time.Now()
	if err := r.copyToContainer(ctx, containerID, hostWorkDir, containerWorkDir); err != nil {
		output.WriteError(fmt.Sprintf("Failed to copy task workspace: %v", err))
		return &model.RunResult{Success: false, ReturnCode: 1}
	}
	output.WriteStatus("docker", fmt.Sprintf("Task workspace copied in %d ms", time.Since(copyStarted).Milliseconds()))
	if result := r.runSetupCommands(ctx, containerID, output); result != nil {
		return result
	}
	r.setupPassed = true

	executor := NewDockerStepExecutor(r.pool, containerID, containerWorkDir)
	return executeTaskGraph(ctx, task, executor, r, output, stdinReader)
}

func (r *DockerRunner) runSetupCommands(ctx context.Context, containerID string, output session.OutputWriter) *model.RunResult {
	for _, command := range r.setupCmds {
		if r.sec != nil && !r.sec.AllowCommand(command) {
			output.WriteStderr(fmt.Sprintf("Command blocked by execution policy: %s", command), "setup")
			return &model.RunResult{Success: false, ReturnCode: 1}
		}
		if r.sec != nil {
			command = r.sec.FilterCommand(command)
		}
		command = autoPersistPip(command)
		output.WriteStatus("setup", fmt.Sprintf("$ %s", command))
		setupCtx, cancel := context.WithTimeout(ctx, 300*time.Second)
		stdout, stderr, exitCode, execErr := r.pool.Exec(setupCtx, containerID, []string{"sh", "-c", command}, containerWorkDir)
		cancel()
		if stdout != "" {
			output.WriteStdout(stdout, "setup")
		}
		if stderr != "" {
			output.WriteStderr(stderr, "setup")
		}
		if execErr != nil || exitCode != 0 {
			if exitCode == 0 {
				exitCode = 1
			}
			output.WriteError(fmt.Sprintf("Setup command failed with code %d: %v", exitCode, execErr))
			return &model.RunResult{Success: false, ReturnCode: exitCode, Stdout: stdout, Stderr: stderr}
		}
	}
	return nil
}

type taskGraphResult struct {
	id     string
	result *model.RunResult
}

func executeTaskGraph(ctx context.Context, task *model.TaskExecution, executor StepExecutor, dockerRunner *DockerRunner, output session.OutputWriter, stdinReader io.Reader) *model.RunResult {
	nodes := make(map[string]model.TaskStep, len(task.Steps))
	indegree := make(map[string]int, len(task.Steps))
	dependents := make(map[string][]string, len(task.Steps))
	terminal := make(map[string]bool, len(task.Steps))
	for _, node := range task.Steps {
		nodes[node.ID] = node
		indegree[node.ID] = len(node.DependsOn)
		terminal[node.ID] = true
	}
	for _, node := range task.Steps {
		for _, dependency := range node.DependsOn {
			dependents[dependency] = append(dependents[dependency], node.ID)
			terminal[dependency] = false
		}
	}
	terminalCount := 0
	for _, isTerminal := range terminal {
		if isTerminal {
			terminalCount++
		}
	}

	completed := 0
	var stdout, stderr strings.Builder
	for completed < len(task.Steps) {
		ready := make([]string, 0)
		for id, degree := range indegree {
			if degree == 0 {
				ready = append(ready, id)
				indegree[id] = -1
			}
		}
		sort.Strings(ready)
		if len(ready) == 0 {
			return &model.RunResult{Success: false, ReturnCode: 1, Stderr: "task dependency graph stalled"}
		}
		if len(ready) > 1 {
			output.WriteStatus("task", fmt.Sprintf("Running %d independent task dependencies in parallel", len(ready)))
		}

		results := make(chan taskGraphResult, len(ready))
		var wait sync.WaitGroup
		for _, id := range ready {
			node := nodes[id]
			wait.Add(1)
			go func() {
				defer wait.Done()
				stage := "task:" + strings.ToLower(node.Kind)
				if stage == "task:" {
					stage = "task:custom"
				}
				stage += ":" + node.ID
				commandForPolicy := strings.Join(node.Argv, " ")
				if node.Type == "shell" && len(node.Argv) > 0 {
					commandForPolicy = node.Argv[len(node.Argv)-1]
				}
				if dockerRunner.sec != nil && !dockerRunner.sec.AllowCommand(commandForPolicy) {
					results <- taskGraphResult{id: node.ID, result: &model.RunResult{Success: false, ReturnCode: 1, Stderr: "task command blocked by execution policy"}}
					return
				}
				step := Step{Stage: stage, Cmd: append([]string(nil), node.Argv...), WorkDir: node.Cwd, Env: node.Env, TimeoutSec: 300}
				if terminalCount == 1 && terminal[node.ID] {
					step.Stdin = stdinReader
				}
				output.WriteStatus(stage, fmt.Sprintf("[%s] %s", node.Label, strings.Join(node.Argv, " ")))
				results <- taskGraphResult{id: node.ID, result: executor.ExecStep(ctx, step, output)}
			}()
		}
		wait.Wait()
		close(results)

		var failed *model.RunResult
		for item := range results {
			result := item.result
			if result == nil {
				result = &model.RunResult{Success: false, ReturnCode: 1, Stderr: "task step returned no result"}
			}
			if result.Stdout != "" {
				if stdout.Len() > 0 {
					stdout.WriteByte('\n')
				}
				stdout.WriteString(result.Stdout)
			}
			if result.Stderr != "" {
				if stderr.Len() > 0 {
					stderr.WriteByte('\n')
				}
				stderr.WriteString(result.Stderr)
			}
			if !result.Success && failed == nil {
				failed = result
			}
			for _, dependent := range dependents[item.id] {
				indegree[dependent]--
			}
			completed++
		}
		if failed != nil {
			failed.Stdout = stdout.String()
			failed.Stderr = stderr.String()
			return failed
		}
	}
	return &model.RunResult{Success: true, ReturnCode: 0, Stdout: stdout.String(), Stderr: stderr.String()}
}
