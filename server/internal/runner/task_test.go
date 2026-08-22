package runner

import (
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/session"
)

type taskTestOutput struct{}

func (taskTestOutput) WriteStatus(string, string)           {}
func (taskTestOutput) WriteStdout(string, string)           {}
func (taskTestOutput) WriteStderr(string, string)           {}
func (taskTestOutput) WriteArtifactBegin()                  {}
func (taskTestOutput) WriteArtifact(string, []byte, string) {}
func (taskTestOutput) WriteArtifactEnd()                    {}
func (taskTestOutput) WriteResult(bool, int)                {}
func (taskTestOutput) WriteError(string)                    {}

type recordingStepExecutor struct {
	mu         sync.Mutex
	calls      []string
	stdinCalls []string
	results    map[string]*model.RunResult
	started    chan string
	release    <-chan struct{}
}

func (e *recordingStepExecutor) ExecStep(ctx context.Context, step Step, _ session.OutputWriter) *model.RunResult {
	e.mu.Lock()
	e.calls = append(e.calls, step.Cmd[0])
	if step.Stdin != nil {
		e.stdinCalls = append(e.stdinCalls, step.Cmd[0])
	}
	e.mu.Unlock()
	if e.started != nil {
		e.started <- step.Cmd[0]
	}
	if e.release != nil {
		select {
		case <-e.release:
		case <-ctx.Done():
			return &model.RunResult{Success: false, ReturnCode: 1}
		}
	}
	if result := e.results[step.Cmd[0]]; result != nil {
		return result
	}
	return &model.RunResult{Success: true}
}

func testTask(steps ...model.TaskStep) *model.TaskExecution {
	return &model.TaskExecution{SchemaVersion: 1, Label: "test", Kind: "custom", Steps: steps}
}

func TestExecuteTaskGraphRunsIndependentStepsInParallel(t *testing.T) {
	started := make(chan string, 2)
	release := make(chan struct{})
	executor := &recordingStepExecutor{started: started, release: release, results: map[string]*model.RunResult{}}
	done := make(chan *model.RunResult, 1)
	go func() {
		done <- executeTaskGraph(context.Background(), testTask(
			model.TaskStep{ID: "a", Label: "A", Kind: "build", Type: "process", Argv: []string{"a"}},
			model.TaskStep{ID: "b", Label: "B", Kind: "test", Type: "process", Argv: []string{"b"}},
		), executor, &DockerRunner{}, taskTestOutput{}, nil)
	}()

	seen := map[string]bool{}
	for len(seen) < 2 {
		select {
		case label := <-started:
			seen[label] = true
		case <-time.After(time.Second):
			t.Fatal("independent task steps did not start concurrently")
		}
	}
	close(release)
	if result := <-done; !result.Success {
		t.Fatalf("parallel graph failed: %#v", result)
	}
}

func TestExecuteTaskGraphHonorsSequenceAndShortCircuitsFailure(t *testing.T) {
	executor := &recordingStepExecutor{results: map[string]*model.RunResult{
		"a": {Success: false, ReturnCode: 7, Stderr: "failed"},
	}}
	result := executeTaskGraph(context.Background(), testTask(
		model.TaskStep{ID: "b", Label: "B", Kind: "run", Type: "process", Argv: []string{"b"}, DependsOn: []string{"a"}},
		model.TaskStep{ID: "a", Label: "A", Kind: "build", Type: "process", Argv: []string{"a"}},
	), executor, &DockerRunner{}, taskTestOutput{}, nil)
	if result.Success || result.ReturnCode != 7 {
		t.Fatalf("unexpected failure result: %#v", result)
	}
	if len(executor.calls) != 1 || executor.calls[0] != "a" {
		t.Fatalf("dependent task ran after failure: %v", executor.calls)
	}
}

func TestExecuteTaskGraphFindsTheTerminalOfAnOutOfOrderDAG(t *testing.T) {
	executor := &recordingStepExecutor{results: map[string]*model.RunResult{}}
	result := executeTaskGraph(context.Background(), testTask(
		model.TaskStep{ID: "run", Label: "Run", Kind: "run", Type: "process", Argv: []string{"run"}, DependsOn: []string{"build"}},
		model.TaskStep{ID: "build", Label: "Build", Kind: "build", Type: "process", Argv: []string{"build"}},
	), executor, &DockerRunner{}, taskTestOutput{}, strings.NewReader("input\n"))
	if !result.Success {
		t.Fatalf("out-of-order DAG failed: %#v", result)
	}
	if len(executor.stdinCalls) != 1 || executor.stdinCalls[0] != "run" {
		t.Fatalf("stdin was not assigned only to the real terminal: %v", executor.stdinCalls)
	}
}

type taskPoolFake struct {
	mu             sync.Mutex
	events         []string
	pruneCtxActive bool
}

func (p *taskPoolFake) add(event string) {
	p.mu.Lock()
	p.events = append(p.events, event)
	p.mu.Unlock()
}

func (p *taskPoolFake) Acquire(context.Context, string, session.OutputWriter) (string, error) {
	return p.AcquireForUser(context.Background(), "", "", nil)
}
func (p *taskPoolFake) AcquireForUser(context.Context, string, string, session.OutputWriter) (string, error) {
	p.add("acquire")
	return "container-1", nil
}
func (p *taskPoolFake) AcquireForUserWithContext(context.Context, string, string, string, map[string]string, map[string]string, session.OutputWriter) (string, error) {
	return p.AcquireForUser(context.Background(), "", "", nil)
}
func (p *taskPoolFake) Release(string)                { p.add("release") }
func (p *taskPoolFake) ReleaseForUser(string, string) { p.add("release") }
func (p *taskPoolFake) DiscardForUser(string, string) { p.add("discard") }
func (p *taskPoolFake) Exec(ctx context.Context, _ string, cmd []string, _ string) (string, string, int, error) {
	if len(cmd) >= 3 && cmd[0] == "sh" && cmd[1] == "-c" && strings.Contains(cmd[2], "find . -type d") {
		p.pruneCtxActive = ctx.Err() == nil
		p.add("prune")
	} else {
		p.add("mkdir")
	}
	return "", "", 0, nil
}
func (p *taskPoolFake) ExecStreamingEnv(ctx context.Context, _ string, _ []string, _ string, _ session.OutputWriter, _ string, _ map[string]string, _ io.Reader) *model.RunResult {
	p.add("step")
	return &model.RunResult{Success: ctx.Err() == nil, ReturnCode: 1}
}

type taskCopierFake struct{ pool *taskPoolFake }

func (c taskCopierFake) CopyTo(context.Context, string, string, string) error {
	c.pool.add("copy-to")
	return nil
}
func (c taskCopierFake) CopyFrom(context.Context, string, string, string) error {
	c.pool.add("copy-from")
	return nil
}

func TestRunTaskCleanupUsesFreshContextPrunesBeforeCopyAndAlwaysReleases(t *testing.T) {
	pool := &taskPoolFake{}
	runner := NewDockerRunner(model.RuntimeDef{DockerImage: "test-image"}, pool, nil)
	runner.workspaceCopier = taskCopierFake{pool: pool}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	runner.RunTaskExecution(ctx, testTask(
		model.TaskStep{ID: "run", Label: "Run", Kind: "run", Type: "process", Argv: []string{"run"}},
	), t.TempDir(), taskTestOutput{}, nil)

	wantOrder := []string{"acquire", "mkdir", "copy-to", "step", "prune", "copy-from", "release"}
	if strings.Join(pool.events, ",") != strings.Join(wantOrder, ",") {
		t.Fatalf("unexpected task lifecycle order: got %v want %v", pool.events, wantOrder)
	}
	if !pool.pruneCtxActive {
		t.Fatal("task cleanup reused the cancelled run context")
	}
}
