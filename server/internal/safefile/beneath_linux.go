//go:build linux

package safefile

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

const (
	rootResolveFlags    = unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_SYMLINKS
	beneathResolveFlags = unix.RESOLVE_BENEATH | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_XDEV
	directoryOpenFlags  = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC | unix.O_NONBLOCK
)

func validateDirectoryBeneath(root, relative string) error {
	cleaned, err := cleanRelative(relative, false)
	if err != nil {
		return err
	}
	rootFD, err := openLinuxRoot(root)
	if errors.Is(err, unix.ENOSYS) {
		return validateDirectoryBeneathFallback(root, relative)
	}
	if err != nil {
		return err
	}
	defer unix.Close(rootFD)
	directoryFD, err := unix.Openat2(rootFD, cleaned, &unix.OpenHow{
		Flags: uint64(directoryOpenFlags), Resolve: uint64(beneathResolveFlags),
	})
	if err != nil {
		return &os.PathError{Op: "open-directory-beneath", Path: cleaned, Err: err}
	}
	return unix.Close(directoryFD)
}

func ensureDirectoryBeneath(root, relative string, mode fs.FileMode) error {
	cleaned, err := cleanRelative(relative, false)
	if err != nil {
		return err
	}
	rootFD, err := openLinuxRoot(root)
	if errors.Is(err, unix.ENOSYS) {
		return ensureDirectoryBeneathFallback(root, relative, mode)
	}
	if err != nil {
		return err
	}
	currentFD := rootFD
	defer func() { _ = unix.Close(currentFD) }()
	for _, component := range strings.Split(cleaned, string(filepath.Separator)) {
		if err := unix.Mkdirat(currentFD, component, uint32(mode.Perm())); err != nil && !errors.Is(err, unix.EEXIST) {
			return &os.PathError{Op: "mkdirat-beneath", Path: component, Err: err}
		}
		nextFD, err := openLinuxDirectoryAt(currentFD, component)
		if errors.Is(err, unix.ENOSYS) {
			return ensureDirectoryBeneathFallback(root, relative, mode)
		}
		if err != nil {
			return err
		}
		_ = unix.Close(currentFD)
		currentFD = nextFD
	}
	return nil
}

func openRegularBeneath(root, relative string) (*os.File, error) {
	cleaned, err := cleanRelative(relative, false)
	if err != nil {
		return nil, err
	}
	rootFD, err := openLinuxRoot(root)
	if errors.Is(err, unix.ENOSYS) {
		return openRegularBeneathFallback(root, relative)
	}
	if err != nil {
		return nil, err
	}
	defer unix.Close(rootFD)
	fd, err := unix.Openat2(rootFD, cleaned, &unix.OpenHow{
		Flags: uint64(unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NONBLOCK), Resolve: uint64(beneathResolveFlags),
	})
	if errors.Is(err, unix.ENOSYS) {
		return openRegularBeneathFallback(root, relative)
	}
	if err != nil {
		return nil, &os.PathError{Op: "open-regular-beneath", Path: cleaned, Err: err}
	}
	file := os.NewFile(uintptr(fd), filepath.Join(root, cleaned))
	if file == nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("create regular file handle")
	}
	return file, nil
}

func replaceRegularBeneath(ctx context.Context, root, relative string, source io.Reader, mode fs.FileMode, maxBytes int64) error {
	parentFD, base, err := openLinuxParent(root, relative, true)
	if errors.Is(err, unix.ENOSYS) {
		return replaceRegularBeneathFallback(ctx, root, relative, source, mode, maxBytes)
	}
	if err != nil {
		return err
	}
	defer unix.Close(parentFD)

	temporaryName, err := linuxTemporaryName()
	if err != nil {
		return err
	}
	temporaryFD, err := unix.Openat(parentFD, temporaryName, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW, uint32(mode.Perm()))
	if err != nil {
		return &os.PathError{Op: "create-regular-beneath", Path: temporaryName, Err: err}
	}
	temporary := os.NewFile(uintptr(temporaryFD), temporaryName)
	if temporary == nil {
		_ = unix.Close(temporaryFD)
		return fmt.Errorf("create destination file handle")
	}
	published := false
	defer func() {
		_ = temporary.Close()
		if !published {
			_ = unix.Unlinkat(parentFD, temporaryName, 0)
		}
	}()
	if err := copyBounded(temporary, source, maxBytes); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := unix.Renameat(parentFD, temporaryName, parentFD, base); err != nil {
		return &os.PathError{Op: "rename-regular-beneath", Path: base, Err: err}
	}
	published = true
	if err := unix.Fsync(parentFD); err != nil && !errors.Is(err, unix.EINVAL) {
		return err
	}
	return nil
}

func removeEntryBeneath(root, relative string) error {
	parentFD, base, err := openLinuxParent(root, relative, false)
	if errors.Is(err, unix.ENOSYS) {
		return removeEntryBeneathFallback(root, relative)
	}
	if err != nil {
		return err
	}
	defer unix.Close(parentFD)
	if err := unix.Unlinkat(parentFD, base, 0); err == nil {
		return nil
	} else if !errors.Is(err, unix.EISDIR) && !errors.Is(err, unix.EPERM) {
		return &os.PathError{Op: "unlinkat-beneath", Path: base, Err: err}
	}
	if err := unix.Unlinkat(parentFD, base, unix.AT_REMOVEDIR); err != nil {
		return &os.PathError{Op: "unlinkat-beneath", Path: base, Err: err}
	}
	return nil
}

func removeAllBeneath(root, relative string) error {
	parentFD, base, err := openLinuxParent(root, relative, false)
	if errors.Is(err, unix.ENOSYS) {
		return removeAllBeneathFallback(root, relative)
	}
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer unix.Close(parentFD)
	if err := removeLinuxEntryTree(parentFD, base); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func openLinuxRoot(root string) (int, error) {
	absolute, err := absolutePath(root)
	if err != nil {
		return -1, err
	}
	fd, err := unix.Openat2(unix.AT_FDCWD, absolute, &unix.OpenHow{
		Flags: uint64(directoryOpenFlags), Resolve: uint64(rootResolveFlags),
	})
	if err != nil {
		return -1, &os.PathError{Op: "open-root", Path: absolute, Err: err}
	}
	return fd, nil
}

func openLinuxDirectoryAt(parentFD int, component string) (int, error) {
	fd, err := unix.Openat2(parentFD, component, &unix.OpenHow{
		Flags: uint64(directoryOpenFlags), Resolve: uint64(beneathResolveFlags),
	})
	if err != nil {
		return -1, &os.PathError{Op: "open-directory-beneath", Path: component, Err: err}
	}
	return fd, nil
}

func openLinuxParent(root, relative string, create bool) (int, string, error) {
	cleaned, err := cleanRelative(relative, false)
	if err != nil {
		return -1, "", err
	}
	parentRelative := filepath.Dir(cleaned)
	if create && parentRelative != "." {
		if err := ensureDirectoryBeneath(root, parentRelative, 0755); err != nil {
			return -1, "", err
		}
	}
	rootFD, err := openLinuxRoot(root)
	if err != nil {
		return -1, "", err
	}
	if parentRelative == "." {
		return rootFD, filepath.Base(cleaned), nil
	}
	parentFD, err := unix.Openat2(rootFD, parentRelative, &unix.OpenHow{
		Flags: uint64(directoryOpenFlags), Resolve: uint64(beneathResolveFlags),
	})
	_ = unix.Close(rootFD)
	if err != nil {
		return -1, "", &os.PathError{Op: "open-parent-beneath", Path: parentRelative, Err: err}
	}
	return parentFD, filepath.Base(cleaned), nil
}

func removeLinuxEntryTree(parentFD int, name string) error {
	var stat unix.Stat_t
	if err := unix.Fstatat(parentFD, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return &os.PathError{Op: "fstatat-beneath", Path: name, Err: err}
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		if err := unix.Unlinkat(parentFD, name, 0); err != nil {
			return &os.PathError{Op: "unlinkat-beneath", Path: name, Err: err}
		}
		return nil
	}
	directoryFD, err := openLinuxDirectoryAt(parentFD, name)
	if err != nil {
		return err
	}
	directory := os.NewFile(uintptr(directoryFD), name)
	if directory == nil {
		_ = unix.Close(directoryFD)
		return fmt.Errorf("create directory handle for removal")
	}
	for {
		entries, readErr := directory.ReadDir(128)
		for _, entry := range entries {
			if err := removeLinuxEntryTree(directoryFD, entry.Name()); err != nil {
				_ = directory.Close()
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			_ = directory.Close()
			return readErr
		}
	}
	if err := directory.Close(); err != nil {
		return err
	}
	if err := unix.Unlinkat(parentFD, name, unix.AT_REMOVEDIR); err != nil {
		return &os.PathError{Op: "rmdirat-beneath", Path: name, Err: err}
	}
	return nil
}

func linuxTemporaryName() (string, error) {
	var value [12]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return ".bobo-copy-" + hex.EncodeToString(value[:]), nil
}
