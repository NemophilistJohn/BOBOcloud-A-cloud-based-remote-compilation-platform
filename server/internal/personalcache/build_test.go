package personalcache

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"bobocloud-server/internal/cachev2"
)

func TestBuildLeaseConfiguresCargoTargetAtPlanWorkDir(t *testing.T) {
	manager := newTestManager(t.TempDir(), Options{})
	lease, err := manager.PrepareBuild(context.Background(), BuildRequest{
		UserID: "u1", WorkspaceID: "project", RuntimeID: "rust:1.86",
		RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "rust", Target: "native",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if err := lease.ConfigureCargoTarget("crates/app"); err != nil {
		t.Fatal(err)
	}
	hostTarget := filepath.Join(lease.HostRoot, "cargo-target")
	if lease.DockerMounts[hostTarget] != "/workspace/crates/app/target" || lease.DockerEnv["CARGO_TARGET_DIR"] != "/workspace/crates/app/target" {
		t.Fatalf("Cargo cache context = mounts %#v env %#v", lease.DockerMounts, lease.DockerEnv)
	}
	if err := lease.ConfigureCargoTarget("../escape"); err == nil {
		t.Fatal("escaping Cargo work directory was accepted")
	}
	if err := lease.ConfigureCargoTarget("C:/escape"); err == nil {
		t.Fatal("drive-qualified Cargo work directory was accepted")
	}
}

func TestCatalogDeleteRestoresBuildBindingWhenStagingFails(t *testing.T) {
	manager := newTestManager(t.TempDir(), Options{})
	request := BuildRequest{
		UserID: "u1", WorkspaceID: "project", RuntimeID: "go:1.24",
		RuntimeFingerprint: trustedTestRuntimeFingerprint, Language: "go", Target: "native",
	}
	lease, err := manager.PrepareBuild(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	cacheID := lease.CacheID
	hostRoot := lease.HostRoot
	if err := lease.Commit(); err != nil {
		t.Fatal(err)
	}
	lease.Release()

	snapshot, err := manager.catalogLocked(request.UserID, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	record, ok := snapshot.records[cacheID]
	if !ok {
		t.Fatalf("incremental cache %s is missing from the catalog", cacheID)
	}
	record.root = hostRoot + "-missing"
	if _, err := manager.deleteCatalogRecordsLocked(request.UserID, map[cachev2.CacheID]catalogRecord{cacheID: record}); err == nil {
		t.Fatal("cache deletion unexpectedly succeeded with a missing staging root")
	}
	layout, err := manager.ensureUserLayout(request.UserID)
	if err != nil {
		t.Fatal(err)
	}
	binding, ok := readBuildCurrentBinding(layout.Root, request)
	if !ok || binding.CacheID != cacheID {
		t.Fatalf("build binding was not restored after rollback: %+v", binding)
	}
	if _, err := os.Stat(hostRoot); err != nil {
		t.Fatalf("live incremental cache root changed during rollback: %v", err)
	}
}
