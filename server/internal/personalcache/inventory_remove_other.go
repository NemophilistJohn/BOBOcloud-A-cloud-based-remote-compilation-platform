//go:build !linux

package personalcache

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func removePythonInventoryFile(root, relative string) error {
	target := filepath.Join(root, filepath.FromSlash(relative))
	if _, err := pythonInventoryRegularFile(root, target); err != nil {
		return err
	}
	return os.Remove(target)
}

func removePythonInventoryDirectory(root, relative string) error {
	target := filepath.Join(root, filepath.FromSlash(relative))
	cleanRoot, cleanTarget := filepath.Clean(root), filepath.Clean(target)
	rel, err := filepath.Rel(cleanRoot, cleanTarget)
	if err != nil || rel == "." || rel == ".." || filepath.IsAbs(rel) || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("Python inventory directory escapes target root")
	}
	current := cleanRoot
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, statErr := os.Lstat(current)
		if statErr != nil {
			return statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Python inventory directory contains symlink")
		}
	}
	info, err := os.Lstat(cleanTarget)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("Python inventory target is not a directory")
	}
	return os.Remove(cleanTarget)
}
