//go:build linux

package files

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestArtifactOperationsIgnoreFIFO(t *testing.T) {
	temporary := t.TempDir()
	project := t.TempDir()
	fifo := filepath.Join(temporary, "artifact.pipe")
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := SnapshotProjectFiles(context.Background(), temporary, ProjectCopyLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := snapshot.Files["artifact.pipe"]; ok {
		t.Fatal("FIFO was included in an artifact snapshot")
	}
	result, err := SyncGeneratedArtifactsWithLimits(context.Background(), temporary, project, nil, "", ArtifactLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Paths) != 0 {
		t.Fatalf("FIFO was synchronized: %v", result.Paths)
	}
	if _, err := os.Lstat(filepath.Join(project, "artifact.pipe")); !os.IsNotExist(err) {
		t.Fatalf("FIFO appeared in the project: %v", err)
	}
}
