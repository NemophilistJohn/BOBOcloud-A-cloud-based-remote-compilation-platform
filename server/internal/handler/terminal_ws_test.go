package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"

	"github.com/gorilla/websocket"
)

func terminalWebSocketURL(serverURL string) string {
	return "ws" + strings.TrimPrefix(serverURL, "http")
}

func readTerminalControl(t *testing.T, connection *websocket.Conn) map[string]any {
	t.Helper()
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	var message map[string]any
	if err := connection.ReadJSON(&message); err != nil {
		t.Fatal(err)
	}
	return message
}

func TestTerminalWebSocketRejectsInvalidStartAndLocalRuntime(t *testing.T) {
	handler := &WSHandler{Config: config.Default()}
	server := httptest.NewServer(http.HandlerFunc(handler.HandleTerminalWebSocket))
	defer server.Close()

	connection, _, err := websocket.DefaultDialer.Dial(terminalWebSocketURL(server.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.WriteJSON(map[string]any{"type": "start"}); err != nil {
		connection.Close()
		t.Fatal(err)
	}
	message := readTerminalControl(t, connection)
	connection.Close()
	if message["type"] != "terminal.error" || message["code"] != "invalid_start" {
		t.Fatalf("invalid start response = %#v", message)
	}

	connection, _, err = websocket.DefaultDialer.Dial(terminalWebSocketURL(server.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.WriteJSON(map[string]any{
		"type": "terminal.start", "runtimeId": "local",
		"workspace": map[string]any{"kind": "personal", "folderKey": "project"},
	}); err != nil {
		connection.Close()
		t.Fatal(err)
	}
	message = readTerminalControl(t, connection)
	connection.Close()
	if message["type"] != "terminal.error" || message["code"] != "local_runtime_unsupported" {
		t.Fatalf("local runtime response = %#v", message)
	}

	connection, _, err = websocket.DefaultDialer.Dial(terminalWebSocketURL(server.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.WriteJSON(map[string]any{
		"type": "terminal.start", "protocol": terminalProtocolVersion + 1,
	}); err != nil {
		connection.Close()
		t.Fatal(err)
	}
	message = readTerminalControl(t, connection)
	connection.Close()
	if message["type"] != "terminal.error" || message["code"] != "unsupported_protocol" {
		t.Fatalf("unsupported protocol response = %#v", message)
	}
}

func TestTerminalAuthenticationUsesConfiguredCredential(t *testing.T) {
	store := auth.NewMemoryUserStore()
	user := &auth.User{ID: "terminal-user", Username: "terminal-user", APIKey: "terminal-secret", Role: auth.RoleMember}
	if err := store.Create(user); err != nil {
		t.Fatal(err)
	}
	handler := &WSHandler{
		Config: config.Default(), AuthEnabled: true, UserStore: store,
		Authenticator: auth.NewAPIKeyAuth(store),
	}
	authenticated, err := handler.authenticateTerminal("Bearer terminal-secret")
	if err != nil || authenticated.ID != user.ID {
		t.Fatalf("authenticated user = %#v, %v", authenticated, err)
	}
	if _, err := handler.authenticateTerminal("wrong"); err == nil {
		t.Fatal("invalid terminal credential was accepted")
	}
}

func TestTerminalWorkspaceResolutionIsScopedToTheAuthenticatedUser(t *testing.T) {
	dataRoot := t.TempDir()
	userID := "terminal-user"
	workspaceRoot := filepath.Join(dataRoot, "users", userID, "workspaces", "project-key")
	if err := os.MkdirAll(workspaceRoot, 0755); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.DataDir = dataRoot
	handler := &WSHandler{Config: cfg, AuthEnabled: true}

	resolution, err := handler.resolveTerminalWorkspace(context.Background(), userID, terminalWorkspaceRequest{
		Kind: "personal", FolderKey: "project-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolution.root != workspaceRoot || resolution.activityKey != "project-key" {
		t.Fatalf("workspace resolution = %#v", resolution)
	}
	if _, err := handler.resolveTerminalWorkspace(context.Background(), userID, terminalWorkspaceRequest{
		Kind: "personal", FolderKey: "../another-user",
	}); err == nil {
		t.Fatal("workspace traversal was accepted")
	}
	if _, err := handler.resolveTerminalWorkspace(context.Background(), userID, terminalWorkspaceRequest{
		Kind: "personal", FolderKey: "missing",
	}); err == nil {
		t.Fatal("missing workspace was accepted")
	}
}

func TestTerminalProtocolLimitsUseConfigValues(t *testing.T) {
	cfg := config.Default()
	cfg.TerminalHandshakeTimeoutSeconds = 3
	cfg.TerminalIdleTTLSeconds = 7
	cfg.TerminalMaxSessionSeconds = 11
	cfg.TerminalMaxMessageBytes = 1234
	cfg.TerminalBandwidthPerMinuteBytes = 5678
	cfg.TerminalWorkspaceCopyTimeoutSeconds = 13
	cfg.TerminalWorkspaceCopyMaxBytes = 9876
	limits := terminalProtocolLimits(cfg)
	if limits.Handshake != 3*time.Second || limits.Idle != 7*time.Second || limits.MaxSession != 11*time.Second || limits.MaxMessage != 1234 || limits.Bandwidth != 5678 || limits.CopyTimeout != 13*time.Second || limits.CopyMaxBytes != 9876 {
		t.Fatalf("terminal limits = %#v", limits)
	}
}

func TestTerminalReadyPayloadAdvertisesSnapshotAndCapabilities(t *testing.T) {
	limits := terminalProtocolLimits(config.Default())
	payload := terminalReadyPayload("session", "python:3.11", map[string]string{"kind": "personal"}, limits, true)
	if payload["type"] != "terminal.ready" || payload["protocol"] != terminalProtocolVersion || payload["snapshot"] != true {
		t.Fatalf("terminal ready payload = %#v", payload)
	}
	capabilities, ok := payload["capabilities"].(map[string]bool)
	if !ok || !capabilities["isolatedWorkspace"] || !capabilities["tty"] || capabilities["resize"] {
		t.Fatalf("terminal capabilities = %#v", payload["capabilities"])
	}
}

func TestTerminalSnapshotCopyIsBoundedAndDoesNotMutateSource(t *testing.T) {
	source := t.TempDir()
	destination := t.TempDir()
	sourceFile := filepath.Join(source, "main.py")
	if err := os.WriteFile(sourceFile, []byte("print('source')\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := copyTerminalWorkspaceFiles(context.Background(), source, destination, 1024); err != nil {
		t.Fatal(err)
	}
	destinationFile := filepath.Join(destination, "main.py")
	if contents, err := os.ReadFile(destinationFile); err != nil || string(contents) != "print('source')\n" {
		t.Fatalf("snapshot contents = %q, %v", contents, err)
	}
	if err := os.WriteFile(destinationFile, []byte("print('snapshot')\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if contents, err := os.ReadFile(sourceFile); err != nil || string(contents) != "print('source')\n" {
		t.Fatalf("source was mutated by snapshot write: %q, %v", contents, err)
	}

	tooLargeSource := t.TempDir()
	if err := os.WriteFile(filepath.Join(tooLargeSource, "large.bin"), make([]byte, 32), 0644); err != nil {
		t.Fatal(err)
	}
	if err := copyTerminalWorkspaceFiles(context.Background(), tooLargeSource, t.TempDir(), 31); !errors.Is(err, errTerminalWorkspaceTooLarge) {
		t.Fatalf("size-limited snapshot error = %v", err)
	}
}

func TestTerminalSnapshotCopyHonorsCancelledContext(t *testing.T) {
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "main.py"), []byte("pass\n"), 0644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := copyTerminalWorkspaceFiles(ctx, source, t.TempDir(), 1024); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled snapshot error = %v", err)
	}
	expired, cancelExpired := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancelExpired()
	if err := copyTerminalWorkspaceFiles(expired, source, t.TempDir(), 1024); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expired snapshot error = %v", err)
	}
}

func TestTerminalSnapshotCopyRejectsSymbolicLinks(t *testing.T) {
	source := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(source, "linked.txt")); err != nil {
		// Windows can forbid symlink creation for an unprivileged test process.
		t.Skipf("symbolic links are unavailable in this test environment: %v", err)
	}
	err := copyTerminalWorkspaceFiles(context.Background(), source, t.TempDir(), 1024)
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("symbolic link snapshot error = %v", err)
	}
}

func TestTerminalWorkspaceResetOnlyTargetsEphemeralDirectory(t *testing.T) {
	commands := terminalWorkspaceResetArguments("container-id")
	if len(commands) != 2 {
		t.Fatalf("workspace reset commands = %#v", commands)
	}
	// /workspace is the runtime WorkingDir and is deliberately removed by the
	// first command. Both exec calls must therefore select / before Docker
	// attempts to start either process.
	wantRemove := []string{"docker", "exec", "-w", "/", "container-id", "rm", "-rf", terminalWorkspaceDir}
	wantCreate := []string{"docker", "exec", "-w", "/", "container-id", "mkdir", "-p", terminalWorkspaceDir}
	if strings.Join(commands[0], "\x00") != strings.Join(wantRemove, "\x00") || strings.Join(commands[1], "\x00") != strings.Join(wantCreate, "\x00") {
		t.Fatalf("workspace reset commands = %#v", commands)
	}
}

func TestTerminalHandshakeDeadlineCanBeCleared(t *testing.T) {
	readResult := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := terminalUpgrader.Upgrade(w, r, nil)
		if err != nil {
			readResult <- err
			return
		}
		defer connection.Close()
		if err := connection.SetReadDeadline(time.Now().Add(50 * time.Millisecond)); err != nil {
			readResult <- err
			return
		}
		if err := clearTerminalHandshakeDeadline(connection); err != nil {
			readResult <- err
			return
		}
		time.Sleep(100 * time.Millisecond)
		_, _, err = connection.ReadMessage()
		readResult <- err
	}))
	defer server.Close()

	connection, _, err := websocket.DefaultDialer.Dial(terminalWebSocketURL(server.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	time.Sleep(75 * time.Millisecond)
	if err := connection.WriteJSON(map[string]any{"type": "terminal.ping"}); err != nil {
		t.Fatal(err)
	}
	if err := <-readResult; err != nil {
		t.Fatalf("read deadline was not cleared: %v", err)
	}
}

func TestTerminalOriginPolicyAllowsElectronAndSameHostOnly(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://terminal.example/terminal", nil)
	request.Host = "terminal.example"
	if !terminalUpgrader.CheckOrigin(request) {
		t.Fatal("Electron request without Origin was rejected")
	}
	request.Header.Set("Origin", "https://terminal.example")
	if !terminalUpgrader.CheckOrigin(request) {
		t.Fatal("same-host origin was rejected")
	}
	request.Header.Set("Origin", "https://other.example")
	if terminalUpgrader.CheckOrigin(request) {
		t.Fatal("cross-host origin was accepted")
	}
}

func TestTerminalWriterBase64PreservesRawOutput(t *testing.T) {
	payloadBytes := []byte{0xe4, 0xb8, 0x00, 0xff, 0x1b, '[', '3', '1', 'm'}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := terminalUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		writer := &terminalWriter{conn: connection, writeWait: time.Second, budget: newTerminalByteWindow(1024)}
		_ = writer.output("stdout", payloadBytes)
	}))
	defer server.Close()

	connection, _, err := websocket.DefaultDialer.Dial(terminalWebSocketURL(server.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_, raw, err := connection.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var message map[string]any
	if err := json.Unmarshal(raw, &message); err != nil {
		t.Fatal(err)
	}
	if message["type"] != "terminal.output" || message["encoding"] != "base64" {
		t.Fatalf("output message = %#v", message)
	}
	decoded, err := base64.StdEncoding.DecodeString(message["data"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != string(payloadBytes) {
		t.Fatalf("decoded output = %v, want %v", decoded, payloadBytes)
	}
}

func TestTerminalInputFallbackNormalizesCarriageReturns(t *testing.T) {
	if actual := normalizeTerminalInput("first\rsecond\r", false); actual != "first\nsecond\n" {
		t.Fatalf("fallback input = %q", actual)
	}
	if actual := normalizeTerminalInput("first\r", true); actual != "first\r" {
		t.Fatalf("pty input = %q", actual)
	}
}

func TestTerminalHeartbeatDoesNotRefreshIdleActivity(t *testing.T) {
	clock := newTerminalActivityClock()
	stale := time.Now().Add(-2 * time.Minute)
	clock.mu.Lock()
	clock.last = stale
	clock.mu.Unlock()

	recordTerminalClientActivity(clock, "terminal.ping")
	clock.mu.RLock()
	afterHeartbeat := clock.last
	clock.mu.RUnlock()
	if !afterHeartbeat.Equal(stale) {
		t.Fatalf("heartbeat refreshed terminal activity: before=%v after=%v", stale, afterHeartbeat)
	}
	if clock.idleFor() < time.Minute {
		t.Fatalf("heartbeat shortened idle time to %v", clock.idleFor())
	}

	recordTerminalClientActivity(clock, "terminal.stdin")
	clock.mu.RLock()
	afterInput := clock.last
	clock.mu.RUnlock()
	if !afterInput.After(stale) {
		t.Fatalf("terminal input did not refresh activity: before=%v after=%v", stale, afterInput)
	}
}

func TestTerminalReaderQueueUnblocksWhenSessionEnds(t *testing.T) {
	done := make(chan struct{})
	messages := make(chan terminalClientMessage, 1)
	messages <- terminalClientMessage{Type: "terminal.stdin", Data: "first"}

	result := make(chan bool, 1)
	go func() {
		result <- enqueueTerminalClientMessage(done, messages, terminalClientMessage{Type: "terminal.stdin", Data: "second"})
	}()

	select {
	case accepted := <-result:
		t.Fatalf("queued a second reader message despite a full queue: accepted=%v", accepted)
	case <-time.After(50 * time.Millisecond):
		// The reader is blocked on its bounded queue, as it can be in a busy
		// client session just before the shell exits.
	}

	close(done)
	select {
	case accepted := <-result:
		if accepted {
			t.Fatal("reader message was accepted after terminal session ended")
		}
	case <-time.After(time.Second):
		t.Fatal("terminal reader remained blocked after terminal session ended")
	}
}
