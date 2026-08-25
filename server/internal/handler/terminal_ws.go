package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"

	"github.com/gorilla/websocket"
)

// terminal_ws.go implements an isolated terminal transport. It intentionally
// does not reuse run, LSP, or DAP framing: each WebSocket owns exactly one
// Docker-contained interactive shell and one temporary workspace snapshot.

const (
	terminalProtocolVersion         = 1
	terminalDefaultHandshakeTimeout = 10 * time.Second
	terminalDefaultIdleTTL          = 15 * time.Minute
	terminalDefaultMaxSession       = time.Hour
	terminalDefaultMaxMessageBytes  = 64 * 1024
	terminalDefaultBandwidth        = int64(8 << 20)
	terminalMaxInputBytes           = 16 * 1024
	terminalOutputChunkBytes        = 16 * 1024
	terminalCopyBufferBytes         = 128 * 1024
	terminalWorkspaceDir            = "/workspace"
)

var (
	errTerminalBandwidth         = errors.New("terminal bandwidth limit exceeded")
	errTerminalWorkspaceTooLarge = errors.New("terminal workspace snapshot exceeds the configured size limit")
)

var terminalUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		// Electron has no Origin header. Browser clients are accepted only from
		// the server host. Credentials are sent by Electron's main process in
		// the first frame, never exposed through a renderer URL/query string.
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin == "" {
			return true
		}
		parsed, err := url.Parse(origin)
		return err == nil && strings.EqualFold(parsed.Host, r.Host)
	},
}

// terminalWorkspaceRequest contains only logical cloud-workspace identity.
// Client paths are deliberately absent and never accepted by the service.
type terminalWorkspaceRequest struct {
	Kind       string `json:"kind"`
	FolderName string `json:"folderName,omitempty"`
	FolderKey  string `json:"folderKey,omitempty"`
	TeamID     string `json:"teamId,omitempty"`
	ProjectID  string `json:"projectId,omitempty"`
	Branch     string `json:"branch,omitempty"`
}

type terminalStartMessage struct {
	Protocol       int                      `json:"protocol,omitempty"`
	Type           string                   `json:"type"`
	Token          string                   `json:"token,omitempty"`
	RuntimeID      string                   `json:"runtimeId,omitempty"`
	Workspace      terminalWorkspaceRequest `json:"workspace"`
	SetupCommands  []string                 `json:"setupCommands,omitempty"`
	PackageIntents bool                     `json:"packageIntents,omitempty"`
	Cols           int                      `json:"cols,omitempty"`
	Rows           int                      `json:"rows,omitempty"`
}

type terminalClientMessage struct {
	Type     string `json:"type"`
	Data     string `json:"data,omitempty"`
	Cols     int    `json:"cols,omitempty"`
	Rows     int    `json:"rows,omitempty"`
	IntentID string `json:"intentId,omitempty"`
	Accepted bool   `json:"accepted,omitempty"`
	Code     string `json:"code,omitempty"`
}

type terminalLimits struct {
	Handshake    time.Duration
	Idle         time.Duration
	MaxSession   time.Duration
	MaxMessage   int64
	Bandwidth    int64
	WriteWait    time.Duration
	CopyTimeout  time.Duration
	CopyMaxBytes int64
}

func terminalProtocolLimits(cfg *config.Config) terminalLimits {
	limits := terminalLimits{
		Handshake:    terminalDefaultHandshakeTimeout,
		Idle:         terminalDefaultIdleTTL,
		MaxSession:   terminalDefaultMaxSession,
		MaxMessage:   terminalDefaultMaxMessageBytes,
		Bandwidth:    terminalDefaultBandwidth,
		WriteWait:    10 * time.Second,
		CopyTimeout:  30 * time.Second,
		CopyMaxBytes: 512 << 20,
	}
	if cfg == nil {
		return limits
	}
	if value := cfg.TerminalHandshakeDuration(); value > 0 {
		limits.Handshake = value
	}
	if value := cfg.TerminalIdleDuration(); value > 0 {
		limits.Idle = value
	}
	if value := cfg.TerminalMaxSessionDuration(); value > 0 {
		limits.MaxSession = value
	}
	if value := cfg.TerminalMaxMessageLimit(); value > 0 {
		limits.MaxMessage = value
	}
	if value := cfg.TerminalBandwidthLimit(); value > 0 {
		limits.Bandwidth = value
	}
	if value := cfg.WSWriteWaitDuration(); value > 0 {
		limits.WriteWait = value
	}
	if value := cfg.TerminalWorkspaceCopyTimeoutDuration(); value > 0 {
		limits.CopyTimeout = value
	}
	if value := cfg.TerminalWorkspaceCopyLimit(); value > 0 {
		limits.CopyMaxBytes = value
	}
	return limits
}

type terminalByteWindow struct {
	mu      sync.Mutex
	limit   int64
	used    int64
	started time.Time
}

func newTerminalByteWindow(limit int64) *terminalByteWindow {
	return &terminalByteWindow{limit: limit, started: time.Now()}
}

func (window *terminalByteWindow) allow(size int) bool {
	if window == nil || window.limit <= 0 {
		return true
	}
	window.mu.Lock()
	defer window.mu.Unlock()
	if time.Since(window.started) >= time.Minute {
		window.started = time.Now()
		window.used = 0
	}
	if size < 0 || window.used+int64(size) > window.limit {
		return false
	}
	window.used += int64(size)
	return true
}

// terminalWriter owns the single WebSocket writer. stdout/stderr reads can run
// concurrently, but each output chunk is serialized and byte-accounted.
type terminalWriter struct {
	conn      *websocket.Conn
	writeWait time.Duration
	budget    *terminalByteWindow
	mu        sync.Mutex
}

func (writer *terminalWriter) writePayload(payload []byte) error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if err := writer.conn.SetWriteDeadline(time.Now().Add(writer.writeWait)); err != nil {
		return err
	}
	defer writer.conn.SetWriteDeadline(time.Time{})
	return writer.conn.WriteMessage(websocket.TextMessage, payload)
}

func (writer *terminalWriter) control(message any) error {
	payload, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return writer.writePayload(payload)
}

func (writer *terminalWriter) output(stream string, data []byte) error {
	for len(data) > 0 {
		end := terminalOutputChunkBytes
		if end > len(data) {
			end = len(data)
		}
		// Base64 avoids corrupting an xterm stream when a read ends halfway
		// through a UTF-8 sequence. The client decodes it with a streaming
		// TextDecoder before writing to xterm.
		payload, err := json.Marshal(map[string]any{
			"type": "terminal.output", "stream": stream,
			"encoding": "base64", "data": base64.StdEncoding.EncodeToString(data[:end]),
		})
		if err != nil {
			return err
		}
		if !writer.budget.allow(len(payload)) {
			return errTerminalBandwidth
		}
		if err := writer.writePayload(payload); err != nil {
			return err
		}
		data = data[end:]
	}
	return nil
}

type terminalActivityClock struct {
	mu   sync.RWMutex
	last time.Time
}

func newTerminalActivityClock() *terminalActivityClock {
	return &terminalActivityClock{last: time.Now()}
}

func (clock *terminalActivityClock) touch() {
	clock.mu.Lock()
	clock.last = time.Now()
	clock.mu.Unlock()
}

func (clock *terminalActivityClock) idleFor() time.Duration {
	clock.mu.RLock()
	defer clock.mu.RUnlock()
	return time.Since(clock.last)
}

// recordTerminalClientActivity intentionally excludes terminal.ping. A ping
// proves that the WebSocket transport is alive, but it must not keep an
// abandoned interactive shell past the configured no-input/no-output TTL.
func recordTerminalClientActivity(clock *terminalActivityClock, messageType string) {
	if clock == nil {
		return
	}
	switch messageType {
	case "terminal.stdin", "terminal.resize":
		clock.touch()
	}
}

func enqueueTerminalClientMessage(done <-chan struct{}, messages chan<- terminalClientMessage, message terminalClientMessage) bool {
	select {
	case messages <- message:
		return true
	case <-done:
		return false
	}
}

func reportTerminalReadError(done <-chan struct{}, errors chan<- error, err error) bool {
	select {
	case errors <- err:
		return true
	case <-done:
		return false
	}
}

func readTerminalClientMessages(conn *websocket.Conn, writer *terminalWriter, sessionReady *atomic.Bool, cancelSetup context.CancelFunc, done <-chan struct{}, messages chan<- terminalClientMessage, readErrs chan<- error) {
	defer close(messages)
	for {
		_, payload, readErr := conn.ReadMessage()
		if readErr != nil {
			if sessionReady == nil || !sessionReady.Load() {
				cancelSetup()
			}
			reportTerminalReadError(done, readErrs, readErr)
			return
		}
		if !writer.budget.allow(len(payload)) {
			if sessionReady == nil || !sessionReady.Load() {
				cancelSetup()
			}
			reportTerminalReadError(done, readErrs, errTerminalBandwidth)
			return
		}
		var message terminalClientMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			continue
		}
		if (message.Type == "terminal.close" || message.Type == "terminal.cancel") && (sessionReady == nil || !sessionReady.Load()) {
			// Before terminal.ready there is no session loop consuming controls.
			// Cancel preparation immediately so a closed client cannot retain a
			// cache writer while dependency preparation or container acquisition waits.
			cancelSetup()
		}
		if !enqueueTerminalClientMessage(done, messages, message) {
			return
		}
	}
}

type terminalWorkspaceResolution struct {
	root         string
	activityKey  string
	teamID       string
	projectID    string
	publicFields map[string]string
}

func (h *WSHandler) authenticateTerminal(token string) (*auth.User, error) {
	if !h.AuthEnabled {
		return &auth.User{ID: "default", Username: "default", Name: "Default User", Role: auth.RoleRoot}, nil
	}
	token = strings.TrimSpace(strings.TrimPrefix(token, "Bearer "))
	if token == "" {
		return nil, fmt.Errorf("authentication required")
	}
	if h.UserStore == nil {
		return nil, fmt.Errorf("terminal authentication is not configured")
	}
	if h.AuthSessions != nil && h.Config != nil {
		if session, err := h.AuthSessions.Validate(token, h.Config.SessionTokenTTL()); err == nil {
			if user, userErr := h.UserStore.Get(session.UserID); userErr == nil && !user.Disabled {
				return user, nil
			}
		}
	}
	if h.Authenticator != nil {
		if user, err := h.Authenticator.Validate(token); err == nil && !user.Disabled {
			return user, nil
		}
	}
	return nil, fmt.Errorf("invalid or expired credential")
}

func (h *WSHandler) resolveTerminalWorkspace(ctx context.Context, userID string, request terminalWorkspaceRequest) (terminalWorkspaceResolution, error) {
	if h.Config == nil {
		return terminalWorkspaceResolution{}, fmt.Errorf("terminal configuration is unavailable")
	}
	switch strings.ToLower(strings.TrimSpace(request.Kind)) {
	case "personal":
		key := strings.TrimSpace(request.FolderKey)
		if key == "" {
			key = strings.TrimSpace(request.FolderName)
		}
		if key == "" {
			return terminalWorkspaceResolution{}, fmt.Errorf("folderKey or folderName is required")
		}
		base := h.Config.ServerRoot
		if h.AuthEnabled {
			base = filepath.Join(h.Config.DataDir, "users", userID, "workspaces")
		}
		root, err := safePath(base, key)
		if err != nil {
			return terminalWorkspaceResolution{}, err
		}
		if info, err := os.Lstat(root); err != nil || !info.IsDir() {
			return terminalWorkspaceResolution{}, fmt.Errorf("workspace does not exist")
		}
		return terminalWorkspaceResolution{
			root: root, activityKey: key,
			publicFields: map[string]string{"kind": "personal", "folderKey": key},
		}, nil
	case "team":
		if h.Collaboration == nil || strings.TrimSpace(request.TeamID) == "" || strings.TrimSpace(request.ProjectID) == "" {
			return terminalWorkspaceResolution{}, fmt.Errorf("teamId and projectId are required")
		}
		// ResolveWorktree can create or refresh a member worktree. Verify
		// membership before that side effect rather than after it.
		if !h.Collaboration.IsMember(userID, request.TeamID) {
			return terminalWorkspaceResolution{}, fmt.Errorf("you are not a member of this team")
		}
		root, err := h.Collaboration.ResolveWorktree(ctx, userID, request.TeamID, request.ProjectID, request.Branch)
		if err != nil {
			return terminalWorkspaceResolution{}, err
		}
		return terminalWorkspaceResolution{
			root: root, teamID: request.TeamID, projectID: request.ProjectID,
			publicFields: map[string]string{"kind": "team", "teamId": request.TeamID, "projectId": request.ProjectID, "branch": request.Branch},
		}, nil
	default:
		return terminalWorkspaceResolution{}, fmt.Errorf("workspace kind must be personal or team")
	}
}

func terminalColumns(value int) int {
	if value < 20 || value > 500 {
		return 120
	}
	return value
}

func terminalRows(value int) int {
	if value < 5 || value > 300 {
		return 30
	}
	return value
}

func terminalPTYAvailable(ctx context.Context, containerID string) bool {
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return exec.CommandContext(checkCtx, "docker", "exec", containerID, "sh", "-c", "command -v script >/dev/null 2>&1").Run() == nil
}

func terminalShellCommand(ctx context.Context, containerID, workspaceDir string, cols, rows int, usePTY, packageIntents bool) *exec.Cmd {
	commandPrefix := ""
	if packageIntents {
		commandPrefix = "export PATH=\"" + terminalPackageShimRoot + "/bin:$PATH\"; "
	}
	command := commandPrefix + "exec sh -i"
	if usePTY {
		// All values here are static server-owned strings. Runtime identity and
		// workspace paths were resolved before this point and never enter shell
		// text. script provides a pragmatic in-container PTY for common images;
		// stty must run inside that same PTY so carriage-return progress output
		// uses the xterm dimensions supplied during the handshake.
		command = commandPrefix + "if command -v bash >/dev/null 2>&1; then exec script -qefc 'stty cols \"$COLUMNS\" rows \"$LINES\" 2>/dev/null || true; exec bash --noprofile --norc -i' /dev/null; else exec script -qefc 'stty cols \"$COLUMNS\" rows \"$LINES\" 2>/dev/null || true; exec sh -i' /dev/null; fi"
	} else {
		command = commandPrefix + "if command -v bash >/dev/null 2>&1; then exec bash --noprofile --norc -i; else exec sh -i; fi"
	}
	args := []string{
		"exec", "-i",
		"-e", "TERM=xterm-256color",
		"-e", "COLUMNS=" + strconv.Itoa(terminalColumns(cols)),
		"-e", "LINES=" + strconv.Itoa(terminalRows(rows)),
		"-e", "PS1=\\u@bobocloud:\\w\\$ ",
		"-w", workspaceDir, containerID,
		"sh", "-lc", command,
	}
	return exec.CommandContext(ctx, "docker", args...)
}

// terminalWorkspaceResetArguments clears only the pool's documented ephemeral
// workspace. The values are server-owned argv items, never user input or shell
// source, so a pooled container cannot retain a previous terminal snapshot.
func terminalWorkspaceResetArguments(containerID string) [][]string {
	return [][]string{
		// The runtime images use /workspace as their Docker WorkingDir. Removing
		// it first means every reset command must explicitly run from a stable
		// directory, otherwise Docker fails before it can recreate /workspace.
		{"docker", "exec", "-w", "/", containerID, "rm", "-rf", terminalWorkspaceDir},
		{"docker", "exec", "-w", "/", containerID, "mkdir", "-p", terminalWorkspaceDir},
	}
}

func resetTerminalWorkspace(ctx context.Context, containerID string) error {
	for _, args := range terminalWorkspaceResetArguments(containerID) {
		if output, err := exec.CommandContext(ctx, args[0], args[1:]...).CombinedOutput(); err != nil {
			return fmt.Errorf("prepare terminal workspace: %s", strings.TrimSpace(string(output)))
		}
	}
	return nil
}

// copyTerminalWorkspaceFiles makes a bounded, no-follow snapshot. A terminal
// never operates on the authoritative cloud worktree and a symlink is rejected
// instead of risking a copy of files outside that worktree.
func copyTerminalWorkspaceFiles(ctx context.Context, source, destination string, maxBytes int64) error {
	if maxBytes <= 0 {
		return fmt.Errorf("terminal workspace copy limit must be positive")
	}
	if err := os.MkdirAll(destination, 0755); err != nil {
		return err
	}

	var copied int64
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("terminal workspace path escapes its source")
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("terminal workspace contains unsupported symbolic link: %s", filepath.ToSlash(rel))
		}
		if rel == "." {
			if !entry.IsDir() {
				return fmt.Errorf("terminal workspace root is not a directory")
			}
			return nil
		}
		target := filepath.Join(destination, rel)
		if entry.IsDir() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			return os.MkdirAll(target, info.Mode().Perm())
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("terminal workspace contains unsupported file type: %s", filepath.ToSlash(rel))
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		written, err := copyTerminalWorkspaceFile(ctx, path, target, entry, maxBytes-copied)
		if err != nil {
			return err
		}
		copied += written
		return nil
	})
}

func copyTerminalWorkspaceFile(ctx context.Context, source, destination string, entry fs.DirEntry, remaining int64) (int64, error) {
	if remaining < 0 {
		return 0, errTerminalWorkspaceTooLarge
	}
	info, err := entry.Info()
	if err != nil {
		return 0, err
	}
	if info.Size() > remaining {
		return 0, errTerminalWorkspaceTooLarge
	}
	input, err := openTerminalSnapshotInput(source)
	if err != nil {
		return 0, err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return 0, err
	}
	defer output.Close()

	var written int64
	buffer := make([]byte, terminalCopyBufferBytes)
	for {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		read, readErr := input.Read(buffer)
		if read > 0 {
			if int64(read) > remaining-written {
				return written, errTerminalWorkspaceTooLarge
			}
			if err := writeAll(output, buffer[:read]); err != nil {
				return written, err
			}
			written += int64(read)
		}
		if errors.Is(readErr, io.EOF) {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}

func copyTerminalWorkspace(ctx context.Context, source, containerID string, limits terminalLimits) (string, error) {
	copyCtx, cancel := context.WithTimeout(ctx, limits.CopyTimeout)
	defer cancel()
	tempDir, err := os.MkdirTemp("", "bobocloud-terminal-")
	if err != nil {
		return "", fmt.Errorf("create terminal workspace: %w", err)
	}
	if err := copyTerminalWorkspaceFiles(copyCtx, source, tempDir, limits.CopyMaxBytes); err != nil {
		os.RemoveAll(tempDir)
		return "", fmt.Errorf("copy terminal workspace: %w", err)
	}
	if err := resetTerminalWorkspace(copyCtx, containerID); err != nil {
		os.RemoveAll(tempDir)
		return "", err
	}
	copyCommand := exec.CommandContext(copyCtx, "docker", "cp", filepath.Clean(tempDir)+string(filepath.Separator)+".", containerID+":"+terminalWorkspaceDir)
	if output, err := copyCommand.CombinedOutput(); err != nil {
		os.RemoveAll(tempDir)
		return "", fmt.Errorf("copy workspace into terminal: %s", strings.TrimSpace(string(output)))
	}
	return tempDir, nil
}

func killTerminalContainer(containerID string) bool {
	if containerID == "" {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "docker", "kill", containerID).Run() == nil
}

func terminalExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return 1
}

func terminalExitPayload(reason string, exitCode int, duration time.Duration, cleanupConfirmed bool, pendingIntentID string) map[string]any {
	return map[string]any{
		"type": "terminal.exit", "reason": reason, "exitCode": exitCode,
		"durationMs": duration.Milliseconds(), "cleanupConfirmed": cleanupConfirmed,
		"packageIntentPending": pendingIntentID != "", "packageIntentId": pendingIntentID,
		// A terminal package intent is only a request. The client may report a
		// dependency change after cleanup is confirmed and Package Center's
		// manifest-CAS transaction actually publishes a generation.
		"dependenciesChanged": false, "environmentChanged": false,
		"generation": "", "dependencyDigest": "",
	}
}

func normalizeTerminalInput(data string, usePTY bool) string {
	if usePTY {
		return data
	}
	// A pipe has no terminal line discipline. xterm sends Enter as CR, but sh
	// on the other end expects LF when no PTY is available.
	return strings.ReplaceAll(data, "\r", "\n")
}

func clearTerminalHandshakeDeadline(conn *websocket.Conn) error {
	return conn.SetReadDeadline(time.Time{})
}

func terminalReadyPayload(sessionID string, runtime model.RuntimeDef, workspace map[string]string, limits terminalLimits, usePTY, packageIntents bool) map[string]any {
	return map[string]any{
		"type":      "terminal.ready",
		"protocol":  terminalProtocolVersion,
		"sessionId": sessionID,
		"runtimeId": runtime.RuntimeID,
		// Terminal edits stay in an isolated snapshot; rclone sync remains the
		// only path that can mutate the authoritative cloud worktree.
		"snapshot":  true,
		"workspace": workspace,
		"environment": map[string]string{
			"runtimeId":     runtime.RuntimeID,
			"displayName":   runtime.DisplayName,
			"language":      runtime.Language,
			"version":       runtime.Version,
			"dockerImage":   runtime.DockerImage,
			"workspaceKind": workspace["kind"],
		},
		"capabilities": map[string]bool{
			"stdin": true, "cancel": true, "tty": usePTY,
			"resize": false, "isolatedWorkspace": true, "packageIntents": packageIntents,
		},
		"limits": map[string]any{
			"maxInputBytes":     terminalMaxInputBytes,
			"idleTTLSeconds":    int(limits.Idle.Seconds()),
			"maxSessionSeconds": int(limits.MaxSession.Seconds()),
		},
	}
}

// stopTerminalShellBeforeStreaming handles the narrow interval after
// shell.Start but before the terminal reader/output goroutines own Wait. It
// prevents a failed terminal.ready write from leaving a docker CLI child behind.
func stopTerminalShellBeforeStreaming(shell *exec.Cmd, stdin io.Closer, containerID string) {
	if stdin != nil {
		_ = stdin.Close()
	}
	if shell != nil && shell.Process != nil {
		_ = shell.Process.Kill()
	}
	_ = killTerminalContainer(containerID)
	if shell != nil {
		_ = shell.Wait()
	}
}

func combineTerminalResourceReleases(releases ...func()) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			for _, release := range releases {
				if release != nil {
					release()
				}
			}
		})
	}
}

type terminalContainerDiscarder interface {
	DiscardForUserAndWait(containerID, userID string) error
}

const (
	terminalCleanupInitialRetry = 250 * time.Millisecond
	terminalCleanupMaxRetry     = 30 * time.Second
)

// retryTerminalContainerCleanup retains ownership of the cache release until
// Docker confirms that the container is absent or stopped. The capped backoff
// gives a temporarily unavailable daemon a continuing owner without spinning or
// turning the cache lease into ownerless, permanently active state.
func retryTerminalContainerCleanup(discarder terminalContainerDiscarder, containerID, userID string, release func(), wait func(time.Duration)) {
	if discarder == nil {
		return
	}
	if wait == nil {
		wait = time.Sleep
	}
	delay := terminalCleanupInitialRetry
	for attempt := 1; ; attempt++ {
		wait(delay)
		if err := discarder.DiscardForUserAndWait(containerID, userID); err == nil {
			if release != nil {
				release()
			}
			slog.Info("Deferred terminal container cleanup completed", "container_id", containerID, "user_id", userID, "attempt", attempt)
			return
		} else if attempt == 1 || attempt%10 == 0 {
			slog.Warn("Deferred terminal container cleanup is still pending", "container_id", containerID, "user_id", userID, "attempt", attempt, "error", err)
		}
		if delay < terminalCleanupMaxRetry {
			delay *= 2
			if delay > terminalCleanupMaxRetry {
				delay = terminalCleanupMaxRetry
			}
		}
	}
}

func handoffTerminalContainerCleanup(discarder terminalContainerDiscarder, containerID, userID string, release func(), cleanupErr error) {
	slog.Warn("Terminal cleanup was not immediately confirmed; retaining resource leases for background cleanup", "container_id", containerID, "user_id", userID, "error", cleanupErr)
	go retryTerminalContainerCleanup(discarder, containerID, userID, release, time.Sleep)
}

// HandleTerminalWebSocket is the canonical `/terminal` endpoint. Main keeps
// `/term` as a routing alias only for internal backwards compatibility.
func (h *WSHandler) HandleTerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := terminalUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Warn("Terminal WebSocket upgrade failed", "error", err)
		return
	}
	defer conn.Close()

	limits := terminalProtocolLimits(h.Config)
	conn.SetReadLimit(limits.MaxMessage)
	_ = conn.SetReadDeadline(time.Now().Add(limits.Handshake))
	writer := &terminalWriter{conn: conn, writeWait: limits.WriteWait, budget: newTerminalByteWindow(limits.Bandwidth)}

	_, rawStart, err := conn.ReadMessage()
	if err != nil {
		return
	}
	var start terminalStartMessage
	if err := json.Unmarshal(rawStart, &start); err != nil || start.Type != "terminal.start" {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "invalid_start", "message": "the first message must be terminal.start"})
		return
	}
	// Omitted protocol is accepted as version 1 for a short compatibility
	// window. Any explicit incompatible version fails before a Docker resource
	// can be acquired.
	if start.Protocol != 0 && start.Protocol != terminalProtocolVersion {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "unsupported_protocol", "message": "unsupported terminal protocol version"})
		return
	}
	if err := validateRunArgs(start.SetupCommands); err != nil {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "invalid_setup_commands", "message": "invalid setupCommands: " + err.Error()})
		return
	}
	// The start deadline applies only to the initial capability/auth frame. Idle
	// enforcement below is activity-aware, so it must not inherit this short
	// WebSocket read deadline once a valid terminal.start has arrived.
	_ = clearTerminalHandshakeDeadline(conn)
	user, err := h.authenticateTerminal(start.Token)
	if err != nil {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "unauthorized", "message": err.Error()})
		return
	}
	runtimeID := strings.TrimSpace(start.RuntimeID)
	if runtimeID == "" || strings.EqualFold(runtimeID, "local") {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "local_runtime_unsupported", "message": "interactive terminals require a Docker runtime"})
		return
	}
	runtime := model.GetRuntimeDef(runtimeID)
	if runtime == nil {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "invalid_runtime", "message": "unknown runtime: " + runtimeID})
		return
	}
	if h.DockerPool == nil {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "docker_unavailable", "message": "Docker terminal support is unavailable"})
		return
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), limits.MaxSession)
	defer cancel()
	readMessages := make(chan terminalClientMessage, 1)
	readErrs := make(chan error, 1)
	readerDone := make(chan struct{})
	var readerStop sync.Once
	stopReader := func() {
		readerStop.Do(func() {
			close(readerDone)
			_ = conn.SetReadDeadline(time.Now())
		})
	}
	defer stopReader()
	var sessionReady atomic.Bool
	go readTerminalClientMessages(conn, writer, &sessionReady, cancel, readerDone, readMessages, readErrs)

	workspace, err := h.resolveTerminalWorkspace(ctx, user.ID, start.Workspace)
	if err != nil {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "workspace_denied", "message": err.Error()})
		return
	}
	packagePolicy := newTerminalPackagePolicy(h.Config)
	packageIntentsEnabled := terminalPackageIntentEligible(start.PackageIntents, workspace.teamID, runtime.Language, h.PersonalCache != nil, packagePolicy)
	packageFrameNonce := ""
	pendingResourceRelease := combineTerminalResourceReleases()
	if h.Lifecycle != nil {
		// Team workspaces intentionally use an empty generic key. The
		// collaboration lease below is the exact team/project authority; this
		// generic lease still blocks user-wide cache and account mutations.
		activity, leaseErr := h.Lifecycle.AcquireActivity(user.ID, workspace.activityKey)
		if leaseErr != nil {
			_ = writer.control(map[string]any{"type": "terminal.error", "code": "workspace_in_use", "message": leaseErr.Error()})
			return
		}
		pendingResourceRelease = combineTerminalResourceReleases(activity.Release)
	}
	defer func() { pendingResourceRelease() }()
	if workspace.teamID != "" {
		activity, leaseErr := h.Collaboration.AcquireProjectActivity(user.ID, workspace.teamID, workspace.projectID)
		if leaseErr != nil {
			_ = writer.control(map[string]any{"type": "terminal.error", "code": "workspace_in_use", "message": leaseErr.Error()})
			return
		}
		pendingResourceRelease = combineTerminalResourceReleases(activity.Release, pendingResourceRelease)
	}

	var personalLease *personalcache.Lease
	var persistOperation *personalcache.Operation
	var terminalDependencyEnv map[string]string
	if workspace.teamID == "" && h.PersonalCache != nil && projectLockDependencyLanguage(runtime.Language) {
		terminalDependencyEnv = personalcache.TerminalDependencyDockerEnvironment(runtime.Language, false)
		workspaceID := lsp.StableWorkspaceIdentity(user.ID, "", "", "", workspace.activityKey)
		personalLease, err = h.PersonalCache.PrepareReadOnly(ctx, personalcache.Request{
			UserID: user.ID, WorkspaceID: workspaceID, WorkspaceName: start.Workspace.FolderName,
			RuntimeID: runtime.RuntimeID, RuntimeFingerprint: resolvedRuntimeFingerprint(ctx, h.RuntimeMetadata, runtime.RuntimeID, runtime.DockerImage, runtime.Version), Language: runtime.Language, WorkspaceRoot: workspace.root,
			SetupCommands: start.SetupCommands,
			QuotaBytes:    userQuotaBytes(h.UserStore, user.ID),
		})
		if err != nil {
			_ = writer.control(map[string]any{"type": "terminal.error", "code": "storage_quota", "message": err.Error()})
			return
		}
		if personalLease != nil {
			dependencyScope := personalDependencyRefreshScope(user.ID, workspace.activityKey, runtime.RuntimeID, runtime.Language)
			pendingResourceRelease = combineTerminalResourceReleases(func() {
				h.releasePersonalCacheLease(personalLease, dependencyScope)
			}, pendingResourceRelease)
			terminalDependencyEnv = personalcache.TerminalDependencyDockerEnvironment(runtime.Language, personalLease.Hit)
		}
	}
	if personalLease == nil && h.PersonalCache != nil {
		persistOperation, err = h.PersonalCache.BeginOperation(ctx, user.ID, userQuotaBytes(h.UserStore, user.ID))
		if err != nil {
			_ = writer.control(map[string]any{"type": "terminal.error", "code": "storage_quota", "message": err.Error()})
			return
		}
		if persistOperation != nil {
			pendingResourceRelease = combineTerminalResourceReleases(persistOperation.Release, pendingResourceRelease)
			ctx = persistOperation.Context()
		}
	}
	var containerID string
	if personalLease != nil {
		containerID, err = h.DockerPool.AcquireForUserWithContext(ctx, user.ID, runtime.DockerImage, personalLease.ContainerKey+":terminal", personalLease.DockerMounts, terminalDependencyEnv, nil)
	} else if len(terminalDependencyEnv) > 0 {
		containerID, err = h.DockerPool.AcquireForUserWithContext(ctx, user.ID, runtime.DockerImage, "terminal-ephemeral/"+auth.GenerateToken(), nil, terminalDependencyEnv, nil)
	} else {
		containerID, err = h.DockerPool.AcquireForUser(ctx, user.ID, runtime.DockerImage, nil)
	}
	if err != nil {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "container_unavailable", "message": "unable to acquire a terminal container"})
		slog.Warn("Terminal container acquisition failed", "user_id", user.ID, "runtime", runtimeID, "error", err)
		return
	}
	containerReleased := false
	defer func() {
		if !containerReleased {
			if cleanupErr := h.DockerPool.DiscardForUserAndWait(containerID, user.ID); cleanupErr != nil {
				resourceRelease := pendingResourceRelease
				pendingResourceRelease = combineTerminalResourceReleases()
				handoffTerminalContainerCleanup(h.DockerPool, containerID, user.ID, resourceRelease, cleanupErr)
			}
		}
	}()

	copyStarted := time.Now()
	tempDir, err := copyTerminalWorkspace(ctx, workspace.root, containerID, limits)
	if h.Metrics != nil {
		h.Metrics.Observe("workspace.copy.terminal", time.Since(copyStarted))
	}
	if err != nil {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "workspace_copy_failed", "message": "unable to prepare the terminal workspace"})
		slog.Warn("Terminal workspace copy failed", "user_id", user.ID, "runtime", runtimeID, "error", err)
		return
	}
	defer os.RemoveAll(tempDir)
	if packageIntentsEnabled {
		packageFrameNonce = auth.GenerateToken()
		if shimErr := installTerminalPackageShim(ctx, containerID, packageFrameNonce, runtime.Language); shimErr != nil {
			packageIntentsEnabled = false
			packageFrameNonce = ""
			slog.Warn("Terminal package intent shim is unavailable; installs remain session-local", "user_id", user.ID, "runtime", runtimeID, "error", shimErr)
		}
	}

	usePTY := terminalPTYAvailable(ctx, containerID)
	// The runtime-specific pip/npm/pnpm shim emits a nonce-bound structured
	// intent for dependency mutations. It never executes those mutations and
	// therefore cannot bypass Package Center's manifest CAS and generation
	// transaction; ordinary package-manager queries still reach the real tool.
	shell := terminalShellCommand(ctx, containerID, terminalWorkspaceDir, start.Cols, start.Rows, usePTY, packageIntentsEnabled)
	stdin, err := shell.StdinPipe()
	if err != nil {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "shell_start_failed", "message": "unable to create terminal input"})
		return
	}
	stdout, err := shell.StdoutPipe()
	if err != nil {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "shell_start_failed", "message": "unable to create terminal output"})
		return
	}
	stderr, err := shell.StderrPipe()
	if err != nil {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "shell_start_failed", "message": "unable to create terminal diagnostics"})
		return
	}
	if err := shell.Start(); err != nil {
		_ = writer.control(map[string]any{"type": "terminal.error", "code": "shell_start_failed", "message": "unable to start the terminal shell"})
		slog.Warn("Terminal shell start failed", "user_id", user.ID, "runtime", runtimeID, "error", err)
		return
	}

	clock := newTerminalActivityClock()
	inputQueue := newStdinWriteQueue(stdin, stdinQueueMaxMessages, stdinQueueMaxBytes, func(writeErr error) {
		slog.Debug("Terminal stdin closed", "user_id", user.ID, "error", writeErr)
		cancel()
	})
	defer inputQueue.Stop()

	sessionID := auth.GenerateToken()
	if err := writer.control(terminalReadyPayload(sessionID, *runtime, workspace.publicFields, limits, usePTY, packageIntentsEnabled)); err != nil {
		cancel()
		inputQueue.Stop()
		stopTerminalShellBeforeStreaming(shell, stdin, containerID)
		return
	}
	sessionReady.Store(true)

	type shellResult struct{ err error }
	shellDone := make(chan shellResult, 1)
	var outputWG sync.WaitGroup
	var packageIntentState terminalPackageIntentState
	handlePackageFrame := func(encoded []byte) error {
		intent, parseErr := packagePolicy.parseFrame(encoded, packageFrameNonce, runtime.Language)
		if parseErr != nil {
			code := terminalPackageErrorCode(parseErr)
			slog.Info("Terminal package intent rejected", "session_id", sessionID, "user_id", user.ID, "runtime", runtimeID, "code", code)
			return writer.control(map[string]any{
				"type": "terminal.packageIntentRejected", "schema": terminalPackageIntentSchema,
				"sessionId": sessionID, "code": code,
			})
		}
		intent.SessionID = sessionID
		intent.RuntimeID = runtime.RuntimeID
		intent.Workspace = make(map[string]string, len(workspace.publicFields))
		for key, value := range workspace.publicFields {
			intent.Workspace[key] = value
		}
		if pendingIntentID, offered := packageIntentState.offer(intent, time.Now()); !offered {
			slog.Info("Terminal package intent rejected", "session_id", sessionID, "user_id", user.ID, "runtime", runtimeID, "code", "package_intent_pending")
			return writer.control(map[string]any{
				"type": "terminal.packageIntentRejected", "schema": terminalPackageIntentSchema,
				"sessionId": sessionID, "intentId": pendingIntentID, "code": "package_intent_pending",
			})
		}
		return writer.control(intent)
	}
	streamOutput := func(name string, reader io.Reader) {
		defer outputWG.Done()
		var packageDecoder *terminalPackageFrameDecoder
		if name == "stdout" && packageIntentsEnabled {
			packageDecoder = &terminalPackageFrameDecoder{}
		}
		defer func() {
			if packageDecoder != nil {
				if visible := packageDecoder.Flush(); len(visible) > 0 {
					_ = writer.output(name, visible)
				}
			}
		}()
		buffer := make([]byte, terminalOutputChunkBytes)
		for {
			n, readErr := reader.Read(buffer)
			if n > 0 {
				clock.touch()
				visible := buffer[:n]
				var frames [][]byte
				if packageDecoder != nil {
					visible, frames = packageDecoder.Push(visible)
				}
				for _, frame := range frames {
					if frameErr := handlePackageFrame(frame); frameErr != nil {
						cancel()
						return
					}
				}
				if len(visible) == 0 {
					if readErr != nil {
						return
					}
					continue
				}
				if writeErr := writer.output(name, visible); writeErr != nil {
					if errors.Is(writeErr, errTerminalBandwidth) {
						_ = writer.control(map[string]any{"type": "terminal.error", "code": "bandwidth_limit", "message": "terminal output exceeded the per-minute limit"})
					}
					cancel()
					return
				}
			}
			if readErr != nil {
				return
			}
		}
	}
	outputWG.Add(2)
	go streamOutput("stdout", stdout)
	go streamOutput("stderr", stderr)
	go func() {
		outputWG.Wait()
		err := shell.Wait()
		shellDone <- shellResult{err: err}
	}()

	reason := "process_exited"
	forceContainerStop := false
	gotShellResult := false
	var result shellResult
	idleTicker := time.NewTicker(time.Second)
	defer idleTicker.Stop()

sessionLoop:
	for {
		select {
		case message, open := <-readMessages:
			if !open {
				reason = "client_disconnected"
				forceContainerStop = true
				cancel()
				break sessionLoop
			}
			switch message.Type {
			case "terminal.stdin":
				if len(message.Data) == 0 {
					continue
				}
				if len(message.Data) > terminalMaxInputBytes {
					_ = writer.control(map[string]any{"type": "terminal.error", "code": "input_too_large", "message": "terminal input exceeds the per-message limit"})
					continue
				}
				if !inputQueue.Enqueue(normalizeTerminalInput(message.Data, usePTY)) {
					reason = "input_backpressure"
					forceContainerStop = true
					_ = writer.control(map[string]any{"type": "terminal.error", "code": "input_backpressure", "message": "terminal input queue is full"})
					cancel()
					break sessionLoop
				}
				recordTerminalClientActivity(clock, message.Type)
			case "terminal.resize":
				// Docker CLI has no safe resize operation for this attached exec
				// stream. Initial dimensions are supplied to the shell; do not run
				// a misleading stty command in a separate docker exec session.
				_ = writer.control(map[string]any{"type": "terminal.resize", "applied": false, "cols": terminalColumns(message.Cols), "rows": terminalRows(message.Rows)})
				recordTerminalClientActivity(clock, message.Type)
			case "terminal.packageIntentDecision":
				decisionID := strings.TrimSpace(message.IntentID)
				if !validTerminalPackageIntentID(decisionID) {
					_ = writer.control(map[string]any{
						"type": "terminal.packageIntentRejected", "schema": terminalPackageIntentSchema,
						"sessionId": sessionID, "code": "invalid_package_intent",
					})
					continue
				}
				code, decided := packageIntentState.decide(decisionID, message.Accepted, time.Now())
				if !decided {
					_ = writer.control(map[string]any{
						"type": "terminal.packageIntentRejected", "schema": terminalPackageIntentSchema,
						"sessionId": sessionID, "intentId": decisionID, "code": code,
					})
					continue
				}
				_ = writer.control(map[string]any{
					"type": "terminal.packageIntentDecision", "schema": terminalPackageIntentSchema,
					"sessionId": sessionID, "intentId": decisionID, "accepted": message.Accepted,
				})
				if !message.Accepted {
					slog.Info("Terminal package intent declined by client", "session_id", sessionID, "user_id", user.ID, "runtime", runtimeID, "code", cleanTerminalPackageDecisionCode(message.Code))
				}
			case "terminal.ping":
				_ = writer.control(map[string]any{"type": "terminal.pong"})
				recordTerminalClientActivity(clock, message.Type)
			case "terminal.cancel":
				reason = "cancelled"
				forceContainerStop = true
				cancel()
				break sessionLoop
			case "terminal.close":
				reason = "closed"
				forceContainerStop = true
				cancel()
				break sessionLoop
			}
		case readErr := <-readErrs:
			if errors.Is(readErr, errTerminalBandwidth) {
				reason = "bandwidth_limit"
				_ = writer.control(map[string]any{"type": "terminal.error", "code": "bandwidth_limit", "message": "terminal traffic exceeded the per-minute limit"})
			} else {
				reason = "client_disconnected"
			}
			forceContainerStop = true
			cancel()
			break sessionLoop
		case result = <-shellDone:
			gotShellResult = true
			break sessionLoop
		case <-idleTicker.C:
			if expiredIntentID := packageIntentState.expire(time.Now()); expiredIntentID != "" {
				slog.Info("Terminal package intent expired", "session_id", sessionID, "user_id", user.ID, "runtime", runtimeID)
				_ = writer.control(map[string]any{
					"type": "terminal.packageIntentRejected", "schema": terminalPackageIntentSchema,
					"sessionId": sessionID, "intentId": expiredIntentID, "code": "package_intent_timeout",
				})
			}
			if clock.idleFor() >= limits.Idle {
				reason = "idle_timeout"
				forceContainerStop = true
				_ = writer.control(map[string]any{"type": "terminal.error", "code": "idle_timeout", "message": "terminal session ended after inactivity"})
				cancel()
				break sessionLoop
			}
		case <-ctx.Done():
			if personalCacheLeaseError(personalLease, ctx) != nil || (persistOperation != nil && persistOperation.Err() != nil) {
				reason = "storage_quota"
				_ = writer.control(map[string]any{"type": "terminal.error", "code": "storage_quota", "message": "personal storage quota was exceeded"})
			} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				reason = "max_duration"
				_ = writer.control(map[string]any{"type": "terminal.error", "code": "max_duration", "message": "terminal session reached its maximum duration"})
			} else if reason == "process_exited" {
				reason = "cancelled"
			}
			forceContainerStop = true
			break sessionLoop
		}
	}

	// Wake the sole WebSocket reader before waiting for the process. The shell
	// context controls the Docker CLI; container kill below also stops any exec
	// process that outlives its disconnected CLI client.
	stopReader()
	if forceContainerStop {
		if !killTerminalContainer(containerID) {
			slog.Warn("Terminal container force-stop was not confirmed; discarding it", "container_id", containerID, "user_id", user.ID)
		}
	}
	inputQueue.Stop()
	if !gotShellResult {
		select {
		case result = <-shellDone:
			gotShellResult = true
		case <-time.After(7 * time.Second):
			result.err = context.Canceled
		}
	}

	// An interactive shell can leave descendants behind even after the shell
	// itself exits (for example `pip install ... &; exit`). Its project cache is
	// also a live bind mount. Never return a terminal-used container to the idle
	// pool: destroy it before releasing the cache lease so no background writer
	// or stale mount can survive as an apparently inactive cache entry.
	cleanupConfirmed := true
	if cleanupErr := h.DockerPool.DiscardForUserAndWait(containerID, user.ID); cleanupErr != nil {
		cleanupConfirmed = false
		resourceRelease := pendingResourceRelease
		pendingResourceRelease = combineTerminalResourceReleases()
		handoffTerminalContainerCleanup(h.DockerPool, containerID, user.ID, resourceRelease, cleanupErr)
	}
	containerReleased = true
	// terminal.exit is the client's cleanup acknowledgement. Release every
	// cache and lifecycle lease before sending it so a cache delete issued after
	// terminalStop resolves cannot race a stale "currently in use" state.
	if cleanupConfirmed {
		pendingResourceRelease()
	} else {
		reason = "cleanup_pending"
	}
	exitCode := terminalExitCode(result.err)
	pendingIntentID := packageIntentState.acceptedIntentID()
	_ = writer.control(terminalExitPayload(reason, exitCode, time.Since(started), cleanupConfirmed, pendingIntentID))
	slog.Info("Terminal session ended", "session_id", sessionID, "user_id", user.ID, "runtime", runtimeID, "reason", reason, "exit_code", exitCode)
}
