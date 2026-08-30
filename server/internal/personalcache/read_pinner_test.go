package personalcache

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestPortableReadPinnerRetainsExactGeneration(t *testing.T) {
	dataDir := t.TempDir()
	root := filepath.Join(dataDir, "users")
	source := filepath.Join(dataDir, "published")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "generation"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}

	pinner := NewPortableReadPinnerForTests()
	anchor, release, err := pinner.pin(root, source)
	if err != nil {
		t.Fatal(err)
	}
	if anchor == source {
		release()
		t.Fatal("portable test pinner returned the mutable published path")
	}
	retired := filepath.Join(dataDir, "retired")
	if err := os.Rename(source, retired); err != nil {
		release()
		t.Fatal(err)
	}
	if err := os.MkdirAll(source, 0700); err != nil {
		release()
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "generation"), []byte("new"), 0600); err != nil {
		release()
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(anchor, "generation"))
	if err != nil || string(data) != "old" {
		release()
		t.Fatalf("pinned generation = %q err=%v", data, err)
	}
	release()
	if _, err := os.Stat(anchor); !os.IsNotExist(err) {
		t.Fatalf("released portable pin still exists: %v", err)
	}
}

func TestPortableReadPinnerCleansAbandonedPins(t *testing.T) {
	dataDir := t.TempDir()
	root := filepath.Join(dataDir, "users")
	source := filepath.Join(dataDir, "published")
	if err := os.MkdirAll(filepath.Join(source, "readonly"), 0500); err != nil {
		t.Fatal(err)
	}
	pinner := NewPortableReadPinnerForTests()
	anchor, _, err := pinner.pin(root, source)
	if err != nil {
		t.Fatal(err)
	}
	if err := pinner.cleanup(context.Background(), root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(anchor); !os.IsNotExist(err) {
		t.Fatalf("abandoned portable pin still exists: %v", err)
	}
}

func TestManagerDefaultsToPlatformReadPinner(t *testing.T) {
	manager := NewManager(t.TempDir(), Options{})
	if _, ok := manager.readPinner.(platformReadPinner); !ok {
		t.Fatalf("default read pinner = %T", manager.readPinner)
	}
}
