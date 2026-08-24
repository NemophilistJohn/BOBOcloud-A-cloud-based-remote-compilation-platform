package personalcache

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bobocloud-server/internal/cachev2"
)

func catalogLifecycleEntry(t *testing.T, inventory cachev2.Inventory, category cachev2.Category) cachev2.Entry {
	t.Helper()
	for _, entry := range inventory.Entries {
		if entry.Category == category {
			return entry
		}
	}
	t.Fatalf("category %s missing from catalog: %+v", category, inventory.Entries)
	return cachev2.Entry{}
}

func TestCurrentDependencyManualDeleteIsProtectedButQuotaLRURemovesBinding(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8, ReservationFiles: 1, MaxFiles: 10_000})
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("numpy==2.2.6\n"), 0600); err != nil {
		t.Fatal(err)
	}
	request := Request{
		UserID: "u1", WorkspaceID: "project", WorkspaceName: "Project",
		RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint,
		Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20,
	}
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.2.6")
	root := lease.HostRoot
	lease.Release()
	if !lease.Published() {
		t.Fatal("dependency generation was not published")
	}

	inventory, err := manager.Catalog(request.UserID, request.QuotaBytes)
	if err != nil {
		t.Fatal(err)
	}
	entry := catalogLifecycleEntry(t, inventory, cachev2.CategoryDependencies)
	if entry.State != cachev2.EntryStateCurrent || entry.Capabilities["delete"] {
		t.Fatalf("current dependency lifecycle = %+v", entry)
	}
	if _, err := manager.DeleteByID(request.UserID, entry.ID, inventory.Revision, request.QuotaBytes); !errors.Is(err, ErrCurrentCacheProtected) {
		t.Fatalf("manual current dependency deletion error = %v", err)
	}
	layout, err := manager.ensureUserLayout(request.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if binding, ok := readCurrentBinding(layout.Root, request); !ok || binding.CacheID != entry.ID {
		t.Fatalf("manual deletion changed current binding: %+v", binding)
	}

	manager.Enforce(request.UserID, 1)
	if _, ok := readCurrentBinding(layout.Root, request); ok {
		t.Fatal("quota LRU left a binding to the evicted current dependency")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("quota LRU left the evicted dependency root: %v", err)
	}
	if _, exists, err := manager.Lookup(request); err != nil || exists {
		t.Fatalf("quota LRU left lookup truth: exists=%t err=%v", exists, err)
	}
	reader, err := manager.PrepareReadOnly(context.Background(), request)
	if err != nil || reader != nil {
		t.Fatalf("quota LRU left a readable generation: reader=%v err=%v", reader, err)
	}
}

func TestBuildCatalogParentChildCASAndDeletionSemantics(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{MaxFiles: 10_000})
	request := BuildRequest{
		UserID: "u1", WorkspaceID: "project", WorkspaceName: "Project", RuntimeID: "go:1.24",
		RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "go", DependencyDigest: "deps-a", Target: "native",
	}
	lease, err := manager.PrepareBuild(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lease.HostRoot, "incremental.bin"), []byte("incremental"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := lease.CommitResult("source-a"); err != nil {
		t.Fatal(err)
	}
	incrementalRoot, resultRoot := lease.HostRoot, lease.ResultRoot
	lease.Release()

	inventory, err := manager.Catalog(request.UserID, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	incremental := catalogLifecycleEntry(t, inventory, cachev2.CategoryIncremental)
	result := catalogLifecycleEntry(t, inventory, cachev2.CategoryResults)
	if result.ParentID != incremental.ID || incremental.State != cachev2.EntryStateCurrent || result.State != cachev2.EntryStateCurrent {
		t.Fatalf("build cache relationship = incremental:%+v result:%+v", incremental, result)
	}
	if _, err := manager.DeleteByID(request.UserID, result.ID, "", 1<<20); !errors.Is(err, ErrCatalogRevisionMismatch) {
		t.Fatalf("revision-free build result deletion error = %v", err)
	}
	if _, err := manager.DeleteByID(request.UserID, result.ID, "stale", 1<<20); !errors.Is(err, ErrCatalogRevisionMismatch) {
		t.Fatalf("stale build result deletion error = %v", err)
	}
	if _, err := os.Stat(incrementalRoot); err != nil {
		t.Fatalf("stale CAS changed incremental root: %v", err)
	}
	if _, err := os.Stat(resultRoot); err != nil {
		t.Fatalf("stale CAS changed result root: %v", err)
	}

	deletedResult, err := manager.DeleteByID(request.UserID, result.ID, inventory.Revision, 1<<20)
	if err != nil || len(deletedResult.DeletedIDs) != 1 || deletedResult.DeletedIDs[0] != result.ID {
		t.Fatalf("result-only deletion = %+v err=%v", deletedResult, err)
	}
	if _, err := os.Stat(incrementalRoot); err != nil {
		t.Fatalf("result deletion removed its incremental parent: %v", err)
	}
	if _, err := os.Stat(resultRoot); !os.IsNotExist(err) {
		t.Fatalf("result cache survived deletion: %v", err)
	}
	layout, err := manager.ensureUserLayout(request.UserID)
	if err != nil {
		t.Fatal(err)
	}
	binding, ok := readBuildCurrentBinding(layout.Root, request)
	if !ok || binding.CacheID != incremental.ID || binding.ResultCacheID != "" {
		t.Fatalf("result deletion left an invalid build binding: %+v", binding)
	}

	recreated, err := manager.PrepareBuild(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if err := recreated.CommitResult("source-b"); err != nil {
		t.Fatal(err)
	}
	recreatedResultID := recreated.ResultCacheID
	recreatedResultRoot := recreated.ResultRoot
	recreated.Release()
	inventory, err = manager.Catalog(request.UserID, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	incremental = catalogLifecycleEntry(t, inventory, cachev2.CategoryIncremental)
	result = catalogLifecycleEntry(t, inventory, cachev2.CategoryResults)
	if result.ID != recreatedResultID || result.ParentID != incremental.ID {
		t.Fatalf("recreated result relationship = incremental:%+v result:%+v", incremental, result)
	}
	deletedFamily, err := manager.DeleteByID(request.UserID, incremental.ID, inventory.Revision, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	deleted := make(map[cachev2.CacheID]bool, len(deletedFamily.DeletedIDs))
	for _, id := range deletedFamily.DeletedIDs {
		deleted[id] = true
	}
	if len(deleted) != 2 || !deleted[incremental.ID] || !deleted[result.ID] {
		t.Fatalf("parent deletion did not include its result child: %+v", deletedFamily)
	}
	if _, ok := readBuildCurrentBinding(layout.Root, request); ok {
		t.Fatal("parent deletion left the build binding")
	}
	for _, root := range []string{incrementalRoot, recreatedResultRoot} {
		if _, err := os.Stat(root); !os.IsNotExist(err) {
			t.Fatalf("build family root survived deletion: root=%s err=%v", root, err)
		}
	}
	after, err := manager.Catalog(request.UserID, 1<<20)
	if err != nil || len(after.Entries) != 0 {
		t.Fatalf("build family deletion left catalog entries: entries=%+v err=%v", after.Entries, err)
	}
}

func TestBuildFamilyDeleteRollbackRestoresRootsAndBinding(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{MaxFiles: 10_000})
	request := BuildRequest{
		UserID: "u1", WorkspaceID: "project", RuntimeID: "rust:1.86",
		RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "rust", DependencyDigest: "deps-a", Target: "native",
	}
	lease, err := manager.PrepareBuild(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.CommitResult("source-a"); err != nil {
		t.Fatal(err)
	}
	lease.Release()

	snapshot, err := manager.catalogLocked(request.UserID, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	parent := catalogLifecycleEntry(t, snapshot.inventory, cachev2.CategoryIncremental)
	selected := catalogRecordFamily(snapshot, parent.ID)
	if len(selected) != 2 {
		t.Fatalf("build family = %+v", selected)
	}
	originalRoots := make(map[cachev2.CacheID]string, len(selected))
	var highest cachev2.CacheID
	for id, record := range selected {
		originalRoots[id] = record.root
		if id > highest {
			highest = id
		}
	}
	missing := selected[highest]
	missing.root += "-missing"
	selected[highest] = missing
	if _, err := manager.deleteCatalogRecordsLocked(request.UserID, selected); err == nil {
		t.Fatal("family deletion unexpectedly succeeded with a missing final root")
	}
	layout, err := manager.ensureUserLayout(request.UserID)
	if err != nil {
		t.Fatal(err)
	}
	binding, ok := readBuildCurrentBinding(layout.Root, request)
	if !ok || binding.CacheID != lease.CacheID || binding.ResultCacheID != lease.ResultCacheID {
		t.Fatalf("rollback did not restore the build binding: %+v", binding)
	}
	for id, root := range originalRoots {
		if _, err := os.Stat(root); err != nil {
			t.Fatalf("rollback did not restore %s at %s: %v", id, root, err)
		}
	}
	transactions, err := os.ReadDir(layout.Transactions)
	if err != nil {
		t.Fatal(err)
	}
	for _, transaction := range transactions {
		if strings.HasPrefix(transaction.Name(), "delete-cv2_") {
			t.Fatalf("failed deletion left a transaction root: %s", transaction.Name())
		}
	}
	after, err := manager.Catalog(request.UserID, 1<<20)
	if err != nil || len(after.Entries) != 2 {
		t.Fatalf("failed deletion left dead catalog references: entries=%+v err=%v", after.Entries, err)
	}
}
