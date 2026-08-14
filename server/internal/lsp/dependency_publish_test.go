package lsp

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func nodeSnapshotFixture(t *testing.T, root, name string, size int) (string, string) {
	t.Helper()
	manifest := filepath.Join(root, name, "workspace")
	modules := filepath.Join(root, name, "run", "node_modules", "pkg")
	if err := os.MkdirAll(manifest, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(modules, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(manifest, "package.json"), []byte(`{"name":"`+name+`"}`), 0644); err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, size)
	for index := range payload {
		payload[index] = byte((index + len(name)) % 251)
	}
	if err := os.WriteFile(filepath.Join(modules, "index.js"), payload, 0644); err != nil {
		t.Fatal(err)
	}
	return manifest, filepath.Dir(modules)
}

func nodeSnapshotFixtureCharge() int64 {
	// node_modules root, package directory, and package file.
	return 3 * NodeDependencyEntryChargeBytes
}

func TestPublishNodeDependencySnapshotIsContentAddressedAndResolvable(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	modules := filepath.Join(root, "run", "node_modules")
	if err := os.MkdirAll(filepath.Join(modules, "left-pad"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workspace, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "package-lock.json"), []byte(`{"lockfileVersion":3}`), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(modules, "left-pad", "index.js"), []byte("module.exports = 1"), 0644); err != nil {
		t.Fatal(err)
	}
	result, err := PublishNodeDependencySnapshot(filepath.Join(root, "persist"), "personal-folder", workspace, "node:20", "node:20-slim", modules)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.Revision == "" || NodeDependencySnapshot(filepath.Join(root, "persist"), "personal-folder", "node:20") != result.Path {
		t.Fatalf("snapshot = %+v", result)
	}
	if _, err := os.Stat(filepath.Join(result.Path, "left-pad", "index.js")); err != nil {
		t.Fatal(err)
	}
	secondModules := filepath.Join(root, "second-run", "node_modules", "left-pad")
	if err := os.MkdirAll(secondModules, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secondModules, "index.js"), []byte("module.exports = 1"), 0644); err != nil {
		t.Fatal(err)
	}
	second, err := PublishNodeDependencySnapshot(filepath.Join(root, "persist"), "personal-folder", workspace, "node:20", "node:20-slim", filepath.Dir(secondModules))
	if err != nil {
		t.Fatal(err)
	}
	if second.Revision != result.Revision || second.Changed {
		t.Fatalf("same installed tree published duplicate generation: first=%+v second=%+v", result, second)
	}
	changedModules := filepath.Join(root, "changed-run", "node_modules", "left-pad")
	if err := os.MkdirAll(changedModules, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(changedModules, "index.js"), []byte("module.exports = 2"), 0644); err != nil {
		t.Fatal(err)
	}
	changed, err := PublishNodeDependencySnapshot(filepath.Join(root, "persist"), "personal-folder", workspace, "node:20", "node:20-slim", filepath.Dir(changedModules))
	if err != nil {
		t.Fatal(err)
	}
	if changed.Revision == result.Revision || !changed.Changed {
		t.Fatalf("changed installed tree reused old generation: first=%+v changed=%+v", result, changed)
	}
	differentImageModules := filepath.Join(root, "different-image", "node_modules", "left-pad")
	if err := os.MkdirAll(differentImageModules, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(differentImageModules, "index.js"), []byte("module.exports = 1"), 0644); err != nil {
		t.Fatal(err)
	}
	differentImage, err := PublishNodeDependencySnapshot(filepath.Join(root, "persist"), "personal-folder", workspace, "node:20", "node:20-bookworm-slim", filepath.Dir(differentImageModules))
	if err != nil {
		t.Fatal(err)
	}
	if differentImage.Revision == result.Revision || !differentImage.Changed {
		t.Fatalf("different runtime image reused old generation: first=%+v changed=%+v", result, differentImage)
	}
}

func TestPublishNodeDependencySnapshotMarksRetainedRollbackAsChanged(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "store")
	manifestA, modulesA := nodeSnapshotFixture(t, root, "rollback-a", 30)
	first, err := PublishNodeDependencySnapshot(base, "workspace", manifestA, "node:20", "image", modulesA)
	if err != nil {
		t.Fatal(err)
	}
	manifestB, modulesB := nodeSnapshotFixture(t, root, "rollback-b", 30)
	second, err := PublishNodeDependencySnapshot(base, "workspace", manifestB, "node:20", "image", modulesB)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision == second.Revision || !second.Changed {
		t.Fatalf("second snapshot = %+v; first = %+v", second, first)
	}

	manifestAAgain, modulesAAgain := nodeSnapshotFixture(t, root, "rollback-a", 30)
	rolledBack, err := PublishNodeDependencySnapshot(base, "workspace", manifestAAgain, "node:20", "image", modulesAAgain)
	if err != nil {
		t.Fatal(err)
	}
	if rolledBack.Revision != first.Revision || !rolledBack.Changed {
		t.Fatalf("retained rollback did not change active view: first=%+v second=%+v rollback=%+v", first, second, rolledBack)
	}
	if got := NodeDependencySnapshot(base, "workspace", "node:20"); got != rolledBack.Path {
		t.Fatalf("active rollback path = %q, want %q", got, rolledBack.Path)
	}
}

func TestNodeDependencySnapshotRejectsInvalidMarker(t *testing.T) {
	root := t.TempDir()
	snapshotRoot := nodeSnapshotWorkspaceRoot(filepath.Join(root, "persist"), "personal-folder", "node:20")
	if err := os.MkdirAll(snapshotRoot, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(snapshotRoot, nodeSnapshotCurrentFile), []byte("../../outside"), 0644); err != nil {
		t.Fatal(err)
	}
	if got := NodeDependencySnapshot(filepath.Join(root, "persist"), "personal-folder", "node:20"); got != "" {
		t.Fatalf("invalid marker resolved to %q", got)
	}
}

func TestDependencyTreeSizeIsBounded(t *testing.T) {
	root := t.TempDir()
	file, err := os.Create(filepath.Join(root, "huge"))
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(nodeSnapshotMaxBytes + 1); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	if _, err := dependencyTreeSize(root); !errors.Is(err, ErrDependencySnapshotTooLarge) {
		t.Fatalf("size error = %v", err)
	}
}

func TestDependencyTreeStateChargesEveryEntry(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "empty-directory"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "empty-file"), nil, 0644); err != nil {
		t.Fatal(err)
	}
	usage, _, err := dependencyTreeState(root)
	if err != nil {
		t.Fatal(err)
	}
	if usage.LogicalBytes != 0 || usage.Entries != 3 || usage.ChargedBytes != 3*NodeDependencyEntryChargeBytes {
		t.Fatalf("empty tree usage = %+v", usage)
	}

	if err := os.Symlink("empty-file", filepath.Join(root, "empty-link")); err != nil {
		t.Logf("symlink charge assertion skipped: %v", err)
		return
	}
	usage, _, err = dependencyTreeState(root)
	if err != nil {
		t.Fatal(err)
	}
	if usage.Entries != 4 || usage.ChargedBytes != 4*NodeDependencyEntryChargeBytes {
		t.Fatalf("tree usage with symlink = %+v", usage)
	}
}

func TestNodeDependencyFingerprintRejectsUnsafeManifests(t *testing.T) {
	t.Run("oversized", func(t *testing.T) {
		root := t.TempDir()
		file, err := os.Create(filepath.Join(root, "package-lock.json"))
		if err != nil {
			t.Fatal(err)
		}
		if err := file.Truncate(nodeDependencyManifestMaxBytes + 1); err != nil {
			_ = file.Close()
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		if _, err := nodeDependencyFingerprint(root, "node:20", "image", "tree"); err == nil {
			t.Fatal("oversized lock file was accepted")
		}
	})

	t.Run("non-regular", func(t *testing.T) {
		root := t.TempDir()
		if err := os.Mkdir(filepath.Join(root, "package.json"), 0755); err != nil {
			t.Fatal(err)
		}
		if _, err := nodeDependencyFingerprint(root, "node:20", "image", "tree"); err == nil {
			t.Fatal("non-regular package manifest was accepted")
		}
	})

	t.Run("symlink", func(t *testing.T) {
		root := t.TempDir()
		outside := filepath.Join(t.TempDir(), "package.json")
		if err := os.WriteFile(outside, []byte(`{"name":"outside"}`), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(root, "package.json")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		if _, err := nodeDependencyFingerprint(root, "node:20", "image", "tree"); err == nil {
			t.Fatal("symlinked package manifest was accepted")
		}
	})
}

func TestCopyDependencyTreeHandlesManyFiles(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source")
	target := filepath.Join(t.TempDir(), "target")
	if err := os.MkdirAll(source, 0755); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 2048; index++ {
		name := filepath.Join(source, fmt.Sprintf("module-%04d.js", index))
		if err := os.WriteFile(name, []byte("module.exports = 1"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	usage, fingerprint, err := dependencyTreeState(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := copyDependencyTree(source, target, usage, fingerprint); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(target, "module-2047.js")); err != nil {
		t.Fatal(err)
	}
}

func TestCopyDependencyTreeRejectsTreeChangedAfterScan(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source")
	target := filepath.Join(t.TempDir(), "target")
	if err := os.MkdirAll(source, 0755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(source, "module.js")
	if err := os.WriteFile(file, []byte("before"), 0644); err != nil {
		t.Fatal(err)
	}
	usage, fingerprint, err := dependencyTreeState(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("after-growth"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := copyDependencyTree(source, target, usage, fingerprint); err == nil {
		t.Fatal("changed dependency tree was copied")
	}
}

func TestDeleteNodeDependencyWorkspaceRespectsActiveSnapshotLease(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "persist")
	workspaceID := "personal-folder"
	manifest := filepath.Join(root, "workspace")
	modules := filepath.Join(root, "run", "node_modules", "pkg")
	if err := os.MkdirAll(manifest, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(modules, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(modules, "index.js"), []byte("module.exports = 1"), 0644); err != nil {
		t.Fatal(err)
	}
	published, err := PublishNodeDependencySnapshot(base, workspaceID, manifest, "node:20", "node:20-slim", filepath.Dir(modules))
	if err != nil {
		t.Fatal(err)
	}
	release, err := acquireDependencySnapshotMounts(AnalysisDependencyView{Mounts: []AnalysisDependencyMount{{HostPath: published.Path, Managed: true}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := DeleteNodeDependencyWorkspace(base, workspaceID); !errors.Is(err, ErrDependencySnapshotInUse) {
		t.Fatalf("delete with active lease error = %v", err)
	}
	if _, err := os.Stat(published.Path); err != nil {
		t.Fatalf("active dependency snapshot was removed: %v", err)
	}
	release()
	if err := DeleteNodeDependencyWorkspace(base, workspaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(published.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("released dependency snapshot still exists: %v", err)
	}
}

func TestNodeDependencySnapshotStorePrunesOldInactiveGeneration(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "store")
	policy := DependencySnapshotPolicy{MaxStoreBytes: 3 * nodeSnapshotFixtureCharge(), MaxAdditionalBytes: -1}
	manifestA, modulesA := nodeSnapshotFixture(t, root, "a-one", 30)
	first, err := PublishNodeDependencySnapshotWithPolicy(base, "workspace-a", manifestA, "node:20", "image-a", modulesA, policy)
	if err != nil {
		t.Fatal(err)
	}
	manifestA2, modulesA2 := nodeSnapshotFixture(t, root, "a-two", 30)
	second, err := PublishNodeDependencySnapshotWithPolicy(base, "workspace-a", manifestA2, "node:20", "image-a", modulesA2, policy)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision == second.Revision {
		t.Fatal("changed dependency tree reused the first generation")
	}
	manifestB, modulesB := nodeSnapshotFixture(t, root, "b-one", 30)
	if _, err := PublishNodeDependencySnapshotWithPolicy(base, "workspace-b", manifestB, "node:20", "image-b", modulesB, policy); err != nil {
		t.Fatal(err)
	}
	manifestB2, modulesB2 := nodeSnapshotFixture(t, root, "b-two", 30)
	if _, err := PublishNodeDependencySnapshotWithPolicy(base, "workspace-b", manifestB2, "node:20", "image-b", modulesB2, policy); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(first.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old inactive generation was not pruned: %v", err)
	}
}

func TestNodeDependencySnapshotStoreFailsClosedWhenGenerationsArePinned(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "store")
	policy := DependencySnapshotPolicy{MaxStoreBytes: 2 * nodeSnapshotFixtureCharge(), MaxAdditionalBytes: -1}
	manifestA, modulesA := nodeSnapshotFixture(t, root, "pin-one", 60)
	first, err := PublishNodeDependencySnapshotWithPolicy(base, "workspace-a", manifestA, "node:20", "image", modulesA, policy)
	if err != nil {
		t.Fatal(err)
	}
	release, err := acquireDependencySnapshotMounts(AnalysisDependencyView{Mounts: []AnalysisDependencyMount{{HostPath: first.Path, Managed: true}}})
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	manifestA2, modulesA2 := nodeSnapshotFixture(t, root, "pin-two", 60)
	if _, err := PublishNodeDependencySnapshotWithPolicy(base, "workspace-a", manifestA2, "node:20", "image", modulesA2, policy); err != nil {
		t.Fatal(err)
	}
	secondPath := NodeDependencySnapshot(base, "workspace-a", "node:20")
	releaseSecond, err := acquireDependencySnapshotMounts(AnalysisDependencyView{Mounts: []AnalysisDependencyMount{{HostPath: secondPath, Managed: true}}})
	if err != nil {
		t.Fatal(err)
	}
	defer releaseSecond()
	manifestB, modulesB := nodeSnapshotFixture(t, root, "pin-three", 20)
	if _, err := PublishNodeDependencySnapshotWithPolicy(base, "workspace-b", manifestB, "node:20", "image", modulesB, policy); !errors.Is(err, ErrDependencySnapshotStoreFull) {
		t.Fatalf("publish with only pinned/current generations error = %v", err)
	}
}

func TestNodeDependencySnapshotStoreEvictsUnpinnedCurrentGeneration(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "store")
	policy := DependencySnapshotPolicy{MaxStoreBytes: nodeSnapshotFixtureCharge(), MaxAdditionalBytes: -1}
	manifestA, modulesA := nodeSnapshotFixture(t, root, "current-a", 20)
	first, err := PublishNodeDependencySnapshotWithPolicy(base, "workspace-a", manifestA, "node:20", "image", modulesA, policy)
	if err != nil {
		t.Fatal(err)
	}
	manifestB, modulesB := nodeSnapshotFixture(t, root, "current-b", 20)
	second, err := PublishNodeDependencySnapshotWithPolicy(base, "workspace-b", manifestB, "node:20", "image", modulesB, policy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(first.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unpinned current generation was not evicted: %v", err)
	}
	if got := NodeDependencySnapshot(base, "workspace-a", "node:20"); got != "" {
		t.Fatalf("evicted workspace marker still resolves to %q", got)
	}
	if got := NodeDependencySnapshot(base, "workspace-b", "node:20"); got != second.Path {
		t.Fatalf("new workspace marker resolves to %q, want %q", got, second.Path)
	}
}

func TestNodeDependencySnapshotStoreSerializesConcurrentQuotaChecks(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "store")
	policy := DependencySnapshotPolicy{MaxStoreBytes: nodeSnapshotFixtureCharge(), MaxAdditionalBytes: -1}
	type fixture struct{ manifest, modules, workspace string }
	fixtures := make([]fixture, 2)
	for index := range fixtures {
		fixtures[index].manifest, fixtures[index].modules = nodeSnapshotFixture(t, root, fmt.Sprintf("parallel-%d", index), 60)
		fixtures[index].workspace = fmt.Sprintf("workspace-%d", index)
	}
	start := make(chan struct{})
	errorsOut := make(chan error, len(fixtures))
	var workers sync.WaitGroup
	for _, item := range fixtures {
		item := item
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			_, err := PublishNodeDependencySnapshotWithPolicy(base, item.workspace, item.manifest, "node:20", "image", item.modules, policy)
			errorsOut <- err
		}()
	}
	close(start)
	workers.Wait()
	close(errorsOut)
	succeeded, full := 0, 0
	for err := range errorsOut {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrDependencySnapshotStoreFull):
			full++
		default:
			t.Fatalf("unexpected publish error: %v", err)
		}
	}
	if succeeded != 2 || full != 0 {
		t.Fatalf("concurrent quota result succeeded=%d full=%d", succeeded, full)
	}
	items, usage, err := listNodeStoredGenerations(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || !nodeSnapshotUsageWithinStoreLimit(usage, policy.MaxStoreBytes, DefaultNodeDependencyStoreEntries) {
		t.Fatalf("serialized quota left items=%d usage=%+v", len(items), usage)
	}
}

func TestNodeDependencySnapshotStoreChargesEmptyTree(t *testing.T) {
	root := t.TempDir()
	manifest := filepath.Join(root, "workspace")
	modules := filepath.Join(root, "run", "node_modules")
	if err := os.MkdirAll(manifest, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(modules, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(modules, "empty-package"), nil, 0644); err != nil {
		t.Fatal(err)
	}
	policy := DependencySnapshotPolicy{
		MaxStoreBytes:      2*NodeDependencyEntryChargeBytes - 1,
		MaxStoreEntries:    10,
		MaxAdditionalBytes: -1,
	}
	if _, err := PublishNodeDependencySnapshotWithPolicy(filepath.Join(root, "store"), "workspace", manifest, "node:20", "image", modules, policy); !errors.Is(err, ErrDependencySnapshotStoreFull) {
		t.Fatalf("empty tree quota error = %v", err)
	}
}

func TestNodeDependencySnapshotStoreEnforcesEntryLimit(t *testing.T) {
	root := t.TempDir()
	manifest := filepath.Join(root, "workspace")
	modules := filepath.Join(root, "run", "node_modules")
	if err := os.MkdirAll(manifest, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(modules, 0755); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 4; index++ {
		if err := os.WriteFile(filepath.Join(modules, fmt.Sprintf("empty-%d", index)), nil, 0644); err != nil {
			t.Fatal(err)
		}
	}
	policy := DependencySnapshotPolicy{
		MaxStoreBytes:      nodeSnapshotMaxBytes,
		MaxStoreEntries:    4,
		MaxAdditionalBytes: -1,
	}
	if _, err := PublishNodeDependencySnapshotWithPolicy(filepath.Join(root, "store"), "workspace", manifest, "node:20", "image", modules, policy); !errors.Is(err, ErrDependencySnapshotStoreFull) {
		t.Fatalf("entry quota error = %v", err)
	}
}
