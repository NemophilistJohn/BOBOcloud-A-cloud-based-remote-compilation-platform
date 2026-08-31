package safefile

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestJoinChildRejectsPathSyntax(t *testing.T) {
	root := t.TempDir()
	for _, value := range []string{"", ".", "..", "nested/project", `nested\project`, "bad\x00key"} {
		if _, err := JoinChild(root, value); err == nil {
			t.Fatalf("JoinChild accepted %q", value)
		}
	}
	path, err := JoinChild(root, "project-key")
	if err != nil || path != filepath.Join(root, "project-key") {
		t.Fatalf("JoinChild path=%q err=%v", path, err)
	}
}

func TestDirectoryOperationsRejectRedirectedComponents(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "redirect")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	if _, err := ResolveDirectoryBeneath(root, "redirect"); err == nil {
		t.Fatal("redirected directory was resolved")
	}
	if _, err := EnsureDirectoryBeneath(root, filepath.Join("redirect", "created"), 0755); err == nil {
		t.Fatal("directory was created through a redirect")
	}
	if _, err := os.Stat(filepath.Join(outside, "created")); !os.IsNotExist(err) {
		t.Fatalf("outside directory was changed: %v", err)
	}
}

func TestOpenRegularBeneathRejectsLinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "sentinel")
	if err := os.WriteFile(sentinel, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sentinel, filepath.Join(root, "final-link")); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	if _, _, err := OpenRegularBeneath(root, "final-link", 64); err == nil {
		t.Fatal("final symlink was opened")
	}
	if err := os.Symlink(outside, filepath.Join(root, "parent-link")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := OpenRegularBeneath(root, filepath.Join("parent-link", "sentinel"), 64); err == nil {
		t.Fatal("intermediate symlink was opened")
	}
	if err := os.WriteFile(filepath.Join(root, "regular"), []byte("ok"), 0600); err != nil {
		t.Fatal(err)
	}
	file, _, err := OpenRegularBeneath(root, "regular", 64)
	if err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
}

func TestReplaceRegularBeneathReplacesDestinationLink(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "sentinel")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "out", "artifact.txt")
	if err := os.Mkdir(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, target); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	sourcePath := filepath.Join(root, "source.txt")
	if err := os.WriteFile(sourcePath, []byte("artifact"), 0600); err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err := ReplaceRegularBeneath(root, filepath.Join("out", "artifact.txt"), source, 0644, 64); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "keep" {
		t.Fatalf("outside target changed: data=%q err=%v", data, err)
	}
	info, err := os.Lstat(target)
	if err != nil || !info.Mode().IsRegular() {
		t.Fatalf("replacement is not regular: info=%v err=%v", info, err)
	}
}

type cancelAtEOFReader struct {
	reader *bytes.Reader
	cancel context.CancelFunc
}

func (reader *cancelAtEOFReader) Read(buffer []byte) (int, error) {
	read, err := reader.reader.Read(buffer)
	if errors.Is(err, io.EOF) {
		reader.cancel()
	}
	return read, err
}

func TestReplaceRegularBeneathContextDoesNotPublishAfterCancellation(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "artifact.txt")
	if err := os.WriteFile(target, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	reader := &cancelAtEOFReader{reader: bytes.NewReader([]byte("new")), cancel: cancel}
	err := ReplaceRegularBeneathContext(ctx, root, "artifact.txt", reader, 0600, 64)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("replace error=%v", err)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "old" {
		t.Fatalf("cancelled replacement was published: data=%q err=%v", data, err)
	}
}

func TestReplaceRegularBeneathRejectsRedirectedParent(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "redirect")); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	if err := ReplaceRegularBeneath(root, filepath.Join("redirect", "artifact.txt"), bytes.NewReader([]byte("blocked")), 0644, 64); err == nil {
		t.Fatal("artifact was written through a redirected parent")
	}
	if _, err := os.Lstat(filepath.Join(outside, "artifact.txt")); !os.IsNotExist(err) {
		t.Fatalf("outside directory was changed: %v", err)
	}
}

func TestRemoveEntryBeneathRejectsRedirectedParent(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "sentinel")
	if err := os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "redirect")); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	if err := RemoveEntryBeneath(root, filepath.Join("redirect", "sentinel")); err == nil {
		t.Fatal("entry was removed through a redirected parent")
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "keep" {
		t.Fatalf("outside target changed: data=%q err=%v", data, err)
	}
}

func TestRemoveEntryBeneathUnlinksFinalLinkWithoutFollowing(t *testing.T) {
	root := t.TempDir()
	sentinel := filepath.Join(t.TempDir(), "sentinel")
	if err := os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(sentinel, link); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	if err := RemoveEntryBeneath(root, "link"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("link still exists: %v", err)
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "keep" {
		t.Fatalf("link target changed: data=%q err=%v", data, err)
	}
}

func TestRemoveAllBeneathRemovesOnlySelectedTree(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "project", "nested")
	if err := os.MkdirAll(project, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "file"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := RemoveAllBeneath(root, "project"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, "project")); !os.IsNotExist(err) {
		t.Fatalf("project still exists: %v", err)
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		t.Fatalf("root was removed: info=%v err=%v", info, err)
	}
}

func TestReadRegularBeneathEnforcesLimit(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "large"), make([]byte, 65), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRegularBeneath(root, "large", 64); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("large read error=%v", err)
	}
}
