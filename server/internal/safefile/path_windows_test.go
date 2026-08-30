//go:build windows

package safefile

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestRealDirectoryRejectsWindowsJunction(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "sentinel")
	if err := os.WriteFile(sentinel, []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}
	junction := filepath.Join(root, "junction")
	if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", junction, outside).CombinedOutput(); err != nil {
		t.Skipf("Windows junctions are unavailable: %v: %s", err, output)
	}
	defer os.Remove(junction)
	if _, err := RealDirectory(junction); err == nil {
		t.Fatal("junction was accepted as a real directory")
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Fatalf("junction validation changed its target: %v", err)
	}
}

func TestWindowsShortPathIsTheSameRealDirectory(t *testing.T) {
	longPath := filepath.Join(t.TempDir(), "BOBOCloud Path Alias Directory")
	if err := os.Mkdir(longPath, 0755); err != nil {
		t.Fatal(err)
	}
	shortPath := windowsShortPath(t, longPath)
	if strings.EqualFold(filepath.Clean(shortPath), filepath.Clean(longPath)) {
		t.Skip("8.3 path aliases are disabled on this volume")
	}
	validated, err := RealDirectory(shortPath)
	if err != nil {
		t.Fatalf("short path alias was rejected: %v", err)
	}
	if !SameFile(validated, longPath) {
		t.Fatalf("short path %q and long path %q do not identify the same directory", validated, longPath)
	}
	within, err := PathWithin(shortPath, filepath.Join(longPath, "missing", "file.go"))
	if err != nil || !within {
		t.Fatalf("mixed-alias child within root = %v, %v", within, err)
	}
}

func windowsShortPath(t *testing.T, value string) string {
	t.Helper()
	buffer := make([]uint16, windows.MAX_PATH)
	length, err := windows.GetShortPathName(windows.StringToUTF16Ptr(value), &buffer[0], uint32(len(buffer)))
	if err != nil {
		t.Skipf("Windows short paths are unavailable: %v", err)
	}
	if length == 0 {
		t.Skip("Windows did not return a short path")
	}
	if length >= uint32(len(buffer)) {
		buffer = make([]uint16, length+1)
		length, err = windows.GetShortPathName(windows.StringToUTF16Ptr(value), &buffer[0], uint32(len(buffer)))
		if err != nil || length == 0 || length >= uint32(len(buffer)) {
			t.Skipf("Windows short path buffer could not be sized: length=%d err=%v", length, err)
		}
	}
	return windows.UTF16ToString(buffer[:length])
}
