package lsp

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type dependencyReparseTestInfo struct{}

func (dependencyReparseTestInfo) Name() string       { return "reparse" }
func (dependencyReparseTestInfo) Size() int64        { return 0 }
func (dependencyReparseTestInfo) Mode() os.FileMode  { return os.ModeDir | 0700 }
func (dependencyReparseTestInfo) ModTime() time.Time { return time.Time{} }
func (dependencyReparseTestInfo) IsDir() bool        { return true }
func (dependencyReparseTestInfo) Sys() any {
	return &struct{ FileAttributes uint32 }{FileAttributes: windowsReparsePointAttribute}
}

func TestPersonalDependencyRootUsesQuotaOwnedUserDirectoryAndRejectsEscape(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "server-data")
	root, err := PersonalDependencyRoot(dataDir, "user-safe_1")
	if err != nil {
		t.Fatal(err)
	}
	relative, err := filepath.Rel(dataDir, root)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		t.Fatalf("dependency root escaped DataDir: root=%q relative=%q err=%v", root, relative, err)
	}
	want := filepath.Join(dataDir, "users", "user-safe_1", personalDependencyStoreDirectory)
	if root != want {
		t.Fatalf("dependency root = %q, want quota-owned %q", root, want)
	}
	if _, err := PersonalDependencyRoot(dataDir, `../../persist/workspace`); err == nil {
		t.Fatal("unsafe user identity was accepted")
	}
}

func TestPersonalDependencyReparseAttributeIsRejected(t *testing.T) {
	if !personalDependencyLinkOrReparse(dependencyReparseTestInfo{}) {
		t.Fatal("Windows reparse attribute was not rejected")
	}
}

func TestPersonalDependencyRootRejectsIntermediateSymlink(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "server-data")
	storeRoot := filepath.Join(dataDir, personalDependencyOwnerDirectory, "user-1")
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.MkdirAll(storeRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(storeRoot, personalDependencyStoreDirectory)
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	if _, err := PersonalDependencyRoot(dataDir, "user-1"); err == nil || !strings.Contains(err.Error(), "link or reparse point") {
		t.Fatalf("intermediate symlink was not rejected: %v", err)
	}
}

func TestPersonalDependencyRootCreatesPrivateDirectories(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not expose POSIX directory permission bits")
	}
	dataDir := filepath.Join(t.TempDir(), "new-data")
	root, err := PersonalDependencyRoot(dataDir, "user-1")
	if err != nil {
		t.Fatal(err)
	}
	for current := root; ; current = filepath.Dir(current) {
		info, err := os.Stat(current)
		if err != nil {
			t.Fatal(err)
		}
		if permission := info.Mode().Perm(); permission != 0700 {
			t.Fatalf("directory %q permission = %o, want 700", current, permission)
		}
		if current == dataDir {
			break
		}
	}
}

func TestPersonalDependencyInspectAndClearAreUserIsolated(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "server-data")
	first, err := PersonalDependencyRoot(dataDir, "user-a")
	if err != nil {
		t.Fatal(err)
	}
	second, err := PersonalDependencyRoot(dataDir, "user-b")
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("different users received the same dependency root")
	}
	if err := os.WriteFile(filepath.Join(first, "first.cache"), []byte("first"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(second, "second.cache"), []byte("second-user"), 0600); err != nil {
		t.Fatal(err)
	}
	inspection, err := InspectPersonalDependencies(dataDir, "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if !inspection.Exists || inspection.Bytes != int64(len("first")) || inspection.Entries != 1 || inspection.Truncated {
		t.Fatalf("unexpected inspection: %+v", inspection)
	}
	if err := ClearPersonalDependencies(dataDir, "user-a"); err != nil {
		t.Fatal(err)
	}
	cleared, err := InspectPersonalDependencies(dataDir, "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Exists {
		t.Fatalf("cleared dependency root still exists: %+v", cleared)
	}
	if _, err := os.Stat(filepath.Join(second, "second.cache")); err != nil {
		t.Fatalf("clearing one user affected another: %v", err)
	}
	if err := ClearPersonalDependencies(dataDir, "user-a"); err != nil {
		t.Fatalf("clear should be idempotent: %v", err)
	}
}

func TestPersonalDependencyInspectionIsBounded(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a", "b", "c"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	result := PersonalDependencyInspection{Exists: true, Root: root}
	if err := inspectPersonalDependencyDirectory(root, &result, 2, 4); err != nil {
		t.Fatal(err)
	}
	if result.Entries != 2 || !result.Truncated {
		t.Fatalf("bounded inspection = %+v", result)
	}
}

func TestClearPersonalDependenciesRejectsReplacedRoot(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "server-data")
	root, err := PersonalDependencyRoot(dataDir, "user-1")
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.MkdirAll(outside, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(outside, "keep")
	if err := os.WriteFile(marker, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, root); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	if err := ClearPersonalDependencies(dataDir, "user-1"); err == nil {
		t.Fatal("clear accepted a replaced dependency root")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("clear followed the replaced root: %v", err)
	}
}

func TestPersonalDependencyLeaseBlocksClearAndIsPerUser(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "server-data")
	lease, err := AcquirePersonalDependencyStore(dataDir, "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if err := ClearPersonalDependencies(dataDir, "user-a"); !errors.Is(err, ErrPersonalDependencyStoreInUse) {
		t.Fatalf("clear with active lease error = %v", err)
	}
	other, err := AcquirePersonalDependencyStore(dataDir, "user-b")
	if err != nil {
		t.Fatalf("another user's store was blocked: %v", err)
	}
	other.Release()
	lease.Release()
	if err := ClearPersonalDependencies(dataDir, "user-a"); err != nil {
		t.Fatal(err)
	}
}
