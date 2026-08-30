//go:build linux && privileged_integration

package dap

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDAPDependencyMountPinSurvivesSourceReplacement(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "dependencies")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "sentinel"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	anchor, release, err := pinDAPDependencyMount(filepath.Join(root, "dap-cache", "mounts"), "test-session", source)
	if err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(root, "dependencies-original")
	if err := os.Rename(source, moved); err != nil {
		release()
		t.Fatal(err)
	}
	replacement := filepath.Join(root, "replacement")
	if err := os.Mkdir(replacement, 0700); err != nil {
		release()
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(replacement, "sentinel"), []byte("replacement"), 0600); err != nil {
		release()
		t.Fatal(err)
	}
	if err := os.Symlink(replacement, source); err != nil {
		release()
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(anchor, "sentinel"))
	if err != nil || string(content) != "original" {
		release()
		t.Fatalf("DAP mount pin followed replaced source: content=%q err=%v", content, err)
	}
	release()
	if _, err := os.Stat(anchor); !os.IsNotExist(err) {
		t.Fatalf("DAP mount anchor remained after release: %v", err)
	}
}

func TestCleanupDAPDependencyMountOrphans(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "dependencies")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	mountRoot := filepath.Join(root, "dap-cache", "mounts")
	anchor, release, err := pinDAPDependencyMount(mountRoot, "orphaned-session", source)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	unrelated := filepath.Join(mountRoot, "unrelated")
	if err := os.Mkdir(unrelated, 0700); err != nil {
		t.Fatal(err)
	}

	if err := CleanupDependencyMountOrphans(mountRoot); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Lstat(anchor); !os.IsNotExist(err) {
		t.Fatalf("orphan DAP mount anchor remained after cleanup: %v", err)
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatalf("cleanup removed unrelated directory: %v", err)
	}
}
