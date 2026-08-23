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

func TestProjectDependencyWriteRequiredByRuntimeBehavior(t *testing.T) {
	tests := []struct {
		name     string
		language string
		setup    []string
		want     bool
	}{
		{name: "python import only", language: "python", want: false},
		{name: "python alias import only", language: "py", want: false},
		{name: "node import only", language: "node", want: false},
		{name: "typescript import only", language: "typescript", want: false},
		{name: "node alias import only", language: "js", want: false},
		{name: "react typescript import only", language: "typescriptreact", want: false},
		{name: "python setup", language: "python", setup: []string{"pip install numpy"}, want: true},
		{name: "node setup", language: "node", setup: []string{"npm install"}, want: true},
		{name: "go compile populates modules", language: "go", want: true},
		{name: "rust compile populates cargo", language: "rust", want: true},
		{name: "java compile populates build cache", language: "java", want: true},
		{name: "unknown is conservative", language: "custom", want: true},
		{name: "blank setup is ignored", language: "python", setup: []string{"  "}, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := projectDependencyWriteRequired(test.language, test.setup); got != test.want {
				t.Fatalf("projectDependencyWriteRequired(%q, %q) = %t, want %t", test.language, test.setup, got, test.want)
			}
		})
	}
}

func TestPersonalCacheLeaseErrorAcceptsReadOnlyGeneration(t *testing.T) {
	dataRoot := t.TempDir()
	workspace := filepath.Join(dataRoot, "users", "default", "workspaces", "project")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("demo==1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cache := personalcache.NewManager(dataRoot, personalcache.Options{ScopeMode: "project-lock", ReservationBytes: 8})
	request := personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project"), WorkspaceName: "Project",
		RuntimeID: "python:3.11", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.11", "python:3.11-slim"),
		Language: "python", WorkspaceRoot: workspace,
	}
	writer, err := cache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writer.Release()
	reader, err := cache.PrepareReadOnly(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release()
	if reader.Writable() {
		t.Fatal("published generation unexpectedly remained writable")
	}
	if err := personalCacheLeaseError(reader, context.Background()); err != nil {
		t.Fatalf("read-only generation reported a quota guard error: %v", err)
	}
}

func TestRunSkipsProjectDependencyGenerationForLanguagesWithoutManagedDependencies(t *testing.T) {
	dataRoot := t.TempDir()
	workspace := filepath.Join(dataRoot, "users", "default", "workspaces", "project")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	handler := &WSHandler{PersonalCache: personalcache.NewManager(dataRoot, personalcache.Options{ScopeMode: "project-lock", ReservationBytes: 8})}
	session := &model.RunSession{UserID: "default", FolderName: "Project", FolderKey: "project"}
	runtime := model.RuntimeDef{RuntimeID: "cpp:13", DockerImage: "gcc:13", Language: "cpp"}
	lease, err := handler.prepareRunPersonalCache(context.Background(), session, runtime, runtime.Language, workspace)
	if err != nil || lease != nil {
		t.Fatalf("C++ run project dependency lease = %v, %v", lease, err)
	}
	if entries := handler.PersonalCache.Inspect("default", 0).Entries; len(entries) != 0 {
		t.Fatalf("C++ run created an empty project dependency generation: %+v", entries)
	}
}

func TestProjectLockDependencyLanguageCoversManagedRuntimesOnly(t *testing.T) {
	tests := map[string]bool{
		"python": true, "py": true,
		"node": true, "javascript": true, "typescript": true,
		"go": true, "rust": true, "java": true,
		"c": false, "cpp": false, "c++": false, "custom": false,
	}
	for language, want := range tests {
		if got := projectLockDependencyLanguage(language); got != want {
			t.Errorf("projectLockDependencyLanguage(%q) = %t, want %t", language, got, want)
		}
	}
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

func TestProjectDependencyCacheListsAndDeletesExactPythonDistribution(t *testing.T) {
	handler, _, user := newAuthenticatedLifecycleHandler(t)
	handler.PersonalCache = personalcache.NewManager(handler.Config.DataDir, personalcache.Options{ReservationBytes: 8})
	cleared := 0
	handler.OnPersonalCacheCleared = func() { cleared++ }
	workspace := filepath.Join(handler.Config.DataDir, "users", user.ID, "workspaces", "project")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("numpy==2.1.0\nmatplotlib==3.9.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	request := personalcache.Request{
		UserID: user.ID, WorkspaceID: lsp.StableWorkspaceIdentity(user.ID, "", "", "", "project"), WorkspaceName: "Project",
		RuntimeID: "python:3.10", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.10", "python:3.10-slim"),
		Language: "python", WorkspaceRoot: workspace,
	}
	lease, err := handler.PersonalCache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writePythonDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.1.0")
	writePythonDistInfo(t, filepath.Join(lease.HostRoot, "python"), "matplotlib", "3.9.0")
	lease.Release()

	listedRecorder := serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"listCacheModules"}`)
	var listed model.Response
	if err := json.Unmarshal(listedRecorder.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	modules := cacheModules(listed)
	if listedRecorder.Code != http.StatusOK || len(modules) != 1 {
		t.Fatalf("list response: status=%d body=%s", listedRecorder.Code, listedRecorder.Body.String())
	}
	module := modules[0]
	if module.InventoryStatus != "ready" || !module.InventoryExact || module.Generation == "" || module.InventoryRevision == "" || len(module.Packages) != 2 {
		t.Fatalf("exact cache module = %+v", module)
	}
	if module.Packages[0].Name != "matplotlib" || module.Packages[1].Name != "numpy" || len(module.Packages[1].Imports) != 1 || module.Packages[1].Imports[0] != "numpy" {
		t.Fatalf("package inventory = %+v", module.Packages)
	}

	stalePayload, _ := json.Marshal(&model.Request{
		Action: "deleteCachePackage", CachePath: module.Path, CachePackageName: "numpy", CachePackageVersion: "2.1.0",
		CacheGeneration: strings.Repeat("0", 32), CacheInventoryRevision: module.InventoryRevision,
	})
	stale := serveAuthenticatedAction(t, handler, user.APIKey, string(stalePayload))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale delete status=%d body=%s", stale.Code, stale.Body.String())
	}

	deletePayload, _ := json.Marshal(&model.Request{
		Action: "deleteCachePackage", CachePath: module.Path, CachePackageName: "numpy", CachePackageVersion: "2.1.0",
		CacheGeneration: module.Generation, CacheInventoryRevision: module.InventoryRevision,
	})
	deleted := serveAuthenticatedAction(t, handler, user.APIKey, string(deletePayload))
	if deleted.Code != http.StatusOK || cleared != 1 {
		t.Fatalf("delete status=%d body=%s cleared=%d", deleted.Code, deleted.Body.String(), cleared)
	}

	afterRecorder := serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"listCacheModules"}`)
	var after model.Response
	if err := json.Unmarshal(afterRecorder.Body.Bytes(), &after); err != nil {
		t.Fatal(err)
	}
	afterModules := cacheModules(after)
	if afterRecorder.Code != http.StatusOK || len(afterModules) != 1 || afterModules[0].Generation == module.Generation || afterModules[0].InventoryRevision == module.InventoryRevision || len(afterModules[0].Packages) != 1 || afterModules[0].Packages[0].Name != "matplotlib" {
		t.Fatalf("after delete cache truth: status=%d modules=%+v", afterRecorder.Code, afterModules)
	}
}

func TestProjectDependencyCacheListsObservedPackagesForOtherLanguages(t *testing.T) {
	handler, _, user := newAuthenticatedLifecycleHandler(t)
	handler.PersonalCache = personalcache.NewManager(handler.Config.DataDir, personalcache.Options{ReservationBytes: 8, ReservationFiles: 1})

	tests := []struct {
		language  string
		runtimeID string
		path      string
		contents  string
		wantName  string
		version   string
	}{
		{language: "node", runtimeID: "node:22", path: "node_modules/lodash/package.json", contents: `{"name":"lodash","version":"4.17.21"}`, wantName: "lodash", version: "4.17.21"},
		{language: "go", runtimeID: "go:1.24", path: "go/pkg/mod/example.com/demo@v1.2.3/demo.go", contents: "package demo\n", wantName: "example.com/demo", version: "v1.2.3"},
		{language: "rust", runtimeID: "rust:1.85", path: "cargo/registry/src/index.crates.io/serde-1.0.219/src/lib.rs", contents: "pub struct Demo;\n", wantName: "serde", version: "1.0.219"},
		{language: "java", runtimeID: "java:21", path: "maven/com/example/demo/1.2.3/demo-1.2.3.pom", contents: "<project/>\n", wantName: "com.example:demo", version: "1.2.3"},
	}
	for _, test := range tests {
		workspace := filepath.Join(handler.Config.DataDir, "users", user.ID, "workspaces", "project-"+test.language)
		if err := os.MkdirAll(workspace, 0700); err != nil {
			t.Fatal(err)
		}
		request := personalcache.Request{
			UserID: user.ID, WorkspaceID: lsp.StableWorkspaceIdentity(user.ID, "", "", "", "project-"+test.language), WorkspaceName: "Project " + test.language,
			RuntimeID: test.runtimeID, Language: test.language, WorkspaceRoot: workspace,
		}
		lease, err := handler.PersonalCache.Prepare(context.Background(), request)
		if err != nil {
			t.Fatalf("prepare %s: %v", test.language, err)
		}
		path := filepath.Join(lease.HostRoot, filepath.FromSlash(test.path))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(test.contents), 0600); err != nil {
			t.Fatal(err)
		}
		lease.Release()
		if !lease.Published() {
			t.Fatalf("%s cache was not published", test.language)
		}
	}

	recorder := serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"listCacheModules"}`)
	var listed model.Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	byLanguage := make(map[string]model.CacheModule)
	for _, module := range cacheModules(listed) {
		if module.Kind == "project-dependency" {
			byLanguage[module.Language] = module
		}
	}
	for _, test := range tests {
		module, exists := byLanguage[test.language]
		if !exists || module.InventoryStatus != "observed" || module.InventoryExact || module.InventoryRevision != "" || module.Generation == "" || len(module.Packages) != 1 {
			t.Fatalf("%s observed module = %+v", test.language, module)
		}
		if module.Packages[0].Name != test.wantName || module.Packages[0].Version != test.version {
			t.Fatalf("%s packages = %+v", test.language, module.Packages)
		}
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
