package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
)

func callProjectCatalogAction(t *testing.T, handler *HTTPHandler, body string) model.Response {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(recorder, request)
	var response model.Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, recorder.Body.String())
	}
	if recorder.Code != http.StatusOK || !response.Success {
		t.Fatalf("request failed: status=%d response=%+v", recorder.Code, response)
	}
	return response
}

func projectNameFromResponse(t *testing.T, response model.Response, folderKey string) string {
	t.Helper()
	if response.StorageInfo == nil {
		t.Fatal("missing storage info")
	}
	for _, project := range response.StorageInfo.Projects {
		if project.Key == folderKey {
			return project.Name
		}
	}
	t.Fatalf("project %q not found in %+v", folderKey, response.StorageInfo.Projects)
	return ""
}

func TestProjectDisplayNameSurvivesWorkspaceMirror(t *testing.T) {
	handler, serverRoot, _ := newProjectEnvironmentTestHandler(t)
	callProjectCatalogAction(t, handler, `{"action":"checkFolder","folderName":"tryjava","folderKey":"pqwvdum"}`)

	workspace := filepath.Join(serverRoot, "pqwvdum")
	if _, err := os.Stat(filepath.Join(workspace, ".boboproject")); !os.IsNotExist(err) {
		t.Fatalf("display metadata must not live in mirrored workspace: %v", err)
	}
	if err := os.RemoveAll(workspace); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "main.py"), []byte("print('ok')\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	response := callProjectCatalogAction(t, handler, `{"action":"listProjects"}`)
	if got := projectNameFromResponse(t, response, "pqwvdum"); got != "tryjava" {
		t.Fatalf("project name = %q, want tryjava", got)
	}
}

func TestProjectDisplayNameMigratesFromLegacyWorkspaceMetadata(t *testing.T) {
	handler, serverRoot, _ := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "legacy-hash")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(workspace, ".boboproject")
	if err := os.WriteFile(legacy, []byte("Natural project"), 0o600); err != nil {
		t.Fatal(err)
	}
	first := callProjectCatalogAction(t, handler, `{"action":"listProjects"}`)
	if got := projectNameFromResponse(t, first, "legacy-hash"); got != "Natural project" {
		t.Fatalf("legacy project name = %q", got)
	}
	if err := os.Remove(legacy); err != nil {
		t.Fatal(err)
	}
	second := callProjectCatalogAction(t, handler, `{"action":"listProjects"}`)
	if got := projectNameFromResponse(t, second, "legacy-hash"); got != "Natural project" {
		t.Fatalf("migrated project name = %q", got)
	}
}

func TestProjectDisplayNameFallsBackToPersonalCacheMetadata(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "pqwvdum")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("numpy==2.2.6\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler.PersonalCache = newPersonalCacheManagerForTest(dataRoot, personalcache.Options{
		ScopeMode:        "project-lock",
		ReservationBytes: 8,
	})
	lease, err := handler.PersonalCache.Prepare(t.Context(), personalcache.Request{
		UserID:             "default",
		WorkspaceID:        lsp.StableWorkspaceIdentity("default", "", "", "", "pqwvdum"),
		WorkspaceName:      "tryjava",
		RuntimeID:          "python:3.10",
		RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.10", "python:3.10-slim"),
		Language:           "python",
		WorkspaceRoot:      workspace,
		QuotaBytes:         1 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	lease.Release()

	response := callProjectCatalogAction(t, handler, `{"action":"listProjects"}`)
	if got := projectNameFromResponse(t, response, "pqwvdum"); got != "tryjava" {
		t.Fatalf("cache-backed project name = %q", got)
	}
}

func TestProjectCatalogPrunesDeletedWorkspaceMetadata(t *testing.T) {
	handler, _, _ := newProjectEnvironmentTestHandler(t)
	if err := handler.writeWorkspaceDisplayName("default", "stale-key", "Stale project"); err != nil {
		t.Fatal(err)
	}
	metadataPath := filepath.Join(handler.workspaceDisplayMetadataDir("default"), workspaceDisplayMetadataFilename("stale-key"))
	callProjectCatalogAction(t, handler, `{"action":"listProjects"}`)
	if _, err := os.Stat(metadataPath); !os.IsNotExist(err) {
		t.Fatalf("stale metadata was not pruned: %v", err)
	}
}
