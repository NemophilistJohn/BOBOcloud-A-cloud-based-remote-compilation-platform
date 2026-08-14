//go:build linux

package lsp

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// dependencyAPIIndexDirectory keeps every static-index read anchored beneath
// an already validated dependency mount. Opening descendants through the held
// descriptor prevents a concurrent path swap from redirecting the scanner.
type dependencyAPIIndexDirectory struct {
	file *os.File
}

func openDependencyAPIIndexDirectory(path string) (*dependencyAPIIndexDirectory, error) {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return nil, fmt.Errorf("dependency index directory must be absolute")
	}
	fd, err := unix.Open(filepath.Clean(path), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("wrap dependency index directory descriptor")
	}
	info, statErr := file.Stat()
	if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		_ = file.Close()
		if statErr != nil {
			return nil, statErr
		}
		return nil, fmt.Errorf("dependency index directory must be a real directory")
	}
	return &dependencyAPIIndexDirectory{file: file}, nil
}

func (d *dependencyAPIIndexDirectory) Close() error {
	if d == nil || d.file == nil {
		return nil
	}
	err := d.file.Close()
	d.file = nil
	return err
}

func (d *dependencyAPIIndexDirectory) ReadDir(count int) ([]os.DirEntry, error) {
	if d == nil || d.file == nil {
		return nil, fs.ErrClosed
	}
	return d.file.ReadDir(count)
}

func (d *dependencyAPIIndexDirectory) OpenChild(name string) (*dependencyAPIIndexDirectory, error) {
	if d == nil || d.file == nil || !validDependencyAPIIndexChildName(name) {
		return nil, fmt.Errorf("invalid dependency index directory child")
	}
	fd, err := unix.Openat(int(d.file.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	if file == nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("wrap dependency index child descriptor")
	}
	info, statErr := file.Stat()
	if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		_ = file.Close()
		if statErr != nil {
			return nil, statErr
		}
		return nil, fmt.Errorf("dependency index child must be a real directory")
	}
	return &dependencyAPIIndexDirectory{file: file}, nil
}

func (d *dependencyAPIIndexDirectory) ReadSmallRegular(name string, maxBytes int64) ([]byte, error) {
	if d == nil || d.file == nil || !validDependencyAPIIndexChildName(name) || maxBytes <= 0 {
		return nil, fmt.Errorf("invalid dependency index file")
	}
	// O_NONBLOCK makes rejecting a named pipe, device, or socket safe: opening
	// one must never wait for a writer before the post-open regular-file check.
	fd, err := unix.Openat(int(d.file.Fd()), name, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	if file == nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("wrap dependency index file descriptor")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > maxBytes {
		return nil, fmt.Errorf("dependency index source is not a bounded regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("dependency index source exceeds limit")
	}
	return data, nil
}

func validDependencyAPIIndexChildName(name string) bool {
	return name != "" && name == filepath.Base(name) && !strings.ContainsRune(name, '\x00')
}
