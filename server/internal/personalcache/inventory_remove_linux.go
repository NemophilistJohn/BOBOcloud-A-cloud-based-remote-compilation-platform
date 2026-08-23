//go:build linux

package personalcache

import (
	"fmt"
	"strings"

	"golang.org/x/sys/unix"
)

func removePythonInventoryFile(root, relative string) error {
	parent, name, err := openPythonInventoryParent(root, relative)
	if err != nil {
		return err
	}
	defer unix.Close(parent)
	var stat unix.Stat_t
	if err := unix.Fstatat(parent, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return fmt.Errorf("Python inventory target is not a regular file")
	}
	return unix.Unlinkat(parent, name, 0)
}

func removePythonInventoryDirectory(root, relative string) error {
	parent, name, err := openPythonInventoryParent(root, relative)
	if err != nil {
		return err
	}
	defer unix.Close(parent)
	var stat unix.Stat_t
	if err := unix.Fstatat(parent, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return fmt.Errorf("Python inventory target is not a directory")
	}
	return unix.Unlinkat(parent, name, unix.AT_REMOVEDIR)
}

func openPythonInventoryParent(root, relative string) (int, string, error) {
	parts, err := pythonInventoryRelativeParts(relative)
	if err != nil {
		return -1, "", err
	}
	current, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return -1, "", err
	}
	for _, part := range parts[:len(parts)-1] {
		next, openErr := unix.Openat(current, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		unix.Close(current)
		if openErr != nil {
			return -1, "", openErr
		}
		current = next
	}
	return current, parts[len(parts)-1], nil
}

func pythonInventoryRelativeParts(relative string) ([]string, error) {
	relative = strings.ReplaceAll(strings.TrimSpace(relative), "\\", "/")
	parts := strings.Split(relative, "/")
	if len(parts) == 0 {
		return nil, fmt.Errorf("empty Python inventory path")
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, fmt.Errorf("invalid Python inventory path")
		}
	}
	return parts, nil
}
