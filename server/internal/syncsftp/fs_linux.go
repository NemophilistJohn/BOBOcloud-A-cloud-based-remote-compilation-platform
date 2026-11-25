//go:build linux

package syncsftp

import (
	"errors"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

const resolveRoot = unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_SYMLINKS
const resolveChild = unix.RESOLVE_BENEATH | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_XDEV

func rootFD(root string) (int, error) {
	return unix.Openat2(unix.AT_FDCWD, root, &unix.OpenHow{Flags: unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: resolveRoot})
}
func openChecked(root, rel string, flags int, mode os.FileMode) (*os.File, error) {
	fd, e := rootFD(root)
	if e != nil {
		return nil, e
	}
	defer unix.Close(fd)
	// Do not truncate until the opened inode has passed the hard-link check.
	trunc := flags&os.O_TRUNC != 0
	flags &^= os.O_TRUNC
	if flags&os.O_CREATE == 0 {
		mode = 0
	}
	child, e := unix.Openat2(fd, rel, &unix.OpenHow{Flags: uint64(flags | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK), Mode: uint64(mode.Perm()), Resolve: resolveChild})
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(child), rel)
	st, e := f.Stat()
	if e != nil || (!st.Mode().IsRegular() && !st.IsDir()) {
		f.Close()
		return nil, denied
	}
	var stat unix.Stat_t
	if e = unix.Fstat(child, &stat); e != nil || (st.Mode().IsRegular() && stat.Nlink != 1) {
		f.Close()
		return nil, denied
	}
	if trunc {
		if e = f.Truncate(0); e != nil {
			f.Close()
			return nil, e
		}
	}
	return f, nil
}
func parent(root, rel string) (*os.File, string, error) {
	name := filepath.Base(rel)
	if name == "." || name == ".." || name == string(filepath.Separator) {
		return nil, "", denied
	}
	f, e := openChecked(root, filepath.Dir(rel), os.O_RDONLY, 0)
	if e != nil {
		return nil, "", e
	}
	info, e := f.Stat()
	if e != nil || !info.IsDir() {
		f.Close()
		return nil, "", denied
	}
	return f, name, nil
}
func mkdirChecked(root, rel string) error {
	p, n, e := parent(root, rel)
	if e != nil {
		return e
	}
	defer p.Close()
	return unix.Mkdirat(int(p.Fd()), n, 0700)
}
func checkEntry(fd int, name string, dir bool, missing bool) error {
	var st unix.Stat_t
	e := unix.Fstatat(fd, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(e, unix.ENOENT) && missing {
		return nil
	}
	if e != nil {
		return e
	}
	typ := st.Mode & unix.S_IFMT
	if dir && typ != unix.S_IFDIR {
		return denied
	}
	if !dir && (typ != unix.S_IFREG || st.Nlink != 1) {
		return denied
	}
	return nil
}
func removeChecked(root, rel string, dir bool) error {
	p, n, e := parent(root, rel)
	if e != nil {
		return e
	}
	defer p.Close()
	if e = checkEntry(int(p.Fd()), n, dir, false); e != nil {
		return e
	}
	flags := 0
	if dir {
		flags = unix.AT_REMOVEDIR
	}
	return unix.Unlinkat(int(p.Fd()), n, flags)
}
func renameChecked(root, old, new string) error {
	a, an, e := parent(root, old)
	if e != nil {
		return e
	}
	defer a.Close()
	b, bn, e := parent(root, new)
	if e != nil {
		return e
	}
	defer b.Close()
	var st unix.Stat_t
	if e = unix.Fstatat(int(a.Fd()), an, &st, unix.AT_SYMLINK_NOFOLLOW); e != nil {
		return e
	}
	typ := st.Mode & unix.S_IFMT
	if typ != unix.S_IFREG && typ != unix.S_IFDIR {
		return denied
	}
	if typ == unix.S_IFREG && st.Nlink != 1 {
		return denied
	}
	if e = checkEntry(int(b.Fd()), bn, typ == unix.S_IFDIR, true); e != nil {
		return e
	}
	return unix.Renameat(int(a.Fd()), an, int(b.Fd()), bn)
}
func setTimes(root, rel string, atime, mtime time.Time) error {
	f, e := openChecked(root, rel, os.O_RDONLY, 0)
	if e != nil {
		return e
	}
	defer f.Close()
	return unix.Futimes(int(f.Fd()), []unix.Timeval{unix.NsecToTimeval(atime.UnixNano()), unix.NsecToTimeval(mtime.UnixNano())})
}
