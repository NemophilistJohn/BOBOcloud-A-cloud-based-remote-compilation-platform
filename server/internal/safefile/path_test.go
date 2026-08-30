package safefile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRealDirectoryRejectsRedirectedComponent(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "redirect")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	if _, err := RealDirectory(link); err == nil {
		t.Fatal("redirected directory was accepted")
	}
}

func TestPathWithinResolvesExistingAncestorAndRejectsEscape(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "new", "file.go")
	within, err := PathWithin(root, inside)
	if err != nil || !within {
		t.Fatalf("missing child within root = %v, %v", within, err)
	}
	outside := filepath.Join(filepath.Dir(root), "outside", "file.go")
	within, err = PathWithin(root, outside)
	if err != nil {
		t.Fatal(err)
	}
	if within {
		t.Fatal("outside path was accepted")
	}
}
