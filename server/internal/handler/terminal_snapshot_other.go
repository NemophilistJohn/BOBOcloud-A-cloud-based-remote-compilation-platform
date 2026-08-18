//go:build !linux

package handler

import (
	"fmt"
	"os"
)

// Development builds on non-Linux hosts do not expose O_NOFOLLOW through a
// common portable API. Production runs the Linux implementation above; this
// branch still rejects links before opening and validates the opened file.
func openTerminalSnapshotInput(path string) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("terminal workspace contains unsupported file type")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if !opened.Mode().IsRegular() {
		_ = file.Close()
		return nil, fmt.Errorf("terminal workspace contains unsupported file type")
	}
	return file, nil
}
