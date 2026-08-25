package dap

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCleanupDependencyMountOrphansContextHonorsCancellation(t *testing.T) {
	mountRoot := t.TempDir()
	marker := filepath.Join(mountRoot, "session-marker")
	if err := os.WriteFile(marker, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := CleanupDependencyMountOrphansContext(ctx, mountRoot)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("CleanupDependencyMountOrphansContext() error = %v, want context cancellation", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("cancelled cleanup changed the mount root: %v", err)
	}
}
