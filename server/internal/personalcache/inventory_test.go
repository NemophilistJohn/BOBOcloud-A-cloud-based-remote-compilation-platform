package personalcache

import (
	"context"
	"errors"
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

func writeFontToolsInventoryTree(t *testing.T, root string) {
	t.Helper()
	const (
		name    = "fonttools"
		version = "4.63.0"
	)
	directory := filepath.Join(root, name+"-"+version+".dist-info")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	metadata := []byte("Metadata-Version: 2.1\nName: " + name + "\nVersion: " + version + "\n")
	if err := os.WriteFile(filepath.Join(directory, "METADATA"), metadata, 0600); err != nil {
		t.Fatal(err)
	}
	payload := filepath.Join(root, "fontTools", "__init__.py")
	if err := os.MkdirAll(filepath.Dir(payload), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(payload, []byte("version = '4.63.0'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	record := "fontTools/__init__.py,,\n" +
		name + "-" + version + ".dist-info/METADATA,,\n" +
		name + "-" + version + ".dist-info/RECORD,,\n" +
		"../../bin/fonttools,,\n" +
		"../../bin/pyftmerge,,\n" +
		"../../bin/pyftsubset,,\n" +
		"../../bin/ttx,,\n"
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

func TestPythonInventoryAcceptsPipTargetRelocatedSchemeFiles(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(lease.HostRoot, "python")
	writeInventoryDistInfo(t, root, "numpy", "2.2.6")
	for path, content := range map[string]string{
		"bin/f2py":              "#!/bin/sh\n",
		"share/man/man1/f2py.1": ".TH f2py 1\n",
	} {
		absolute := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(absolute), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolute, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	record := filepath.Join(root, "numpy-2.2.6.dist-info", "RECORD")
	file, err := os.OpenFile(record, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("../../bin/f2py,,\n../../share/man/man1/f2py.1,,\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	lease.Release()

	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "ready" || !inspection.Exact || len(inspection.Packages) != 1 || inspection.Packages[0].Name != "numpy" {
		t.Fatalf("pip --target inventory = %+v", inspection)
	}
}

func TestPythonInventoryAcceptsFontToolsWithoutRelocatedConsoleScripts(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeFontToolsInventoryTree(t, filepath.Join(lease.HostRoot, "python"))
	lease.Release()

	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "ready" || !inspection.Exact || len(inspection.Packages) != 1 || inspection.Packages[0].Name != "fonttools" || inspection.Packages[0].Version != "4.63.0" {
		t.Fatalf("fonttools inventory without console scripts = %+v", inspection)
	}
}

func TestPythonInventoryMissingRelocatedScriptsDoesNotOwnOrphanBin(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(lease.HostRoot, "python")
	writeFontToolsInventoryTree(t, root)
	orphan := filepath.Join(root, "bin", "orphan")
	if err := os.MkdirAll(filepath.Dir(orphan), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(orphan, []byte("#!/bin/sh\n"), 0600); err != nil {
		t.Fatal(err)
	}
	lease.Release()

	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "incomplete" || inspection.Exact {
		t.Fatalf("missing relocated scripts granted ownership to orphan bin: %+v", inspection)
	}
}

func TestPythonInventoryRejectsRelocatedSchemeSymlink(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(lease.HostRoot, "python")
	writeFontToolsInventoryTree(t, root)
	target := filepath.Join(t.TempDir(), "ttx")
	if err := os.WriteFile(target, []byte("#!/bin/sh\n"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "bin", "ttx")
	if err := os.MkdirAll(filepath.Dir(link), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		lease.Abort()
		lease.Release()
		t.Skipf("symlinks are unavailable: %v", err)
	}
	lease.Release()

	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "incomplete" || inspection.Exact {
		t.Fatalf("relocated scheme symlink was trusted: %+v", inspection)
	}
}

func TestPythonInventoryRepairsLegacyIncompleteSnapshot(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(lease.HostRoot, "python")
	writeInventoryDistInfo(t, root, "numpy", "2.2.6")
	lease.Release()

	document, err := readPackageInventory(lease.HostRoot)
	if err != nil {
		t.Fatal(err)
	}
	document.State = "incomplete"
	document.TreeRevision = ""
	document.Packages = []InventoryPackage{}
	document.Detail = "Python package metadata could not be read completely"
	if err := writePackageInventory(lease.HostRoot, document); err != nil {
		t.Fatal(err)
	}

	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "ready" || !inspection.Exact || len(inspection.Packages) != 1 || inspection.Packages[0].Name != "numpy" {
		t.Fatalf("legacy inventory was not repaired from the validated package tree: %+v", inspection)
	}
	repaired, err := readPackageInventory(lease.HostRoot)
	if err != nil || repaired.State != "ready" || repaired.TreeRevision == "" {
		t.Fatalf("repaired snapshot was not persisted: %+v, %v", repaired, err)
	}
}

func TestPythonInventoryUpgradesLegacySchemaWithExactImportOwnership(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(lease.HostRoot, "python"), "NumPy", "2.1.0")
	lease.Release()
	document, err := readPackageInventory(lease.HostRoot)
	if err != nil {
		t.Fatal(err)
	}
	document.Schema = 1
	document.Packages = []InventoryPackage{{Name: "numpy", Version: "2.1.0"}}
	document.TreeRevision = "legacy-revision"
	if err := writePackageInventory(lease.HostRoot, document); err != nil {
		t.Fatal(err)
	}

	inspection := manager.InspectPackageInventory(request)
	if inspection.State != "ready" || !inspection.Exact || len(inspection.Packages) != 1 || len(inspection.Packages[0].Imports) != 1 || inspection.Packages[0].Imports[0] != "numpy" {
		t.Fatalf("upgraded inventory = %+v", inspection)
	}
	upgraded, err := readPackageInventory(lease.HostRoot)
	if err != nil || upgraded.Schema != packageInventorySchema || upgraded.TreeRevision != inspection.Revision {
		t.Fatalf("upgraded document = %+v, err=%v", upgraded, err)
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

	// A writer stages a new generation while an analyzer retains the published
	// one. The reader changes revision only after the writer atomically publishes.
	refresh, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !reader.Stable() {
		t.Fatal("staging writer changed the published reader before commit")
	}
	refresh.Release()
	if reader.Stable() {
		t.Fatal("reader did not observe the published generation change")
	}
	if current := manager.InspectPackageInventory(request); current.State != "ready" || !current.Exact {
		t.Fatalf("reader prevented last writer publication: %+v", current)
	}

	reader.Release()
	reader.Release()
	if err := manager.Delete(request.UserID, entry.Path); err != nil {
		t.Fatalf("released read lease still blocked deletion: %v", err)
	}
}

func TestPackageInventorySnapshotRetainsPublishedGenerationWhenInventoryIsCorrupt(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, _ := inventoryTestRequest(t, manager)
	writer, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(writer.HostRoot, "python"), "numpy", "2.2.6")
	writer.Release()
	if err := os.WriteFile(filepath.Join(writer.HostRoot, packageInventoryFile), []byte("{invalid-json"), 0600); err != nil {
		t.Fatal(err)
	}

	reader, entry, inspection, exists := manager.AcquirePackageInventorySnapshotRead(request)
	if !exists || reader == nil || inspection.State != "corrupt" {
		t.Fatalf("corrupt inventory snapshot = exists=%v reader=%v entry=%+v inspection=%+v", exists, reader != nil, entry, inspection)
	}
	defer reader.Release()
	if err := manager.Delete(request.UserID, entry.Path); !errors.Is(err, ErrCacheInUse) {
		t.Fatalf("snapshot did not retain the published generation: %v", err)
	}

	next, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeInventoryDistInfo(t, filepath.Join(next.HostRoot, "python"), "matplotlib", "3.10.0")
	next.Release()
	current, _, currentInspection, currentExists := manager.AcquirePackageInventorySnapshotRead(request)
	if current != nil {
		defer current.Release()
	}
	if !currentExists || current == nil || currentInspection.State != "ready" || current.Generation == reader.Generation {
		t.Fatalf("next generation was not published independently: old=%q new=%q inspection=%+v", reader.Generation, func() string {
			if current == nil {
				return ""
			}
			return current.Generation
		}(), currentInspection)
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
