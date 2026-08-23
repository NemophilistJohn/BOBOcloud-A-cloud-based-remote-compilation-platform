package personalcache

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func writeOwnedPythonDistribution(t *testing.T, root, name, version string, files map[string]string) {
	t.Helper()
	distInfo := name + "-" + version + ".dist-info"
	directory := filepath.Join(root, distInfo)
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	metadata := "Metadata-Version: 2.1\nName: " + name + "\nVersion: " + version + "\n"
	if err := os.WriteFile(filepath.Join(directory, "METADATA"), []byte(metadata), 0600); err != nil {
		t.Fatal(err)
	}
	records := make([]string, 0, len(files)+2)
	for relative, content := range files {
		path := filepath.Join(root, filepath.FromSlash(relative))
		if relocatedPath, _, relocated, verify := pythonTargetRecordPath(root, relative); relocated && verify {
			path = relocatedPath
		}
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if existing, err := os.ReadFile(path); err == nil {
			if string(existing) != content {
				t.Fatalf("shared file %q has conflicting content", relative)
			}
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		} else if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		records = append(records, filepath.ToSlash(relative)+",,\n")
	}
	records = append(records, distInfo+"/METADATA,,\n", distInfo+"/RECORD,,\n")
	if err := os.WriteFile(filepath.Join(directory, "RECORD"), []byte(strings.Join(records, "")), 0600); err != nil {
		t.Fatal(err)
	}
}

func publishSharedNamespaceInventory(t *testing.T, manager *Manager) (Request, Entry, InventoryInspection) {
	t.Helper()
	request, _ := inventoryTestRequest(t, manager)
	lease, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(lease.HostRoot, "python")
	writeOwnedPythonDistribution(t, root, "google-alpha", "1.0.0", map[string]string{
		"google/__init__.py":    "# shared namespace\n",
		"google/cloud/alpha.py": "alpha = True\n",
		"shared-google.pth":     "google\n",
		"../../bin/google-tool": "#!/bin/sh\n",
	})
	writeOwnedPythonDistribution(t, root, "google-beta", "2.0.0", map[string]string{
		"google/__init__.py":    "# shared namespace\n",
		"google/cloud/beta.py":  "beta = True\n",
		"shared-google.pth":     "google\n",
		"../../bin/google-tool": "#!/bin/sh\n",
	})
	lease.Release()
	if !lease.Published() {
		t.Fatal("shared namespace generation was not published")
	}
	entry, inspection, exists, err := manager.InspectEntryPackageInventory(request.UserID, lease.RelativePath)
	if err != nil || !exists || inspection.State != "ready" || !inspection.Exact {
		t.Fatalf("published inventory: entry=%+v inspection=%+v exists=%v err=%v", entry, inspection, exists, err)
	}
	return request, entry, inspection
}

func TestDeletePythonDistributionPublishesOwnershipSafeGeneration(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8, ReservationFiles: 1})
	request, entry, inspection := publishSharedNamespaceInventory(t, manager)
	reader, _, current := manager.AcquirePackageInventoryRead(request)
	if reader == nil || current.State != "ready" {
		t.Fatalf("reader=%v inventory=%+v", reader, current)
	}

	result, err := manager.DeletePythonDistribution(context.Background(), DeletePythonDistributionRequest{
		UserID: request.UserID, CachePath: entry.Path, Name: "google-alpha", Version: "1.0.0",
		ExpectedGeneration: entry.Generation, ExpectedInventoryRevision: inspection.Revision, QuotaBytes: request.QuotaBytes,
	})
	if err != nil {
		reader.Release()
		t.Fatal(err)
	}
	if result.Generation == entry.Generation || result.PreviousGeneration != entry.Generation || result.InventoryRevision == inspection.Revision {
		reader.Release()
		t.Fatalf("generation result = %+v", result)
	}
	if len(result.Packages) != 1 || result.Packages[0].Name != "google-beta" || result.FreedFiles < 3 || result.FreedBytes <= 0 {
		reader.Release()
		t.Fatalf("delete result = %+v", result)
	}
	if reader.Stable() {
		reader.Release()
		t.Fatal("old inventory reader did not observe the generation publication")
	}

	afterEntry, after, exists, err := manager.InspectEntryPackageInventory(request.UserID, entry.Path)
	if err != nil || !exists || after.State != "ready" || !after.Exact || len(after.Packages) != 1 || after.Packages[0].Name != "google-beta" {
		reader.Release()
		t.Fatalf("after delete: entry=%+v inventory=%+v exists=%v err=%v", afterEntry, after, exists, err)
	}
	if afterEntry.Generation != result.Generation || after.Revision != result.InventoryRevision {
		reader.Release()
		t.Fatalf("published truth differs from result: entry=%+v inventory=%+v result=%+v", afterEntry, after, result)
	}
	for path, wantExists := range map[string]bool{
		"google/__init__.py":                 true,
		"google/cloud/beta.py":               true,
		"google/cloud/alpha.py":              false,
		"shared-google.pth":                  true,
		"bin/google-tool":                    true,
		"google-alpha-1.0.0.dist-info":       false,
		"google-beta-2.0.0.dist-info/RECORD": true,
	} {
		_, statErr := os.Stat(filepath.Join(afterEntry.HostPath, "python", filepath.FromSlash(path)))
		if wantExists && statErr != nil || !wantExists && !os.IsNotExist(statErr) {
			reader.Release()
			t.Fatalf("path %q exists=%v err=%v", path, wantExists, statErr)
		}
	}
	reader.Release()
}

func TestDeletePythonDistributionRejectsStaleGenerationAndRevision(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8})
	request, entry, inspection := publishSharedNamespaceInventory(t, manager)
	base := DeletePythonDistributionRequest{
		UserID: request.UserID, CachePath: entry.Path, Name: "google-alpha", Version: "1.0.0",
		ExpectedGeneration: entry.Generation, ExpectedInventoryRevision: inspection.Revision,
	}
	staleGeneration := base
	staleGeneration.ExpectedGeneration = strings.Repeat("0", 32)
	if _, err := manager.DeletePythonDistribution(context.Background(), staleGeneration); !errors.Is(err, ErrCacheGenerationChanged) {
		t.Fatalf("stale generation error = %v", err)
	}
	staleRevision := base
	staleRevision.ExpectedInventoryRevision = strings.Repeat("0", 64)
	if _, err := manager.DeletePythonDistribution(context.Background(), staleRevision); !errors.Is(err, ErrInventoryRevisionChanged) {
		t.Fatalf("stale inventory error = %v", err)
	}
	_, after, exists, err := manager.InspectEntryPackageInventory(request.UserID, entry.Path)
	if err != nil || !exists || after.Revision != inspection.Revision || len(after.Packages) != 2 {
		t.Fatalf("stale request mutated cache: inventory=%+v exists=%v err=%v", after, exists, err)
	}
}

func TestDeletePythonDistributionDoesNotNeedGrowthReservationAtQuota(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8 << 20, ReservationFiles: 10_000})
	request, entry, inspection := publishSharedNamespaceInventory(t, manager)
	request.QuotaBytes = manager.Inspect(request.UserID, 0).UsedBytes
	result, err := manager.DeletePythonDistribution(context.Background(), DeletePythonDistributionRequest{
		UserID: request.UserID, CachePath: entry.Path, Name: "google-alpha", Version: "1.0.0",
		ExpectedGeneration: entry.Generation, ExpectedInventoryRevision: inspection.Revision, QuotaBytes: request.QuotaBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Packages) != 1 || result.Packages[0].Name != "google-beta" {
		t.Fatalf("result = %+v", result)
	}
	if info := manager.Inspect(request.UserID, request.QuotaBytes); info.ReservedBytes != 0 || info.ReservedFiles != 0 || len(info.Entries) != 1 {
		t.Fatalf("delete leaked reservation or evicted cache: %+v", info)
	}
}

func TestDeletePythonDistributionRechecksGenerationAfterConcurrentWriter(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{ReservationBytes: 8, ReservationFiles: 1})
	request, entry, inspection := publishSharedNamespaceInventory(t, manager)

	writer, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writeOwnedPythonDistribution(t, filepath.Join(writer.HostRoot, "python"), "google-gamma", "3.0.0", map[string]string{
		"google/cloud/gamma.py": "gamma = True\n",
	})

	type deleteResult struct {
		result DeletePythonDistributionResult
		err    error
	}
	deleted := make(chan deleteResult, 1)
	go func() {
		result, deleteErr := manager.DeletePythonDistribution(context.Background(), DeletePythonDistributionRequest{
			UserID: request.UserID, CachePath: entry.Path, Name: "google-alpha", Version: "1.0.0",
			ExpectedGeneration: entry.Generation, ExpectedInventoryRevision: inspection.Revision, QuotaBytes: request.QuotaBytes,
		})
		deleted <- deleteResult{result: result, err: deleteErr}
	}()
	deadline := time.Now().Add(time.Second)
	for {
		manager.mu.Lock()
		waiting := manager.writerDone[writer.Key] != nil
		manager.mu.Unlock()
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			writer.Abort()
			writer.Release()
			t.Fatal("package deletion did not wait for the active writer")
		}
		time.Sleep(time.Millisecond)
	}

	writer.Release()
	if outcome := <-deleted; !errors.Is(outcome.err, ErrCacheGenerationChanged) {
		t.Fatalf("delete result=%+v error=%v, want stale generation", outcome.result, outcome.err)
	}
	currentEntry, current, exists, err := manager.InspectEntryPackageInventory(request.UserID, entry.Path)
	if err != nil || !exists || currentEntry.Generation == entry.Generation || current.State != "ready" || len(current.Packages) != 3 {
		t.Fatalf("concurrent writer truth: entry=%+v inventory=%+v exists=%v err=%v", currentEntry, current, exists, err)
	}
	if info := manager.Inspect(request.UserID, request.QuotaBytes); info.ReservedBytes != 0 || info.ReservedFiles != 0 {
		t.Fatalf("concurrent writer/delete leaked reservation: %+v", info)
	}
}

func TestPythonInventoryRejectsUnownedNestedFile(t *testing.T) {
	root := t.TempDir()
	writeOwnedPythonDistribution(t, root, "demo", "1.0", map[string]string{"demo/__init__.py": ""})
	if err := os.WriteFile(filepath.Join(root, "demo", "orphan.py"), []byte("orphan = True\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := scanPythonPackageTree(root); err == nil || !strings.Contains(err.Error(), "unowned file") {
		t.Fatalf("unowned nested file error = %v", err)
	}
}

func TestPythonInventoryRejectsIntermediateSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		// Developer-mode Windows commonly lacks symlink privilege; the production
		// path is Linux and is covered whenever the test host permits symlinks.
	}
	root := t.TempDir()
	external := t.TempDir()
	if err := os.WriteFile(filepath.Join(external, "payload.py"), []byte("value = 1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	distInfo := filepath.Join(root, "evil-1.0.dist-info")
	if err := os.MkdirAll(distInfo, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(distInfo, "METADATA"), []byte("Name: evil\nVersion: 1.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(distInfo, "RECORD"), []byte("evil/payload.py,,\nevil-1.0.dist-info/METADATA,,\nevil-1.0.dist-info/RECORD,,\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(root, "evil")); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	if _, _, _, err := scanPythonPackageTree(root); err == nil || !strings.Contains(strings.ToLower(err.Error()), "symlink") {
		t.Fatalf("intermediate symlink error = %v", err)
	}
}
