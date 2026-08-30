package personalcache

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func writeNodeInventoryPackage(t *testing.T, root, relative, name, version string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relative), "package.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	content := []byte(`{"name":"` + name + `","version":"` + version + `"}`)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestScanNodePackageTreeIncludesNPMAndPNPMLayouts(t *testing.T) {
	root := filepath.Join(t.TempDir(), "node_modules")
	writeNodeInventoryPackage(t, root, "direct", "direct", "1.2.3")
	writeNodeInventoryPackage(t, root, "@scope/pkg", "@scope/pkg", "2.0.0")
	writeNodeInventoryPackage(t, root, "direct/node_modules/nested", "nested", "3.1.4")
	writeNodeInventoryPackage(t, root, ".pnpm/shared@4.0.0/node_modules/shared", "shared", "4.0.0")
	writeNodeInventoryPackage(t, root, ".pnpm/direct@1.2.3/node_modules/direct", "direct", "1.2.3")

	packages, revision, latest, err := scanNodePackageTree(root)
	if err != nil {
		t.Fatal(err)
	}
	if revision == "" || latest == 0 {
		t.Fatalf("inventory metadata = revision:%q latest:%d", revision, latest)
	}
	want := []InventoryPackage{
		{Name: "@scope/pkg", Version: "2.0.0"},
		{Name: "direct", Version: "1.2.3"},
		{Name: "nested", Version: "3.1.4"},
		{Name: "shared", Version: "4.0.0"},
	}
	if len(packages) != len(want) {
		t.Fatalf("packages = %+v", packages)
	}
	for index := range want {
		if packages[index].Name != want[index].Name || packages[index].Version != want[index].Version {
			t.Fatalf("packages = %+v, want %+v", packages, want)
		}
	}

	writeNodeInventoryPackage(t, root, "direct", "direct", "1.2.4")
	_, changedRevision, _, err := scanNodePackageTree(root)
	if err != nil {
		t.Fatal(err)
	}
	if changedRevision == revision {
		t.Fatal("package metadata mutation did not change the inventory revision")
	}
}

func TestScanNodePackageTreeRejectsInvalidMetadata(t *testing.T) {
	root := filepath.Join(t.TempDir(), "node_modules")
	path := filepath.Join(root, "broken", "package.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"name":"broken"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := scanNodePackageTree(root); err == nil {
		t.Fatal("invalid Node package metadata was accepted as exact inventory")
	}
}

func TestScanNodePackageTreeTreatsMissingDirectoryAsExactEmpty(t *testing.T) {
	packages, revision, latest, err := scanNodePackageTree(filepath.Join(t.TempDir(), "node_modules"))
	if err != nil || len(packages) != 0 || revision == "" || latest != 0 {
		t.Fatalf("missing Node inventory = packages:%+v revision:%q latest:%d err:%v", packages, revision, latest, err)
	}
}

func TestNodeInventoryRepairPersistsTheNodeEcosystem(t *testing.T) {
	manager := newTestManager(t.TempDir(), Options{ReservationBytes: 8})
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "package.json"), []byte("{\"name\":\"demo\",\"dependencies\":{\"lodash\":\"4.17.21\"}}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	request := Request{
		UserID: "user-a", WorkspaceID: "workspace-node", WorkspaceName: "Node Workspace",
		RuntimeID: "node:20", RuntimeFingerprint: trustedTestRuntimeFingerprint,
		Language: "node", WorkspaceRoot: workspace, QuotaBytes: 16 << 20,
	}
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeNodeInventoryPackage(t, filepath.Join(lease.HostRoot, "node_modules"), "lodash", "lodash", "4.17.21")
	lease.Release()

	document, err := readPackageInventory(lease.HostRoot)
	if err != nil {
		t.Fatal(err)
	}
	document.State = "incomplete"
	document.TreeRevision = ""
	document.Packages = []InventoryPackage{}
	if err := writePackageInventory(lease.HostRoot, document); err != nil {
		t.Fatal(err)
	}

	first := manager.InspectPackageInventory(request)
	second := manager.InspectPackageInventory(request)
	if first.State != "ready" || !first.Exact || second.State != "ready" || !second.Exact {
		t.Fatalf("repaired Node inventory did not remain exact: first=%+v second=%+v", first, second)
	}
	repaired, err := readPackageInventory(lease.HostRoot)
	if err != nil || repaired.Language != "node" {
		t.Fatalf("repaired inventory ecosystem = %q, err=%v", repaired.Language, err)
	}
}
