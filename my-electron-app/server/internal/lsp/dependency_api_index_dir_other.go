//go:build !linux

package lsp

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"bobocloud-server/internal/safefile"
)

// Development builds retain final-component no-follow checks. Production runs
// on Linux and uses descriptor-relative opens in dependency_api_index_dir_linux.
type dependencyAPIIndexDirectory struct {
	path   string
	opened *os.File
}

func openDependencyAPIIndexDirectory(path string) (*dependencyAPIIndexDirectory, error) {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return nil, fmt.Errorf("dependency index directory must be absolute")
	}
	info, err := os.Lstat(filepath.Clean(path))
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("dependency index directory must be a real directory")
	}
	opened, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return &dependencyAPIIndexDirectory{path: path, opened: opened}, nil
}

func (d *dependencyAPIIndexDirectory) Close() error {
	if d == nil || d.opened == nil {
		return nil
	}
	err := d.opened.Close()
	d.opened = nil
	return err
}

func (d *dependencyAPIIndexDirectory) ReadDir(count int) ([]os.DirEntry, error) {
	if d == nil || d.opened == nil {
		return nil, os.ErrClosed
	}
	return d.opened.ReadDir(count)
}

func (d *dependencyAPIIndexDirectory) OpenChild(name string) (*dependencyAPIIndexDirectory, error) {
	if d == nil || !validDependencyAPIIndexChildName(name) {
		return nil, fmt.Errorf("invalid dependency index directory child")
	}
	return openDependencyAPIIndexDirectory(filepath.Join(d.path, name))
}

func (d *dependencyAPIIndexDirectory) ReadSmallRegular(name string, maxBytes int64) ([]byte, error) {
	if d == nil || !validDependencyAPIIndexChildName(name) {
		return nil, fmt.Errorf("invalid dependency index file")
	}
	return safefile.ReadSmallRegular(d.path, name, maxBytes)
}

func validDependencyAPIIndexChildName(name string) bool {
	return name != "" && name == filepath.Base(name) && !strings.ContainsRune(name, '\x00')
}
