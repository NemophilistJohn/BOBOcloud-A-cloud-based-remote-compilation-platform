package personalcache

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDependencyFingerprintChangesWithLockAndSetup(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "requirements.txt"), []byte("demo==1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	first, err := DependencyFingerprint(root, "python", nil)
	if err != nil {
		t.Fatal(err)
	}
	second, _ := DependencyFingerprint(root, "python", []string{"pip install extra"})
	if first.Digest == second.Digest || first.Source != "manifest" {
		t.Fatalf("fingerprints first=%+v second=%+v", first, second)
	}
	if err := os.WriteFile(filepath.Join(root, "poetry.lock"), []byte("locked"), 0600); err != nil {
		t.Fatal(err)
	}
	locked, _ := DependencyFingerprint(root, "python", nil)
	if locked.Source != "lock" || locked.Digest == first.Digest {
		t.Fatalf("locked fingerprint = %+v", locked)
	}
}

func TestManagerScopesCachesByProjectRuntimeAndDigest(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(dataDir, "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("demo==1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(dataDir, Options{ReservationBytes: 10, ScanInterval: time.Millisecond})
	request := Request{UserID: "u1", WorkspaceID: "project-a", WorkspaceName: "Project A", RuntimeID: "python:3.11", Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20}
	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Hit || first.DockerEnv["PIP_TARGET"] != "/project-deps/python" {
		t.Fatalf("first lease = %+v", first)
	}
	first.Release()
	second, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Hit || second.ContainerKey != first.ContainerKey {
		t.Fatalf("second lease hit=%v key=%q want=%q", second.Hit, second.ContainerKey, first.ContainerKey)
	}
	second.Release()
	entries := manager.Inspect("u1", 1<<20).Entries
	if len(entries) != 1 || entries[0].WorkspaceName != "Project A" || entries[0].Digest == "" {
		t.Fatalf("entries = %+v", entries)
	}
}

func TestManagerWriterWaitIsCancelableWithoutReservationLeak(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(dataDir, "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(dataDir, Options{ReservationBytes: 10})
	request := Request{UserID: "u1", WorkspaceID: "project-a", RuntimeID: "python:3.11", Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20}
	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := manager.Prepare(ctx, request); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled writer wait error = %v", err)
	}
	if got := manager.Inspect("u1", request.QuotaBytes).ReservedBytes; got != 10 {
		t.Fatalf("reserved bytes after cancelled wait = %d, want active writer reservation only", got)
	}
	first.Release()
	if got := manager.Inspect("u1", request.QuotaBytes).ReservedBytes; got != 0 {
		t.Fatalf("reserved bytes after release = %d", got)
	}
}

func TestManagerReservationRejectsInsufficientQuota(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(dataDir, "workspace")
	_ = os.MkdirAll(workspace, 0700)
	manager := NewManager(dataDir, Options{ReservationBytes: 1024})
	_, err := manager.Prepare(context.Background(), Request{UserID: "u1", WorkspaceID: "p", RuntimeID: "python:3.11", Language: "python", WorkspaceRoot: workspace, QuotaBytes: 100})
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("error = %v, want quota exceeded", err)
	}
}

func TestManagerListsAndDeletesOrphanedNamespace(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{})
	orphan := filepath.Join(dataDir, "users", "u1", "persist", dependenciesDir, "workspace", "runtime", "python", "digest")
	if err := os.MkdirAll(orphan, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphan, "partial"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	entries := manager.Inspect("u1", 0).Entries
	if len(entries) != 1 || !entries[0].Orphaned {
		t.Fatalf("entries = %+v", entries)
	}
	if err := manager.Delete("u1", entries[0].Path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatalf("orphan still exists: %v", err)
	}
}

func TestManagerTracksActiveNamespaceAfterMetadataIsCorrupted(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(dataDir, "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(dataDir, Options{ReservationBytes: 8})
	request := Request{
		UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11",
		Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20,
	}
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lease.HostRoot, metadataFile), []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	entries := manager.Inspect(request.UserID, request.QuotaBytes).Entries
	if len(entries) != 1 || !entries[0].Orphaned || !entries[0].Active {
		t.Fatalf("corrupt active namespace was not tracked: %+v", entries)
	}
	if err := manager.Delete(request.UserID, lease.RelativePath); err == nil {
		t.Fatal("active namespace with corrupt metadata was deleted")
	}
	lease.Release()
	if err := manager.Delete(request.UserID, lease.RelativePath); err != nil {
		t.Fatalf("released namespace could not be deleted: %v", err)
	}
}

func TestManagerRejectsSymlinkedPackageDirectory(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(dataDir, "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(dataDir, Options{ReservationBytes: 8})
	request := Request{
		UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11",
		Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20,
	}
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	lease.Release()
	pythonRoot := filepath.Join(lease.HostRoot, "python")
	if err := os.RemoveAll(pythonRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), pythonRoot); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	if _, err := manager.Prepare(context.Background(), request); err == nil {
		t.Fatal("symlinked dependency directory was accepted")
	}
}

func TestManagerCancelsOperationWhenUserDirectoryExceedsQuota(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{ReservationBytes: 8, ScanInterval: 5 * time.Millisecond})
	operation, err := manager.BeginOperation(context.Background(), "u1", 128)
	if err != nil {
		t.Fatal(err)
	}
	defer operation.Release()
	path := filepath.Join(dataDir, "users", "u1", "persist", "custom", "payload")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, 256), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-operation.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("quota guard did not cancel the active operation")
	}
	if !errors.Is(context.Cause(operation.Context()), ErrQuotaExceeded) || !errors.Is(operation.Err(), ErrQuotaExceeded) {
		t.Fatalf("unexpected quota cause: context=%v operation=%v", context.Cause(operation.Context()), operation.Err())
	}
}

func TestManagerLockChangeCreatesDistinctCRUDNamespaces(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(dataDir, "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(workspace, "poetry.lock")
	manager := NewManager(dataDir, Options{ReservationBytes: 8})
	request := Request{UserID: "u1", WorkspaceID: "project-a", WorkspaceName: "Project A", RuntimeID: "python:3.11", Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20}
	for _, content := range []string{"version=1", "version=2"} {
		if err := os.WriteFile(lockPath, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		lease, err := manager.Prepare(context.Background(), request)
		if err != nil {
			t.Fatal(err)
		}
		lease.Release()
	}
	entries := manager.Inspect("u1", request.QuotaBytes).Entries
	if len(entries) != 2 || entries[0].Digest == entries[1].Digest {
		t.Fatalf("lock versions were not isolated: %+v", entries)
	}
	if err := manager.Delete("u1", entries[0].Path); err != nil {
		t.Fatal(err)
	}
	if got := len(manager.Inspect("u1", request.QuotaBytes).Entries); got != 1 {
		t.Fatalf("individual digest delete left %d entries", got)
	}
	if err := manager.DeleteWorkspace("u1", request.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	if got := len(manager.Inspect("u1", request.QuotaBytes).Entries); got != 0 {
		t.Fatalf("workspace delete left %d entries", got)
	}
}

func TestManagerLRUEvictionInvalidatesIdleContainerMounts(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(dataDir, "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("demo==1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	evictions := 0
	manager := NewManager(dataDir, Options{ReservationBytes: 8, OnEvicted: func() { evictions++ }})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20}
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lease.HostRoot, "python", "payload"), make([]byte, 256), 0600); err != nil {
		t.Fatal(err)
	}
	lease.Release()
	manager.Enforce("u1", 64)
	if len(manager.Inspect("u1", 64).Entries) != 0 || evictions == 0 {
		t.Fatalf("LRU eviction did not invalidate idle mounts: evictions=%d", evictions)
	}
}

func TestManagerExposesAndReleasesFileReservation(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{
		ReservationBytes: 8,
		MaxFiles:         100,
		ReservationFiles: 7,
		ScanInterval:     time.Millisecond,
	})
	operation, err := manager.BeginOperation(context.Background(), "u1", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	info := manager.Inspect("u1", 1<<20)
	if info.QuotaFiles != 100 || info.ReservedFiles != 7 || info.UsedFiles != 0 || info.PersistFiles != 0 {
		t.Fatalf("file quota info = %+v", info)
	}
	operation.Release()
	if got := manager.Inspect("u1", 1<<20).ReservedFiles; got != 0 {
		t.Fatalf("reserved files after release = %d", got)
	}
}

func TestManagerRejectsConcurrentFileReservationsOverQuota(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{
		ReservationBytes: 8,
		MaxFiles:         10,
		ReservationFiles: 6,
		ScanInterval:     time.Millisecond,
	})
	first, err := manager.BeginOperation(context.Background(), "u1", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	if _, err := manager.BeginOperation(context.Background(), "u1", 1<<20); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("second reservation error = %v, want file quota exceeded", err)
	}
	if info := manager.Inspect("u1", 1<<20); info.ReservedFiles != 6 {
		t.Fatalf("rejected concurrent reservation leaked state: %+v", info)
	}
}

func TestManagerReservationRejectsInsufficientFileQuota(t *testing.T) {
	dataDir := t.TempDir()
	userRoot := filepath.Join(dataDir, "users", "u1")
	if err := os.MkdirAll(userRoot, 0700); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 9; index++ {
		if err := os.WriteFile(filepath.Join(userRoot, fmt.Sprintf("entry-%02d", index)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	manager := NewManager(dataDir, Options{ReservationBytes: 8, MaxFiles: 10, ReservationFiles: 2})
	if _, err := manager.BeginOperation(context.Background(), "u1", 1<<20); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("error = %v, want file quota exceeded", err)
	}
	if info := manager.Inspect("u1", 1<<20); info.UsedFiles != 9 || info.ReservedFiles != 0 {
		t.Fatalf("file quota state after rejection = %+v", info)
	}
}

func TestManagerCancelsOperationWhenUserDirectoryExceedsFileQuota(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{
		ReservationBytes: 8,
		MaxFiles:         8,
		ReservationFiles: 1,
		ScanInterval:     5 * time.Millisecond,
	})
	operation, err := manager.BeginOperation(context.Background(), "u1", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer operation.Release()
	persistRoot := filepath.Join(dataDir, "users", "u1", "persist")
	if err := os.MkdirAll(persistRoot, 0700); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 8; index++ {
		if err := os.WriteFile(filepath.Join(persistRoot, fmt.Sprintf("entry-%02d", index)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-operation.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("file quota guard did not cancel the active operation")
	}
	if !errors.Is(context.Cause(operation.Context()), ErrQuotaExceeded) || !errors.Is(operation.Err(), ErrQuotaExceeded) {
		t.Fatalf("unexpected file quota cause: context=%v operation=%v", context.Cause(operation.Context()), operation.Err())
	}
}

func TestManagerLRUEvictsZeroByteCacheByFileCount(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(dataDir, "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	evictions := 0
	manager := NewManager(dataDir, Options{
		ReservationBytes: 8,
		MaxFiles:         40,
		ReservationFiles: 1,
		OnEvicted:        func() { evictions++ },
	})
	request := Request{
		UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11",
		Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 30,
	}
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 64; index++ {
		if err := os.WriteFile(filepath.Join(lease.HostRoot, "python", fmt.Sprintf("empty-%02d", index)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	lease.Release()
	if entries := manager.Inspect("u1", request.QuotaBytes).Entries; len(entries) != 0 || evictions == 0 {
		t.Fatalf("file-count LRU did not evict zero-byte cache: entries=%+v evictions=%d", entries, evictions)
	}
}

func TestBoundedDirectoryStatsStopsAfterFileLimit(t *testing.T) {
	root := t.TempDir()
	for index := 0; index < 10; index++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("entry-%02d", index)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	usage := boundedDirectoryStats(root, 3)
	if !usage.truncated || usage.files != 4 {
		t.Fatalf("bounded usage = %+v", usage)
	}
}

func TestManagerDeletesNamespaceWithOversizedMetadata(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{})
	persistRoot := filepath.Join(dataDir, "users", "u1", "persist")
	relative := filepath.ToSlash(filepath.Join(dependenciesDir, "workspace", "runtime", "python", "digest"))
	target := filepath.Join(persistRoot, filepath.FromSlash(relative))
	if err := os.MkdirAll(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, metadataFile), make([]byte, maxMetadataBytes+1), 0600); err != nil {
		t.Fatal(err)
	}
	if err := manager.Delete("u1", relative); err != nil {
		t.Fatalf("oversized orphan metadata prevented CRUD delete: %v", err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("oversized-metadata namespace still exists: %v", err)
	}
}
