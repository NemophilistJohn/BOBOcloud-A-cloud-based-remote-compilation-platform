package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/dap"
	"bobocloud-server/internal/lifecycle"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/personalcache"

	"github.com/gorilla/websocket"
)

type dapStartCleanupTestError struct {
	done <-chan struct{}
}

func (e *dapStartCleanupTestError) Error() string                { return "DAP start cleanup pending" }
func (e *dapStartCleanupTestError) CleanupDone() <-chan struct{} { return e.done }

func TestDAPFailedStartRetainsWholeSessionContextUntilContainerCleanup(t *testing.T) {
	cleanupDone := make(chan struct{})
	var workspaceReleased atomic.Int32
	var cacheReleased atomic.Int32
	released := make(chan struct{})
	release := combineDAPReleases(
		func() { close(released) },
		func() { workspaceReleased.Add(1) },
		func() { cacheReleased.Add(1) },
	)
	err := fmt.Errorf("manager start: %w", &dapStartCleanupTestError{done: cleanupDone})
	releaseDAPSessionAfterStartError(release, err)
	select {
	case <-released:
		t.Fatal("SessionContext was released while failed-start Docker cleanup was pending")
	default:
	}
	if workspaceReleased.Load() != 0 || cacheReleased.Load() != 0 {
		t.Fatalf("partial SessionContext release before cleanup: workspace=%d cache=%d", workspaceReleased.Load(), cacheReleased.Load())
	}
	close(cleanupDone)
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("SessionContext was not released after failed-start Docker cleanup completed")
	}
	if workspaceReleased.Load() != 1 || cacheReleased.Load() != 1 {
		t.Fatalf("SessionContext release counts: workspace=%d cache=%d", workspaceReleased.Load(), cacheReleased.Load())
	}

	var immediate atomic.Int32
	releaseDAPSessionAfterStartError(func() { immediate.Add(1) }, errors.New("validation failed before Docker start"))
	if immediate.Load() != 1 {
		t.Fatal("non-Docker start failure did not release SessionContext immediately")
	}
}

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
	if !strings.HasSuffix(filepath.Clean(launch.DependencyMountRoot), filepath.Join("dap-cache", "mounts")) || strings.Contains(filepath.ToSlash(launch.DependencyMountRoot), "/lsp-cache/") {
		t.Fatalf("DAP dependency projection root is not isolated from LSP: %q", launch.DependencyMountRoot)
	}
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

func writeDAPInventoryPackage(t *testing.T, root, name, version string) {
	t.Helper()
	packageRoot := filepath.Join(root, name)
	distInfo := filepath.Join(root, name+"-"+version+".dist-info")
	if err := os.MkdirAll(packageRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(distInfo, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "__init__.py"), []byte(""), 0600); err != nil {
		t.Fatal(err)
	}
	metadata := "Metadata-Version: 2.1\nName: " + name + "\nVersion: " + version + "\n"
	if err := os.WriteFile(filepath.Join(distInfo, "METADATA"), []byte(metadata), 0600); err != nil {
		t.Fatal(err)
	}
	record := name + "/__init__.py,,\n" + name + "-" + version + ".dist-info/METADATA,,\n" + name + "-" + version + ".dist-info/RECORD,,\n"
	if err := os.WriteFile(filepath.Join(distInfo, "RECORD"), []byte(record), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestDAPAcquiresPythonDependencyCacheWithOrdinaryReadLease(t *testing.T) {
	dataDir := t.TempDir()
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("numpy==2.1.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cache := personalcache.NewManager(dataDir, personalcache.Options{ReservationBytes: 8})
	request := personalcache.Request{
		UserID: "user-a", WorkspaceID: lsp.StableWorkspaceIdentity("user-a", "", "", "", "project"),
		WorkspaceName: "Project", RuntimeID: "python:3.11", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.11", "python:3.11-slim"), Language: "python", WorkspaceRoot: workspace,
	}
	writer, err := cache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeDAPInventoryPackage(t, filepath.Join(writer.HostRoot, "python"), "numpy", "2.1.0")
	writer.Release()
	entries := cache.Inspect(request.UserID, 0).Entries
	if len(entries) != 1 {
		t.Fatalf("cache entries = %+v", entries)
	}
	handler := &DAPHandler{PersonalCache: cache}
	root, env, status, release := handler.acquireDAPDependencyCache(
		request.UserID, request.WorkspaceName, "project", request.RuntimeID, "python:3.11-slim", request.Language, workspace, nil,
	)
	if root == "" || release == nil || status.State != "mounted" || status.InventoryState != "ready" || !status.Required || !status.Exact {
		t.Fatalf("dependency attachment = root %q status %+v release %v", root, status, release != nil)
	}
	if env["PYTHONPATH"] != "/project-deps/python" || env["PIP_TARGET"] != "" {
		t.Fatalf("read-only Python environment = %#v", env)
	}
	if err := cache.Delete(request.UserID, entries[0].Path); err == nil {
		t.Fatal("active DAP read lease did not protect cache CRUD")
	}
	concurrentWriter, err := cache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatalf("ordinary DAP read lease blocked a copy-on-write dependency update: %v", err)
	}
	concurrentWriter.Release()
	release()
	writerAfterDebug, err := cache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatalf("released DAP namespace still blocked a writer: %v", err)
	}
	writerAfterDebug.Release()
	if err := cache.Delete(request.UserID, entries[0].Path); err != nil {
		t.Fatalf("released DAP cache could not be deleted: %v", err)
	}
}

func TestDAPManagedLanguagesUseCopyOnWriteReadLeases(t *testing.T) {
	tests := []struct {
		language, runtimeID, image, manifest string
	}{
		{language: "node", runtimeID: "node:20", image: "node:20", manifest: "package-lock.json"},
		{language: "go", runtimeID: "go:1.24", image: "golang:1.24", manifest: "go.sum"},
		{language: "rust", runtimeID: "rust:1.85", image: "rust:1.85", manifest: "Cargo.lock"},
		{language: "java", runtimeID: "java:21", image: "eclipse-temurin:21", manifest: "pom.xml"},
	}
	for _, test := range tests {
		t.Run(test.language, func(t *testing.T) {
			dataDir := t.TempDir()
			workspace := t.TempDir()
			if err := os.WriteFile(filepath.Join(workspace, test.manifest), []byte("locked dependency\n"), 0600); err != nil {
				t.Fatal(err)
			}
			cache := personalcache.NewManager(dataDir, personalcache.Options{ReservationBytes: 8})
			request := personalcache.Request{
				UserID: "user-a", WorkspaceID: lsp.StableWorkspaceIdentity("user-a", "", "", "", "project"),
				WorkspaceName: "Project", RuntimeID: test.runtimeID,
				RuntimeFingerprint: personalCacheRuntimeFingerprint(test.runtimeID, test.image),
				Language:           test.language, WorkspaceRoot: workspace,
			}
			writer, err := cache.Prepare(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(writer.HostRoot, "installed.marker"), []byte("ready"), 0600); err != nil {
				t.Fatal(err)
			}
			writer.Release()

			handler := &DAPHandler{PersonalCache: cache}
			root, _, status, release := handler.acquireDAPDependencyCache(
				request.UserID, request.WorkspaceName, "project", request.RuntimeID, test.image, request.Language, workspace, nil,
			)
			if root == "" || release == nil || status.State != "mounted" || !status.Required {
				t.Fatalf("dependency attachment = root %q status %+v release %v", root, status, release != nil)
			}
			concurrentWriter, err := cache.Prepare(context.Background(), request)
			if err != nil {
				release()
				t.Fatalf("DAP read lease blocked copy-on-write update: %v", err)
			}
			concurrentWriter.Release()
			release()
		})
	}
}

func TestDAPCAndCPPDependencyCacheIsNotApplicableBeforeFingerprinting(t *testing.T) {
	handler := &DAPHandler{}
	for _, language := range []string{"c", "cpp", "c++"} {
		t.Run(language, func(t *testing.T) {
			root, environment, status, release := handler.acquireDAPDependencyCache(
				"user-a", "Project", "project", "native", "native-image", language,
				filepath.Join(t.TempDir(), "missing-workspace"), []string{"install native dependency"},
			)
			if root != "" || environment != nil || release != nil || status.State != "not_applicable" || status.Required {
				t.Fatalf("native dependency status = root %q env %#v status %+v release %v", root, environment, status, release != nil)
			}
		})
	}
}

func TestDAPMountsExactPythonDigestWhenInventoryIsIncomplete(t *testing.T) {
	dataDir := t.TempDir()
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("numpy==2.1.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cache := personalcache.NewManager(dataDir, personalcache.Options{ReservationBytes: 8})
	request := personalcache.Request{
		UserID: "user-a", WorkspaceID: lsp.StableWorkspaceIdentity("user-a", "", "", "", "project"),
		WorkspaceName: "Project", RuntimeID: "python:3.11", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.11", "python:3.11-slim"), Language: "python", WorkspaceRoot: workspace,
	}
	writer, err := cache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeDAPInventoryPackage(t, filepath.Join(writer.HostRoot, "python"), "numpy", "2.1.0")
	writer.Release()
	if err := os.WriteFile(filepath.Join(writer.HostRoot, ".package-inventory.json"), []byte("{invalid-json"), 0600); err != nil {
		t.Fatal(err)
	}

	handler := &DAPHandler{PersonalCache: cache}
	root, _, status, release := handler.acquireDAPDependencyCache(
		request.UserID, request.WorkspaceName, "project", request.RuntimeID, "python:3.11-slim", request.Language, workspace, nil,
	)
	if root == "" || release == nil || status.State != "mounted" || status.InventoryState != "corrupt" || status.Exact {
		t.Fatalf("inventory truth incorrectly became a mount gate: root=%q status=%+v release=%v", root, status, release != nil)
	}
	release()
}

func TestDAPReadOnlyDependencyEnvironmentCoversNodeRustAndJava(t *testing.T) {
	node := dapReadOnlyDependencyDockerEnvironment("javascript")
	if node["NODE_PATH"] != "/project-deps/node_modules" {
		t.Fatalf("Node dependency environment = %#v", node)
	}
	if _, exists := node["BOBOCLOUD_NODE_MODULES"]; exists {
		t.Fatalf("Node dependency environment retained runner-only fallback = %#v", node)
	}
	rust := dapReadOnlyDependencyDockerEnvironment("rust")
	if rust["CARGO_HOME"] != "/project-deps/cargo" || rust["CARGO_TARGET_DIR"] != "/workspace/target" {
		t.Fatalf("Rust dependency environment = %#v", rust)
	}
	java := dapReadOnlyDependencyDockerEnvironment("java")
	if java["MAVEN_OPTS"] != "-Dmaven.repo.local=/project-deps/maven" || java["GRADLE_USER_HOME"] != "/project-deps/gradle" {
		t.Fatalf("Java dependency environment = %#v", java)
	}
}

func TestDAPDependencyCacheReportsMissingAndBusyBeforeStart(t *testing.T) {
	dataDir := t.TempDir()
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("numpy==2.1.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cache := personalcache.NewManager(dataDir, personalcache.Options{ReservationBytes: 8})
	handler := &DAPHandler{PersonalCache: cache}
	_, _, missing, missingRelease := handler.acquireDAPDependencyCache("user-a", "Project", "project", "python:3.11", "python:3.11-slim", "python", workspace, nil)
	if missing.State != "missing" || !missing.Required || missingRelease != nil {
		t.Fatalf("missing dependency status = %+v release=%v", missing, missingRelease != nil)
	}
	request := personalcache.Request{
		UserID: "user-a", WorkspaceID: lsp.StableWorkspaceIdentity("user-a", "", "", "", "project"),
		WorkspaceName: "Project", RuntimeID: "python:3.11", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.11", "python:3.11-slim"), Language: "python", WorkspaceRoot: workspace,
	}
	writer, err := cache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Release()
	_, _, busy, busyRelease := handler.acquireDAPDependencyCache("user-a", "Project", "project", "python:3.11", "python:3.11-slim", "python", workspace, nil)
	if busy.State != "busy" || !busy.Required || busyRelease != nil {
		t.Fatalf("busy dependency status = %+v release=%v", busy, busyRelease != nil)
	}
}

func TestDAPWebSocketRejectsRequiredCacheBeforeWorkspaceCopyOrAdapterStart(t *testing.T) {
	serverRoot := t.TempDir()
	projectRoot := filepath.Join(serverRoot, "project")
	if err := os.MkdirAll(projectRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectRoot, "requirements.txt"), []byte("numpy==2.1.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(t.TempDir(), "dap_adapters.json")
	manifest := `{"version":"1.0","adapters":[{
		"id":"python-debugpy","label":"Python debugpy","languageId":"python",
		"runtimeId":"python:3.11","image":"bobocloud/dap-python:test",
		"command":["adapter"],"supportsLaunch":true
	}]}`
	if err := os.WriteFile(manifestPath, []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	catalog, err := dap.LoadCatalog(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	starter := &dapHandlerTestStarter{process: newBridgeTestProcess(), launches: make(chan dap.LaunchSpec, 1)}
	manager := dap.NewManager(catalog, starter, dap.ManagerOptions{MaxSessions: 1, MaxPerUser: 1, Inspector: dapHandlerTestInspector{}})
	t.Cleanup(manager.Close)
	cfg := config.Default()
	cfg.DAPEnabled = true
	cfg.ServerRoot = serverRoot
	cfg.DataDir = t.TempDir()
	handler := &DAPHandler{Config: cfg, Manager: manager, PersonalCache: personalcache.NewManager(cfg.DataDir, personalcache.Options{})}
	testServer := httptest.NewServer(http.HandlerFunc(handler.HandleWebSocket))
	t.Cleanup(testServer.Close)
	dial := func() *websocket.Conn {
		connection, _, dialErr := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(testServer.URL, "http"), nil)
		if dialErr != nil {
			t.Fatal(dialErr)
		}
		return connection
	}
	connection := dial()
	if err := connection.WriteJSON(map[string]any{
		"type": "dap.start", "runtimeId": "python:3.11", "languageId": "python",
		"workspace": map[string]any{"kind": "personal", "folderKey": "project"},
	}); err != nil {
		t.Fatal(err)
	}
	var dependencyError map[string]any
	if err := connection.ReadJSON(&dependencyError); err != nil {
		t.Fatal(err)
	}
	connection.Close()
	if dependencyError["type"] != "dap.error" || dependencyError["code"] != "dependency_cache_unavailable" {
		t.Fatalf("dependency cache error = %#v", dependencyError)
	}
	select {
	case launch := <-starter.launches:
		t.Fatalf("adapter started without required dependencies: %+v", launch)
	default:
	}

	invalidConnection := dial()
	if err := invalidConnection.WriteJSON(map[string]any{
		"type": "dap.start", "runtimeId": "python:3.11", "languageId": "python",
		"setupCommands": []string{strings.Repeat("x", 513)},
		"workspace":     map[string]any{"kind": "personal", "folderKey": "project"},
	}); err != nil {
		t.Fatal(err)
	}
	var invalidError map[string]any
	if err := invalidConnection.ReadJSON(&invalidError); err != nil {
		t.Fatal(err)
	}
	invalidConnection.Close()
	if invalidError["type"] != "dap.error" || invalidError["code"] != "invalid_start" {
		t.Fatalf("invalid setup command error = %#v", invalidError)
	}
}
