//go:build !linux && !windows

package packageops

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func openRequirementsFile(root, relative string) (*os.File, bool, error) {
	current := filepath.Clean(root)
	rootInfo, err := os.Lstat(current)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, false, fmt.Errorf("project workspace must be a real directory")
	}
	parts := strings.Split(filepath.Clean(relative), string(filepath.Separator))
	for _, part := range parts[:len(parts)-1] {
		current = filepath.Join(current, part)
		info, statErr := os.Lstat(current)
		if os.IsNotExist(statErr) {
			return nil, false, nil
		}
		if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, false, fmt.Errorf("requirements directory must be real")
		}
	}
	target := filepath.Join(current, parts[len(parts)-1])
	before, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
		return nil, false, fmt.Errorf("requirements manifest must be a real regular file")
	}
	file, err := os.Open(target)
	if err != nil {
		return nil, false, err
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		_ = file.Close()
		return nil, false, fmt.Errorf("requirements manifest changed while opening")
	}
	return file, true, nil
}
