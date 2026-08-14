//go:build linux

package safefile

import (
	"os"
	"syscall"
)

func openNoFollow(path string) (*os.File, error) {
	descriptor, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open-nofollow", Path: path, Err: err}
	}
	return os.NewFile(uintptr(descriptor), path), nil
}
