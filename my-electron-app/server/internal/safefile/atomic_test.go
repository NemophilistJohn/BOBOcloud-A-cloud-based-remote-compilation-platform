package safefile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteAtomicReplacesDestinationSymlinkWithoutFollowingIt(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "cache")
	if err := os.Mkdir(directory, 0755); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(root, "sentinel")
	if err := os.WriteFile(sentinel, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(directory, "metadata.json")
	if err := os.Symlink(sentinel, target); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := WriteAtomic(directory, "metadata.json", []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "unchanged" {
		t.Fatalf("sentinel changed: data=%q err=%v", data, err)
	}
	info, err := os.Lstat(target)
	if err != nil || !info.Mode().IsRegular() {
		t.Fatalf("destination is not a regular file: info=%v err=%v", info, err)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "replacement" {
		t.Fatalf("replacement data=%q err=%v", data, err)
	}
}

func TestWriteAtomicRejectsLinkedDirectory(t *testing.T) {
	root := t.TempDir()
	realDirectory := filepath.Join(root, "real")
	if err := os.Mkdir(realDirectory, 0755); err != nil {
		t.Fatal(err)
	}
	linkedDirectory := filepath.Join(root, "linked")
	if err := os.Symlink(realDirectory, linkedDirectory); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := WriteAtomic(linkedDirectory, "metadata.json", []byte("blocked"), 0600); err == nil {
		t.Fatal("linked directory was accepted")
	}
}

func TestReadSmallRegularRejectsLinksAndOversizedFiles(t *testing.T) {
	root := t.TempDir()
	sentinel := filepath.Join(root, "sentinel")
	if err := os.WriteFile(sentinel, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sentinel, filepath.Join(root, "linked")); err == nil {
		if _, err := ReadSmallRegular(root, "linked", 64); err == nil {
			t.Fatal("linked file was accepted")
		}
	}
	if err := os.WriteFile(filepath.Join(root, "large"), make([]byte, 65), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadSmallRegular(root, "large", 64); err == nil {
		t.Fatal("oversized file was accepted")
	}
	if err := os.WriteFile(filepath.Join(root, "small"), []byte("ok"), 0600); err != nil {
		t.Fatal(err)
	}
	if data, err := ReadSmallRegular(root, "small", 64); err != nil || string(data) != "ok" {
		t.Fatalf("small file data=%q err=%v", data, err)
	}
}
