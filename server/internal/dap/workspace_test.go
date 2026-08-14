package dap

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCopyWorkspaceSkipsHeavyAndPrivateDirectories(t *testing.T) {
	source, destination := t.TempDir(), t.TempDir()
	for _, directory := range []string{".git", ".bobocloud", "node_modules", "target", "__pycache__", ".venv", "venv"} {
		path := filepath.Join(source, directory)
		if err := os.MkdirAll(path, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "large.bin"), []byte("ignored"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(source, "main.py"), []byte("print('ok')"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := CopyWorkspace(context.Background(), source, destination, 32); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(destination, "main.py")); err != nil {
		t.Fatal("source file was not copied")
	}
	for directory := range ignoredWorkspaceDirs {
		if _, err := os.Stat(filepath.Join(destination, directory)); !os.IsNotExist(err) {
			t.Fatalf("ignored directory %s was copied", directory)
		}
	}
}

func TestCopyWorkspaceHonorsSizeAndContextLimits(t *testing.T) {
	source, destination := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "large.bin"), make([]byte, 64), 0644); err != nil {
		t.Fatal(err)
	}
	if err := CopyWorkspace(context.Background(), source, destination, 32); !errors.Is(err, ErrWorkspaceCopyLimit) {
		t.Fatalf("copy error = %v", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := CopyWorkspace(cancelled, source, t.TempDir(), 128); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled copy error = %v", err)
	}
}

func TestCopyWorkspaceRejectsDestinationInsideSource(t *testing.T) {
	source := t.TempDir()
	destination := filepath.Join(source, "nested", "copy")
	if err := CopyWorkspace(context.Background(), source, destination, 128); err == nil {
		t.Fatal("copy accepted a destination inside its source tree")
	}
}
