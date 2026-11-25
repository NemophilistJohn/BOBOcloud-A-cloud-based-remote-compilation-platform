//go:build !linux

package syncsftp

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// checkedRoot anchors access beneath an authorized directory and rejects links.
func checkedRoot(root, relative string, allowMissing bool) (*os.Root, error) {
	r, e := os.OpenRoot(root)
	if e != nil {
		return nil, e
	}
	parts := strings.Split(filepath.Clean(relative), string(filepath.Separator))
	cur := ""
	for _, part := range parts {
		if part == "." {
			continue
		}
		cur = filepath.Join(cur, part)
		v, err := r.Lstat(cur)
		if errors.Is(err, os.ErrNotExist) && allowMissing {
			break
		}
		if err != nil {
			r.Close()
			return nil, err
		}
		if v.Mode()&os.ModeSymlink != 0 {
			r.Close()
			return nil, denied
		}
	}
	return r, nil
}
func openChecked(root, rel string, flags int, mode os.FileMode) (*os.File, error) {
	r, e := checkedRoot(root, rel, flags&os.O_CREATE != 0)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	f, e := r.OpenFile(rel, flags, mode)
	if e != nil {
		return nil, e
	}
	st, e := f.Stat()
	if e != nil || (!st.Mode().IsRegular() && !st.IsDir()) {
		f.Close()
		return nil, denied
	}
	return f, nil
}
func mkdirChecked(root, rel string) error {
	r, e := checkedRoot(root, rel, true)
	if e != nil {
		return e
	}
	defer r.Close()
	return r.Mkdir(rel, 0700)
}
func removeChecked(root, rel string, dir bool) error {
	r, e := checkedRoot(root, rel, false)
	if e != nil {
		return e
	}
	defer r.Close()
	v, e := r.Lstat(rel)
	if e != nil {
		return e
	}
	if v.IsDir() != dir || (!dir && !v.Mode().IsRegular()) {
		return denied
	}
	return r.Remove(rel)
}
func renameChecked(root, old, new string) error {
	r, e := checkedRoot(root, old, false)
	if e != nil {
		return e
	}
	defer r.Close()
	r2, e := checkedRoot(root, new, true)
	if e != nil {
		return e
	}
	defer r2.Close()
	v, e := r.Lstat(old)
	if e != nil || (!v.IsDir() && !v.Mode().IsRegular()) {
		return denied
	}
	return r.Rename(old, new)
}
func setTimes(root, rel string, atime, mtime time.Time) error {
	r, err := checkedRoot(root, rel, false)
	if err != nil {
		return err
	}
	defer r.Close()
	return r.Chtimes(rel, atime, mtime)
}
