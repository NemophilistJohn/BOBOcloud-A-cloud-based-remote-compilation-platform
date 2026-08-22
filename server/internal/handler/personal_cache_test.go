package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
)

func cacheModules(response model.Response) []model.CacheModule {
	modules := make([]model.CacheModule, 0)
	for _, group := range response.CacheGroups {
		modules = append(modules, group.Modules...)
	}
	return modules
}

func TestProjectDependencyCacheCRUDAndProjectCleanup(t *testing.T) {
	handler, _, user := newAuthenticatedLifecycleHandler(t)
	handler.PersonalCache = personalcache.NewManager(handler.Config.DataDir, personalcache.Options{ReservationBytes: 8})
	cleared := 0
	handler.OnPersonalCacheCleared = func() { cleared++ }
	workspace := filepath.Join(handler.Config.DataDir, "users", user.ID, "workspaces", "project")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("demo==1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	request := personalcache.Request{
		UserID: user.ID, WorkspaceID: lsp.StableWorkspaceIdentity(user.ID, "", "", "", "project"), WorkspaceName: "Project",
		RuntimeID: "python:3.11", Language: "python", WorkspaceRoot: workspace,
	}
	lease, err := handler.PersonalCache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}

	recorder := serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"deleteCacheModule","cachePath":"`+lease.RelativePath+`"}`)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("active cache delete status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"listCacheModules"}`)
	var activeList model.Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &activeList); err != nil {
		t.Fatal(err)
	}
	activeModules := cacheModules(activeList)
	if len(activeModules) != 1 || !activeModules[0].Active || !activeModules[0].Writing {
		t.Fatalf("active writer state not exposed: %+v", activeModules)
	}
	lease.Release()
	reader, _, inventory := handler.PersonalCache.AcquirePackageInventoryRead(request)
	if reader == nil || inventory.State != "ready" {
		t.Fatalf("read lease unavailable: reader=%v inventory=%+v", reader, inventory)
	}
	recorder = serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"listCacheModules"}`)
	var readList model.Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &readList); err != nil {
		t.Fatal(err)
	}
	readModules := cacheModules(readList)
	if len(readModules) != 1 || !readModules[0].Active || readModules[0].Writing {
		t.Fatalf("read-only activity state not exposed: %+v", readModules)
	}
	reader.Release()

	recorder = serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"listCacheModules"}`)
	var listed model.Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusOK || len(listed.CacheGroups) != 1 || len(listed.CacheGroups[0].Modules) != 1 || listed.CacheGroups[0].Modules[0].Kind != "project-dependency" {
		t.Fatalf("project cache not exposed through CRUD: status=%d response=%+v", recorder.Code, listed)
	}
	recorder = serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"deleteCacheModule","cachePath":"`+lease.RelativePath+`"}`)
	if recorder.Code != http.StatusOK || len(handler.PersonalCache.Inspect(user.ID, 0).Entries) != 0 || cleared != 1 {
		t.Fatalf("cache delete failed: status=%d body=%s cleared=%d", recorder.Code, recorder.Body.String(), cleared)
	}

	second, err := handler.PersonalCache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	second.Release()
	recorder = serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"deleteProject","folderKey":"project"}`)
	if recorder.Code != http.StatusOK || len(handler.PersonalCache.Inspect(user.ID, 0).Entries) != 0 {
		t.Fatalf("project deletion left dependency cache: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestPersonalCacheWorkspaceFolderKey(t *testing.T) {
	identity := lsp.StableWorkspaceIdentity("user-a", "", "", "", "folder-a")
	if got := personalCacheWorkspaceFolderKey(identity, "user-a"); got != "folder-a" {
		t.Fatalf("folder key = %q", got)
	}
	if got := personalCacheWorkspaceFolderKey(identity, "user-b"); got != "" {
		t.Fatalf("foreign identity exposed folder key %q", got)
	}
}

func TestSingleUserProjectDeletionRemovesDependencyNamespaces(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	handler.PersonalCache = personalcache.NewManager(dataRoot, personalcache.Options{ReservationBytes: 8})
	workspace := filepath.Join(serverRoot, "project")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("demo==1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	lease, err := handler.PersonalCache.Prepare(context.Background(), personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project"),
		RuntimeID: "python:3.11", Language: "python", WorkspaceRoot: workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	lease.Release()
	recorder, _ := callProjectEnvironment(t, handler, `{"action":"deleteProject","folderKey":"project"}`)
	if recorder.Code != http.StatusOK || len(handler.PersonalCache.Inspect("default", 0).Entries) != 0 {
		t.Fatalf("single-user delete left project cache: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestLegacyCacheCRUDUsesWholeNamespacesWithoutDeadMetadata(t *testing.T) {
	handler, _, user := newAuthenticatedLifecycleHandler(t)
	persist := filepath.Join(handler.Config.DataDir, "users", user.ID, "persist")
	pythonRoot := filepath.Join(persist, "pip-packages")
	for path, content := range map[string]string{
		filepath.Join(pythonRoot, "numpy", "__init__.py"):               "",
		filepath.Join(pythonRoot, "numpy-2.1.0.dist-info", "METADATA"):  "Name: numpy\nVersion: 2.1.0\n",
		filepath.Join(persist, "go", "pkg", "mod", "example", "mod.go"): "package example\n",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}

	recorder := serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"listCacheModules"}`)
	var listed model.Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	paths := map[string]model.CacheModule{}
	for _, module := range cacheModules(listed) {
		paths[module.Path] = module
		if strings.HasPrefix(module.Path, "pip-packages/") || strings.HasPrefix(module.Path, "go/") {
			t.Fatalf("partial legacy cache entry leaked into CRUD: %+v", module)
		}
	}
	if paths["pip-packages"].Kind != "legacy-cache" || paths["go"].Kind != "legacy-cache" {
		t.Fatalf("coherent legacy namespaces missing: %+v", paths)
	}

	recorder = serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"deleteCacheModule","cachePath":"pip-packages"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := os.Stat(pythonRoot); !os.IsNotExist(err) {
		t.Fatalf("Python namespace or dist-info survived delete: %v", err)
	}
}
