//go:build linux && privileged_integration

package personalcache

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLinuxPlatformReadPinnerUsesKernelBindMount(t *testing.T) {
	dataDir := t.TempDir()
	root := filepath.Join(dataDir, "users")
	source := filepath.Join(dataDir, "published")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "generation"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}

	manager := NewManager(dataDir, Options{})
	anchor, release, err := manager.readPinner.pin(root, source)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if !linuxMountInfoContains(anchor) {
		t.Fatalf("published dependency pin %q is not a kernel mount", anchor)
	}
	retired := filepath.Join(dataDir, "retired")
	if err := os.Rename(source, retired); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "generation"), []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(anchor, "generation"))
	if err != nil || string(data) != "old" {
		t.Fatalf("bind-pinned generation = %q err=%v", data, err)
	}
}

func linuxMountInfoContains(path string) bool {
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return false
	}
	want := filepath.Clean(path)
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 4 && filepath.Clean(fields[4]) == want {
			return true
		}
	}
	return false
}
