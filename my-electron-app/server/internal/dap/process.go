package dap

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type LaunchSpec struct {
	SessionID     string
	UserID        string
	Workspace     string
	PersistDir    string
	Adapter       AdapterSpec
	MemoryLimit   string
	CPULimit      string
	NetworkEnable bool
}

type Process interface {
	Stdin() io.WriteCloser
	Stdout() io.ReadCloser
	Wait() error
	Kill() error
}

type ProcessStarter interface {
	Start(context.Context, LaunchSpec) (Process, error)
}

type ExecStarter struct{}

type execProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
}

func (p *execProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *execProcess) Stdout() io.ReadCloser { return p.stdout }
func (p *execProcess) Wait() error           { return p.cmd.Wait() }
func (p *execProcess) Kill() error {
	if p == nil || p.cmd.Process == nil {
		return nil
	}
	return p.cmd.Process.Kill()
}

type dockerProcess struct {
	Process
	name string
	once sync.Once
}

func (p *dockerProcess) Kill() error {
	var result error
	p.once.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, "docker", "rm", "-f", p.name).Run()
		result = p.Process.Kill()
	})
	return result
}

func safeContainerLabel(value string) string {
	var builder strings.Builder
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.' {
			builder.WriteRune(char)
		}
		if builder.Len() >= 50 {
			break
		}
	}
	return builder.String()
}

func dapEnvironment(spec LaunchSpec) map[string]string {
	env := map[string]string{
		"HOME":              "/tmp/bobocloud-home",
		"TMPDIR":            "/tmp",
		"PIP_CACHE_DIR":     "/persist/pip-cache",
		"GOPATH":            "/persist/go",
		"GOMODCACHE":        "/persist/go/pkg/mod",
		"GOCACHE":           "/persist/go-cache",
		"NPM_CONFIG_PREFIX": "/persist/npm-global",
		"NPM_CONFIG_CACHE":  "/persist/npm-cache",
		"NODE_PATH":         "/persist/npm-global/lib/node_modules",
	}
	if spec.Adapter.LanguageID == "python" {
		version := strings.TrimPrefix(spec.Adapter.RuntimeID, "python:")
		if version != spec.Adapter.RuntimeID && version != "" {
			env["PYTHONPATH"] = "/persist/pip-packages/runtimes/python-" + version
		}
	}
	return env
}

func (ExecStarter) Start(ctx context.Context, spec LaunchSpec) (Process, error) {
	workspace, err := filepath.Abs(strings.TrimSpace(spec.Workspace))
	if err != nil || workspace == "" {
		return nil, fmt.Errorf("resolve DAP workspace")
	}
	info, err := os.Lstat(workspace)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("DAP workspace must be a real directory")
	}
	name := "bobocloud-dap-" + safeContainerLabel(spec.SessionID)
	args := []string{
		"run", "--rm", "-i", "--name", name,
		"--label", "bobocloud.dap=true",
		"--label", "bobocloud.dap.session=" + safeContainerLabel(spec.SessionID),
		"--label", "bobocloud.dap.user=" + safeContainerLabel(spec.UserID),
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--pids-limit", "256", "--init",
		"--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
		"-v", workspace + ":" + ContainerRoot + ":rw", "-w", ContainerRoot,
	}
	if !spec.NetworkEnable {
		args = append(args, "--network", "none")
	}
	if spec.Adapter.RequiresPtrace {
		// Delve needs ptrace and Docker's default seccomp profile intentionally
		// blocks it. This is limited to the isolated, single-session Go image.
		args = append(args, "--cap-add", "SYS_PTRACE", "--security-opt", "seccomp=unconfined")
	}
	if spec.MemoryLimit != "" {
		args = append(args, "--memory", spec.MemoryLimit, "--memory-swap", spec.MemoryLimit)
	}
	if spec.CPULimit != "" {
		args = append(args, "--cpus", spec.CPULimit)
	}
	if spec.PersistDir != "" {
		persist, absErr := filepath.Abs(spec.PersistDir)
		if absErr != nil {
			return nil, fmt.Errorf("resolve DAP persist directory: %w", absErr)
		}
		if err := os.MkdirAll(persist, 0755); err != nil {
			return nil, fmt.Errorf("prepare DAP persist directory: %w", err)
		}
		args = append(args, "-v", persist+":/persist:rw")
	}
	for key, value := range dapEnvironment(spec) {
		args = append(args, "-e", key+"="+value)
	}
	args = append(args, spec.Adapter.Image)
	args = append(args, spec.Adapter.Command...)
	return startDockerCommand(ctx, exec.CommandContext(ctx, "docker", args...), name, spec.SessionID)
}

func startDockerCommand(ctx context.Context, cmd *exec.Cmd, name, sessionID string) (Process, error) {
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, err
	}
	go func() {
		// Adapter diagnostics must never share stdout because stdout carries
		// Content-Length framed DAP messages.
		limited := &io.LimitedReader{R: stderr, N: 64 << 10}
		scanner := bufio.NewScanner(limited)
		for scanner.Scan() {
			slog.Debug("Debug adapter stderr", "session_id", sessionID, "message", scanner.Text())
		}
		_, _ = io.Copy(io.Discard, stderr)
	}()
	base := &execProcess{cmd: cmd, stdin: stdin, stdout: stdout}
	return &dockerProcess{Process: base, name: name}, nil
}

func CleanupDockerOrphans() {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", "ps", "-aq", "--filter", "label=bobocloud.dap=true").Output()
	if err != nil {
		return
	}
	ids := strings.Fields(string(output))
	if len(ids) == 0 {
		return
	}
	args := append([]string{"rm", "-f"}, ids...)
	_ = exec.CommandContext(ctx, "docker", args...).Run()
}
