package syncsftp

import (
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

var denied = errors.New("SFTP access denied")

type handler struct {
	s    *Server
	user string
}

func validPath(p string) bool {
	if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00\r\n") || len(p) > 4096 {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." || strings.EqualFold(part, ".git") {
			return false
		}
	}
	return path.Clean(p) == p
}
func (h *handler) access(ctx context.Context, p string, w bool) (RootAccess, error) {
	if !validPath(p) || p == "/" {
		return RootAccess{}, denied
	}
	a, e := h.s.cfg.Authorize(ctx, h.user, p, w)
	if e != nil {
		return RootAccess{}, denied
	}
	if !filepath.IsAbs(a.Root) || a.Relative == "" || filepath.IsAbs(a.Relative) || filepath.Clean(a.Relative) != a.Relative || a.Relative == ".." || strings.HasPrefix(a.Relative, ".."+string(filepath.Separator)) {
		if a.Release != nil {
			a.Release()
		}
		return RootAccess{}, denied
	}
	for _, part := range strings.Split(filepath.ToSlash(a.Relative), "/") {
		if strings.EqualFold(part, ".git") {
			if a.Release != nil {
				a.Release()
			}
			return RootAccess{}, denied
		}
	}
	return a, nil
}
func release(a RootAccess) {
	if a.Release != nil {
		a.Release()
	}
}

type heldFile struct {
	h     *handler
	path  string
	write bool
	file  *os.File
}

func (f *heldFile) check() (func(), error) {
	a, e := f.h.access(f.h.s.ctx, f.path, f.write)
	if e != nil {
		return nil, e
	}
	check, e := openChecked(a.Root, a.Relative, os.O_RDONLY, 0)
	if e != nil {
		release(a)
		return nil, denied
	}
	defer check.Close()
	one, e := f.file.Stat()
	if e != nil {
		release(a)
		return nil, denied
	}
	two, e := check.Stat()
	if e != nil || !os.SameFile(one, two) {
		release(a)
		return nil, denied
	}
	return func() { release(a) }, nil
}
func (f *heldFile) ReadAt(b []byte, off int64) (int, error) {
	done, e := f.check()
	if e != nil {
		return 0, e
	}
	defer done()
	return f.file.ReadAt(b, off)
}
func (f *heldFile) WriteAt(b []byte, off int64) (int, error) {
	done, e := f.check()
	if e != nil {
		return 0, e
	}
	defer done()
	return f.file.WriteAt(b, off)
}
func (f *heldFile) Close() error { return f.file.Close() }
func (h *handler) Fileread(r *sftp.Request) (io.ReaderAt, error) {
	a, e := h.access(r.Context(), r.Filepath, false)
	if e != nil {
		return nil, e
	}
	defer release(a)
	f, e := openChecked(a.Root, a.Relative, os.O_RDONLY, 0)
	if e != nil {
		return nil, e
	}
	return &heldFile{h: h, path: r.Filepath, file: f}, nil
}
func (h *handler) Filewrite(r *sftp.Request) (io.WriterAt, error) {
	a, e := h.access(r.Context(), r.Filepath, true)
	if e != nil {
		return nil, e
	}
	defer release(a)
	p := r.Pflags()
	flags := os.O_WRONLY
	if p.Read {
		flags = os.O_RDWR
	}
	if p.Creat {
		flags |= os.O_CREATE
	}
	if p.Trunc {
		flags |= os.O_TRUNC
	}
	if p.Excl {
		flags |= os.O_EXCL
	}
	if p.Append {
		return nil, denied
	}
	f, e := openChecked(a.Root, a.Relative, flags, 0600)
	if e != nil {
		return nil, e
	}
	return &heldFile{h: h, path: r.Filepath, file: f, write: true}, nil
}
func (h *handler) Filecmd(r *sftp.Request) error {
	if !validPath(r.Filepath) || r.Filepath == "/" {
		return denied
	}
	a, e := h.access(r.Context(), r.Filepath, true)
	if e != nil {
		return e
	}
	defer release(a)
	switch r.Method {
	case "Mkdir":
		return mkdirChecked(a.Root, a.Relative)
	case "Remove", "Rmdir":
		return removeChecked(a.Root, a.Relative, r.Method == "Rmdir")
	case "Rename", "PosixRename":
		b, e := h.access(r.Context(), r.Target, true)
		if e != nil {
			return e
		}
		defer release(b)
		if filepath.Clean(a.Root) != filepath.Clean(b.Root) {
			return denied
		}
		return renameChecked(a.Root, a.Relative, b.Relative)
	case "Setstat":
		flags := r.AttrFlags()
		openFlags := os.O_RDONLY
		if flags.Size {
			openFlags = os.O_RDWR
		}
		f, e := openChecked(a.Root, a.Relative, openFlags, 0)
		if e != nil {
			return e
		}
		defer f.Close()
		attrs := r.Attributes()
		if flags.UidGid {
			return denied
		}
		if flags.Size {
			if attrs.Size > 1<<40 {
				return denied
			}
			if e = f.Truncate(int64(attrs.Size)); e != nil {
				return e
			}
		}
		if flags.Permissions {
			if e = f.Chmod(attrs.FileMode().Perm() & 0700); e != nil {
				return e
			}
		}
		if flags.Acmodtime {
			return setTimes(a.Root, a.Relative, attrs.AccessTime(), attrs.ModTime())
		}
		return nil
	}
	return denied
}

type listing struct {
	h       *handler
	path    string
	entries []os.FileInfo
	virtual bool
}

func (l *listing) ListAt(dst []os.FileInfo, off int64) (int, error) {
	if !l.virtual {
		a, e := l.h.access(l.h.s.ctx, l.path, false)
		if e != nil {
			return 0, e
		}
		defer release(a)
	}
	if off < 0 || off >= int64(len(l.entries)) {
		return 0, io.EOF
	}
	n := copy(dst, l.entries[off:])
	if int(off)+n >= len(l.entries) {
		return n, io.EOF
	}
	return n, nil
}

type virtualInfo struct{}

func (virtualInfo) Name() string       { return "/" }
func (virtualInfo) Size() int64        { return 0 }
func (virtualInfo) Mode() os.FileMode  { return os.ModeDir | 0700 }
func (virtualInfo) ModTime() time.Time { return time.Time{} }
func (virtualInfo) IsDir() bool        { return true }
func (virtualInfo) Sys() any           { return nil }
func (h *handler) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	if r.Filepath == "/" {
		switch r.Method {
		case "Stat":
			return &listing{h: h, path: "/", entries: []os.FileInfo{virtualInfo{}}, virtual: true}, nil
		case "List":
			return &listing{h: h, path: "/", virtual: true}, nil
		}
		return nil, denied
	}
	a, e := h.access(r.Context(), r.Filepath, false)
	if e != nil {
		return nil, e
	}
	defer release(a)
	f, e := openChecked(a.Root, a.Relative, os.O_RDONLY, 0)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return nil, e
	}
	switch r.Method {
	case "Stat":
		return &listing{h: h, path: r.Filepath, entries: []os.FileInfo{info}}, nil
	case "List":
		if !info.IsDir() {
			return nil, denied
		}
		all, e := f.Readdirnames(-1)
		if e != nil {
			return nil, e
		}
		out := make([]os.FileInfo, 0, len(all))
		for _, name := range all {
			if strings.EqualFold(name, ".git") {
				continue
			}
			child := path.Join(r.Filepath, name)
			allowed, e := h.access(r.Context(), child, false)
			if e == nil {
				item, openErr := openChecked(allowed.Root, allowed.Relative, os.O_RDONLY, 0)
				if openErr == nil {
					if entry, statErr := item.Stat(); statErr == nil {
						out = append(out, entry)
					}
					_ = item.Close()
				}
				release(allowed)
			}
		}
		return &listing{h: h, path: r.Filepath, entries: out}, nil
	}
	return nil, denied
}
