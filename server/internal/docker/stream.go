package docker

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/ringbuffer"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/streamoutput"
)

// ExecStreaming 在容器内流式执行命令。
func (dp *Pool) ExecStreaming(ctx context.Context, containerID string, cmd []string, workDir string, output session.OutputWriter, stage string) *model.RunResult {
	result := dockerStreamProcess(ctx, containerID, cmd, workDir, output, stage, nil, nil, dp.outputRetainedBytes)
	if ctx.Err() != nil {
		dp.markContainerTainted(containerID)
	}
	return result
}

// ExecStreamingEnv 在容器内流式执行命令，并注入额外的环境变量（docker exec -e K=V）。
func (dp *Pool) ExecStreamingEnv(ctx context.Context, containerID string, cmd []string, workDir string, output session.OutputWriter, stage string, env map[string]string, stdin io.Reader) *model.RunResult {
	result := dockerStreamProcess(ctx, containerID, cmd, workDir, output, stage, env, stdin, dp.outputRetainedBytes)
	if ctx.Err() != nil {
		dp.markContainerTainted(containerID)
	}
	return result
}

func (dp *Pool) markContainerTainted(containerID string) {
	if dp == nil || strings.TrimSpace(containerID) == "" {
		return
	}
	dp.mu.Lock()
	if dp.taintedContainers == nil {
		dp.taintedContainers = make(map[string]bool)
	}
	dp.taintedContainers[containerID] = true
	dp.mu.Unlock()
}

func dockerStreamProcess(ctx context.Context, containerID string, command []string, workDir string, output session.OutputWriter, stage string, env map[string]string, stdin io.Reader, retainedBytes int) *model.RunResult {
	cmdDisplay := strings.Join(command, " ")
	output.WriteStatus(stage, fmt.Sprintf("[docker] %s", cmdDisplay))

	args := []string{"exec"}
	if stdin != nil {
		args = append(args, "-i")
	}
	for key, value := range env {
		args = append(args, "-e", key+"="+value)
	}
	if workDir != "" {
		args = append(args, "-w", workDir)
	}
	args = append(args, containerID)
	args = append(args, command...)

	cmd := exec.CommandContext(ctx, "docker", args...)
	if stdin != nil {
		cmd.Stdin = stdin
	}
	stdoutPipe, stdoutErr := cmd.StdoutPipe()
	if stdoutErr != nil {
		output.WriteError(fmt.Sprintf("Docker stdout pipe failed: %v", stdoutErr))
		return &model.RunResult{Success: false, ReturnCode: 1}
	}
	stderrPipe, stderrErr := cmd.StderrPipe()
	if stderrErr != nil {
		output.WriteError(fmt.Sprintf("Docker stderr pipe failed: %v", stderrErr))
		return &model.RunResult{Success: false, ReturnCode: 1}
	}
	if err := cmd.Start(); err != nil {
		output.WriteError(fmt.Sprintf("Docker exec start failed: %v", err))
		return &model.RunResult{Success: false, ReturnCode: 1}
	}

	limit := retainedBytes
	if limit <= 0 {
		limit = 256 << 10
	}
	stdoutRetained := ringbuffer.New(limit)
	stderrRetained := ringbuffer.New(limit)
	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
		_ = streamoutput.Forward(ctx, stdoutPipe, stdoutRetained, output, stage, false)
	}()
	go func() {
		defer readers.Done()
		_ = streamoutput.Forward(ctx, stderrPipe, stderrRetained, output, stage, true)
	}()
	readers.Wait()
	err := cmd.Wait()

	timedOut := ctx.Err() == context.DeadlineExceeded
	if timedOut {
		output.WriteStderr(fmt.Sprintf("[%s] Process timed out", stage), stage)
	}
	returnCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			returnCode = exitErr.ExitCode()
		} else if !timedOut {
			returnCode = 1
		}
	}
	return &model.RunResult{
		Success:         returnCode == 0 && !timedOut,
		ReturnCode:      returnCode,
		Stdout:          stdoutRetained.String(),
		Stderr:          stderrRetained.String(),
		TimedOut:        timedOut,
		StdoutTruncated: stdoutRetained.Truncated(),
		StderrTruncated: stderrRetained.Truncated(),
	}
}
