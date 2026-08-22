package personalcache

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeInventoryDistInfo(t *testing.T, root, name, version string) {
	t.Helper()
	directory := filepath.Join(root, name+"-"+version+".dist-info")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	data := []byte("Metadata-Version: 2.1\nName: " + name + "\nVersion: " + version + "\n")
	if err := os.WriteFile(filepath.Join(directory, "METADATA"), data, 0600); err != nil {
		t.Fatal(err)
	}
	packageName := normalizeInventoryPythonName(name)
	packageFile := filepath.Join(root, packageName, "__init__.py")
	if err := os.MkdirAll(filepath.Dir(packageFile), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(packageFile, []byte("__version__ = '"+version+"'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	record := packageName + "/__init__.py,,\n" + name + "-" + version + ".dist-info/METADATA,,\n" + name + "-" + version + ".dist-info/RECORD,,\n"
	if err := os.WriteFile(filepath.Join(directory, "RECORD"), []byte(record), 0600); err != nil {
		t.Fatal(err)
	}
}

func inventoryTestRequest(t *testing.T, manager *Manager) (Request, string) {
	t.Helper()
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "requirements.txt"), []byte("numpy==2.1.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return Request{
		UserID: "user-a", WorkspaceID: "workspace-a", WorkspaceName: "Workspace A",
		RuntimeID: "python:3.10", Language: "python", WorkspaceRoot: workspace, QuotaBytes: 16 << 20,
	}, workspace
}

func TestLeaseReleasePublishesExactPythonInventory(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(lease.HostRoot, "python"), "NumPy", "2.1.0")
	lease.Release()

	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "ready" || !inspection.Exact || len(inspection.Packages) != 1 {
		t.Fatalf("inventory = %+v", inspection)
	}
	if inspection.Packages[0].Name != "numpy" || inspection.Packages[0].Version != "2.1.0" {
		t.Fatalf("packages = %+v", inspection.Packages)
	}
}

func TestPythonInventoryNeverTrustsIncompleteMetadata(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	broken := filepath.Join(lease.HostRoot, "python", "numpy-2.1.0.dist-info")
	if err := os.MkdirAll(broken, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(broken, "METADATA"), []byte("Name: numpy\n"), 0600); err != nil {
		t.Fatal(err)
	}
	lease.Release()

	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "incomplete" || inspection.Exact {
		t.Fatalf("incomplete metadata was trusted: %+v", inspection)
	}
}

func TestPythonInventoryDetectsMutationAfterSnapshot(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(lease.HostRoot, "python")
	writeInventoryDistInfo(t, root, "numpy", "2.1.0")
	lease.Release()
	if err := os.RemoveAll(filepath.Join(root, "numpy-2.1.0.dist-info")); err != nil {
		t.Fatal(err)
	}

	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "incomplete" || inspection.Exact {
		t.Fatalf("mutated package tree was trusted: %+v", inspection)
	}
}

func TestPythonInventoryDetectsMissingPackageFilesBehindIntactDistInfo(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(lease.HostRoot, "python")
	writeInventoryDistInfo(t, root, "numpy", "2.1.0")
	lease.Release()
	if err := os.RemoveAll(filepath.Join(root, "numpy")); err != nil {
		t.Fatal(err)
	}

	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "incomplete" || inspection.Exact {
		t.Fatalf("missing package payload was trusted behind dist-info: %+v", inspection)
	}
}

func TestPythonInventoryDoesNotSnapshotActiveTree(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	writeInventoryDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.1.0")

	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "busy" || inspection.Exact {
		t.Fatalf("active package tree was trusted: %+v", inspection)
	}
}

func TestPythonInventoryDoesNotTrustIdlePreInventoryCache(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.1.0")
	lease.Release()
	if err := os.Remove(filepath.Join(lease.HostRoot, packageInventoryFile)); err != nil {
		t.Fatal(err)
	}

	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "missing" || inspection.Exact {
		t.Fatalf("cache without an inventory was trusted: %+v", inspection)
	}
	if _, err := os.Stat(filepath.Join(lease.HostRoot, packageInventoryFile)); !os.IsNotExist(err) {
		t.Fatalf("read-only inspection recreated a missing inventory: %v", err)
	}
}

func TestPythonInventorySerializesWritersAndPublishesBeforeHandoff(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	first, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	type prepareResult struct {
		lease *Lease
		err   error
	}
	prepared := make(chan prepareResult, 1)
	go func() {
		second, prepareErr := manager.Prepare(context.Background(), request)
		prepared <- prepareResult{lease: second, err: prepareErr}
	}()
	select {
	case result := <-prepared:
		if result.lease != nil {
			result.lease.Release()
		}
		t.Fatal("second writer entered the namespace before the first released")
	case <-time.After(25 * time.Millisecond):
	}
	document, err := readPackageInventory(first.HostRoot)
	if err != nil || document.State != "busy" {
		t.Fatalf("active inventory = %+v, %v", document, err)
	}
	first.Release()
	var second *Lease
	select {
	case result := <-prepared:
		if result.err != nil {
			t.Fatal(result.err)
		}
		second = result.lease
	case <-time.After(time.Second):
		t.Fatal("second writer did not continue after the first released")
	}
	document, err = readPackageInventory(second.HostRoot)
	if err != nil || document.State != "busy" {
		t.Fatalf("handoff writer did not mark inventory busy: %+v, %v", document, err)
	}
	second.Release()
	if inspection := manager.InspectPackageInventory(request); inspection.State != "ready" || !inspection.Exact {
		t.Fatalf("last writer did not publish inventory: %+v", inspection)
	}
}

func TestPythonInventoryRejectsPackageWithoutDistributionRecord(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	orphan := filepath.Join(lease.HostRoot, "python", "numpy")
	if err := os.MkdirAll(orphan, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphan, "__init__.py"), []byte("__version__ = '2.1.0'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	lease.Release()
	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "incomplete" || inspection.Exact {
		t.Fatalf("unowned Python package was trusted: %+v", inspection)
	}
}

func TestPackageInventoryReadLeaseProtectsCacheWithoutLookingLikeWriter(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	writer, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(writer.HostRoot, "python"), "numpy", "2.1.0")
	writer.Release()

	reader, entry, inspection := manager.AcquirePackageInventoryRead(request)
	if reader == nil || inspection.State != "ready" || !inspection.Exact {
		t.Fatalf("read lease = %v, entry = %+v, inventory = %+v", reader, entry, inspection)
	}
	if !reader.Stable() {
		t.Fatal("new read lease was not stable")
	}
	entries := manager.Inspect(request.UserID, request.QuotaBytes).Entries
	if len(entries) != 1 || !entries[0].Active || entries[0].Writing {
		t.Fatalf("read lease activity = %+v", entries)
	}
	if current := manager.InspectPackageInventory(request); current.State != "ready" || !current.Exact {
		t.Fatalf("reader made exact inventory busy: %+v", current)
	}
	if err := manager.Delete(request.UserID, entry.Path); err == nil {
		t.Fatal("active read lease did not protect cache from deletion")
	}

	// A writer may refresh the live namespace while an analyzer retains its
	// mount. The last writer must still publish even though the reader remains.
	refresh, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if reader.Stable() {
		t.Fatal("reader did not observe a concurrent writer generation")
	}
	refresh.Release()
	if current := manager.InspectPackageInventory(request); current.State != "ready" || !current.Exact {
		t.Fatalf("reader prevented last writer publication: %+v", current)
	}

	reader.Release()
	reader.Release()
	if err := manager.Delete(request.UserID, entry.Path); err != nil {
		t.Fatalf("released read lease still blocked deletion: %v", err)
	}
}

func TestPythonInventoryRemainsIncompleteAfterUncleanRestart(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewManager(dataDir, Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	writeInventoryDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.1.0")

	restarted := NewManager(dataDir, Options{ReservationBytes: 8})
	inspection := restarted.InspectPackageInventory(request)
	if inspection.State != "incomplete" || inspection.Exact {
		t.Fatalf("unclean writer was trusted after restart: %+v", inspection)
	}
}
