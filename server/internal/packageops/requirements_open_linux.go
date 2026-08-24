//go:build linux

package packageops

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

func openRequirementsFile(root, relative string) (*os.File, bool, error) {
	parts := strings.Split(filepath.Clean(relative), string(filepath.Separator))
	if len(parts) == 0 {
		return nil, false, fmt.Errorf("invalid requirements manifest path")
	}
	directoryFD, err := unix.Open(filepath.Clean(root), unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, false, fmt.Errorf("open real project workspace: %w", err)
	}
	defer func() { _ = unix.Close(directoryFD) }()

	for _, part := range parts[:len(parts)-1] {
		if part == "" || part == "." || part == ".." {
			return nil, false, fmt.Errorf("invalid requirements manifest path")
		}
		nextFD, openErr := unix.Openat(directoryFD, part, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
		if errors.Is(openErr, unix.ENOENT) {
			return nil, false, nil
		}
		if openErr != nil {
			return nil, false, fmt.Errorf("open real requirements directory %q: %w", part, openErr)
		}
		_ = unix.Close(directoryFD)
		directoryFD = nextFD
	}

	name := parts[len(parts)-1]
	if name == "" || name == "." || name == ".." {
		return nil, false, fmt.Errorf("invalid requirements manifest path")
	}
	fileFD, err := unix.Openat(directoryFD, name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("open real requirements manifest: %w", err)
	}
	file := os.NewFile(uintptr(fileFD), filepath.Join(root, relative))
	if file == nil {
		_ = unix.Close(fileFD)
		return nil, false, fmt.Errorf("open real requirements manifest")
	}
	return file, true, nil
}
