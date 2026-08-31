//go:build linux

package safefile

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestOpenRegularBeneathRejectsFIFOWithoutBlocking(t *testing.T) {
	root := t.TempDir()
	fifo := filepath.Join(root, "pipe")
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := OpenRegularBeneath(root, "pipe", 64); !errors.Is(err, ErrNotRegular) {
		t.Fatalf("FIFO open error=%v", err)
	}
	if info, err := os.Lstat(fifo); err != nil || info.Mode()&os.ModeNamedPipe == 0 {
		t.Fatalf("FIFO changed during validation: info=%v err=%v", info, err)
	}
}
