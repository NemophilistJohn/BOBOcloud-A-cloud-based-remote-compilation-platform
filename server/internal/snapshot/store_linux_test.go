package snapshot

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCaptureRejectsFileAndDirectorySymlinks(t *testing.T) {
	for _, directory := range []bool{false, true} {
		name := "file"
		if directory {
			name = "directory"
		}
		t.Run(name, func(t *testing.T) {
			s := testStore(t)
			source := t.TempDir()
			outside := t.TempDir()
			writeTestFile(t, outside, "secret", "secret outside workspace")
			target := filepath.Join(outside, "secret")
			if directory {
				target = outside
			}
			if err := os.Symlink(target, filepath.Join(source, "link")); err != nil {
				t.Fatal(err)
			}
			if _, release, err := s.Capture(context.Background(), source); err == nil {
				if release != nil {
					release()
				}
				t.Fatal("symlink source was archived")
			}
			archiveCount(t, s, 0)
		})
	}
}
