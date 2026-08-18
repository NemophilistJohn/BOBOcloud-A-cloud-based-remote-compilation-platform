//go:build linux

package handler

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// openTerminalSnapshotInput refuses a symbolic link at the open boundary.
// The terminal service is deployed on Linux; O_NONBLOCK lets us reject a file
// swapped to a FIFO before a potentially blocking read, and O_NOFOLLOW closes
// the WalkDir-to-open race for symlink swaps.
func openTerminalSnapshotInput(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("create terminal snapshot file handle")
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, fmt.Errorf("terminal workspace contains unsupported file type")
	}
	return file, nil
}
