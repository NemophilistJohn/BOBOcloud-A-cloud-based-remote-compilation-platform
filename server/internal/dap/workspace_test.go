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

func TestCopyWorkspaceMakesStagingTreeReadableAcrossUmaskAndUserNamespaces(t *testing.T) {
	if os.PathSeparator != '/' {
		t.Skip("POSIX permission bits are not portable to this platform")
	}
	source, destination := t.TempDir(), t.TempDir()
	nested := filepath.Join(source, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	regular := filepath.Join(nested, "main.py")
	if err := os.WriteFile(regular, []byte("print('ok')\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(destination, 0700); err != nil {
		t.Fatal(err)
	}
	if err := CopyWorkspace(context.Background(), source, destination, 1<<20); err != nil {
		t.Fatal(err)
	}
	assertDAPStagingMode(t, destination, true)
	assertDAPStagingMode(t, filepath.Join(destination, "nested"), true)
	assertDAPStagingMode(t, filepath.Join(destination, "nested", "main.py"), false)
}

func assertDAPStagingMode(t *testing.T, path string, directory bool) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	perm := info.Mode().Perm()
	if directory {
		if !info.IsDir() || perm&0555 != 0555 || perm&0200 == 0 {
			t.Fatalf("staging directory mode for %s = %04o, want read/traverse for all and owner write", path, perm)
		}
		return
	}
	if !info.Mode().IsRegular() || perm&0444 != 0444 || perm&0200 == 0 {
		t.Fatalf("staging file mode for %s = %04o, want read for all and owner write", path, perm)
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
