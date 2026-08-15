package dap

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
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

// ChildConnectionProvider is deliberately a DAP-local interface. It is used
// by js-debug's DAP session tree and is not shared with the LSP transport.
type ChildConnectionProvider interface {
	OpenChild(context.Context) (io.ReadWriteCloser, error)
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

// tcpDockerProcess represents an adapter whose DAP server listens inside its
// private Docker network namespace. The only published port is loopback-only
// on the host; browser clients can reach it solely through the authenticated
// DAP child WebSocket broker.
type tcpDockerProcess struct {
	name     string
	hostPort string
	root     net.Conn
	once     sync.Once
}

// unixDockerProcess keeps TCP inside an internal Docker network. The adapter
// exposes a Unix socket through a session-private bind mount, so neither the
// adapter nor its child sessions need a host TCP port.
type unixDockerProcess struct {
	name      string
	socketDir string
	socket    string
	root      net.Conn
	once      sync.Once
}

func (p *unixDockerProcess) Stdin() io.WriteCloser { return p.root }
func (p *unixDockerProcess) Stdout() io.ReadCloser { return p.root }
func (p *unixDockerProcess) Wait() error {
	return exec.Command("docker", "wait", p.name).Run()
}
func (p *unixDockerProcess) OpenChild(ctx context.Context) (io.ReadWriteCloser, error) {
	if p == nil || strings.TrimSpace(p.socket) == "" {
		return nil, fmt.Errorf("DAP child connection is unavailable")
	}
	return dialDAPUnix(ctx, p.socket)
}
func (p *unixDockerProcess) Kill() error {
	if p == nil {
		return nil
	}
	var result error
	p.once.Do(func() {
		if p.root != nil {
			_ = p.root.Close()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		result = exec.CommandContext(ctx, "docker", "rm", "-f", p.name).Run()
		_ = os.RemoveAll(p.socketDir)
	})
	return result
}

func (p *tcpDockerProcess) Stdin() io.WriteCloser { return p.root }
func (p *tcpDockerProcess) Stdout() io.ReadCloser { return p.root }
func (p *tcpDockerProcess) Wait() error {
	return exec.Command("docker", "wait", p.name).Run()
}
func (p *tcpDockerProcess) OpenChild(ctx context.Context) (io.ReadWriteCloser, error) {
	if p == nil || strings.TrimSpace(p.hostPort) == "" {
		return nil, fmt.Errorf("DAP child connection is unavailable")
	}
	return dialDAPTCP(ctx, p.hostPort)
}
func (p *tcpDockerProcess) Kill() error {
	if p == nil {
		return nil
	}
	var result error
	p.once.Do(func() {
		if p.root != nil {
			_ = p.root.Close()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		result = exec.CommandContext(ctx, "docker", "rm", "-f", p.name).Run()
	})
	return result
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

func dockerRunArgs(spec LaunchSpec, name string, detached bool) ([]string, error) {
	workspace, err := filepath.Abs(strings.TrimSpace(spec.Workspace))
	if err != nil || workspace == "" {
		return nil, fmt.Errorf("resolve DAP workspace")
	}
	info, err := os.Lstat(workspace)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("DAP workspace must be a real directory")
	}
	args := []string{"run", "--rm"}
	if detached {
		args = append(args, "-d")
	} else {
		args = append(args, "-i")
	}
	args = append(args,
		"--name", name,
		"--label", "bobocloud.dap=true",
		"--label", "bobocloud.dap.session="+safeContainerLabel(spec.SessionID),
		"--label", "bobocloud.dap.user="+safeContainerLabel(spec.UserID),
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--pids-limit", "256", "--init",
		"--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
		"-v", workspace+":"+ContainerRoot+":rw", "-w", ContainerRoot,
	)
	if !spec.NetworkEnable {
		// An internal Docker network gives the server loopback access to the
		// adapter while denying container egress to public networks.
		if err := ensureDAPInternalNetwork(); err != nil {
			return nil, err
		}
		args = append(args, "--network", "bobocloud-dap-internal")
	}
	if spec.Adapter.RequiresPtrace {
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
	return args, nil
}

func ensureDAPInternalNetwork() error {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "docker", "network", "inspect", "bobocloud-dap-internal").Run(); err == nil {
		return nil
	}
	if err := exec.CommandContext(ctx, "docker", "network", "create", "--internal", "bobocloud-dap-internal").Run(); err != nil {
		return fmt.Errorf("prepare internal DAP network: %w", err)
	}
	return nil
}

func (ExecStarter) Start(ctx context.Context, spec LaunchSpec) (Process, error) {
	name := "bobocloud-dap-" + safeContainerLabel(spec.SessionID)
	args, err := dockerRunArgs(spec, name, false)
	if err != nil {
		return nil, err
	}
	if spec.Adapter.Transport == "tcp" {
		return startTCPDockerAdapter(ctx, spec, name, args)
	}
	if spec.Adapter.Transport == "unix" {
		return startUnixDockerAdapter(ctx, spec, name, args)
	}
	args = append(args, spec.Adapter.Image)
	args = append(args, spec.Adapter.Command...)
	return startDockerCommand(ctx, exec.CommandContext(ctx, "docker", args...), name, spec.SessionID)
}

func startUnixDockerAdapter(ctx context.Context, spec LaunchSpec, name string, args []string) (Process, error) {
	socketDir, err := os.MkdirTemp("", "bobocloud-dap-node-")
	if err != nil {
		return nil, fmt.Errorf("prepare DAP Unix socket: %w", err)
	}
	socketPath := filepath.Join(socketDir, "dap.sock")
	args = append(args, "--mount", "type=bind,src="+socketDir+",dst=/bridge,rw")
	args = append(args, spec.Adapter.Image)
	args = append(args, spec.Adapter.Command...)
	if output, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput(); err != nil {
		_ = os.RemoveAll(socketDir)
		return nil, fmt.Errorf("start Unix DAP adapter: %w: %s", err, strings.TrimSpace(string(output)))
	}
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	root, err := dialDAPUnix(dialCtx, socketPath)
	if err != nil {
		_ = exec.Command("docker", "rm", "-f", name).Run()
		_ = os.RemoveAll(socketDir)
		return nil, fmt.Errorf("connect to Unix DAP adapter: %w", err)
	}
	return &unixDockerProcess{name: name, socketDir: socketDir, socket: socketPath, root: root}, nil
}

func startTCPDockerAdapter(ctx context.Context, spec LaunchSpec, name string, args []string) (Process, error) {
	args = append(args, "-p", fmt.Sprintf("127.0.0.1::%d", spec.Adapter.ContainerPort))
	args = append(args, spec.Adapter.Image)
	args = append(args, spec.Adapter.Command...)
	if output, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("start tcp DAP adapter: %w: %s", err, strings.TrimSpace(string(output)))
	}
	portCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	hostPort, err := resolvePublishedPort(portCtx, name, spec.Adapter.ContainerPort)
	if err != nil {
		_ = exec.Command("docker", "rm", "-f", name).Run()
		return nil, err
	}
	root, err := dialDAPTCP(portCtx, hostPort)
	if err != nil {
		_ = exec.Command("docker", "rm", "-f", name).Run()
		return nil, fmt.Errorf("connect to tcp DAP adapter: %w", err)
	}
	return &tcpDockerProcess{name: name, hostPort: hostPort, root: root}, nil
}

func resolvePublishedPort(ctx context.Context, name string, containerPort int) (string, error) {
	for {
		output, err := exec.CommandContext(ctx, "docker", "port", name, fmt.Sprintf("%d/tcp", containerPort)).Output()
		if err == nil {
			for _, line := range strings.Fields(string(output)) {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "127.0.0.1:") {
					return line, nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("discover tcp DAP adapter port: %w", ctx.Err())
		case <-time.After(75 * time.Millisecond):
		}
	}
}

func dialDAPTCP(ctx context.Context, address string) (net.Conn, error) {
	dialer := net.Dialer{Timeout: 500 * time.Millisecond}
	for {
		connection, err := dialer.DialContext(ctx, "tcp", address)
		if err == nil {
			return connection, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(75 * time.Millisecond):
		}
	}
}

func dialDAPUnix(ctx context.Context, path string) (net.Conn, error) {
	dialer := net.Dialer{Timeout: 500 * time.Millisecond}
	for {
		connection, err := dialer.DialContext(ctx, "unix", path)
		if err == nil {
			return connection, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(75 * time.Millisecond):
		}
	}
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
