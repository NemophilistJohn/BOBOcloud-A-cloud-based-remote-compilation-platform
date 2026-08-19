package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
)

func newHealthCapabilityTestHandler(t *testing.T) *HTTPHandler {
	t.Helper()
	cfg := config.Default()
	cfg.TLSEnabled = true
	cfg.DAPEnabled = false
	cfg.DataDir = "/private/data-directory"
	cfg.ServerRoot = "/private/workspaces"
	cfg.AdminAPIKey = "private-api-key"
	cfg.DockerRegistryMirrors = []string{"https://private-registry.example"}

	lspManager := lsp.NewManager(lsp.DefaultCatalog(), nil, nil, lsp.ManagerOptions{})
	t.Cleanup(lspManager.Close)
	h := NewHTTPHandler(
		cfg,
		storage.NewMemorySessionStore(),
		session.NewChannelManager(),
		true,
		nil,
		nil,
		func(context.Context, string, string, string) (string, string, int, error) { return "", "", 0, nil },
		nil,
		nil,
	)
	h.Version = "2.4.0-test"
	h.LSP = lspManager
	h.DependencyViews = lsp.NewDefaultDependencyRegistry()
	h.Readiness = func(context.Context) error { return nil }
	return h
}

func readProbeResponse(t *testing.T, recorder *httptest.ResponseRecorder) probeResponse {
	t.Helper()
	var body probeResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode probe response: %v; body=%s", err, recorder.Body.String())
	}
	return body
}

func TestHealthAndReadinessProbesAreUnauthenticated(t *testing.T) {
	h := newHealthCapabilityTestHandler(t)

	health := httptest.NewRecorder()
	h.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("healthz status = %d, body=%s", health.Code, health.Body.String())
	}
	if got := health.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("healthz Cache-Control = %q", got)
	}
	if body := readProbeResponse(t, health); body.Status != "ok" {
		t.Fatalf("healthz body = %+v", body)
	}

	ready := httptest.NewRecorder()
	h.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusOK {
		t.Fatalf("readyz status = %d, body=%s", ready.Code, ready.Body.String())
	}
	if body := readProbeResponse(t, ready); body.Status != "ready" {
		t.Fatalf("readyz body = %+v", body)
	}
}

func TestReadinessProbeFailsClosedWithoutLeakingDependencyDetails(t *testing.T) {
	h := newHealthCapabilityTestHandler(t)
	h.Readiness = func(context.Context) error {
		return errors.New("docker socket at /private/docker.sock is unavailable")
	}

	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if body := readProbeResponse(t, recorder); body.Status != "not_ready" {
		t.Fatalf("readyz body = %+v", body)
	}
	if strings.Contains(recorder.Body.String(), "/private/docker.sock") {
		t.Fatalf("readiness leaked dependency detail: %s", recorder.Body.String())
	}
}

func TestReadinessProbeCachesShortLivedDependencyResult(t *testing.T) {
	h := newHealthCapabilityTestHandler(t)
	checks := 0
	h.Readiness = func(context.Context) error {
		checks++
		return nil
	}

	for range 2 {
		recorder := httptest.NewRecorder()
		h.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("readyz status = %d, body=%s", recorder.Code, recorder.Body.String())
		}
	}
	if checks != 1 {
		t.Fatalf("readiness checks = %d, want 1 cached check", checks)
	}
}

func TestReadinessProbeUsesItsOwnDeadlineInsteadOfCallerCancellation(t *testing.T) {
	h := newHealthCapabilityTestHandler(t)
	h.Readiness = func(ctx context.Context) error {
		if err := ctx.Err(); err != nil {
			t.Fatalf("readiness inherited caller cancellation: %v", err)
		}
		return nil
	}

	requestContext, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "/readyz", nil).WithContext(requestContext)
	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("readyz status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestHealthProbesRequireGET(t *testing.T) {
	h := newHealthCapabilityTestHandler(t)
	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/healthz", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("healthz POST status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Allow"); got != http.MethodGet {
		t.Fatalf("healthz POST Allow = %q", got)
	}
}

func TestServerInfoPreservesLegacyFieldsAndAddsSanitizedCapabilities(t *testing.T) {
	h := newHealthCapabilityTestHandler(t)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"action":"serverInfo"}`))
	h.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("serverInfo status = %d, body=%s", recorder.Code, recorder.Body.String())
	}

	var response struct {
		Success  bool                       `json:"success"`
		AuthMode string                     `json:"authMode"`
		Version  string                     `json:"version"`
		Data     map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode serverInfo response: %v; body=%s", err, recorder.Body.String())
	}
	if !response.Success || response.AuthMode != "multi" || response.Version != "2.4.0-test" {
		t.Fatalf("legacy serverInfo fields changed: %+v", response)
	}
	if _, ok := response.Data["dap"]; !ok {
		t.Fatalf("legacy serverInfo data.dap is missing: %s", recorder.Body.String())
	}

	var capabilities serverCapabilityDescriptor
	if err := json.Unmarshal(response.Data["serverCapabilities"], &capabilities); err != nil {
		t.Fatalf("decode capabilities: %v; payload=%s", err, response.Data["serverCapabilities"])
	}
	if capabilities.SchemaVersion != 1 || capabilities.Protocol.Name != "bobocloud" || capabilities.Protocol.Version != 1 {
		t.Fatalf("unexpected protocol descriptor: %+v", capabilities.Protocol)
	}
	if capabilities.Release.Version != response.Version {
		t.Fatalf("release version = %q, want %q", capabilities.Release.Version, response.Version)
	}
	if capabilities.Transport.HTTP.Scheme != "https" || capabilities.Transport.WebSocket.Scheme != "wss" {
		t.Fatalf("unexpected transport descriptor: %+v", capabilities.Transport)
	}
	if !capabilities.Capabilities.Run || !capabilities.Capabilities.Tasks || !capabilities.Capabilities.Terminal || !capabilities.Capabilities.ProjectEnvironment || !capabilities.Capabilities.LSP.Enabled {
		t.Fatalf("unexpected feature gates: %+v", capabilities.Capabilities)
	}
	if capabilities.Capabilities.DAP.Enabled || capabilities.CatalogRevisions.DAP != "" || capabilities.Limits.DAP.MaxSessions != 0 {
		t.Fatalf("disabled DAP advertised as available: %+v", capabilities)
	}
	if capabilities.CatalogRevisions.LSP != 1 || capabilities.Limits.LSP.MaxSessions != h.Config.LSPMaxSessions || capabilities.Limits.LSP.MaxPerUser != h.Config.LSPMaxSessionsPerUser {
		t.Fatalf("unexpected LSP capabilities: %+v", capabilities)
	}
	if !containsCapabilityLanguage(capabilities.Capabilities.LSP.Languages, "python") {
		t.Fatalf("LSP language catalogue missing python: %v", capabilities.Capabilities.LSP.Languages)
	}

	for _, forbidden := range []string{"/private/data-directory", "/private/workspaces", "private-api-key", "private-registry.example"} {
		if strings.Contains(recorder.Body.String(), forbidden) {
			t.Fatalf("serverInfo leaked %q: %s", forbidden, recorder.Body.String())
		}
	}
}

func containsCapabilityLanguage(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
