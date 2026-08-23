//go:build !linux

package dap

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCleanupDAPDependencyMountOrphansIsNoOpOutsideLinux(t *testing.T) {
	root := t.TempDir()
	marker := filepath.Join(root, "session-marker")
	if err := os.WriteFile(marker, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := CleanupDependencyMountOrphans(root); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("non-Linux cleanup changed the filesystem: %v", err)
	}
}
