package lsp

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"bobocloud-server/internal/safefile"
)

func cacheTestContext(ownerKind, ownerID, lockHash string) CacheContext {
	return CacheContext{
		OwnerKind: ownerKind, OwnerID: ownerID, UserID: "user-a", ProjectID: "project-a", Branch: "main",
		RuntimeID: "local", LanguageID: "go", Mode: ModeStandard, ToolchainFingerprint: "tool", LockHash: lockHash,
	}
}

func cacheTestNamespaceRoot(manager *CacheManager, ownerKind, ownerID string) string {
	return filepath.Join(manager.ownerRoot(ownerKind, ownerID), "namespaces")
}

func makeCacheTestOrphan(t *testing.T, manager *CacheManager, context CacheContext, metadata []byte, payloadSize int) (string, string) {
	t.Helper()
	key := CacheKey(context)
	dir := filepath.Join(cacheTestNamespaceRoot(manager, context.OwnerKind, context.OwnerID), key)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if metadata != nil {
		if err := os.WriteFile(filepath.Join(dir, cacheMetadataFile), metadata, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "index.bin"), make([]byte, payloadSize), 0644); err != nil {
		t.Fatal(err)
	}
	return key, dir
}

func TestCacheInspectAccountsForMissingAndCorruptMetadata(t *testing.T) {
	manager := NewCacheManager(t.TempDir(), 1, 7)
	missingContext := cacheTestContext("user", "owner-a", "missing")
	corruptContext := cacheTestContext("user", "owner-a", "corrupt")
	_, missingDir := makeCacheTestOrphan(t, manager, missingContext, nil, 2048)
	_, corruptDir := makeCacheTestOrphan(t, manager, corruptContext, []byte("{not-json"), 4096)

	info := manager.Inspect("user", "owner-a")
	if len(info.Namespaces) != 2 || !info.Unknown || info.Truncated {
		t.Fatalf("orphan inspection = %+v", info)
	}
	if info.TotalBytes < 2048+4096 || info.Entries < 4 {
		t.Fatalf("orphan usage was not counted: %+v", info)
	}
	want := map[string]bool{filepath.Clean(missingDir): true, filepath.Clean(corruptDir): true}
	for _, namespace := range info.Namespaces {
		if !namespace.Unknown || namespace.Key == "" || namespace.SizeBytes == 0 || namespace.Entries == 0 || !want[filepath.Clean(namespace.Path)] {
			t.Fatalf("orphan namespace = %+v", namespace)
		}
		delete(want, filepath.Clean(namespace.Path))
	}
	if len(want) != 0 {
		t.Fatalf("real namespace directories were skipped: %+v", want)
	}
}

func TestCacheInspectTruncationIsFailClosed(t *testing.T) {
	manager := NewCacheManager(t.TempDir(), 1, 7)
	context := cacheTestContext("user", "owner-a", "truncated")
	lease, err := manager.Prepare(context)
	if err != nil {
		t.Fatal(err)
	}
	lease.Release()
	for index := 0; index < 8; index++ {
		if err := os.WriteFile(filepath.Join(lease.Dir, "entry-"+string(rune('a'+index))), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	manager.sizeEntries = 2
	manager.sizeBudget = time.Second
	manager.invalidate(context.OwnerKind, context.OwnerID)
	info := manager.Inspect(context.OwnerKind, context.OwnerID)
	if len(info.Namespaces) != 1 || !info.Truncated || !info.Namespaces[0].Truncated {
		t.Fatalf("truncated inspection = %+v", info)
	}
	if info.TotalBytes <= info.QuotaBytes {
		t.Fatalf("partial size was treated as an exact under-quota total: %+v", info)
	}
}

func TestCacheUsageChargesFilesystemEntries(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "empty-directory"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "empty-file"), nil, 0644); err != nil {
		t.Fatal(err)
	}
	size, entries, complete := directorySizeBounded(root, 10, time.Second)
	if !complete || entries != 2 {
		t.Fatalf("entry scan size=%d entries=%d complete=%v", size, entries, complete)
	}
	if size < 2*cacheEntryChargeBytes {
		t.Fatalf("zero-byte entries were not charged: %d", size)
	}
}

func TestCachePruneTreatsTruncatedUsageAsOverQuota(t *testing.T) {
	manager := NewCacheManager(t.TempDir(), 1, 7)
	context := cacheTestContext("user", "owner-a", "truncated-prune")
	lease, err := manager.Prepare(context)
	if err != nil {
		t.Fatal(err)
	}
	lease.Release()
	for index := 0; index < 8; index++ {
		name := fmt.Sprintf("entry-%d", index)
		if err := os.WriteFile(filepath.Join(lease.Dir, name), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	manager.sizeEntries = 2
	manager.sizeBudget = time.Second
	manager.invalidate(context.OwnerKind, context.OwnerID)

	after := manager.Prune(context.OwnerKind, context.OwnerID)
	if len(after.Namespaces) != 0 {
		t.Fatalf("truncated namespace was retained as under quota: %+v", after)
	}
}

func TestCacheClearNamespaceAndAllIgnoreBrokenMetadata(t *testing.T) {
	manager := NewCacheManager(t.TempDir(), 1, 7)
	context := cacheTestContext("user", "owner-a", "corrupt")
	key, dir := makeCacheTestOrphan(t, manager, context, []byte("broken"), 1024)
	if err := manager.Clear(context.OwnerKind, context.OwnerID, "namespace", "", key); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("corrupt namespace was not manually cleared: %v", err)
	}

	_, _ = makeCacheTestOrphan(t, manager, cacheTestContext("user", "owner-a", "missing"), nil, 1024)
	invalidDir := filepath.Join(cacheTestNamespaceRoot(manager, context.OwnerKind, context.OwnerID), "unparseable-orphan")
	if err := os.MkdirAll(invalidDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := manager.Clear(context.OwnerKind, context.OwnerID, "all", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cacheTestNamespaceRoot(manager, context.OwnerKind, context.OwnerID)); !os.IsNotExist(err) {
		t.Fatalf("clear all retained owner namespace root: %v", err)
	}
}

func TestCacheClearRejectsActiveNamespaceDespiteBrokenMetadata(t *testing.T) {
	manager := NewCacheManager(t.TempDir(), 1, 7)
	context := cacheTestContext("user", "owner-a", "active")
	lease, err := manager.Prepare(context)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lease.Dir, cacheMetadataFile), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := manager.Clear(context.OwnerKind, context.OwnerID, "namespace", "", lease.Namespace.Key); err == nil {
		t.Fatal("active corrupt namespace was cleared")
	}
	if err := manager.Clear(context.OwnerKind, context.OwnerID, "all", "", ""); err == nil {
		t.Fatal("owner with an active namespace was cleared")
	}
	if _, err := os.Stat(lease.Dir); err != nil {
		t.Fatalf("active namespace disappeared: %v", err)
	}
	lease.Release()
}

func TestCachePruneIgnoresAndRepairsCrashActiveMetadata(t *testing.T) {
	t.Run("expired crash namespace is deleted", func(t *testing.T) {
		manager := NewCacheManager(t.TempDir(), 1, 1)
		context := cacheTestContext("user", "owner-a", "expired-crash")
		lease, err := manager.Prepare(context)
		if err != nil {
			t.Fatal(err)
		}
		lease.Release()
		namespace := lease.Namespace
		namespace.Active = true
		namespace.LastUsed = time.Now().UTC().Add(-48 * time.Hour)
		if err := writeCacheMetadata(lease.Dir, namespace); err != nil {
			t.Fatal(err)
		}
		manager.invalidate(context.OwnerKind, context.OwnerID)
		if after := manager.Prune(context.OwnerKind, context.OwnerID); len(after.Namespaces) != 0 {
			t.Fatalf("crash Active flag prevented pruning: %+v", after)
		}
	})

	t.Run("warm crash namespace is repaired", func(t *testing.T) {
		manager := NewCacheManager(t.TempDir(), 1, 7)
		context := cacheTestContext("user", "owner-a", "warm-crash")
		lease, err := manager.Prepare(context)
		if err != nil {
			t.Fatal(err)
		}
		lease.Release()
		namespace := lease.Namespace
		namespace.Active = true
		namespace.LastUsed = time.Now().UTC()
		if err := writeCacheMetadata(lease.Dir, namespace); err != nil {
			t.Fatal(err)
		}
		manager.invalidate(context.OwnerKind, context.OwnerID)
		if after := manager.Prune(context.OwnerKind, context.OwnerID); len(after.Namespaces) != 1 || after.Namespaces[0].Active {
			t.Fatalf("warm crash namespace was not retained inactive: %+v", after)
		}
		data, err := safefile.ReadSmallRegular(lease.Dir, cacheMetadataFile, cacheMetadataMaxBytes)
		if err != nil {
			t.Fatal(err)
		}
		var repaired CacheNamespace
		if json.Unmarshal(data, &repaired) != nil || repaired.Active {
			t.Fatalf("crash Active metadata was not repaired: %s", data)
		}
	})
}

func TestCachePruneUsesDirectoryMtimeForCorruptOrphan(t *testing.T) {
	manager := NewCacheManager(t.TempDir(), 1, 1)
	context := cacheTestContext("user", "owner-a", "old-orphan")
	_, dir := makeCacheTestOrphan(t, manager, context, []byte("broken"), 1024)
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(dir, old, old); err != nil {
		t.Fatal(err)
	}
	if after := manager.Prune(context.OwnerKind, context.OwnerID); len(after.Namespaces) != 0 {
		t.Fatalf("expired corrupt orphan was retained: %+v", after)
	}
}
