package dap

import (
	"bufio"
	"context"
	"errors"
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
	SessionID           string
	UserID              string
	Workspace           string
	PersistDir          string
	DependencyRoot      string
	DependencyMountRoot string
	DependencyEnv       map[string]string
	Adapter             AdapterSpec
	MemoryLimit         string
	CPULimit            string
	NetworkEnable       bool
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
	name    string
	removal dockerContainerRemoval
}

// tcpDockerProcess represents an adapter whose DAP server listens inside its
// private Docker network namespace. The only published port is loopback-only
// on the host; browser clients can reach it solely through the authenticated
// DAP child WebSocket broker.
type tcpDockerProcess struct {
	name     string
	hostPort string
	root     net.Conn
	removal  dockerContainerRemoval
}

// unixDockerProcess keeps TCP inside an internal Docker network. The adapter
// exposes a Unix socket through a session-private bind mount, so neither the
// adapter nor its child sessions need a host TCP port.
type unixDockerProcess struct {
	name      string
	socketDir string
	socket    string
	root      net.Conn
	removal   dockerContainerRemoval
}

type dockerContainerRemoval struct {
	mu         sync.Mutex
	confirmed  bool
	remove     func(string) error
	retryDelay time.Duration
}

func forceRemoveDockerContainer(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("Docker container name is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", "rm", "-f", name).CombinedOutput()
	if err == nil {
		return inspectDockerContainerAbsent(name)
	}
	detail := strings.TrimSpace(string(output))
	lower := strings.ToLower(detail)
	if strings.Contains(lower, "no such container") || strings.Contains(lower, "no such object") {
		return nil
	}
	if detail == "" {
		return fmt.Errorf("remove Docker container %q: %w", name, err)
	}
	return fmt.Errorf("remove Docker container %q: %w: %s", name, err, detail)
}

func dockerInspectConfirmsAbsent(name string, output []byte, err error) error {
	detail := strings.TrimSpace(string(output))
	if err == nil {
		return fmt.Errorf("Docker container %q still exists after removal", name)
	}
	lower := strings.ToLower(detail)
	if strings.Contains(lower, "no such container") || strings.Contains(lower, "no such object") {
		return nil
	}
	if detail == "" {
		return fmt.Errorf("confirm Docker container %q removal: %w", name, err)
	}
	return fmt.Errorf("confirm Docker container %q removal: %w: %s", name, err, detail)
}

func inspectDockerContainerAbsent(name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", "inspect", "--type", "container", name).CombinedOutput()
	return dockerInspectConfirmsAbsent(name, output, err)
}

func (r *dockerContainerRemoval) try(name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.confirmed {
		return nil
	}
	remove := r.remove
	if remove == nil {
		remove = forceRemoveDockerContainer
	}
	if err := remove(name); err != nil {
		return err
	}
	r.confirmed = true
	return nil
}

func (r *dockerContainerRemoval) wait(name string) {
	delay := r.retryDelay
	if delay <= 0 {
		delay = 250 * time.Millisecond
	}
	for attempt := 1; ; attempt++ {
		if err := r.try(name); err == nil {
			return
		} else if attempt == 1 || attempt%120 == 0 {
			slog.Warn("Waiting for Docker DAP container removal", "container", name, "attempt", attempt, "error", err)
		}
		time.Sleep(delay)
	}
}

type dockerAdapterStartCleanupError struct {
	cause   error
	removed <-chan struct{}
}

func (e *dockerAdapterStartCleanupError) Error() string { return e.cause.Error() }
func (e *dockerAdapterStartCleanupError) Unwrap() error { return e.cause }
func (e *dockerAdapterStartCleanupError) CleanupDone() <-chan struct{} {
	return e.removed
}

func failDockerAdapterStart(cause error, name, socketDir string) error {
	return failDockerAdapterStartWithRemoval(cause, name, socketDir, &dockerContainerRemoval{})
}

func failDockerAdapterStartWithRemoval(cause error, name, socketDir string, removal *dockerContainerRemoval) error {
	removed := make(chan struct{})
	go func() {
		removal.wait(name)
		if strings.TrimSpace(socketDir) != "" {
			_ = os.RemoveAll(socketDir)
		}
		close(removed)
	}()
	return &dockerAdapterStartCleanupError{cause: cause, removed: removed}
}

// StartCleanupDone returns a completion signal when a failed adapter start may
// still own a Docker container. It deliberately survives error wrapping so the
// WebSocket owner can retain the whole SessionContext until absence is proven.
func StartCleanupDone(err error) <-chan struct{} {
	var pending interface {
		CleanupDone() <-chan struct{}
	}
	if !errors.As(err, &pending) {
		return nil
	}
	return pending.CleanupDone()
}

func releaseDependencyMountAfterStartError(release func(), err error) {
	if release == nil {
		return
	}
	cleanupDone := StartCleanupDone(err)
	if cleanupDone == nil {
		release()
		return
	}
	go func() {
		<-cleanupDone
		release()
	}()
}

func (p *unixDockerProcess) Stdin() io.WriteCloser { return p.root }
func (p *unixDockerProcess) Stdout() io.ReadCloser { return p.root }
func (p *unixDockerProcess) Wait() error {
	p.removal.wait(p.name)
	_ = os.RemoveAll(p.socketDir)
	return nil
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
	if p.root != nil {
		_ = p.root.Close()
	}
	err := p.removal.try(p.name)
	if err != nil {
		go p.removal.wait(p.name)
	}
	return err
}

func (p *tcpDockerProcess) Stdin() io.WriteCloser { return p.root }
func (p *tcpDockerProcess) Stdout() io.ReadCloser { return p.root }
func (p *tcpDockerProcess) Wait() error {
	p.removal.wait(p.name)
	return nil
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
	if p.root != nil {
		_ = p.root.Close()
	}
	err := p.removal.try(p.name)
	if err != nil {
		go p.removal.wait(p.name)
	}
	return err
}

func (p *dockerProcess) Wait() error {
	p.removal.wait(p.name)
	killErr := p.Process.Kill()
	if errors.Is(killErr, os.ErrProcessDone) {
		killErr = nil
	}
	waitErr := p.Process.Wait()
	return errors.Join(waitErr, killErr)
}

func (p *dockerProcess) Kill() error {
	removalErr := p.removal.try(p.name)
	if removalErr != nil {
		go p.removal.wait(p.name)
	}
	killErr := p.Process.Kill()
	if errors.Is(killErr, os.ErrProcessDone) {
		killErr = nil
	}
	return errors.Join(removalErr, killErr)
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
		"HOME":             "/tmp/bobocloud-home",
		"TMPDIR":           "/tmp",
		"PIP_CACHE_DIR":    "/dap-cache/pip",
		"GOCACHE":          "/dap-cache/go-build",
		"NPM_CONFIG_CACHE": "/dap-cache/npm",
	}
	for key, value := range spec.DependencyEnv {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			env[key] = value
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
		persistInfo, statErr := os.Lstat(persist)
		if statErr != nil || !persistInfo.IsDir() || persistInfo.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("DAP persist directory must be a real directory")
		}
		for _, cacheDirectory := range []string{"pip", "go-build", "npm"} {
			hostCache := filepath.Join(persist, cacheDirectory)
			if err := os.MkdirAll(hostCache, 0755); err != nil {
				return nil, fmt.Errorf("prepare DAP %s directory: %w", cacheDirectory, err)
			}
			cacheInfo, cacheErr := os.Lstat(hostCache)
			if cacheErr != nil || !cacheInfo.IsDir() || cacheInfo.Mode()&os.ModeSymlink != 0 {
				return nil, fmt.Errorf("DAP %s directory must be a real directory", cacheDirectory)
			}
			args = append(args, "-v", hostCache+":/dap-cache/"+cacheDirectory+":rw")
		}
	}
	if strings.TrimSpace(spec.DependencyRoot) != "" {
		dependencyRoot, absErr := filepath.Abs(spec.DependencyRoot)
		if absErr != nil {
			return nil, fmt.Errorf("resolve DAP dependency cache: %w", absErr)
		}
		dependencyInfo, statErr := os.Lstat(dependencyRoot)
		if statErr != nil || !dependencyInfo.IsDir() || dependencyInfo.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("DAP dependency cache must be a real directory")
		}
		args = append(args, "-v", dependencyRoot+":/project-deps:ro")
		if spec.Adapter.LanguageID == "node" {
			nodeModules := filepath.Join(dependencyRoot, "node_modules")
			nodeInfo, nodeErr := os.Lstat(nodeModules)
			if nodeErr != nil || !nodeInfo.IsDir() || nodeInfo.Mode()&os.ModeSymlink != 0 {
				return nil, fmt.Errorf("DAP Node dependency cache must contain a real node_modules directory")
			}
			args = append(args, "-v", nodeModules+":"+ContainerRoot+"/node_modules:ro")
		}
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
	var releaseDependencyMount func()
	if strings.TrimSpace(spec.DependencyRoot) != "" {
		pinnedRoot, release, err := pinDAPDependencyMount(spec.DependencyMountRoot, spec.SessionID, spec.DependencyRoot)
		if err != nil {
			return nil, err
		}
		spec.DependencyRoot = pinnedRoot
		releaseDependencyMount = release
	}
	name := "bobocloud-dap-" + safeContainerLabel(spec.SessionID)
	args, err := dockerRunArgs(spec, name, false)
	if err != nil {
		releaseDependencyMountAfterStartError(releaseDependencyMount, err)
		return nil, err
	}
	var process Process
	if spec.Adapter.Transport == "tcp" {
		process, err = startTCPDockerAdapter(ctx, spec, name, args)
	} else if spec.Adapter.Transport == "unix" {
		process, err = startUnixDockerAdapter(ctx, spec, name, args)
	} else {
		args = append(args, spec.Adapter.Image)
		args = append(args, spec.Adapter.Command...)
		process, err = startDockerCommand(ctx, exec.CommandContext(ctx, "docker", args...), name, spec.SessionID)
	}
	if err != nil {
		releaseDependencyMountAfterStartError(releaseDependencyMount, err)
		return nil, err
	}
	return wrapDAPDependencyProcess(process, releaseDependencyMount), nil
}

type dependencyMountedProcess struct {
	Process
	release func()
	once    sync.Once
}

func wrapDAPDependencyProcess(process Process, release func()) Process {
	if release == nil {
		return process
	}
	return &dependencyMountedProcess{Process: process, release: release}
}

func (process *dependencyMountedProcess) releaseMount() {
	process.once.Do(process.release)
}

func (process *dependencyMountedProcess) Wait() error {
	err := process.Process.Wait()
	process.releaseMount()
	return err
}

func (process *dependencyMountedProcess) Kill() error {
	return process.Process.Kill()
}

func (process *dependencyMountedProcess) OpenChild(ctx context.Context) (io.ReadWriteCloser, error) {
	provider, ok := process.Process.(ChildConnectionProvider)
	if !ok {
		return nil, fmt.Errorf("DAP child connection is unavailable")
	}
	return provider.OpenChild(ctx)
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
		cause := fmt.Errorf("start Unix DAP adapter: %w: %s", err, strings.TrimSpace(string(output)))
		return nil, failDockerAdapterStart(cause, name, socketDir)
	}
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	root, err := dialDAPUnix(dialCtx, socketPath)
	if err != nil {
		return nil, failDockerAdapterStart(fmt.Errorf("connect to Unix DAP adapter: %w", err), name, socketDir)
	}
	return &unixDockerProcess{name: name, socketDir: socketDir, socket: socketPath, root: root}, nil
}

func startTCPDockerAdapter(ctx context.Context, spec LaunchSpec, name string, args []string) (Process, error) {
	args = append(args, "-p", fmt.Sprintf("127.0.0.1::%d", spec.Adapter.ContainerPort))
	args = append(args, spec.Adapter.Image)
	args = append(args, spec.Adapter.Command...)
	if output, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput(); err != nil {
		cause := fmt.Errorf("start tcp DAP adapter: %w: %s", err, strings.TrimSpace(string(output)))
		return nil, failDockerAdapterStart(cause, name, "")
	}
	portCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	hostPort, err := resolvePublishedPort(portCtx, name, spec.Adapter.ContainerPort)
	if err != nil {
		return nil, failDockerAdapterStart(err, name, "")
	}
	root, err := dialDAPTCP(portCtx, hostPort)
	if err != nil {
		return nil, failDockerAdapterStart(fmt.Errorf("connect to tcp DAP adapter: %w", err), name, "")
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

func cleanupDockerOrphanIDs(ids []string, remove func(string) error) error {
	var result error
	for _, id := range ids {
		if err := remove(id); err != nil {
			result = errors.Join(result, err)
		}
	}
	return result
}

func CleanupDockerOrphans() error {
	ids, err := listDockerDAPOrphanIDs(dockerDAPOrphanFilters())
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	return cleanupDockerOrphanIDs(ids, forceRemoveDockerContainer)
}

func dockerDAPOrphanFilters() []string {
	return []string{
		"label=bobocloud.dap=true",
		// Toolkit image labels identify adapters created by pre-service-label
		// builds, including containers that Docker assigned a random name.
		"label=bobocloud.dap.adapter",
		"name=bobocloud-dap-",
	}
}

func listDockerDAPOrphanIDs(filters []string) ([]string, error) {
	seen := make(map[string]struct{})
	ids := make([]string, 0)
	for _, filter := range filters {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		output, err := exec.CommandContext(ctx, "docker", "ps", "-aq", "--filter", filter).CombinedOutput()
		cancel()
		if err != nil {
			return nil, fmt.Errorf("list orphaned Docker DAP containers (%s): %w: %s", filter, err, strings.TrimSpace(string(output)))
		}
		for _, id := range strings.Fields(string(output)) {
			if _, exists := seen[id]; exists {
				continue
			}
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
	}
	return ids, nil
}
