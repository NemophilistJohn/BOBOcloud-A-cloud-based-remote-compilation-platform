//go:build linux

package syncsftp

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenCheckedFallbackWalksWithoutOpenat2(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "dir"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dir", "file.txt"), []byte("ok"), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := openCheckedFallback(root, filepath.Join("dir", "file.txt"), os.O_RDONLY, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	value := make([]byte, 2)
	if n, readErr := f.ReadAt(value, 0); readErr != nil || n != len(value) || string(value) != "ok" {
		t.Fatalf("fallback opened unexpected content %q (%d, %v)", value, n, readErr)
	}

	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "dir", "link.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := openCheckedFallback(root, filepath.Join("dir", "link.txt"), os.O_RDONLY, 0, false); err == nil {
		t.Fatal("fallback followed a symlink")
	}
	for _, rel := range []string{"../outside.txt", filepath.Join("dir", "..", "..", "outside.txt"), filepath.Join(string(filepath.Separator), "outside.txt")} {
		if _, err := openCheckedFallback(root, rel, os.O_RDONLY, 0, false); err == nil {
			t.Fatalf("fallback accepted path outside root: %q", rel)
		}
	}
}

func TestNoFollowAndHardlinkBeforeTruncate(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret")
	if e := os.WriteFile(secret, []byte("protected"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.Symlink(outside, filepath.Join(root, "link")); e != nil {
		t.Fatal(e)
	}
	if f, e := openChecked(root, filepath.Join("link", "secret"), os.O_RDONLY, 0); e == nil {
		f.Close()
		t.Fatal("symlink followed")
	}
	if e := os.Link(secret, filepath.Join(root, "hardlink")); e != nil {
		t.Fatal(e)
	}
	if f, e := openChecked(root, "hardlink", os.O_WRONLY|os.O_TRUNC, 0); e == nil {
		f.Close()
		t.Fatal("hardlink accepted")
	}
	contents, e := os.ReadFile(secret)
	if e != nil || string(contents) != "protected" {
		t.Fatalf("protected file truncated: %q %v", contents, e)
	}
}
