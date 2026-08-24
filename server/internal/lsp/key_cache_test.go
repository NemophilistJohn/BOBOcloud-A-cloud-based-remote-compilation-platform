package lsp

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSessionAndCacheKeysAreIsolated(t *testing.T) {
	base := SessionContext{UserID: "u1", WorkspaceKind: "team", TeamID: "t1", ProjectID: "p1", Branch: "main", RuntimeID: "rust:1.82", LanguageID: "rust", Mode: ModeStandard}
	key := SessionKey(base)
	if key != SessionKey(base) {
		t.Fatal("session key is not deterministic")
	}
	changed := base
	changed.UserID = "u2"
	if key == SessionKey(changed) {
		t.Fatal("different users shared a session key")
	}
	changed = base
	changed.RuntimeID = "local"
	if key == SessionKey(changed) {
		t.Fatal("different runtimes shared a session key")
	}

	ctx := CacheContext{OwnerKind: "team", OwnerID: "t1", UserID: "u1", ProjectID: "p1", Branch: "main", RuntimeID: "rust:1.82", LanguageID: "rust", Mode: ModeStandard, ToolchainFingerprint: "tool-a", LockHash: "lock-a"}
	cacheKey := CacheKey(ctx)
	ctx.Mode = ModeFull
	if cacheKey != CacheKey(ctx) {
		t.Fatal("standard/full created duplicate analysis indexes")
	}
	ctx.Mode = ModeStandard
	ctx.LockHash = "lock-b"
	if cacheKey == CacheKey(ctx) {
		t.Fatal("dependency lock changes did not invalidate analysis cache")
	}
}

func TestDefaultCatalogMapsEditorLanguageAliases(t *testing.T) {
	catalog := DefaultCatalog()
	for language, expected := range map[string]string{
		"c": "c", "cpp": "c", "c++": "c",
		"javascript": "node", "typescript": "node", "js": "node", "ts": "node",
		"python": "python", "py": "python",
		"html": "html", "scss": "css", "less": "css", "jsonc": "json",
		"yaml": "yaml", "shellscript": "shell", "bash": "shell", "sh": "shell",
	} {
		spec, ok := catalog.Lookup(language)
		if !ok || spec.LanguageID != expected {
			t.Fatalf("language %s mapped to %+v (found=%v), want %s", language, spec, ok, expected)
		}
	}
}

func TestDependencyLockHashIgnoresSourceEdits(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Cargo.lock"), []byte("v1"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "main.rs"), []byte("fn main() {}"), 0644); err != nil {
		t.Fatal(err)
	}
	first, _ := DependencyLockHash(root)
	_ = os.WriteFile(filepath.Join(root, "main.rs"), []byte("fn main() { println!(\"x\"); }"), 0644)
	second, _ := DependencyLockHash(root)
	if first != second {
		t.Fatal("source-only edit invalidated dependency cache")
	}
	_ = os.WriteFile(filepath.Join(root, "Cargo.lock"), []byte("v2"), 0644)
	third, _ := DependencyLockHash(root)
	if second == third {
		t.Fatal("lockfile edit did not invalidate dependency cache")
	}
}

func TestDependencyLockHashSkipsGeneratedTreesAndIsBounded(t *testing.T) {
	root := t.TempDir()
	_ = os.WriteFile(filepath.Join(root, "go.sum"), []byte("root"), 0644)
	generated := filepath.Join(root, "build")
	if err := os.MkdirAll(generated, 0755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(generated, "Cargo.lock"), []byte("ignored-a"), 0644)
	first, err := DependencyLockHash(root)
	if err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(generated, "Cargo.lock"), []byte("ignored-b"), 0644)
	second, _ := DependencyLockHash(root)
	if first != second {
		t.Fatal("generated build tree affected dependency fingerprint")
	}
	for i := 0; i < maxLockScanEntries+20; i++ {
		name := filepath.Join(root, "src", "f"+fmt.Sprint(i)+".txt")
		if err := os.MkdirAll(filepath.Dir(name), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, nil, 0644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := DependencyLockHash(root); err != nil {
		t.Fatalf("bounded scan should return a usable partial fingerprint: %v", err)
	}
}

func TestAnalysisCacheActiveProtectionAndClearBoundary(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "lsp-cache")
	buildSentinel := filepath.Join(parent, "cache-v2", "teams", "sentinel")
	dapSentinel := filepath.Join(parent, "dap-cache", "sentinel")
	if err := os.MkdirAll(filepath.Dir(buildSentinel), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(buildSentinel, []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(dapSentinel), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dapSentinel, []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}
	manager := NewCacheManager(root, 1, 7)
	lease, err := manager.Prepare(CacheContext{OwnerKind: "team", OwnerID: "team1", UserID: "u1", ProjectID: "p1", Branch: "main", RuntimeID: "local", LanguageID: "rust", Mode: ModeStandard, ToolchainFingerprint: "tool", LockHash: "lock"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Prepare(CacheContext{OwnerKind: "team", OwnerID: "team1", UserID: "u1", ProjectID: "p1", Branch: "main", RuntimeID: "local", LanguageID: "rust", Mode: ModeFull, ToolchainFingerprint: "tool", LockHash: "lock"}); err == nil {
		t.Fatal("standard/full were allowed to write the shared analyzer index concurrently")
	}
	if info := manager.Inspect("team", "team1"); len(info.Namespaces) != 1 || !info.Namespaces[0].Active {
		t.Fatalf("active namespace missing: %+v", info)
	}
	if err := manager.Clear("team", "team1", "all", "", ""); err == nil {
		t.Fatal("active cache was deleted")
	}
	lease.Release()
	if err := manager.Clear("team", "team1", "all", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(buildSentinel); err != nil {
		t.Fatalf("analysis clear crossed into build cache: %v", err)
	}
	if _, err := os.Stat(dapSentinel); err != nil {
		t.Fatalf("analysis clear crossed into DAP cache: %v", err)
	}
}

func TestAnalysisCachePrunesExpiredNamespace(t *testing.T) {
	manager := NewCacheManager(t.TempDir(), 1, 1)
	lease, err := manager.Prepare(CacheContext{OwnerKind: "user", OwnerID: "u1", UserID: "u1", RuntimeID: "local", LanguageID: "go", Mode: ModeStandard, ToolchainFingerprint: "tool", LockHash: "lock"})
	if err != nil {
		t.Fatal(err)
	}
	lease.Release()
	info := manager.Inspect("user", "u1")
	ns := info.Namespaces[0]
	ns.LastUsed = time.Now().Add(-48 * time.Hour)
	if err := writeCacheMetadata(ns.Path, ns); err != nil {
		t.Fatal(err)
	}
	manager.invalidate("user", "u1")
	if after := manager.Prune("user", "u1"); len(after.Namespaces) != 0 {
		t.Fatalf("expired namespace retained: %+v", after)
	}
}

func TestAnalysisCacheReportsWarmNamespaceSize(t *testing.T) {
	manager := NewCacheManager(t.TempDir(), 16, 7)
	context := CacheContext{OwnerKind: "user", OwnerID: "u1", UserID: "u1", RuntimeID: "local", LanguageID: "rust", Mode: ModeStandard, ToolchainFingerprint: "tool", LockHash: "lock"}
	lease, err := manager.Prepare(context)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lease.Dir, "index.bin"), make([]byte, 4096), 0644); err != nil {
		t.Fatal(err)
	}
	lease.Release()
	context.Mode = ModeFull
	warm, err := manager.Prepare(context)
	if err != nil {
		t.Fatal(err)
	}
	defer warm.Release()
	if warm.Namespace.SizeBytes < 4096 {
		t.Fatalf("warm namespace size was lost: %+v", warm.Namespace)
	}
}

func TestAnalysisCacheLifecycleGateIsPerOwner(t *testing.T) {
	manager := NewCacheManager(t.TempDir(), 16, 7)
	blockedContext := CacheContext{OwnerKind: "user", OwnerID: "blocked", UserID: "blocked", RuntimeID: "local", LanguageID: "go", Mode: ModeStandard, ToolchainFingerprint: "tool", LockHash: "lock"}
	otherContext := blockedContext
	otherContext.OwnerID, otherContext.UserID = "other", "other"

	gate := manager.ownerGate("user", "blocked")
	gate.mu.Lock()
	type result struct {
		lease *CacheLease
		err   error
	}
	blocked := make(chan result, 1)
	go func() {
		lease, err := manager.Prepare(blockedContext)
		blocked <- result{lease: lease, err: err}
	}()
	select {
	case got := <-blocked:
		gate.mu.Unlock()
		t.Fatalf("same-owner prepare bypassed lifecycle gate: %+v", got)
	case <-time.After(50 * time.Millisecond):
	}

	otherDone := make(chan result, 1)
	go func() {
		lease, err := manager.Prepare(otherContext)
		otherDone <- result{lease: lease, err: err}
	}()
	select {
	case got := <-otherDone:
		if got.err != nil {
			gate.mu.Unlock()
			t.Fatal(got.err)
		}
		got.lease.Release()
	case <-time.After(time.Second):
		gate.mu.Unlock()
		t.Fatal("one owner's lifecycle gate blocked another owner")
	}

	gate.mu.Unlock()
	select {
	case got := <-blocked:
		if got.err != nil {
			t.Fatal(got.err)
		}
		got.lease.Release()
	case <-time.After(time.Second):
		t.Fatal("same-owner prepare did not resume after lifecycle gate released")
	}
}

func TestAnalysisCacheCachedInspectionTracksLeaseLifecycle(t *testing.T) {
	manager := NewCacheManager(t.TempDir(), 16, 7)
	ctx := CacheContext{OwnerKind: "user", OwnerID: "u1", UserID: "u1", RuntimeID: "local", LanguageID: "go", Mode: ModeStandard, ToolchainFingerprint: "tool", LockHash: "lock"}
	lease, err := manager.Prepare(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if info := manager.Inspect("user", "u1"); len(info.Namespaces) != 1 || !info.Namespaces[0].Active {
		t.Fatalf("active cached inspection = %+v", info)
	}
	lease.Release()
	if info := manager.Inspect("user", "u1"); len(info.Namespaces) != 1 || info.Namespaces[0].Active {
		t.Fatalf("released cached inspection = %+v", info)
	}
	if err := manager.Clear("user", "u1", "all", "", ""); err != nil {
		t.Fatal(err)
	}
	if info := manager.Inspect("user", "u1"); len(info.Namespaces) != 0 {
		t.Fatalf("cleared cache reappeared from stale scan: %+v", info)
	}
}
