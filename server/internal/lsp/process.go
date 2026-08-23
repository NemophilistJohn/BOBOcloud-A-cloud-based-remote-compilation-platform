package lsp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const DockerWorkspaceRoot = "/workspace"

type LaunchSpec struct {
	SessionID          string
	UserID             string
	Workspace          string
	CacheDir           string
	MountRoot          string
	LanguageID         string
	Mode               Mode
	RuntimeID          string
	RuntimeImage       string
	Server             ServerSpec
	Docker             bool
	MemoryLimit        string
	CPULimit           string
	DependencyView     AnalysisDependencyView
	SharedDependencies *SharedDependencies
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

type execProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
}

type dockerProcess struct {
	Process
	name        string
	removal     dockerContainerRemoval
	releaseOnce sync.Once
	release     func()
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
			slog.Warn("Waiting for Docker LSP container removal", "container", name, "attempt", attempt, "error", err)
		}
		time.Sleep(delay)
	}
}

func (p *dockerProcess) releaseMounts() {
	if p == nil {
		return
	}
	p.releaseOnce.Do(func() {
		if p.release != nil {
			p.release()
		}
	})
}

func (p *dockerProcess) Wait() error {
	// Confirm the container is gone before waiting on the attached Docker CLI.
	// A transient `docker rm` failure must not leave Wait blocked behind the
	// very container whose removal retry would otherwise run only afterwards.
	p.removal.wait(p.name)
	killErr := p.Process.Kill()
	if errors.Is(killErr, os.ErrProcessDone) {
		killErr = nil
	}
	waitErr := p.Process.Wait()
	p.releaseMounts()
	return errors.Join(waitErr, killErr)
}

func (p *dockerProcess) Kill() error {
	removalErr := p.removal.try(p.name)
	if removalErr != nil {
		// Keep a remover alive even if the attached Docker CLI or analyzer does
		// not react to stdin/stdout closure. Wait will join the same retry path.
		go p.removal.wait(p.name)
	}
	killErr := p.Process.Kill()
	if errors.Is(killErr, os.ErrProcessDone) {
		killErr = nil
	}
	return errors.Join(removalErr, killErr)
}

func (p *execProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *execProcess) Stdout() io.ReadCloser { return p.stdout }
func (p *execProcess) Wait() error           { return p.cmd.Wait() }
func (p *execProcess) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	return p.cmd.Process.Kill()
}

type ExecStarter struct{}

func analysisEnvironment(cache string, docker bool) map[string]string {
	base := cache
	if docker {
		base = "/analysis-cache"
	}
	return map[string]string{
		"BOBO_LSP_CACHE_DIR":  base,
		"XDG_CACHE_HOME":      filepath.ToSlash(filepath.Join(base, "xdg")),
		"GOCACHE":             filepath.ToSlash(filepath.Join(base, "go-build")),
		"GOMODCACHE":          filepath.ToSlash(filepath.Join(base, "go-mod")),
		"CARGO_HOME":          filepath.ToSlash(filepath.Join(base, "cargo-home")),
		"CARGO_TARGET_DIR":    filepath.ToSlash(filepath.Join(base, "cargo-target")),
		"GRADLE_USER_HOME":    filepath.ToSlash(filepath.Join(base, "gradle")),
		"NPM_CONFIG_CACHE":    filepath.ToSlash(filepath.Join(base, "npm")),
		"PYTHONPYCACHEPREFIX": filepath.ToSlash(filepath.Join(base, "python")),
		"JDTLS_WORKSPACE":     filepath.ToSlash(filepath.Join(base, "jdtls")),
		"MAVEN_OPTS":          "-Dmaven.repo.local=" + filepath.ToSlash(filepath.Join(base, "maven")),
	}
}

func commandEnvironment(spec LaunchSpec, docker bool) map[string]string {
	env := analysisEnvironment(spec.CacheDir, docker)
	env["BOBO_LSP_MODE"] = string(spec.Mode)
	if docker {
		env["HOME"] = "/analysis-cache/home"
	}
	for key, value := range spec.Server.Environment {
		env[key] = strings.ReplaceAll(value, "{{cacheDir}}", env["BOBO_LSP_CACHE_DIR"])
	}
	dependencies := spec.DependencyView.LocalEnvironment
	if docker {
		dependencies = spec.DependencyView.DockerEnvironment
	}
	for key, value := range dependencies {
		cache := spec.CacheDir
		if docker {
			cache = "/analysis-cache"
		}
		env[key] = strings.ReplaceAll(value, localAnalysisCachePlaceholder, filepath.ToSlash(cache))
	}
	return env
}

func numericContainerUser(uid, gid string) string {
	if _, err := strconv.ParseUint(uid, 10, 32); err != nil {
		return ""
	}
	if _, err := strconv.ParseUint(gid, 10, 32); err != nil {
		return ""
	}
	return uid + ":" + gid
}

func appendEnvironment(base []string, additional map[string]string) []string {
	out := append([]string(nil), base...)
	for key, value := range additional {
		out = append(out, key+"="+value)
	}
	return out
}

func expandCommand(command []string, spec LaunchSpec, docker bool) []string {
	cacheDir, workspace := spec.CacheDir, spec.Workspace
	if docker {
		cacheDir, workspace = "/analysis-cache", DockerWorkspaceRoot
	}
	out := make([]string, len(command))
	for i, value := range command {
		value = strings.ReplaceAll(value, "{{cacheDir}}", filepath.ToSlash(cacheDir))
		value = strings.ReplaceAll(value, "{{workspace}}", filepath.ToSlash(workspace))
		out[i] = strings.ReplaceAll(value, "{{mode}}", string(spec.Mode))
	}
	return out
}

func launchCommand(spec LaunchSpec, docker bool) []string {
	if docker {
		if spec.Mode == ModeFull {
			return spec.Server.Docker.FullCommand
		}
		return spec.Server.Docker.StandardCommand
	}
	if spec.Mode == ModeFull {
		return spec.Server.FullCommand
	}
	return spec.Server.StandardCommand
}

func (ExecStarter) Start(ctx context.Context, spec LaunchSpec) (Process, error) {
	if spec.Docker {
		return startDockerProcess(ctx, spec)
	}
	selected := launchCommand(spec, false)
	if len(selected) == 0 {
		return nil, fmt.Errorf("local language server command is not configured")
	}
	command := expandCommand(selected, spec, false)
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir = spec.Workspace
	cmd.Env = appendEnvironment(os.Environ(), commandEnvironment(spec, false))
	return startCommand(cmd, spec.SessionID)
}

func startDockerProcess(ctx context.Context, spec LaunchSpec) (Process, error) {
	image := strings.TrimSpace(spec.Server.Docker.Image)
	if image == "" {
		image = strings.TrimSpace(spec.RuntimeImage)
	}
	if image == "" {
		return nil, fmt.Errorf("Docker LSP image is not configured for %s", spec.LanguageID)
	}
	command := launchCommand(spec, true)
	if len(command) == 0 {
		return nil, fmt.Errorf("Docker LSP command is not configured for %s", spec.LanguageID)
	}
	command = expandCommand(command, spec, true)
	workspace, err := filepath.Abs(spec.Workspace)
	if err != nil {
		return nil, err
	}
	cache, err := filepath.Abs(spec.CacheDir)
	if err != nil {
		return nil, err
	}
	name := "bobocloud-lsp-" + spec.SessionID
	if len(name) > 60 {
		name = name[:60]
	}
	pinnedMounts, releasePinnedMounts, err := pinDockerDependencyMounts(spec.MountRoot, spec.SessionID, spec.DependencyView.Mounts)
	if err != nil {
		return nil, err
	}
	releaseOnError := true
	defer func() {
		if releaseOnError {
			releasePinnedMounts()
		}
	}()
	args := []string{"run", "--rm", "-i", "--name", name, "--label", "bobocloud.lsp=true", "--label", "bobocloud.lsp.session=" + spec.SessionID, "--label", "bobocloud.lsp.user=" + safeLabel(spec.UserID), "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m", "-v", workspace + ":" + DockerWorkspaceRoot + ":ro", "-v", cache + ":/analysis-cache:rw", "-w", DockerWorkspaceRoot}
	if identity := containerUser(); identity != "" {
		args = append(args, "--user", identity)
	}
	for _, mount := range pinnedMounts {
		if !mount.ReadOnly {
			return nil, fmt.Errorf("dependency mount %q must be read-only", mount.Role)
		}
		hostPath, validateErr := validateDockerMountSource(mount.HostPath)
		if validateErr != nil {
			return nil, fmt.Errorf("dependency mount %q changed before launch: %w", mount.Role, validateErr)
		}
		args = append(args, "-v", hostPath+":"+mount.ContainerPath+":ro")
	}
	if spec.MemoryLimit != "" {
		args = append(args, "--memory", spec.MemoryLimit)
	}
	if spec.CPULimit != "" {
		args = append(args, "--cpus", spec.CPULimit)
	}
	for key, value := range commandEnvironment(spec, true) {
		args = append(args, "-e", key+"="+value)
	}
	args = append(args, image)
	args = append(args, command...)
	process, err := startCommand(exec.CommandContext(ctx, "docker", args...), spec.SessionID)
	if err != nil {
		return nil, err
	}
	releaseOnError = false
	return &dockerProcess{Process: process, name: name, release: releasePinnedMounts}, nil
}

func validateDockerMountSource(value string) (string, error) {
	hostPath, err := filepath.Abs(strings.TrimSpace(value))
	if err != nil || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("resolve Docker mount source")
	}
	info, err := os.Lstat(hostPath)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("Docker mount source must be a real directory")
	}
	resolved, err := filepath.EvalSymlinks(hostPath)
	if err != nil {
		return "", err
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil || filepath.Clean(resolved) != filepath.Clean(hostPath) {
		return "", fmt.Errorf("Docker mount source was replaced or redirected")
	}
	return hostPath, nil
}

func safeLabel(value string) string {
	var b strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
		}
		if b.Len() >= 50 {
			break
		}
	}
	return b.String()
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

// CleanupDockerOrphans removes analyzer containers left by an unclean server
// exit. It covers both current labels and the historical container-name
// convention, and succeeds only after every match is confirmed absent.
func CleanupDockerOrphans() error {
	ids, err := listDockerLSPOrphanIDs(dockerLSPOrphanFilters())
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	return cleanupDockerOrphanIDs(ids, forceRemoveDockerContainer)
}

func dockerLSPOrphanFilters() []string {
	return []string{
		"label=bobocloud.lsp=true",
		// Older builds always used this name prefix even before every image
		// carried the explicit service label.
		"name=bobocloud-lsp-",
	}
}

func listDockerLSPOrphanIDs(filters []string) ([]string, error) {
	seen := make(map[string]struct{})
	ids := make([]string, 0)
	for _, filter := range filters {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		output, err := exec.CommandContext(ctx, "docker", "ps", "-aq", "--filter", filter).CombinedOutput()
		cancel()
		if err != nil {
			return nil, fmt.Errorf("list orphaned Docker LSP containers (%s): %w: %s", filter, err, strings.TrimSpace(string(output)))
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

func startCommand(cmd *exec.Cmd, sessionID string) (Process, error) {
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
		logged := &io.LimitedReader{R: stderr, N: 64 << 10}
		scanner := bufio.NewScanner(logged)
		for scanner.Scan() {
			slog.Debug("Language server stderr", "session_id", sessionID, "message", scanner.Text())
		}
		// Logging is bounded, but the pipe must remain drained or a verbose
		// analyzer can block after filling its stderr buffer.
		_, _ = io.Copy(io.Discard, stderr)
	}()
	return &execProcess{cmd: cmd, stdin: stdin, stdout: stdout}, nil
}

func readFrame(reader *bufio.Reader, maxBytes int) ([]byte, error) {
	contentLength := -1
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		name, value, found := strings.Cut(line, ":")
		if !found {
			return nil, fmt.Errorf("invalid LSP frame header")
		}
		if strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			length, parseErr := strconv.Atoi(strings.TrimSpace(value))
			if parseErr != nil || length < 0 {
				return nil, fmt.Errorf("invalid LSP content length")
			}
			contentLength = length
		}
	}
	if contentLength < 0 {
		return nil, fmt.Errorf("LSP frame is missing Content-Length")
	}
	if maxBytes > 0 && contentLength > maxBytes {
		return nil, fmt.Errorf("LSP frame exceeds %d bytes", maxBytes)
	}
	payload := make([]byte, contentLength)
	_, err := io.ReadFull(reader, payload)
	return payload, err
}

func writeFrame(writer io.Writer, payload []byte) error {
	if _, err := fmt.Fprintf(writer, "Content-Length: %d\r\n\r\n", len(payload)); err != nil {
		return err
	}
	_, err := writer.Write(payload)
	return err
}

type lockedWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (w *lockedWriter) frame(payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return writeFrame(w.w, payload)
}
