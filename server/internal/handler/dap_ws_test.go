package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/dap"
	"bobocloud-server/internal/lifecycle"

	"github.com/gorilla/websocket"
)

type dapHandlerTestInspector struct{}

func (dapHandlerTestInspector) Available(context.Context, string) (bool, string) {
	return true, ""
}

type dapHandlerTestStarter struct {
	process  *bridgeTestProcess
	launches chan dap.LaunchSpec
}

func (starter *dapHandlerTestStarter) Start(_ context.Context, spec dap.LaunchSpec) (dap.Process, error) {
	starter.launches <- spec
	return starter.process, nil
}

func newDAPHandlerHarness(t *testing.T) (*websocket.Conn, *bridgeTestProcess, <-chan dap.LaunchSpec, *lifecycle.Manager, string) {
	t.Helper()
	serverRoot := t.TempDir()
	projectRoot := filepath.Join(serverRoot, "project")
	if err := os.MkdirAll(filepath.Join(projectRoot, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectRoot, "main.py"), []byte("print(42)\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectRoot, ".git", "config"), []byte("private"), 0644); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(t.TempDir(), "dap_adapters.json")
	manifest := `{"version":"1.0","adapters":[{
		"id":"python-debugpy","label":"Python debugpy","languageId":"python",
		"runtimeId":"python:3.11","image":"bobocloud/dap-python:test",
		"command":["adapter"],"supportsLaunch":true
	}]}`
	if err := os.WriteFile(manifestPath, []byte(manifest), 0644); err != nil {
		t.Fatal(err)
	}
	catalog, err := dap.LoadCatalog(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	process := newBridgeTestProcess()
	starter := &dapHandlerTestStarter{process: process, launches: make(chan dap.LaunchSpec, 1)}
	manager := dap.NewManager(catalog, starter, dap.ManagerOptions{
		MaxSessions: 1, MaxPerUser: 1, MaxMessageBytes: 1 << 20,
		Inspector: dapHandlerTestInspector{},
	})
	t.Cleanup(manager.Close)
	cfg := config.Default()
	cfg.DAPEnabled = true
	cfg.ServerRoot = serverRoot
	cfg.DataDir = t.TempDir()
	cfg.DAPHandshakeTimeoutSeconds = 2
	cfg.DAPWorkspaceCopyTimeoutSeconds = 2
	cfg.DAPWorkspaceCopyMaxBytes = 1 << 20
	cfg.WSPingPeriod = 1
	leases := lifecycle.NewManager()
	handler := &DAPHandler{Config: cfg, Manager: manager, Lifecycle: leases}
	testServer := httptest.NewServer(http.HandlerFunc(handler.HandleWebSocket))
	t.Cleanup(testServer.Close)
	connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(testServer.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.WriteJSON(map[string]any{
		"type": "dap.start", "runtimeId": "python:3.11", "languageId": "python",
		"workspace": map[string]any{"kind": "personal", "folderKey": "project"},
	}); err != nil {
		connection.Close()
		t.Fatal(err)
	}
	var ready map[string]any
	if err := connection.ReadJSON(&ready); err != nil {
		connection.Close()
		t.Fatal(err)
	}
	if ready["type"] != "dap.ready" || ready["virtualRootUri"] != dap.VirtualRootURI {
		connection.Close()
		t.Fatalf("ready message = %#v", ready)
	}
	return connection, process, starter.launches, leases, projectRoot
}

func TestDAPWebSocketReportsAdapterExitAndDiscardsIsolatedArtifacts(t *testing.T) {
	connection, process, launches, leases, originalRoot := newDAPHandlerHarness(t)
	defer connection.Close()
	launch := <-launches
	if launch.Workspace == originalRoot {
		t.Fatal("the real workspace was mounted into the debug adapter")
	}
	if _, err := os.Stat(filepath.Join(launch.Workspace, "main.py")); err != nil {
		t.Fatal("source was not copied into the isolated workspace")
	}
	if _, err := os.Stat(filepath.Join(launch.Workspace, ".git")); !os.IsNotExist(err) {
		t.Fatal("ignored .git directory was copied into the debug workspace")
	}
	if err := os.WriteFile(filepath.Join(launch.Workspace, "generated.bin"), []byte("discard me"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := process.stdoutW.Close(); err != nil {
		t.Fatal(err)
	}
	var adapterError map[string]any
	if err := connection.ReadJSON(&adapterError); err != nil {
		t.Fatal(err)
	}
	if adapterError["type"] != "dap.error" || adapterError["code"] != "adapter_exited" {
		t.Fatalf("adapter exit message = %#v", adapterError)
	}
	details, _ := adapterError["details"].(map[string]any)
	if !strings.Contains(details["reason"].(string), "DAP stream") {
		t.Fatalf("adapter exit details = %#v", details)
	}
	if _, err := os.Stat(filepath.Join(originalRoot, "generated.bin")); !os.IsNotExist(err) {
		t.Fatal("debug artifacts were copied back to the real workspace")
	}
	if _, err := os.Stat(launch.Workspace); !os.IsNotExist(err) {
		t.Fatal("isolated debug workspace was not removed")
	}
	mutation, err := leases.BeginWorkspaceMutation("default", "project")
	if err != nil {
		t.Fatalf("workspace lease was not released: %v", err)
	}
	mutation.Release()
}

func TestDAPWebSocketDoesNotReportExitAfterTerminatedEvent(t *testing.T) {
	connection, process, _, _, _ := newDAPHandlerHarness(t)
	defer connection.Close()
	payload, _ := json.Marshal(map[string]any{"seq": 1, "type": "event", "event": "terminated"})
	if err := testWriteFrame(process.stdoutW, payload); err != nil {
		t.Fatal(err)
	}
	_, received, err := connection.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(received, &event); err != nil || event["event"] != "terminated" {
		t.Fatalf("terminated event = %s, %v", received, err)
	}
	if err := process.stdoutW.Close(); err != nil {
		t.Fatal(err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, next, readErr := connection.ReadMessage()
	if readErr == nil {
		var message map[string]any
		_ = json.Unmarshal(next, &message)
		if message["type"] == "dap.error" {
			t.Fatalf("normal termination was reported as an adapter failure: %#v", message)
		}
	}
}

func TestDAPAuthenticateUsesConfiguredCredentials(t *testing.T) {
	store := auth.NewMemoryUserStore()
	user := &auth.User{ID: "debug-user", Username: "debug-user", APIKey: "dap-secret", Role: auth.RoleMember}
	if err := store.Create(user); err != nil {
		t.Fatal(err)
	}
	handler := &DAPHandler{
		Config: config.Default(), AuthEnabled: true, UserStore: store,
		Authenticator: auth.NewAPIKeyAuth(store),
	}
	authenticated, err := handler.authenticate("Bearer dap-secret")
	if err != nil || authenticated.ID != user.ID {
		t.Fatalf("authenticated user = %#v, %v", authenticated, err)
	}
	if _, err := handler.authenticate("wrong"); err == nil {
		t.Fatal("invalid DAP credential was accepted")
	}
}
