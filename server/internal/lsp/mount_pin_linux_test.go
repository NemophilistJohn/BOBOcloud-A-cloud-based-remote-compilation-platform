//go:build linux

package lsp

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCleanupDependencyMountOrphansFailsClosedOnUnremovedSession(t *testing.T) {
	mountRoot := filepath.Join(t.TempDir(), "mounts")
	sessionRoot := filepath.Join(mountRoot, "session-incomplete")
	if err := os.MkdirAll(sessionRoot, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(sessionRoot, "unexpected-owner")
	if err := os.WriteFile(marker, []byte("still owned"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := CleanupDependencyMountOrphans(mountRoot); err == nil {
		t.Fatal("unremoved LSP projection state did not fail cleanup")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("fail-closed cleanup removed unknown owner state: %v", err)
	}
}
