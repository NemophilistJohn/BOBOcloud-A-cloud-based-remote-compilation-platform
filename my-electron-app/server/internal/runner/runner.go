package runner

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/session"
)

// ============================================================
// runner.go - 流式进程执行（宿主机模式的基础执行器）
//
// 注意：语言的"编译/运行命令如何生成"已由语言插件负责（plugin_*.go），
// 本文件只保留最底层的进程执行与输出流转发。
// ============================================================

// StreamProcess 启动一个外部进程，实时将 stdout/stderr 逐行推送到 OutputWriter。
// stdin 非空时连接到进程的标准输入（用于交互式 input/scanf 等）。
// 使用 Read(buf) 而非 bufio.Scanner，以便无换行符的部分行（如 input() 的提示文字）
// 也能立即发送给客户端。
func StreamProcess(ctx context.Context, command []string, workDir string, output session.OutputWriter, stage string, extraEnv map[string]string, stdin io.Reader) *model.RunResult {
	cmdDisplay := strings.Join(command, " ")
	output.WriteStatus(stage, cmdDisplay)

	// 本地运行模式：对裸命令名（如 gcc/python3/go，不含路径分隔符）先做 LookPath 检查，
	// 缺失时给出可操作的提示，而非裸露的 "executable file not found in $PATH"。
	// 相对/绝对路径（如编译产物 .bobocloud/output）跳过此检查。
	if !strings.ContainsRune(command[0], filepath.Separator) && !strings.ContainsRune(command[0], '/') {
		if _, err := exec.LookPath(command[0]); err != nil {
			output.WriteError(fmt.Sprintf(
				"Local toolchain '%s' is not installed on the server (not in $PATH). "+
					"Please select a Docker runtime for this language, or install '%s' on the server.",
				command[0], command[0]))
			return &model.RunResult{Success: false, ReturnCode: 1}
		}
	}

	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir = workDir

	if len(extraEnv) > 0 {
		cmd.Env = os.Environ()
		for k, v := range extraEnv {
			cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
		}
	}

	// 连接 stdin（交互式输入：Python input() / C scanf 等）
	// stdin 为 *os.File 时 exec 包直接连接，无 copy goroutine，cmd.Wait() 不会死锁
	if stdin != nil {
		cmd.Stdin = stdin
	}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		output.WriteError(fmt.Sprintf("Failed to create stdout pipe: %v", err))
		return &model.RunResult{Success: false, ReturnCode: 1}
	}

	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		output.WriteError(fmt.Sprintf("Failed to create stderr pipe: %v", err))
		return &model.RunResult{Success: false, ReturnCode: 1}
	}

	if err := cmd.Start(); err != nil {
		output.WriteError(fmt.Sprintf("Failed to start process: %v", err))
		return &model.RunResult{Success: false, ReturnCode: 1}
	}

	var stdoutLines, stderrLines []string
	var wg sync.WaitGroup
	var mu sync.Mutex

	// stdout：用 Read(buf) 读取，按换行分割后逐行发送。
	// 不用 bufio.Scanner 是因为它只在遇到换行符时才产生一行，
	// 而 input("prompt") 的提示文字没有换行符，会卡在 Scanner 缓冲区里。
	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, err := stdoutPipe.Read(buf)
			if n > 0 {
				for _, line := range strings.Split(strings.TrimSuffix(string(buf[:n]), "\n"), "\n") {
					if ctx.Err() != nil {
						return
					}
					if line != "" {
						mu.Lock()
						stdoutLines = append(stdoutLines, line)
						mu.Unlock()
						output.WriteStdout(line, stage)
					}
				}
			}
			if err != nil || ctx.Err() != nil {
				break
			}
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, err := stderrPipe.Read(buf)
			if n > 0 {
				for _, line := range strings.Split(strings.TrimSuffix(string(buf[:n]), "\n"), "\n") {
					if ctx.Err() != nil {
						return
					}
					if line != "" {
						mu.Lock()
						stderrLines = append(stderrLines, line)
						mu.Unlock()
						output.WriteStderr(line, stage)
					}
				}
			}
			if err != nil || ctx.Err() != nil {
				break
			}
		}
	}()

	wg.Wait()

	err = cmd.Wait()
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
		Success:    returnCode == 0 && !timedOut,
		ReturnCode: returnCode,
		Stdout:     strings.Join(stdoutLines, "\n"),
		Stderr:     strings.Join(stderrLines, "\n"),
		TimedOut:   timedOut,
	}
}
