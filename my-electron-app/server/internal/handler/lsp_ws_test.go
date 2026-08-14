package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/buildcache"
	"bobocloud-server/internal/collab"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/lifecycle"
	"bobocloud-server/internal/lsp"

	"github.com/gorilla/websocket"
)

type bridgeTestProcess struct {
	stdinR  *io.PipeReader
	stdinW  *io.PipeWriter
	stdoutR *io.PipeReader
	stdoutW *io.PipeWriter
	done    chan struct{}
	once    sync.Once
}

func newBridgeTestProcess() *bridgeTestProcess {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	return &bridgeTestProcess{stdinR: stdinR, stdinW: stdinW, stdoutR: stdoutR, stdoutW: stdoutW, done: make(chan struct{})}
}

func (p *bridgeTestProcess) Stdin() io.WriteCloser { return p.stdinW }
func (p *bridgeTestProcess) Stdout() io.ReadCloser { return p.stdoutR }
func (p *bridgeTestProcess) Wait() error           { <-p.done; return nil }
func (p *bridgeTestProcess) Kill() error {
	p.once.Do(func() {
		_ = p.stdinR.Close()
		_ = p.stdinW.Close()
		_ = p.stdoutW.Close()
		close(p.done)
	})
	return nil
}

func testReadFrame(reader *bufio.Reader) ([]byte, error) {
	length := -1
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		if strings.HasPrefix(strings.ToLower(line), "content-length:") {
			length, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(strings.ToLower(line), "content-length:")))
		}
	}
	if length < 0 {
		return nil, fmt.Errorf("missing content length")
	}
	payload := make([]byte, length)
	_, err := io.ReadFull(reader, payload)
	return payload, err
}

func testWriteFrame(writer io.Writer, payload []byte) error {
	_, err := fmt.Fprintf(writer, "Content-Length: %d\r\n\r\n%s", len(payload), payload)
	return err
}

func testFileURI(path string) string {
	value := filepath.ToSlash(path)
	if !strings.HasPrefix(value, "/") {
		value = "/" + value
	}
	return (&url.URL{Scheme: "file", Path: value}).String()
}

type bridgeTestStarter struct {
	launches chan lsp.LaunchSpec
	inbound  chan []byte
}

type bridgeDependencyAdapter struct{}

func (bridgeDependencyAdapter) Name() string        { return "bridge-test" }
func (bridgeDependencyAdapter) Languages() []string { return []string{"go"} }
func (bridgeDependencyAdapter) Resolve(ctx lsp.DependencyAdapterContext) (lsp.DependencyAdapterResult, error) {
	settings := map[string]any{"gopls": map[string]any{"directoryFilters": []string{"-vendor"}}}
	result := lsp.DependencyAdapterResult{LocalLSPSettings: settings, DockerLSPSettings: settings}
	if ctx.Paths.SnapshotRoot != "" {
		result.Mounts = []lsp.DependencyMountSpec{{Role: "test.snapshot", HostPath: ctx.Paths.SnapshotRoot, ContainerPath: lsp.AnalysisDependenciesRoot + "/test-snapshot"}}
	}
	return result, nil
}

type bridgePythonDependencyAdapter struct{}

func (bridgePythonDependencyAdapter) Name() string        { return "bridge-python" }
func (bridgePythonDependencyAdapter) Languages() []string { return []string{"python"} }
func (bridgePythonDependencyAdapter) Resolve(ctx lsp.DependencyAdapterContext) (lsp.DependencyAdapterResult, error) {
	if ctx.Paths.UserPersistRoot == "" {
		return lsp.DependencyAdapterResult{}, nil
	}
	packages := filepath.Join(ctx.Paths.UserPersistRoot, "pip-packages", "runtimes", "python-3.10")
	if info, err := os.Stat(packages); err != nil || !info.IsDir() {
		return lsp.DependencyAdapterResult{}, nil
	}
	return lsp.DependencyAdapterResult{Mounts: []lsp.DependencyMountSpec{{Role: lsp.DependencyRolePythonPackages, HostPath: packages, ContainerPath: lsp.AnalysisDependenciesRoot + "/python/test-site-packages"}}}, nil
}

func (s *bridgeTestStarter) Start(_ context.Context, spec lsp.LaunchSpec) (lsp.Process, error) {
	process := newBridgeTestProcess()
	s.launches <- spec
	analyzerWorkspace := spec.Workspace
	if spec.Docker {
		analyzerWorkspace = lsp.DockerWorkspaceRoot
	}
	go func() {
		reader := bufio.NewReader(process.stdinR)
		for {
			payload, err := testReadFrame(reader)
			if err != nil {
				return
			}
			s.inbound <- payload
			var env struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			_ = json.Unmarshal(payload, &env)
			if env.Method == "initialize" {
				response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(env.ID), "result": map[string]any{"capabilities": map[string]any{}, "location": map[string]any{"uri": testFileURI(filepath.Join(analyzerWorkspace, "main.go"))}}})
				_ = testWriteFrame(process.stdoutW, response)
				serverRequest := []byte(`{"jsonrpc":"2.0","id":77,"method":"workspace/configuration","params":{"items":[]}}`)
				_ = testWriteFrame(process.stdoutW, serverRequest)
			} else if env.Method == "" && string(env.ID) == "77" {
				mixedRequest := []byte(`{"jsonrpc":"2.0","id":80,"method":"workspace/configuration","params":{"items":[{"section":"gopls"},{"section":"formattingOptions"}]}}`)
				_ = testWriteFrame(process.stdoutW, mixedRequest)
			} else if env.Method == "" && string(env.ID) == "80" {
				unknownConfiguration := []byte(`{"jsonrpc":"2.0","id":81,"method":"workspace/configuration","params":{"items":[{"section":"editor"}]}}`)
				_ = testWriteFrame(process.stdoutW, unknownConfiguration)
			} else if env.Method == "" && string(env.ID) == "81" {
				invalidResultRequest := []byte(`{"jsonrpc":"2.0","id":82,"method":"workspace/configuration","params":{"items":[{"section":"gopls"},{"section":"formattingOptions"}]}}`)
				_ = testWriteFrame(process.stdoutW, invalidResultRequest)
			} else if env.Method == "" && string(env.ID) == "82" {
				unknownRequest := []byte(`{"jsonrpc":"2.0","id":78,"method":"workspace/unsupportedRequest","params":{}}`)
				_ = testWriteFrame(process.stdoutW, unknownRequest)
			} else if env.Method == "" && string(env.ID) == "78" {
				inside := testFileURI(filepath.Join(analyzerWorkspace, "main.go"))
				alternate := strings.Replace(inside, "file:///", "file:/", 1)
				badServerRequest, _ := json.Marshal(map[string]any{
					"jsonrpc": "2.0", "id": 79, "method": "workspace/applyEdit",
					"params": map[string]any{"edit": map[string]any{"changes": map[string]any{inside: []any{}, alternate: []any{}}}},
				})
				_ = testWriteFrame(process.stdoutW, badServerRequest)
			} else if env.Method == "textDocument/completion" {
				inside := testFileURI(filepath.Join(analyzerWorkspace, "main.go"))
				alternate := strings.Replace(inside, "file:///", "file:/", 1)
				badResponse, _ := json.Marshal(map[string]any{
					"jsonrpc": "2.0", "id": json.RawMessage(env.ID),
					"result": map[string]any{"changes": map[string]any{inside: []any{}, alternate: []any{}}},
				})
				_ = testWriteFrame(process.stdoutW, badResponse)
			}
		}
	}()
	return process, nil
}

func readWSJSON(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatalf("invalid WS JSON %s: %v", payload, err)
	}
	return value
}

func TestLSPWebSocketHandshakeInitializePolicyAndCacheClear(t *testing.T) {
	serverRoot := t.TempDir()
	workspace := filepath.Join(serverRoot, "project-key")
	if err := os.MkdirAll(workspace, 0755); err != nil {
		t.Fatal(err)
	}
	catalog, err := lsp.NewCatalog(lsp.Manifest{Version: 1, Servers: []lsp.ServerSpec{{LanguageID: "go", Command: []string{"gopls"}, Docker: lsp.DockerSpec{Image: "toolkit:test", Command: []string{"gopls"}}}}})
	if err != nil {
		t.Fatal(err)
	}
	starter := &bridgeTestStarter{launches: make(chan lsp.LaunchSpec, 1), inbound: make(chan []byte, 8)}
	manager := lsp.NewManager(catalog, lsp.NewCacheManager(filepath.Join(t.TempDir(), "lsp-cache"), 16, 7), starter, lsp.ManagerOptions{MaxSessions: 2, MaxPerUser: 2, IdleTTL: time.Minute, MaxMessageBytes: 1 << 20, CleanupInterval: time.Hour})
	defer manager.Close()
	dependencyViews, err := lsp.NewDependencyRegistry(bridgeDependencyAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.ServerRoot = serverRoot
	cfg.DataDir = filepath.Join(t.TempDir(), "data")
	cfg.LSPEnabled = true
	cfg.LSPMaxMessageBytes = 1 << 20
	cfg.LSPBandwidthPerMinuteBytes = 8 << 20
	lifecycleManager := lifecycle.NewManager()
	handler := &WSHandler{Config: cfg, LSP: manager, DependencyViews: dependencyViews, Lifecycle: lifecycleManager}
	mux := http.NewServeMux()
	mux.HandleFunc("/lsp", handler.HandleLSPWebSocket)
	testServer := httptest.NewServer(mux)
	defer testServer.Close()
	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/lsp"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	start := map[string]any{"type": "lsp.start", "token": "", "mode": "standard", "languageId": "go", "runtimeId": "local", "workspace": map[string]any{"kind": "personal", "folderName": "Project", "folderKey": "project-key"}}
	if err := conn.WriteJSON(start); err != nil {
		t.Fatal(err)
	}
	ready := readWSJSON(t, conn)
	if ready["type"] != "lsp.ready" || ready["sessionId"] == "" {
		t.Fatalf("unexpected gateway ready: %+v", ready)
	}
	launch := <-starter.launches
	if filepath.Clean(launch.Workspace) != filepath.Clean(workspace) {
		t.Fatalf("personal folderKey was not resolved through the user workspace root: %s", launch.Workspace)
	}
	inspection, err := lsp.InspectPersonalDependencies(cfg.DataDir, "default")
	if err != nil || !inspection.Exists || !launch.DependencyView.UsesHostRoot(inspection.Root) {
		t.Fatalf("personal snapshot root was not resolved through the dependency view: inspection=%+v view=%+v err=%v", inspection, launch.DependencyView, err)
	}
	if err := lsp.ClearPersonalDependencies(cfg.DataDir, "default"); !errors.Is(err, lsp.ErrPersonalDependencyStoreInUse) {
		t.Fatalf("active personal LSP did not retain its dependency store: %v", err)
	}
	if _, err := lifecycleManager.BeginWorkspaceMutation("default", "project-key"); !errors.Is(err, lifecycle.ErrResourcesInUse) {
		t.Fatalf("active personal LSP did not retain its workspace activity: %v", err)
	}

	invalidInitialize := []byte(`{"jsonrpc":"2.0","id":99,"method":"initialize","params":{"rootUri":"file:///outside"}}`)
	if err := conn.WriteMessage(websocket.TextMessage, invalidInitialize); err != nil {
		t.Fatal(err)
	}
	invalidInitializeResponse := readWSJSON(t, conn)
	if invalidInitializeResponse["error"] == nil {
		t.Fatalf("absolute initialize URI was accepted: %+v", invalidInitializeResponse)
	}

	initialize := []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":"bobocloud-lsp:///","workspaceFolders":[]}}`)
	if err := conn.WriteMessage(websocket.TextMessage, initialize); err != nil {
		t.Fatal(err)
	}
	forwarded := <-starter.inbound
	if !strings.Contains(string(forwarded), "file:") || strings.Contains(string(forwarded), "bobocloud-lsp:") || !strings.Contains(string(forwarded), "/workspace") {
		t.Fatalf("initialize was not rewritten to the authorized remote root: %s", forwarded)
	}
	initializeResponse := readWSJSON(t, conn)
	result := initializeResponse["result"].(map[string]any)
	location := result["location"].(map[string]any)
	if location["uri"] != "bobocloud-lsp:///main.go" {
		t.Fatalf("server file URI was not virtualized: %+v", initializeResponse)
	}
	select {
	case response := <-starter.inbound:
		var configuration map[string]any
		if err := json.Unmarshal(response, &configuration); err != nil {
			t.Fatal(err)
		}
		if configuration["id"] != float64(77) {
			t.Fatalf("workspace configuration was not answered by the gateway: %s", response)
		}
		if result, ok := configuration["result"].([]any); !ok || len(result) != 0 {
			t.Fatalf("unexpected empty workspace configuration response: %s", response)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("workspace configuration was not answered by the gateway")
	}

	mixedConfiguration := readWSJSON(t, conn)
	if mixedConfiguration["id"] != float64(80) || mixedConfiguration["method"] != "workspace/configuration" {
		t.Fatalf("mixed configuration request was not forwarded to the client: %+v", mixedConfiguration)
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"jsonrpc":"2.0","id":80,"result":[{"directoryFilters":["-user","-vendor"],"userSetting":true},{"tabSize":2,"insertSpaces":true}]}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case response := <-starter.inbound:
		var merged struct {
			ID     int              `json:"id"`
			Result []map[string]any `json:"result"`
		}
		if err := json.Unmarshal(response, &merged); err != nil {
			t.Fatal(err)
		}
		if merged.ID != 80 || len(merged.Result) != 2 {
			t.Fatalf("mixed configuration response was not forwarded to the analyzer: %s", response)
		}
		if !reflect.DeepEqual(merged.Result[0]["directoryFilters"], []any{"-user", "-vendor"}) || merged.Result[0]["userSetting"] != true {
			t.Fatalf("same-section user configuration was not preserved and merged: %s", response)
		}
		if !reflect.DeepEqual(merged.Result[1], map[string]any{"tabSize": float64(2), "insertSpaces": true}) {
			t.Fatalf("unknown formatting options changed: %s", response)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("mixed configuration response did not reach the analyzer")
	}

	unknownConfiguration := readWSJSON(t, conn)
	if unknownConfiguration["id"] != float64(81) || unknownConfiguration["method"] != "workspace/configuration" {
		t.Fatalf("unknown configuration request was not forwarded to the client: %+v", unknownConfiguration)
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"jsonrpc":"2.0","id":81,"result":[{"fontSize":14}]}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case response := <-starter.inbound:
		if !strings.Contains(string(response), `"id":81`) || !strings.Contains(string(response), "fontSize") {
			t.Fatalf("unknown configuration response was not forwarded to the analyzer: %s", response)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("unknown configuration response did not reach the analyzer")
	}

	invalidResultConfiguration := readWSJSON(t, conn)
	if invalidResultConfiguration["id"] != float64(82) || invalidResultConfiguration["method"] != "workspace/configuration" {
		t.Fatalf("invalid-result configuration request was not forwarded to the client: %+v", invalidResultConfiguration)
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"jsonrpc":"2.0","id":82,"result":{}}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case response := <-starter.inbound:
		var fallback struct {
			ID     int   `json:"id"`
			Result []any `json:"result"`
		}
		if err := json.Unmarshal(response, &fallback); err != nil {
			t.Fatal(err)
		}
		if fallback.ID != 82 || len(fallback.Result) != 2 || fallback.Result[1] != nil {
			t.Fatalf("invalid configuration result did not use a safe fallback: %s", response)
		}
		owned, _ := fallback.Result[0].(map[string]any)
		if !reflect.DeepEqual(owned["directoryFilters"], []any{"-vendor"}) {
			t.Fatalf("dependency configuration was lost in fallback: %s", response)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("invalid configuration result did not resolve the analyzer request")
	}

	select {
	case response := <-starter.inbound:
		var rejected map[string]any
		if err := json.Unmarshal(response, &rejected); err != nil {
			t.Fatal(err)
		}
		errorValue, _ := rejected["error"].(map[string]any)
		if rejected["id"] != float64(78) || errorValue["code"] != float64(-32601) {
			t.Fatalf("unsupported server request did not receive method-not-found: %s", response)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("unsupported server request did not receive an error response")
	}
	select {
	case response := <-starter.inbound:
		var rejected map[string]any
		if err := json.Unmarshal(response, &rejected); err != nil {
			t.Fatal(err)
		}
		errorValue, _ := rejected["error"].(map[string]any)
		if rejected["id"] != float64(79) || errorValue["code"] != float64(-32603) {
			t.Fatalf("unsafe server request rewrite did not receive an error: %s", response)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("unsafe server request rewrite did not receive an error response")
	}

	_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"jsonrpc":"2.0","id":3,"method":"textDocument/completion","params":{"textDocument":{"uri":"bobocloud-lsp:///main.go"},"position":{"line":0,"character":0}}}`))
	unsafeResponse := readWSJSON(t, conn)
	unsafeError, _ := unsafeResponse["error"].(map[string]any)
	if unsafeResponse["id"] != float64(3) || unsafeError["code"] != float64(-32603) {
		t.Fatalf("unsafe analyzer response left the client pending: %+v", unsafeResponse)
	}

	_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"jsonrpc":"2.0","id":2,"method":"workspace/symbol","params":{"query":"x"}}`))
	policyError := readWSJSON(t, conn)
	if policyError["error"] == nil {
		t.Fatalf("standard mode accepted workspace/symbol: %+v", policyError)
	}
	_ = conn.WriteJSON(map[string]any{"type": "lsp.cache.clear", "scope": "all"})
	rejectedCacheClear := readWSJSON(t, conn)
	if rejectedCacheClear["type"] != "lsp.cache" || rejectedCacheClear["success"] != false {
		t.Fatalf("WebSocket session could clear a wider cache scope: %+v", rejectedCacheClear)
	}
	_ = conn.WriteJSON(map[string]any{"type": "lsp.cache.clear"})
	cacheResult := readWSJSON(t, conn)
	if cacheResult["type"] != "lsp.cache" || cacheResult["success"] != true {
		t.Fatalf("active namespace clear did not stop/release the analyzer: %+v", cacheResult)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, closeErr := conn.ReadMessage()
	var websocketClose *websocket.CloseError
	if !errors.As(closeErr, &websocketClose) || websocketClose.Code != websocket.CloseNormalClosure {
		t.Fatalf("cache clear did not end with a normal WebSocket close: %v", closeErr)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		clearErr := lsp.ClearPersonalDependencies(cfg.DataDir, "default")
		if clearErr == nil {
			break
		}
		if !errors.Is(clearErr, lsp.ErrPersonalDependencyStoreInUse) || time.Now().After(deadline) {
			t.Fatalf("personal dependency store was not released with the session: %v", clearErr)
		}
		time.Sleep(10 * time.Millisecond)
	}
	mutation, err := lifecycleManager.BeginWorkspaceMutation("default", "project-key")
	if err != nil {
		t.Fatalf("workspace activity was not released with the LSP process: %v", err)
	}
	mutation.Release()
}

func TestLSPWebSocketDependencyAPIIndexControl(t *testing.T) {
	serverRoot := t.TempDir()
	workspace := filepath.Join(serverRoot, "project-key")
	if err := os.MkdirAll(workspace, 0755); err != nil {
		t.Fatal(err)
	}
	catalog, err := lsp.NewCatalog(lsp.Manifest{Version: 1, Servers: []lsp.ServerSpec{{LanguageID: "python", Command: []string{"pyright-langserver"}, Docker: lsp.DockerSpec{Image: "toolkit:test", Command: []string{"pyright-langserver"}}}}})
	if err != nil {
		t.Fatal(err)
	}
	starter := &bridgeTestStarter{launches: make(chan lsp.LaunchSpec, 1), inbound: make(chan []byte, 8)}
	manager := lsp.NewManager(catalog, lsp.NewCacheManager(filepath.Join(t.TempDir(), "lsp-cache"), 16, 7), starter, lsp.ManagerOptions{MaxSessions: 2, MaxPerUser: 2, IdleTTL: time.Minute, MaxMessageBytes: 1 << 20, CleanupInterval: time.Hour})
	defer manager.Close()
	dependencyViews, err := lsp.NewDependencyRegistry(bridgePythonDependencyAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.ServerRoot = serverRoot
	cfg.DataDir = filepath.Join(t.TempDir(), "data")
	cfg.LSPEnabled = true
	cfg.LSPMaxMessageBytes = 1 << 20
	cfg.LSPBandwidthPerMinuteBytes = 8 << 20
	packages := filepath.Join(cfg.DataDir, "users", "default", "persist", "pip-packages", "runtimes", "python-3.10", "numpy")
	if err := os.MkdirAll(packages, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packages, "__init__.py"), []byte("def array(): pass\nclass Matrix: pass\n"), 0600); err != nil {
		t.Fatal(err)
	}
	handler := &WSHandler{Config: cfg, LSP: manager, DependencyViews: dependencyViews, Lifecycle: lifecycle.NewManager()}
	mux := http.NewServeMux()
	mux.HandleFunc("/lsp", handler.HandleLSPWebSocket)
	testServer := httptest.NewServer(mux)
	defer testServer.Close()
	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/lsp"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.WriteJSON(map[string]any{"type": "lsp.start", "mode": "standard", "languageId": "python", "runtimeId": "python:3.10", "workspace": map[string]any{"kind": "personal", "folderName": "Project", "folderKey": "project-key"}}); err != nil {
		t.Fatal(err)
	}
	ready := readWSJSON(t, conn)
	capabilities, _ := ready["capabilities"].(map[string]any)
	indexCapability, _ := capabilities["dependencyApiIndex"].(map[string]any)
	if ready["type"] != "lsp.ready" || indexCapability["enabled"] != true || indexCapability["schema"] != lsp.DependencyAPIIndexSchema {
		t.Fatalf("dependency index was not advertised: %+v", ready)
	}
	if indexCapability["maxPages"] != float64(lsp.DependencyAPIIndexMaxPages) || indexCapability["maxIndexBytes"] != float64(5<<20) || indexCapability["recommendedPageBytes"] != float64(lsp.DependencyAPIIndexPageDefaultBytes) {
		t.Fatalf("dependency index transfer capability was incomplete: %+v", indexCapability)
	}
	if err := conn.WriteJSON(map[string]any{"type": "lsp.dependency.index.request", "requestId": "index_01", "maxBytes": lsp.DependencyAPIIndexPageMinBytes}); err != nil {
		t.Fatal(err)
	}
	response := readWSJSON(t, conn)
	if response["type"] != "lsp.dependency.index" || response["requestId"] != "index_01" || response["success"] != true {
		t.Fatalf("unexpected dependency index response: %+v", response)
	}
	page, _ := response["page"].(map[string]any)
	entries, _ := page["entries"].([]any)
	if page["schema"] != lsp.DependencyAPIIndexSchema || len(entries) == 0 || strings.Contains(fmt.Sprint(response), filepath.ToSlash(packages)) {
		t.Fatalf("unsafe or incomplete dependency index page: %+v", response)
	}
	if err := conn.WriteJSON(map[string]any{"type": "lsp.dependency.index.request", "requestId": "bad request", "maxBytes": lsp.DependencyAPIIndexPageMinBytes}); err != nil {
		t.Fatal(err)
	}
	invalid := readWSJSON(t, conn)
	if invalid["success"] != false || invalid["code"] != "invalid_request" {
		t.Fatalf("invalid index request was accepted: %+v", invalid)
	}
	longID := strings.Repeat("x", 4096)
	if err := conn.WriteJSON(map[string]any{"type": "lsp.dependency.index.request", "requestId": longID, "maxBytes": lsp.DependencyAPIIndexPageMinBytes}); err != nil {
		t.Fatal(err)
	}
	invalid = readWSJSON(t, conn)
	if invalid["success"] != false || invalid["code"] != "invalid_request" || invalid["requestId"] != "" {
		t.Fatalf("invalid request id was echoed: %+v", invalid)
	}
	_ = conn.WriteJSON(map[string]any{"type": "lsp.stop"})
}

func TestDependencyIndexRequestGateBoundsCachedRequestFlood(t *testing.T) {
	gate := newDependencyIndexRequestGate()
	if gate.maxPerMin != lsp.DependencyAPIIndexMaxPages {
		t.Fatalf("request gate max %d does not match published page cap %d", gate.maxPerMin, lsp.DependencyAPIIndexMaxPages)
	}
	for index := 0; index < gate.maxActive; index++ {
		if accepted, _ := gate.acquire(); !accepted {
			t.Fatal("request gate rejected available slot")
		}
	}
	if accepted, retryAfterMS := gate.acquire(); accepted || retryAfterMS <= 0 {
		t.Fatalf("request gate did not bound concurrent cache hits: accepted=%t retry=%d", accepted, retryAfterMS)
	}
	gate.release()
	if accepted, _ := gate.acquire(); !accepted {
		t.Fatal("request gate did not restore a released slot")
	}
	for index := 0; index < gate.maxActive; index++ {
		gate.release()
	}
	remaining := gate.maxPerMin - gate.used
	for index := 0; index < remaining; index++ {
		if accepted, _ := gate.acquire(); !accepted {
			t.Fatal("request gate rejected remaining minute quota")
		}
		gate.release()
	}
	if accepted, retryAfterMS := gate.acquire(); accepted || retryAfterMS <= 0 {
		t.Fatalf("request gate did not enforce minute quota: accepted=%t retry=%d", accepted, retryAfterMS)
	}
}

func TestPendingWorkspaceConfigurationsAreBoundedAndMatchConcurrentIDs(t *testing.T) {
	settings := map[string]any{
		"python": map[string]any{"analysis": map[string]any{"extraPaths": []string{"/analysis-deps/python"}}},
	}
	newProxy := func(id int) (*lsp.WorkspaceConfigurationProxy, error) {
		request := []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"workspace/configuration","params":{"items":[{"section":"python.analysis"}]}}`, id))
		return lsp.NewWorkspaceConfigurationProxy(request, settings)
	}

	pending := newPendingWorkspaceConfigurations()
	const concurrent = 32
	proxies := make([]*lsp.WorkspaceConfigurationProxy, concurrent)
	for index := range proxies {
		proxy, err := newProxy(index)
		if err != nil {
			t.Fatal(err)
		}
		proxies[index] = proxy
	}
	errorsOut := make(chan error, concurrent)
	var workers sync.WaitGroup
	for _, proxy := range proxies {
		proxy := proxy
		workers.Add(1)
		go func() {
			defer workers.Done()
			errorsOut <- pending.add(proxy, nil)
		}()
	}
	workers.Wait()
	for index := 0; index < concurrent; index++ {
		if err := <-errorsOut; err != nil {
			t.Fatalf("concurrent add: %v", err)
		}
	}
	if pending.count() != concurrent {
		t.Fatalf("pending count = %d", pending.count())
	}

	for index := concurrent - 1; index >= 0; index-- {
		index := index
		workers.Add(1)
		go func() {
			defer workers.Done()
			response := []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":[{"request":%d,"extraPaths":["/workspace/%d"]}]}`, index, index, index))
			proxy, found, err := pending.take(response)
			if err != nil || !found {
				errorsOut <- fmt.Errorf("take id %d: found=%t err=%v", index, found, err)
				return
			}
			merged, err := proxy.MergeResponse(response)
			if err != nil {
				errorsOut <- err
				return
			}
			var decoded struct {
				Result []map[string]any `json:"result"`
			}
			if err := json.Unmarshal(merged, &decoded); err != nil || len(decoded.Result) != 1 || decoded.Result[0]["request"] != float64(index) {
				errorsOut <- fmt.Errorf("merge id %d: %s, err=%v", index, merged, err)
				return
			}
			errorsOut <- nil
		}()
	}
	workers.Wait()
	for index := 0; index < concurrent; index++ {
		if err := <-errorsOut; err != nil {
			t.Fatal(err)
		}
	}
	if pending.count() != 0 {
		t.Fatalf("consumed pending count = %d", pending.count())
	}
	repeated := []byte(`{"jsonrpc":"2.0","id":0,"result":[{}]}`)
	if _, found, err := pending.take(repeated); err != nil || found {
		t.Fatalf("repeated response was not safely ignored: found=%t err=%v", found, err)
	}

	for index := 0; index < maxPendingWorkspaceConfigurations; index++ {
		proxy, err := newProxy(index + 1000)
		if err != nil {
			t.Fatalf("create pending index %d: %v", index, err)
		}
		if err := pending.add(proxy, nil); err != nil {
			t.Fatalf("fill pending index %d: %v", index, err)
		}
	}
	overflow, err := newProxy(9999)
	if err != nil {
		t.Fatal(err)
	}
	if err := pending.add(overflow, nil); err == nil {
		t.Fatal("pending configuration limit was not enforced")
	}
	pending.clear()
	if pending.count() != 0 {
		t.Fatal("pending configuration state was not cleared")
	}
}

func TestPendingWorkspaceConfigurationTimeoutFallsBackAndClears(t *testing.T) {
	request := []byte(`{"jsonrpc":"2.0","id":901,"method":"workspace/configuration","params":{"items":[{"section":"python.analysis"},{"section":"formattingOptions"}]}}`)
	proxy, err := lsp.NewWorkspaceConfigurationProxy(request, map[string]any{
		"python": map[string]any{"analysis": map[string]any{"extraPaths": []string{"/analysis-deps/python"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	pending := newPendingWorkspaceConfigurationsWithTimeout(10 * time.Millisecond)
	expired := make(chan []byte, 1)
	if err := pending.add(proxy, func(expiredProxy *lsp.WorkspaceConfigurationProxy) {
		response, _ := expiredProxy.FallbackResponse()
		expired <- response
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case response := <-expired:
		var decoded struct {
			Result []any `json:"result"`
		}
		if err := json.Unmarshal(response, &decoded); err != nil {
			t.Fatal(err)
		}
		if len(decoded.Result) != 2 || decoded.Result[1] != nil {
			t.Fatalf("timeout fallback = %s", response)
		}
	case <-time.After(time.Second):
		t.Fatal("pending configuration did not expire")
	}
	if pending.count() != 0 {
		t.Fatalf("expired pending count = %d", pending.count())
	}
	pending.clear()

	cancelled := newPendingWorkspaceConfigurationsWithTimeout(time.Hour)
	fired := make(chan struct{}, 1)
	if err := cancelled.add(proxy, func(*lsp.WorkspaceConfigurationProxy) { fired <- struct{}{} }); err != nil {
		t.Fatal(err)
	}
	cancelled.clear()
	select {
	case <-fired:
		t.Fatal("cleared pending configuration callback still fired")
	case <-time.After(20 * time.Millisecond):
	}
	if err := cancelled.add(proxy, nil); !errors.Is(err, errPendingWorkspaceConfigurationClosed) {
		t.Fatalf("closed pending queue accepted a request: %v", err)
	}
}

func TestRequestedLSPWorkspaceActivityKey(t *testing.T) {
	tests := []struct {
		name    string
		request lspWorkspaceStart
		want    string
		wantErr bool
	}{
		{name: "folder key wins", request: lspWorkspaceStart{Kind: "personal", FolderKey: " project-key ", FolderName: "Project"}, want: "project-key"},
		{name: "folder name fallback", request: lspWorkspaceStart{Kind: "personal", FolderName: " Project "}, want: "Project"},
		{name: "team is user wide", request: lspWorkspaceStart{Kind: "team", TeamID: "team-a", ProjectID: "project-a"}, want: ""},
		{name: "missing personal key", request: lspWorkspaceStart{Kind: "personal"}, wantErr: true},
		{name: "unknown kind", request: lspWorkspaceStart{Kind: "other"}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := requestedLSPWorkspaceActivityKey(test.request)
			if (err != nil) != test.wantErr {
				t.Fatalf("requestedLSPWorkspaceActivityKey() error = %v, wantErr %v", err, test.wantErr)
			}
			if got != test.want {
				t.Fatalf("requestedLSPWorkspaceActivityKey() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestLSPActivityIsAcquiredBeforeWorkspaceResolution(t *testing.T) {
	cfg := config.Default()
	cfg.ServerRoot = t.TempDir()
	cfg.LSPEnabled = true
	lifecycleManager := lifecycle.NewManager()
	handler := &WSHandler{Config: cfg, LSP: &lsp.Manager{}, Lifecycle: lifecycleManager}
	mux := http.NewServeMux()
	mux.HandleFunc("/lsp", handler.HandleLSPWebSocket)
	testServer := httptest.NewServer(mux)
	defer testServer.Close()
	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/lsp"

	assertRejected := func(t *testing.T, workspace map[string]any) {
		t.Helper()
		conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		start := map[string]any{"type": "lsp.start", "mode": "standard", "languageId": "go", "runtimeId": "local", "workspace": workspace}
		if err := conn.WriteJSON(start); err != nil {
			t.Fatal(err)
		}
		response := readWSJSON(t, conn)
		if response["type"] != "lsp.error" || response["code"] != "resources_in_use" {
			t.Fatalf("workspace was resolved before its activity lease was acquired: %+v", response)
		}
	}

	workspaceMutation, err := lifecycleManager.BeginWorkspaceMutation("default", "missing-personal")
	if err != nil {
		t.Fatal(err)
	}
	assertRejected(t, map[string]any{"kind": "personal", "folderName": "missing-personal"})
	workspaceMutation.Release()

	userMutation, err := lifecycleManager.BeginUserMutation("default")
	if err != nil {
		t.Fatal(err)
	}
	assertRejected(t, map[string]any{"kind": "team", "teamId": "missing-team", "projectId": "missing-project"})
	userMutation.Release()
}

func TestRevalidateLSPWorkspace(t *testing.T) {
	root := t.TempDir()
	handler := &WSHandler{}
	if err := handler.revalidateLSPWorkspace(root, "", ""); err != nil {
		t.Fatalf("existing personal workspace rejected: %v", err)
	}
	missing := filepath.Join(root, "missing")
	if err := handler.revalidateLSPWorkspace(missing, "", ""); err == nil {
		t.Fatal("missing personal workspace accepted")
	}
	target := t.TempDir()
	symlink := filepath.Join(root, "workspace-link")
	if err := os.Symlink(target, symlink); err == nil {
		if err := handler.revalidateLSPWorkspace(symlink, "", ""); err == nil {
			t.Fatal("symlink workspace accepted by Lstat revalidation")
		}
	}

	store := collab.NewMemoryStore()
	if err := store.SaveProject(&collab.Project{ID: "project-a", TeamID: "team-a"}); err != nil {
		t.Fatal(err)
	}
	teamHandler := &WSHandler{Collaboration: collab.NewManager(store, nil, t.TempDir())}
	teamRoot := t.TempDir()
	if err := teamHandler.revalidateLSPWorkspace(teamRoot, "team-a", "project-a"); err != nil {
		t.Fatalf("matching team project rejected: %v", err)
	}
	if err := teamHandler.revalidateLSPWorkspace(teamRoot, "team-b", "project-a"); err == nil {
		t.Fatal("team/project ownership mismatch accepted")
	}
}

func TestAcquireLSPActivityRejectsMutationsAndScopesTeamsUserWide(t *testing.T) {
	manager := lifecycle.NewManager()
	handler := &WSHandler{Lifecycle: manager}

	workspaceMutation, err := manager.BeginWorkspaceMutation("user-a", "folder-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handler.acquireLSPActivity("user-a", "folder-a"); !errors.Is(err, lifecycle.ErrResourcesInUse) {
		t.Fatalf("personal LSP entered a mutating workspace: %v", err)
	}
	workspaceMutation.Release()

	userMutation, err := manager.BeginUserMutation("user-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handler.acquireLSPActivity("user-a", ""); !errors.Is(err, lifecycle.ErrResourcesInUse) {
		t.Fatalf("team LSP entered a user mutation: %v", err)
	}
	userMutation.Release()

	release, err := handler.acquireLSPActivity("user-a", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.BeginUserMutation("user-a"); !errors.Is(err, lifecycle.ErrResourcesInUse) {
		t.Fatalf("team LSP activity was not user-wide: %v", err)
	}
	release()
}

func TestAcquireLSPProjectActivityBlocksDeletionUntilReleased(t *testing.T) {
	store := collab.NewMemoryStore()
	for _, save := range []func() error{
		func() error { return store.SaveTeam(&collab.Team{ID: "team-a", AdminUserID: "user-a"}) },
		func() error { return store.SaveMember(&collab.Member{TeamID: "team-a", UserID: "user-a"}) },
		func() error { return store.SaveProject(&collab.Project{ID: "project-a", TeamID: "team-a"}) },
	} {
		if err := save(); err != nil {
			t.Fatal(err)
		}
	}
	manager := collab.NewManager(store, nil, t.TempDir())
	handler := &WSHandler{Collaboration: manager}
	release, err := handler.acquireLSPProjectActivity("user-a", "team-a", "project-a")
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.DeleteProjectTransaction("user-a", "team-a", "project-a", nil); err == nil || !strings.Contains(err.Error(), "resources are currently in use") {
		t.Fatalf("active team LSP did not block project deletion: %v", err)
	}
	release()
	release()
	if err := manager.DeleteProjectTransaction("user-a", "team-a", "project-a", nil); err != nil {
		t.Fatalf("project activity was not released idempotently: %v", err)
	}
}

func TestCombineLSPResourceReleasesIsOrderedAndIdempotent(t *testing.T) {
	var order []string
	release := combineLSPResourceReleases(
		func() { order = append(order, "store") },
		func() { order = append(order, "activity") },
	)
	release()
	release()
	if strings.Join(order, ",") != "store,activity" {
		t.Fatalf("combined release order = %v", order)
	}
}

func TestRetainResolvedTeamDependenciesReleasesUnusedRoots(t *testing.T) {
	buildContext := buildcache.BuildContext{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "local", Language: "go"}

	t.Run("project dependencies only", func(t *testing.T) {
		manager := buildcache.NewManager(t.TempDir(), 64)
		lease, err := manager.SharedDependencies(buildContext)
		if err != nil {
			t.Fatal(err)
		}
		mounted := filepath.Join(lease.DependencyHost, "snapshot")
		if err := os.MkdirAll(mounted, 0700); err != nil {
			t.Fatal(err)
		}
		retained := retainResolvedTeamDependencies(lease, lsp.AnalysisDependencyView{Mounts: []lsp.AnalysisDependencyMount{{HostPath: mounted}}}, "")
		if retained == nil {
			t.Fatal("used project dependency lease was released")
		}
		if err := manager.Clear(buildContext.TeamID, "shared", "", ""); err != nil {
			t.Fatalf("unused shared cache remained leased: %v", err)
		}
		if err := manager.Clear(buildContext.TeamID, "project", buildContext.ProjectID, ""); err == nil {
			t.Fatal("used project dependencies were not retained")
		}
		retained.Release()
		if err := manager.Clear(buildContext.TeamID, "project", buildContext.ProjectID, ""); err != nil {
			t.Fatalf("project dependencies remained leased after release: %v", err)
		}
	})

	t.Run("shared dependencies only", func(t *testing.T) {
		manager := buildcache.NewManager(t.TempDir(), 64)
		lease, err := manager.SharedDependencies(buildContext)
		if err != nil {
			t.Fatal(err)
		}
		mounted := filepath.Join(lease.SharedHost, "go", "pkg", "mod")
		if err := os.MkdirAll(mounted, 0755); err != nil {
			t.Fatal(err)
		}
		retained := retainResolvedTeamDependencies(lease, lsp.AnalysisDependencyView{Mounts: []lsp.AnalysisDependencyMount{{HostPath: mounted}}}, "")
		if retained == nil {
			t.Fatal("used shared dependency lease was released")
		}
		if err := manager.Clear(buildContext.TeamID, "project", buildContext.ProjectID, ""); err != nil {
			t.Fatalf("unused project dependencies remained leased: %v", err)
		}
		if err := manager.Clear(buildContext.TeamID, "shared", "", ""); err == nil {
			t.Fatal("used shared cache was not retained")
		}
		retained.Release()
		if err := manager.Clear(buildContext.TeamID, "shared", "", ""); err != nil {
			t.Fatalf("shared cache remained leased after release: %v", err)
		}
	})

	t.Run("generation root without dependency mount", func(t *testing.T) {
		manager := buildcache.NewManager(t.TempDir(), 64)
		lease, err := manager.SharedDependencies(buildContext)
		if err != nil {
			t.Fatal(err)
		}
		retained := retainResolvedTeamDependencies(lease, lsp.AnalysisDependencyView{}, lease.DependencyHost)
		if retained == nil {
			t.Fatal("generation dependency root lease was released")
		}
		if err := manager.Clear(buildContext.TeamID, "project", buildContext.ProjectID, ""); err == nil {
			t.Fatal("active generation dependency root was cleared")
		}
		if err := manager.Clear(buildContext.TeamID, "shared", "", ""); err != nil {
			t.Fatalf("unused shared cache remained pinned: %v", err)
		}
		retained.Release()
		if err := manager.Clear(buildContext.TeamID, "project", buildContext.ProjectID, ""); err != nil {
			t.Fatalf("released generation dependency root was not clearable: %v", err)
		}
	})
}
