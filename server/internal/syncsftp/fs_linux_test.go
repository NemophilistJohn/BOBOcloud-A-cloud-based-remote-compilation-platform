//go:build linux

package syncsftp

import (
	"os"
	"path/filepath"
	"testing"
)

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
