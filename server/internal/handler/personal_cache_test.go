package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bobocloud-server/internal/cachev2"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
)

func personalCacheV2Inventory(t *testing.T, handler http.Handler, apiKey string) cachev2.Inventory {
	t.Helper()
	recorder := serveAuthenticatedAction(t, handler, apiKey, `{"action":"getCacheInventory"}`)
	response := decodeCacheV2TestEnvelope(t, recorder.Body.Bytes())
	if recorder.Code != http.StatusOK || !response.Success {
		t.Fatalf("cache-v2 inventory status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	return response.Data.CacheInventory
}

func dependencyCacheV2Entry(t *testing.T, inventory cachev2.Inventory, predicate func(cachev2.Entry) bool) cachev2.Entry {
	t.Helper()
	for _, entry := range inventory.Entries {
		if entry.Category == cachev2.CategoryDependencies && (predicate == nil || predicate(entry)) {
			return entry
		}
	}
	t.Fatalf("dependency entry was not found in %+v", inventory.Entries)
	return cachev2.Entry{}
}

func personalCacheV2EntryDetail(t *testing.T, handler http.Handler, apiKey string, id cachev2.CacheID) (cachev2.Entry, cachePackageInventoryDetail) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"action": "getCacheEntry", "cacheId": id})
	recorder := serveAuthenticatedAction(t, handler, apiKey, string(payload))
	response := decodeCacheV2TestEnvelope(t, recorder.Body.Bytes())
	if recorder.Code != http.StatusOK || !response.Success {
		t.Fatalf("cache-v2 detail status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	encodedEntry, err := json.Marshal(response.Data.CacheEntry)
	if err != nil {
		t.Fatal(err)
	}
	var entry cachev2.Entry
	if err := json.Unmarshal(encodedEntry, &entry); err != nil {
		t.Fatal(err)
	}
	encodedInventory, err := json.Marshal(response.Data.CacheEntry["package_inventory"])
	if err != nil {
		t.Fatal(err)
	}
	var inventory cachePackageInventoryDetail
	if err := json.Unmarshal(encodedInventory, &inventory); err != nil {
		t.Fatal(err)
	}
	return entry, inventory
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
		RuntimeID: "python:3.11", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.11", "python:3.11-slim"),
		Language: "python", WorkspaceRoot: workspace,
	}
	lease, err := handler.PersonalCache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}

	activeInventory := personalCacheV2Inventory(t, handler, user.APIKey)
	activeEntry := dependencyCacheV2Entry(t, activeInventory, nil)
	if !activeEntry.Writing || activeEntry.Capabilities["delete"] {
		t.Fatalf("active writer state/capability not exposed: %+v", activeEntry)
	}
	deleteActivePayload, _ := json.Marshal(map[string]any{"action": "deleteCacheEntry", "cacheId": activeEntry.ID, "expectedRevision": activeInventory.Revision})
	recorder := serveAuthenticatedAction(t, handler, user.APIKey, string(deleteActivePayload))
	if recorder.Code != http.StatusConflict || decodeCacheV2TestEnvelope(t, recorder.Body.Bytes()).ErrorCode != "cache_in_use" {
		t.Fatalf("active cache delete status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	lease.Release()
	reader, _, inventory := handler.PersonalCache.AcquirePackageInventoryRead(request)
	if reader == nil || inventory.State != "ready" {
		t.Fatalf("read lease unavailable: reader=%v inventory=%+v", reader, inventory)
	}
	readInventory := personalCacheV2Inventory(t, handler, user.APIKey)
	readEntry := dependencyCacheV2Entry(t, readInventory, nil)
	if readEntry.ActiveReaders != 1 || readEntry.Writing || readEntry.Capabilities["delete"] {
		t.Fatalf("read-only activity state not exposed: %+v", readEntry)
	}
	reader.Release()

	currentInventory := personalCacheV2Inventory(t, handler, user.APIKey)
	currentEntry := dependencyCacheV2Entry(t, currentInventory, nil)
	deleteCurrentPayload, _ := json.Marshal(map[string]any{"action": "deleteCacheEntry", "cacheId": currentEntry.ID, "expectedRevision": currentInventory.Revision})
	recorder = serveAuthenticatedAction(t, handler, user.APIKey, string(deleteCurrentPayload))
	if recorder.Code != http.StatusConflict || decodeCacheV2TestEnvelope(t, recorder.Body.Bytes()).ErrorCode != "cache_current_environment_protected" {
		t.Fatalf("current project environment was deletable: status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("demo==2\n"), 0600); err != nil {
		t.Fatal(err)
	}
	second, err := handler.PersonalCache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	second.Release()
	historyInventory := personalCacheV2Inventory(t, handler, user.APIKey)
	historyEntry := dependencyCacheV2Entry(t, historyInventory, func(entry cachev2.Entry) bool { return entry.State == cachev2.EntryStateSuperseded })
	deleteHistoryPayload, _ := json.Marshal(map[string]any{"action": "deleteCacheEntry", "cacheId": historyEntry.ID, "expectedRevision": historyInventory.Revision})
	recorder = serveAuthenticatedAction(t, handler, user.APIKey, string(deleteHistoryPayload))
	if recorder.Code != http.StatusOK || cleared != 1 {
		t.Fatalf("superseded cache delete failed: status=%d body=%s cleared=%d", recorder.Code, recorder.Body.String(), cleared)
	}
	recorder = serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"deleteProject","folderKey":"project"}`)
	afterDelete := personalCacheV2Inventory(t, handler, user.APIKey)
	if recorder.Code != http.StatusOK || len(afterDelete.Entries) != 0 {
		t.Fatalf("project deletion left dependency cache: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestProjectDependencyCacheListsExactPythonDistributionAndRejectsDigestMutation(t *testing.T) {
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

	listed := personalCacheV2Inventory(t, handler, user.APIKey)
	module := dependencyCacheV2Entry(t, listed, nil)
	if module.Generation == "" || module.PackageInventory == nil || module.PackageInventory.State != "deferred" || !module.PackageInventory.Deferred {
		t.Fatalf("lazy cache-v2 summary = entry:%+v inventory:%+v", module, module.PackageInventory)
	}
	detailedEntry, packageInventory := personalCacheV2EntryDetail(t, handler, user.APIKey, module.ID)
	if packageInventory.State != "ready" || !packageInventory.Exact || packageInventory.Revision == "" || len(packageInventory.Packages) != 2 {
		t.Fatalf("exact cache-v2 detail = %+v", packageInventory)
	}
	if packageInventory.Packages[0].Name != "matplotlib" || packageInventory.Packages[1].Name != "numpy" || len(packageInventory.Packages[1].Imports) != 1 || packageInventory.Packages[1].Imports[0] != "numpy" {
		t.Fatalf("package inventory = %+v", packageInventory.Packages)
	}

	deletePayload, _ := json.Marshal(&model.Request{
		Action: "deleteCachePackage", CachePackageName: "numpy", CachePackageVersion: "2.1.0",
		CacheGeneration: module.Generation, CacheInventoryRevision: packageInventory.Revision,
	})
	deleted := serveAuthenticatedAction(t, handler, user.APIKey, string(deletePayload))
	if deleted.Code != http.StatusBadRequest || cleared != 0 || !strings.Contains(deleted.Body.String(), "Unknown action") {
		t.Fatalf("delete status=%d body=%s cleared=%d", deleted.Code, deleted.Body.String(), cleared)
	}

	afterEntry, afterInventory := personalCacheV2EntryDetail(t, handler, user.APIKey, module.ID)
	if afterEntry.Generation != detailedEntry.Generation || afterInventory.Revision != packageInventory.Revision || len(afterInventory.Packages) != 2 {
		t.Fatalf("rejected legacy package delete changed cache truth: entry=%+v inventory=%+v", afterEntry, afterInventory)
	}
}

func TestProjectDependencyCacheKeepsOtherLanguagesOpaqueToPackageInventory(t *testing.T) {
	handler, _, user := newAuthenticatedLifecycleHandler(t)
	handler.PersonalCache = personalcache.NewManager(handler.Config.DataDir, personalcache.Options{ReservationBytes: 8, ReservationFiles: 1})

	tests := []struct {
		language  string
		runtimeID string
		path      string
		contents  string
	}{
		{language: "node", runtimeID: "node:22", path: "node_modules/lodash/package.json", contents: `{"name":"lodash","version":"4.17.21"}`},
		{language: "go", runtimeID: "go:1.24", path: "go/pkg/mod/example.com/demo@v1.2.3/demo.go", contents: "package demo\n"},
		{language: "rust", runtimeID: "rust:1.85", path: "cargo/registry/src/index.crates.io/serde-1.0.219/src/lib.rs", contents: "pub struct Demo;\n"},
		{language: "java", runtimeID: "java:21", path: "maven/com/example/demo/1.2.3/demo-1.2.3.pom", contents: "<project/>\n"},
	}
	for _, test := range tests {
		workspace := filepath.Join(handler.Config.DataDir, "users", user.ID, "workspaces", "project-"+test.language)
		if err := os.MkdirAll(workspace, 0700); err != nil {
			t.Fatal(err)
		}
		request := personalcache.Request{
			UserID: user.ID, WorkspaceID: lsp.StableWorkspaceIdentity(user.ID, "", "", "", "project-"+test.language), WorkspaceName: "Project " + test.language,
			RuntimeID: test.runtimeID, RuntimeFingerprint: personalCacheRuntimeFingerprint(test.runtimeID, "test:"+test.runtimeID),
			Language: test.language, WorkspaceRoot: workspace,
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

	listed := personalCacheV2Inventory(t, handler, user.APIKey)
	byLanguage := make(map[string]cachev2.Entry)
	for _, module := range listed.Entries {
		if module.Category == cachev2.CategoryDependencies {
			byLanguage[module.Language] = module
		}
	}
	for _, test := range tests {
		module, exists := byLanguage[test.language]
		if !exists || module.PackageInventory == nil || module.PackageInventory.State != "unsupported" || module.Generation == "" {
			t.Fatalf("%s lazy module summary = entry:%+v inventory:%+v", test.language, module, module.PackageInventory)
		}
		_, inventory := personalCacheV2EntryDetail(t, handler, user.APIKey, module.ID)
		if inventory.State != "unsupported" || inventory.Exact || inventory.Revision != "" || len(inventory.Packages) != 0 {
			t.Fatalf("%s package inventory leaked observational guesses: %+v", test.language, inventory)
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
		RuntimeID: "python:3.11", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.11", "python:3.11-slim"),
		Language: "python", WorkspaceRoot: workspace,
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

func TestLegacyCacheNamespacesAreNotImportedOrDeletedByCacheV2(t *testing.T) {
	handler, _, user := newAuthenticatedLifecycleHandler(t)
	handler.PersonalCache = personalcache.NewManager(handler.Config.DataDir, personalcache.Options{})
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

	listed := personalCacheV2Inventory(t, handler, user.APIKey)
	if len(listed.Entries) != 0 {
		t.Fatalf("legacy cache namespaces leaked into cache-v2: %+v", listed.Entries)
	}

	recorder := serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"listCacheModules"}`)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "Unknown action") {
		t.Fatalf("legacy list action remained available: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"deleteCacheModule","cachePath":"pip-packages"}`)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "Unknown action") {
		t.Fatalf("legacy delete action remained available: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := os.Stat(pythonRoot); err != nil {
		t.Fatalf("deprecated cache action changed legacy data: %v", err)
	}
}
