package handler

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSecureCacheTargetAcceptsRealChild(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "pip-cache")
	if err := os.Mkdir(target, 0755); err != nil {
		t.Fatal(err)
	}
	got, err := secureCacheTarget(root, "pip-cache")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Clean(got) != filepath.Clean(target) {
		t.Fatalf("target = %q, want %q", got, target)
	}
}

func TestSecureCacheTargetRejectsEscapeAndLinkedComponent(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if _, err := secureCacheTarget(root, ".."); err == nil {
		t.Fatal("parent traversal was accepted")
	}
	link := filepath.Join(root, "linked")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	child := filepath.Join(outside, "child")
	if err := os.Mkdir(child, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := secureCacheTarget(root, filepath.Join("linked", "child")); err == nil {
		t.Fatal("linked cache path was accepted")
	}
}
