//go:build linux

package lsp

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestDependencyAPIIndexDirectoryRejectsSymlinkedDescendant(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	directory, err := openDependencyAPIIndexDirectory(root)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	if child, err := directory.OpenChild("escape"); err == nil {
		_ = child.Close()
		t.Fatal("dependency index followed a symlinked package directory")
	}
}

func TestDependencyAPIIndexDirectoryRejectsNamedPipeWithoutBlocking(t *testing.T) {
	root := t.TempDir()
	if err := unix.Mkfifo(filepath.Join(root, "blocked.py"), 0600); err != nil {
		t.Skipf("named pipes unavailable: %v", err)
	}
	directory, err := openDependencyAPIIndexDirectory(root)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	started := time.Now()
	if _, err := directory.ReadSmallRegular("blocked.py", 1024); err == nil {
		t.Fatal("dependency index accepted a named pipe as source")
	}
	if time.Since(started) > time.Second {
		t.Fatal("dependency index blocked while rejecting a named pipe")
	}
}
