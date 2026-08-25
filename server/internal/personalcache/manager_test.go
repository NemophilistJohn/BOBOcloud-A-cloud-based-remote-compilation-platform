package personalcache

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
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
	request := Request{UserID: "u1", WorkspaceID: "project-a", WorkspaceName: "Project A", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20}
	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Hit || first.DockerEnv["PIP_TARGET"] != "/project-deps/python" {
		t.Fatalf("first lease = %+v", first)
	}
	first.Release()
	if !first.Published() {
		t.Fatal("first writable generation was not reported as published")
	}
	second, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Hit || second.ContainerKey == first.ContainerKey {
		t.Fatalf("second writer did not receive an isolated staging generation: hit=%v first=%q second=%q", second.Hit, first.ContainerKey, second.ContainerKey)
	}
	second.Release()
	if !second.Published() {
		t.Fatal("staged writable generation was not reported as published")
	}
	entries := manager.Inspect("u1", 1<<20).Entries
	if len(entries) != 1 || entries[0].WorkspaceName != "Project A" || entries[0].Digest == "" {
		t.Fatalf("entries = %+v", entries)
	}
}

func TestGenerationCallbackIncludesInitialAndReplacementPublications(t *testing.T) {
	type publication struct {
		cacheKey   string
		generation string
		sequence   uint64
	}
	var published []publication
	manager := NewManager(t.TempDir(), Options{
		ReservationBytes: 8,
		OnGenerationChanged: func(cacheKey, generation string, sequence uint64) {
			published = append(published, publication{cacheKey: cacheKey, generation: generation, sequence: sequence})
		},
	})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: t.TempDir(), QuotaBytes: 1 << 20}

	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	first.Release()
	second, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	second.Release()

	if len(published) != 2 {
		t.Fatalf("generation callbacks = %#v", published)
	}
	if published[0].cacheKey != first.Key || published[0].generation != first.Generation || published[0].sequence == 0 {
		t.Fatalf("initial publication = %#v, lease key=%q generation=%q", published[0], first.Key, first.Generation)
	}
	if published[1].cacheKey != second.Key || published[1].generation != second.Generation || published[1].sequence <= published[0].sequence {
		t.Fatalf("replacement publication = %#v after %#v", published[1], published[0])
	}
}

func TestManagerWriterWaitIsCancelableWithoutReservationLeak(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(dataDir, "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(dataDir, Options{ReservationBytes: 10})
	request := Request{UserID: "u1", WorkspaceID: "project-a", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20}
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

func TestReadOnlyExecutionUsesPublishedGenerationWhileWriterStages(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	workspace := t.TempDir()
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20}
	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(first.HostRoot, "python"), "numpy", "2.2.6")
	first.Release()

	reader, err := manager.PrepareReadOnly(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release()
	if reader.Writable() || reader.Generation == "" || reader.DockerMounts[reader.HostRoot] != "/project-deps:ro" {
		t.Fatalf("read-only lease = %+v", reader)
	}
	if reader.DockerEnv["PYTHONPATH"] != "/project-deps/python" || reader.DockerEnv["PIP_TARGET"] != "" {
		t.Fatalf("read-only lease exposed installer environment: %+v", reader.DockerEnv)
	}

	writer, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !reader.reader.Stable() {
		t.Fatal("published generation changed while the writer was only staging")
	}
	if inventory := manager.InspectPackageInventory(request); inventory.State != "ready" || !inventory.Exact {
		t.Fatalf("staging writer hid the last published inventory: %+v", inventory)
	}
	writeInventoryDistInfo(t, filepath.Join(writer.HostRoot, "python"), "matplotlib", "3.10.9")
	writer.Release()
	if reader.reader.Stable() {
		t.Fatal("reader revision did not change after publication")
	}

	next, err := manager.PrepareReadOnly(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Release()
	if next.Generation == reader.Generation {
		t.Fatalf("published generation did not advance: %q", next.Generation)
	}
	if inventory := manager.InspectPackageInventory(request); inventory.State != "ready" || len(inventory.Packages) != 2 {
		t.Fatalf("published staged inventory = %+v", inventory)
	}
}

func TestRetiredGenerationCleanupTracksExactReaderGeneration(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: t.TempDir(), QuotaBytes: 1 << 20}
	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(first.HostRoot, "python"), "numpy", "2.2.6")
	first.Release()

	oldReader, err := manager.PrepareReadOnly(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	oldGeneration := dependencyGeneration{cacheKey: oldReader.Key, generation: oldReader.Generation}
	writer, err := manager.Prepare(context.Background(), request)
	if err != nil {
		oldReader.Release()
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(writer.HostRoot, "python"), "matplotlib", "3.10.9")
	writer.Release()

	manager.mu.Lock()
	retired := append([]string(nil), manager.retired[oldGeneration]...)
	manager.mu.Unlock()
	if len(retired) != 1 {
		oldReader.Release()
		t.Fatalf("retired paths for old generation = %#v", retired)
	}
	if _, err := os.Stat(retired[0]); err != nil {
		oldReader.Release()
		t.Fatalf("old generation was removed while its reader was active: %v", err)
	}

	newReader, err := manager.PrepareReadOnly(context.Background(), request)
	if err != nil {
		oldReader.Release()
		t.Fatal(err)
	}
	defer newReader.Release()
	if newReader.Generation == oldReader.Generation {
		oldReader.Release()
		t.Fatalf("replacement generation did not advance: %q", newReader.Generation)
	}
	newGeneration := dependencyGeneration{cacheKey: newReader.Key, generation: newReader.Generation}

	oldReader.Release()
	if _, err := os.Stat(retired[0]); !os.IsNotExist(err) {
		t.Fatalf("old retired generation survived its last reader release: %v", err)
	}
	manager.mu.Lock()
	newReaders := manager.readers[newGeneration]
	_, oldReadersRemain := manager.readers[oldGeneration]
	_, oldRetiredRemain := manager.retired[oldGeneration]
	manager.mu.Unlock()
	if newReaders != 1 || oldReadersRemain || oldRetiredRemain {
		t.Fatalf("generation reader state after old release: new=%d old_readers=%v old_retired=%v", newReaders, oldReadersRemain, oldRetiredRemain)
	}
	if !newReader.reader.Stable() {
		t.Fatal("new generation reader stopped being active when the old generation was cleaned")
	}
}

func TestRejectedInitialGenerationCleanupCannotDeleteNextWriter(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: t.TempDir(), QuotaBytes: 1 << 20}
	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	first.Abort()

	cleanupReady := make(chan []string, 1)
	allowCleanup := make(chan struct{})
	var cleanupPause sync.Once
	var allowCleanupOnce sync.Once
	manager.testBeforeReleaseCleanup = func(paths []string) {
		cleanupPause.Do(func() {
			cleanupReady <- append([]string(nil), paths...)
			<-allowCleanup
		})
	}
	t.Cleanup(func() {
		allowCleanupOnce.Do(func() { close(allowCleanup) })
	})

	type prepareResult struct {
		lease *Lease
		err   error
	}
	secondResult := make(chan prepareResult, 1)
	go func() {
		lease, prepareErr := manager.Prepare(context.Background(), request)
		secondResult <- prepareResult{lease: lease, err: prepareErr}
	}()
	deadline := time.Now().Add(time.Second)
	for {
		manager.mu.Lock()
		waiting := manager.writerDone[first.Key] != nil
		manager.mu.Unlock()
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("second writer did not begin waiting for the first generation")
		}
		time.Sleep(time.Millisecond)
	}

	firstReleased := make(chan struct{})
	go func() {
		first.Release()
		close(firstReleased)
	}()
	cleanupPaths := <-cleanupReady
	for _, cleanupPath := range cleanupPaths {
		if filepath.Clean(cleanupPath) == filepath.Clean(first.canonical) {
			t.Fatalf("rejected canonical was scheduled for unlocked deletion: %q", cleanupPath)
		}
	}
	second := <-secondResult
	if second.err != nil || second.lease == nil {
		t.Fatalf("second writer prepare: lease=%v err=%v", second.lease != nil, second.err)
	}
	if second.lease.Hit {
		t.Fatal("second writer adopted the rejected first generation")
	}
	sentinel := filepath.Join(second.lease.HostRoot, "second-writer")
	if err := os.WriteFile(sentinel, []byte("alive"), 0600); err != nil {
		t.Fatal(err)
	}
	allowCleanupOnce.Do(func() { close(allowCleanup) })
	<-firstReleased
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "alive" {
		t.Fatalf("first writer cleanup deleted the second generation: data=%q err=%v", data, err)
	}
	second.lease.Abort()
	second.lease.Release()
}

func TestInitialMetadataCommitFailureDetachesCanonicalBeforeNextWriter(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: t.TempDir(), QuotaBytes: 1 << 20}
	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	metadataPath := filepath.Join(first.HostRoot, metadataFile)
	if err := os.Remove(metadataPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(metadataPath, 0700); err != nil {
		t.Fatal(err)
	}
	first.Release()
	if first.Published() {
		t.Fatal("generation with failed metadata commit was published")
	}
	if _, err := os.Stat(first.canonical); !os.IsNotExist(err) {
		t.Fatalf("failed initial canonical survived release: %v", err)
	}

	second, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Release()
	if second.Hit {
		t.Fatal("next writer adopted a generation whose metadata commit failed")
	}
}

func TestReadOnlyMissDoesNotPublishDependencyNamespace(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: t.TempDir(), QuotaBytes: 1 << 20}
	lease, err := manager.PrepareReadOnly(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if lease != nil {
		lease.Release()
		t.Fatalf("read-only miss manufactured a dependency generation: %+v", lease)
	}
	if entries := manager.Inspect(request.UserID, request.QuotaBytes).Entries; len(entries) != 0 {
		t.Fatalf("read-only miss persisted dependency entries: %+v", entries)
	}
	if inspection := manager.InspectPackageInventory(request); inspection.State != "missing" || inspection.Exact {
		t.Fatalf("read-only miss inventory = %+v", inspection)
	}
}

func TestReadOnlyLeaseReleaseUnlocksCRUDAndRefreshesLRU(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{ReservationBytes: 8})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: t.TempDir(), QuotaBytes: 1 << 20}
	writable, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(writable.HostRoot, "python"), "numpy", "2.2.6")
	writable.Release()
	entries := manager.Inspect(request.UserID, request.QuotaBytes).Entries
	if len(entries) != 1 {
		t.Fatalf("entries = %+v", entries)
	}
	oldLastUsed := entries[0].LastUsed
	time.Sleep(2 * time.Millisecond)

	reader, err := manager.PrepareReadOnly(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if len(reader.DockerMounts) != 1 || reader.DockerMounts[reader.HostRoot] != "/project-deps:ro" {
		reader.Release()
		t.Fatalf("read-only dependency mounts = %#v", reader.DockerMounts)
	}
	if err := manager.Delete(request.UserID, reader.RelativePath); !errors.Is(err, ErrCacheInUse) {
		t.Fatalf("active reader delete error = %v", err)
	}
	reader.Release()
	entries = manager.Inspect(request.UserID, request.QuotaBytes).Entries
	if len(entries) != 1 || !entries[0].LastUsed.After(oldLastUsed) {
		t.Fatalf("read-only use did not refresh LRU: before=%s entries=%+v", oldLastUsed, entries)
	}
	if err := manager.Delete(request.UserID, reader.RelativePath); err != nil {
		t.Fatalf("released reader left cache locked: %v", err)
	}
}

func TestLongLivedReadDoesNotBlockDistinctDependencyLRU(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{ReservationBytes: 8})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: t.TempDir(), QuotaBytes: 1 << 20}
	writable, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writable.Release()

	idleRequest := request
	idleRequest.WorkspaceID = "idle-project"
	idleRequest.WorkspaceRoot = t.TempDir()
	idle, err := manager.Prepare(context.Background(), idleRequest)
	if err != nil {
		t.Fatal(err)
	}
	idleRoot := idle.HostRoot
	if err := os.WriteFile(filepath.Join(idleRoot, "payload"), make([]byte, 4096), 0600); err != nil {
		idle.Abort()
		idle.Release()
		t.Fatal(err)
	}
	idle.Release()
	reader, _, exists, err := manager.AcquireRead(request)
	if err != nil || !exists || reader == nil {
		t.Fatalf("acquire read: exists=%v reader=%v err=%v", exists, reader != nil, err)
	}
	defer reader.Release()

	manager.Enforce(request.UserID, 1)
	if _, err := os.Stat(idleRoot); !os.IsNotExist(err) {
		t.Fatalf("long-lived project reader blocked distinct cache-v2 dependency eviction: %v", err)
	}
	if !reader.Stable() {
		t.Fatal("distinct cache-v2 dependency eviction changed the retained project generation")
	}
}

func TestStagingCloneDoesNotConsumeLogicalWriteQuota(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{ReservationBytes: 8, ScanInterval: 5 * time.Millisecond})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: t.TempDir(), QuotaBytes: 1 << 20}
	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(first.HostRoot, "python"), "numpy", "2.2.6")
	packageFile := filepath.Join(first.HostRoot, "python", "numpy", "__init__.py")
	if err := os.WriteFile(packageFile, make([]byte, 128<<10), 0600); err != nil {
		t.Fatal(err)
	}
	first.Release()
	used := manager.Inspect(request.UserID, request.QuotaBytes).UsedBytes
	request.QuotaBytes = used + 16<<10
	writer, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	guard := writer.StartGuard(context.Background())
	select {
	case <-guard.Context.Done():
		t.Fatalf("staging copy exhausted logical quota: %v", context.Cause(guard.Context))
	case <-time.After(30 * time.Millisecond):
	}
	writer.Abort()
	writer.Release()
	if writer.Published() {
		t.Fatal("aborted writer was reported as published")
	}
}

func TestAbortedStagingGenerationPreservesPublishedCache(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	workspace := t.TempDir()
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20}
	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(first.HostRoot, "python"), "numpy", "2.2.6")
	first.Release()
	before, err := manager.PrepareReadOnly(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	beforeGeneration := before.Generation
	before.Release()

	writer, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(writer.HostRoot, "python"), "broken-install", "1.0.0")
	writer.Abort()
	writer.Release()
	after, err := manager.PrepareReadOnly(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer after.Release()
	if after.Generation != beforeGeneration {
		t.Fatalf("aborted generation was published: before=%q after=%q", beforeGeneration, after.Generation)
	}
	if inventory := manager.InspectPackageInventory(request); inventory.State != "ready" || len(inventory.Packages) != 1 || inventory.Packages[0].Name != "numpy" {
		t.Fatalf("aborted writer polluted inventory: %+v", inventory)
	}
}

func TestUnverifiableStagingGenerationPreservesPublishedCache(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: t.TempDir(), QuotaBytes: 1 << 20}
	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(first.HostRoot, "python"), "numpy", "2.2.6")
	first.Release()
	before, err := manager.PrepareReadOnly(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	beforeGeneration := before.Generation
	before.Release()

	writer, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(writer.HostRoot, "python", "unowned-package"), []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	writer.Release()
	after, err := manager.PrepareReadOnly(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer after.Release()
	if after.Generation != beforeGeneration {
		t.Fatalf("unverifiable staging generation replaced the published cache: before=%q after=%q", beforeGeneration, after.Generation)
	}
	if inspection := manager.InspectPackageInventory(request); inspection.State != "ready" || len(inspection.Packages) != 1 || inspection.Packages[0].Name != "numpy" {
		t.Fatalf("published inventory was polluted: %+v", inspection)
	}
}

func TestManagerReservationRejectsInsufficientQuota(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(dataDir, "workspace")
	_ = os.MkdirAll(workspace, 0700)
	manager := NewManager(dataDir, Options{ReservationBytes: 1024})
	_, err := manager.Prepare(context.Background(), Request{UserID: "u1", WorkspaceID: "p", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: workspace, QuotaBytes: 100})
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("error = %v, want quota exceeded", err)
	}
}

func TestManagerListsAndDeletesOrphanedNamespace(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{})
	orphan := filepath.Join(dataDir, "users", "u1", cacheRootDir, dependenciesDir, "workspace", "runtime", "python", "digest")
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

func TestPrepareClearsInvalidCanonicalInsteadOfAdoptingItsFiles(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{ReservationBytes: 8})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: t.TempDir(), QuotaBytes: 1 << 20}
	resolved, err := manager.resolveRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	staleFile := filepath.Join(resolved.hostRoot, "python", "stale-package.py")
	if err := os.MkdirAll(filepath.Dir(staleFile), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staleFile, []byte("stale"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resolved.hostRoot, metadataFile), []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}

	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if lease.Hit {
		t.Fatal("invalid canonical metadata was treated as a cache hit")
	}
	if _, err := os.Stat(staleFile); !os.IsNotExist(err) {
		t.Fatalf("invalid canonical payload was adopted by the new generation: %v", err)
	}
}

func TestPrepareDoesNotClearInvalidCanonicalHeldByReader(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: t.TempDir(), QuotaBytes: 1 << 20}
	writable, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writable.Release()
	reader, entry, exists, err := manager.AcquireRead(request)
	if err != nil || !exists || reader == nil {
		t.Fatalf("acquire read: exists=%v reader=%v err=%v", exists, reader != nil, err)
	}
	defer reader.Release()
	if err := os.WriteFile(filepath.Join(entry.HostPath, metadataFile), []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Prepare(context.Background(), request); !errors.Is(err, ErrCacheInUse) {
		t.Fatalf("prepare error = %v, want cache in use", err)
	}
	if _, err := os.Stat(entry.HostPath); err != nil {
		t.Fatalf("active invalid canonical was removed: %v", err)
	}
}

func TestPortableClonePreservesFileAndDirectoryMetadata(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	destination := filepath.Join(root, "destination")
	child := filepath.Join(source, "bin")
	file := filepath.Join(child, "tool")
	if err := os.MkdirAll(child, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("payload"), 0751); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(source, 0550); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(child, 0510); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(source, 0700)
		_ = os.Chmod(child, 0700)
	})
	if err := os.Chmod(file, 0751); err != nil {
		t.Fatal(err)
	}
	fileTime := time.Unix(1_700_000_100, 0).UTC()
	childTime := time.Unix(1_700_000_200, 0).UTC()
	rootTime := time.Unix(1_700_000_300, 0).UTC()
	if err := os.Chtimes(file, fileTime, fileTime); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(child, childTime, childTime); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(source, rootTime, rootTime); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	if err := cloneDependencyTreePortable(source, destination); err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{
		{source, destination},
		{child, filepath.Join(destination, "bin")},
		{file, filepath.Join(destination, "bin", "tool")},
	} {
		sourceInfo, err := os.Stat(pair[0])
		if err != nil {
			t.Fatal(err)
		}
		targetInfo, err := os.Stat(pair[1])
		if err != nil {
			t.Fatal(err)
		}
		if sourceInfo.Mode().Perm() != targetInfo.Mode().Perm() {
			t.Fatalf("mode %s = %s, want %s", pair[1], targetInfo.Mode().Perm(), sourceInfo.Mode().Perm())
		}
		if !sourceInfo.ModTime().Equal(targetInfo.ModTime()) {
			t.Fatalf("mtime %s = %s, want %s", pair[1], targetInfo.ModTime(), sourceInfo.ModTime())
		}
	}
	data, err := os.ReadFile(filepath.Join(destination, "bin", "tool"))
	if err != nil || string(data) != "payload" {
		t.Fatalf("cloned file = %q err=%v", data, err)
	}
}

func TestManagerRecoversCompletedTransactionAndRemovesHiddenStaging(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{ReservationBytes: 8})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: t.TempDir(), QuotaBytes: 1 << 20}
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.2.6")
	lease.Release()
	canonical := lease.HostRoot
	cacheRoot := filepath.Join(dataDir, "users", request.UserID, cacheRootDir)
	stagingRoot := filepath.Join(cacheRoot, stagingDir)
	if err := os.MkdirAll(stagingRoot, 0700); err != nil {
		t.Fatal(err)
	}
	completed := filepath.Join(stagingRoot, "generation-completed")
	if err := os.Rename(canonical, completed); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(stagingRoot, "generation-stale")
	if err := os.MkdirAll(stale, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stale, "partial"), []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}

	recovered := NewManager(dataDir, Options{ReservationBytes: 8})
	recovered.RecoverOrphanedTransactions()
	if inspection := recovered.InspectPackageInventory(request); inspection.State != "ready" || len(inspection.Packages) != 1 || inspection.Packages[0].Name != "numpy" {
		t.Fatalf("completed transaction was not recovered: %+v", inspection)
	}
	if _, err := os.Stat(stagingRoot); !os.IsNotExist(err) {
		t.Fatalf("hidden staging data survived startup recovery: %v", err)
	}
}

func TestManagerRecoversOnlyVerifiedCompletedNodeTransaction(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{ReservationBytes: 8})
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "package.json"), []byte("{\"name\":\"demo\",\"dependencies\":{\"lodash\":\"4.17.21\"}}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	request := Request{
		UserID: "u1", WorkspaceID: "node-project", RuntimeID: "node:20", RuntimeFingerprint: trustedTestRuntimeFingerprint,
		Language: "node", WorkspaceRoot: workspace, QuotaBytes: 1 << 20,
	}
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeNodeInventoryPackage(t, filepath.Join(lease.HostRoot, "node_modules"), "lodash", "lodash", "4.17.21")
	lease.Release()
	canonical := lease.HostRoot
	cacheRoot := filepath.Join(dataDir, "users", request.UserID, cacheRootDir)
	stagingRoot := filepath.Join(cacheRoot, stagingDir)
	if err := os.MkdirAll(stagingRoot, 0700); err != nil {
		t.Fatal(err)
	}
	completed := filepath.Join(stagingRoot, "generation-completed-node")
	if err := os.Rename(canonical, completed); err != nil {
		t.Fatal(err)
	}

	recovered := NewManager(dataDir, Options{ReservationBytes: 8})
	recovered.RecoverOrphanedTransactions()
	inspection := recovered.InspectPackageInventory(request)
	if inspection.State != "ready" || !inspection.Exact || len(inspection.Packages) != 1 || inspection.Packages[0].Name != "lodash" {
		t.Fatalf("completed Node transaction was not recovered: %+v", inspection)
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
		UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint,
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
		UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint,
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
	path := filepath.Join(dataDir, "users", "u1", cacheRootDir, "transactions", "quota-test", "payload")
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
	request := Request{UserID: "u1", WorkspaceID: "project-a", WorkspaceName: "Project A", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20}
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
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20}
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
	if info.QuotaFiles != 100 || info.ReservedFiles != 7 || info.PersistFiles == 0 || info.UsedFiles != info.PersistFiles+1 {
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
		MaxFiles:         1000,
		ReservationFiles: 6,
		ScanInterval:     time.Millisecond,
	})
	if _, err := manager.ensureUserLayout("u1"); err != nil {
		t.Fatal(err)
	}
	baseline := manager.Inspect("u1", 1<<20).UsedFiles
	manager.options.MaxFiles = baseline + 11
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
	manager := NewManager(dataDir, Options{ReservationBytes: 8, MaxFiles: 1000, ReservationFiles: 2})
	if _, err := manager.ensureUserLayout("u1"); err != nil {
		t.Fatal(err)
	}
	baseline := manager.Inspect("u1", 1<<20).UsedFiles
	manager.options.MaxFiles = baseline + 1
	if _, err := manager.BeginOperation(context.Background(), "u1", 1<<20); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("error = %v, want file quota exceeded", err)
	}
	if info := manager.Inspect("u1", 1<<20); info.UsedFiles != baseline || info.ReservedFiles != 0 {
		t.Fatalf("file quota state after rejection = %+v", info)
	}
}

func TestManagerCancelsOperationWhenUserDirectoryExceedsFileQuota(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{
		ReservationBytes: 8,
		MaxFiles:         1000,
		ReservationFiles: 1,
		ScanInterval:     5 * time.Millisecond,
	})
	if _, err := manager.ensureUserLayout("u1"); err != nil {
		t.Fatal(err)
	}
	baseline := manager.Inspect("u1", 1<<20).UsedFiles
	manager.options.MaxFiles = baseline + 4
	operation, err := manager.BeginOperation(context.Background(), "u1", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer operation.Release()
	cacheRoot := filepath.Join(dataDir, "users", "u1", cacheRootDir, "transactions", "quota-test")
	if err := os.MkdirAll(cacheRoot, 0700); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 8; index++ {
		if err := os.WriteFile(filepath.Join(cacheRoot, fmt.Sprintf("entry-%02d", index)), nil, 0600); err != nil {
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
		UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint,
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
	cacheRoot := filepath.Join(dataDir, "users", "u1", cacheRootDir)
	relative := filepath.ToSlash(filepath.Join(dependenciesDir, "workspace", "runtime", "python", "digest"))
	target := filepath.Join(cacheRoot, filepath.FromSlash(relative))
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

func TestManagerFreshGenerationSkipsCloningPublishedDependencyTree(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(dataDir, "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("demo==1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(dataDir, Options{ReservationBytes: 8})
	request := Request{UserID: "u1", WorkspaceID: "project", RuntimeID: "python:3.11", RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "python", WorkspaceRoot: workspace, QuotaBytes: 1 << 20}
	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(first.HostRoot, "python", "old-generation.txt")
	if err := os.WriteFile(marker, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	first.Release()
	if !first.Published() {
		t.Fatal("initial generation was not published")
	}

	request.FreshGeneration = true
	staged, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !staged.Hit || staged.HostRoot == first.HostRoot {
		t.Fatalf("fresh staging lease = %+v", staged)
	}
	if _, err := os.Stat(filepath.Join(staged.HostRoot, "python", "old-generation.txt")); !errors.Is(err, os.ErrNotExist) {
		staged.Abort()
		staged.Release()
		t.Fatalf("published dependency bytes were cloned into fresh staging: %v", err)
	}
	reader, err := manager.PrepareReadOnly(context.Background(), request)
	if err != nil || reader == nil {
		staged.Abort()
		staged.Release()
		t.Fatalf("published generation was unavailable during fresh staging: lease=%v err=%v", reader, err)
	}
	if _, err := os.Stat(filepath.Join(reader.HostRoot, "python", "old-generation.txt")); err != nil {
		reader.Release()
		staged.Abort()
		staged.Release()
		t.Fatalf("fresh staging changed the published reader: %v", err)
	}
	reader.Release()
	staged.Abort()
	staged.Release()
}

func TestManagerAppliesNodeMaterializationPolicyToWorkspaceAndSnapshotRequests(t *testing.T) {
	dataDir := t.TempDir()
	workspace := t.TempDir()
	packageJSON := []byte(`{"name":"demo","dependencies":{"lodash":"4.17.21"}}`)
	lockfile := []byte(`{"lockfileVersion":3,"packages":{"node_modules/lodash":{"version":"4.17.21"}}}`)
	if err := os.WriteFile(filepath.Join(workspace, "package.json"), packageJSON, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "package-lock.json"), lockfile, 0600); err != nil {
		t.Fatal(err)
	}
	request := Request{
		UserID: "u1", WorkspaceID: "node-project", RuntimeID: "node:20", RuntimeFingerprint: trustedTestRuntimeFingerprint,
		Language: "node", WorkspaceRoot: workspace, QuotaBytes: 1 << 20,
	}
	enabled := NewManager(dataDir, Options{NodeMaterializationPolicy: NodeDependencyMaterializationPolicy(true, "10.32.1")})
	enabledWorkspace, err := enabled.resolveRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	request.ManifestSnapshot = []ManifestSnapshot{
		{Path: "package.json", Content: packageJSON},
		{Path: "package-lock.json", Content: lockfile},
	}
	enabledSnapshot, err := enabled.resolveRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	if enabledWorkspace.fingerprint.Digest != enabledSnapshot.fingerprint.Digest {
		t.Fatalf("Manager workspace and snapshot identities diverged: workspace=%+v snapshot=%+v", enabledWorkspace.fingerprint, enabledSnapshot.fingerprint)
	}
	disabled := NewManager(dataDir, Options{NodeMaterializationPolicy: NodeDependencyMaterializationPolicy(false, "10.32.1")})
	disabledSnapshot, err := disabled.resolveRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	if enabledSnapshot.fingerprint.Digest == disabledSnapshot.fingerprint.Digest {
		t.Fatalf("Manager Node policy switch reused generation %s", enabledSnapshot.fingerprint.Digest)
	}
	request.MaterializationPolicy = NodeDependencyMaterializationPolicy(true, "10.32.1")
	pinned, err := disabled.resolveRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	if pinned.fingerprint.Digest != enabledSnapshot.fingerprint.Digest {
		t.Fatalf("request-pinned transaction did not match Manager consumer policy: pinned=%+v enabled=%+v", pinned.fingerprint, enabledSnapshot.fingerprint)
	}
}
