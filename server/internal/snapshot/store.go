// Package snapshot stores one immutable archive per project content generation.
package snapshot

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"bobocloud-server/internal/safefile"
)

var (
	ErrCapacity = errors.New("project snapshot storage is full")
	ErrBusy     = errors.New("project snapshot service is busy")
	ErrChanged  = errors.New("project changed while creating its snapshot")
)

const (
	DefaultCapacity = 2 << 30
	DefaultReserve  = 1 << 30
	maxProjectBytes = 1 << 30
	maxEntries      = 20000
	maxPathBytes    = 4096
	blockAllowance  = 4096
)

type Version struct {
	ID    string
	Bytes int64
}

type entry struct {
	Name string
	Size int64
	Mode fs.FileMode
	Hash [sha256.Size]byte
}

type Store struct {
	root              string
	capacity, reserve int64
	free              func(string) (int64, error)
	build             chan struct{}
	copies            chan struct{}
	mu                sync.Mutex
	pins              map[string]int
}

func New(root string, capacity, reserve int64) (*Store, error) {
	if capacity <= 0 {
		capacity = DefaultCapacity
	}
	if reserve <= 0 {
		reserve = DefaultReserve
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	root, err := safefile.RealDirectory(root)
	if err != nil {
		return nil, err
	}
	s := &Store{root: root, capacity: capacity, reserve: reserve, free: freeBytes, build: make(chan struct{}, 1), copies: make(chan struct{}, 1), pins: make(map[string]int)}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".capture-") && e.Type().IsRegular() {
			if err := os.Remove(filepath.Join(root, e.Name())); err != nil {
				return nil, err
			}
		}
	}
	return s, nil
}

func validID(id string) bool {
	decoded, err := hex.DecodeString(id)
	return err == nil && len(decoded) == sha256.Size && strings.ToLower(id) == id
}

func (s *Store) pinLocked(id string) func() {
	s.pins[id]++
	return sync.OnceFunc(func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.pins[id]--
		if s.pins[id] == 0 {
			delete(s.pins, id)
		}
	})
}

// Capture keeps the archive pinned until the caller persists its inbox reference.
func (s *Store) Capture(ctx context.Context, source string) (Version, func(), error) {
	select {
	case s.build <- struct{}{}:
		defer func() { <-s.build }()
	default:
		return Version{}, nil, ErrBusy
	}
	source, err := safefile.RealDirectory(source)
	if err != nil {
		return Version{}, nil, err
	}
	entries, size, err := scan(ctx, source)
	if err != nil {
		return Version{}, nil, err
	}
	manifest, err := json.Marshal(entries)
	if err != nil {
		return Version{}, nil, err
	}
	version := Version{ID: fmt.Sprintf("%x", sha256.Sum256(manifest)), Bytes: size}
	s.mu.Lock()
	archive := filepath.Join(s.root, version.ID+".zip")
	if stat, err := os.Lstat(archive); err == nil && stat.Mode().IsRegular() {
		release := s.pinLocked(version.ID)
		s.mu.Unlock()
		return version, release, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		s.mu.Unlock()
		return Version{}, nil, fmt.Errorf("cannot use snapshot archive: %v", err)
	}
	used, _, err := s.inventory()
	s.mu.Unlock()
	if err != nil {
		return Version{}, nil, err
	}
	free, err := s.free(s.root)
	if err != nil {
		return Version{}, nil, err
	}
	limit := min(s.capacity-used-blockAllowance, free-s.reserve-blockAllowance)
	if limit <= 0 {
		return Version{}, nil, ErrCapacity
	}
	staged, err := os.CreateTemp(s.root, ".capture-")
	if err != nil {
		return Version{}, nil, err
	}
	defer os.Remove(staged.Name())
	defer staged.Close()
	out := &boundedWriter{w: staged, left: limit, free: func() (int64, error) { return s.free(s.root) }, reserve: s.reserve + blockAllowance}
	z := zip.NewWriter(out)
	for _, item := range entries {
		if err := writeEntry(ctx, source, z, item); err != nil {
			return Version{}, nil, err
		}
	}
	if err := z.Close(); err != nil {
		return Version{}, nil, err
	}
	if err := staged.Sync(); err != nil {
		return Version{}, nil, err
	}
	if err := staged.Close(); err != nil {
		return Version{}, nil, err
	}
	// Files are checked while writing; a second manifest also catches additions,
	// removals and directory changes that were absent from the first traversal.
	current, _, err := scan(ctx, source)
	if err != nil {
		return Version{}, nil, err
	}
	currentManifest, err := json.Marshal(current)
	if err != nil {
		return Version{}, nil, err
	}
	if !bytes.Equal(manifest, currentManifest) {
		return Version{}, nil, ErrChanged
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Rename(staged.Name(), archive); err != nil {
		return Version{}, nil, err
	}
	return version, s.pinLocked(version.ID), nil
}

func scan(ctx context.Context, source string) ([]entry, int64, error) {
	entries := make([]entry, 0)
	var size int64
	err := filepath.WalkDir(source, func(full string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if full == source {
			return nil
		}
		switch strings.ToLower(d.Name()) {
		case ".git", ".bobocloud-team.json", ".boboproject":
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		name, err := filepath.Rel(source, full)
		if err != nil || !portablePath(filepath.ToSlash(name)) || len(entries) >= maxEntries {
			return errors.New("project exceeds the snapshot entry limits or contains an unsupported path")
		}
		item := entry{Name: filepath.ToSlash(name)}
		if d.IsDir() {
			item.Mode = fs.ModeDir
		} else {
			f, info, err := safefile.OpenRegularBeneath(source, name, maxProjectBytes)
			if err != nil {
				return err
			}
			item.Size = info.Size()
			item.Mode = info.Mode().Perm() & 0111
			if item.Size > maxProjectBytes-size {
				_ = f.Close()
				return errors.New("project exceeds the snapshot byte limit")
			}
			h := sha256.New()
			n, err := io.Copy(h, io.LimitReader(contextReader{ctx, f}, item.Size+1))
			_ = f.Close()
			if err != nil {
				return err
			}
			if n != item.Size {
				return ErrChanged
			}
			copy(item.Hash[:], h.Sum(nil))
			size += n
		}
		entries = append(entries, item)
		return nil
	})
	return entries, size, err
}

func portablePath(name string) bool {
	if len(name) > maxPathBytes || !fs.ValidPath(name) || name == "." || strings.ContainsAny(name, "\\:\x00") {
		return false
	}
	return true
}

func writeEntry(ctx context.Context, source string, z *zip.Writer, item entry) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	header := &zip.FileHeader{Name: item.Name, Method: zip.Deflate}
	if item.Mode.IsDir() {
		if _, err := safefile.ResolveDirectoryBeneath(source, filepath.FromSlash(item.Name)); err != nil {
			return err
		}
		header.Name += "/"
		header.Method = zip.Store
		header.SetMode(fs.ModeDir | 0755)
		_, err := z.CreateHeader(header)
		return err
	}
	header.SetMode(0644 | item.Mode)
	f, _, err := safefile.OpenRegularBeneath(source, filepath.FromSlash(item.Name), maxProjectBytes)
	if err != nil {
		return err
	}
	defer f.Close()
	dst, err := z.CreateHeader(header)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(dst, h), io.LimitReader(contextReader{ctx, f}, item.Size+1))
	if err != nil {
		return err
	}
	if n != item.Size || !bytes.Equal(h.Sum(nil), item.Hash[:]) {
		return ErrChanged
	}
	return nil
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

type boundedWriter struct {
	w       io.Writer
	left    int64
	free    func() (int64, error)
	reserve int64
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.left {
		return 0, ErrCapacity
	}
	free, err := w.free()
	if err != nil {
		return 0, err
	}
	if free-w.reserve < int64(len(p)) {
		return 0, ErrCapacity
	}
	n, err := w.w.Write(p)
	w.left -= int64(n)
	return n, err
}

func (s *Store) inventory() (int64, []string, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return 0, nil, err
	}
	var total int64
	var ids []string
	for _, e := range entries {
		id := strings.TrimSuffix(e.Name(), ".zip")
		if id == e.Name() || !validID(id) || !e.Type().IsRegular() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return 0, nil, err
		}
		total += info.Size() + blockAllowance
		ids = append(ids, id)
	}
	return total, ids, nil
}

// Prune evaluates references while publication and opening are excluded. The
// callback must read live references, rather than a previously collected list.
func (s *Store) Prune(referenced func(string) (bool, error)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ids, err := s.inventory()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if s.pins[id] != 0 {
			continue
		}
		keep, err := referenced(id)
		if err != nil {
			return err
		}
		if !keep {
			if err := os.Remove(filepath.Join(s.root, id+".zip")); err != nil {
				return err
			}
		}
	}
	return nil
}

// Open gives concurrent readers their own descriptor over the same archive.
func (s *Store) Open(id string) (*os.File, func(), error) {
	if !validID(id) {
		return nil, nil, fs.ErrNotExist
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f, _, err := safefile.OpenRegularBeneath(s.root, id+".zip", 0)
	if err != nil {
		return nil, nil, err
	}
	release := s.pinLocked(id)
	return f, sync.OnceFunc(func() { _ = f.Close(); release() }), nil
}

// Extract writes a single destination tree. The caller owns publication and
// removal after failure; no second server-side archive or tree is generated.
func (s *Store) Extract(ctx context.Context, id, destination string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case s.copies <- struct{}{}:
		defer func() { <-s.copies }()
	default:
		return ErrBusy
	}
	f, done, err := s.Open(id)
	if err != nil {
		return err
	}
	defer done()
	stat, err := f.Stat()
	if err != nil {
		return err
	}
	reader, err := zip.NewReader(f, stat.Size())
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(destination)
	if err != nil {
		return err
	}
	defer root.Close()
	var size int64
	if len(reader.File) > maxEntries {
		return ErrCapacity
	}
	for _, item := range reader.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := strings.TrimSuffix(item.Name, "/")
		if !portablePath(name) || item.UncompressedSize64 > uint64(maxProjectBytes-size) {
			return errors.New("invalid snapshot entry")
		}
		if item.Mode().IsDir() {
			if err := root.Mkdir(name, 0755); err != nil {
				return err
			}
			continue
		}
		if !item.Mode().IsRegular() {
			return errors.New("invalid snapshot file type")
		}
		size += int64(item.UncompressedSize64)
		if err := s.extractFile(ctx, root, destination, name, item); err != nil {
			return err
		}
	}
	return ctx.Err()
}

func (s *Store) extractFile(ctx context.Context, root *os.Root, destination, name string, item *zip.File) error {
	input, err := item.Open()
	if err != nil {
		return err
	}
	defer input.Close()
	out, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644|item.Mode().Perm()&0111)
	if err != nil {
		return err
	}
	w := &boundedWriter{w: out, left: int64(item.UncompressedSize64), free: func() (int64, error) { return s.free(destination) }, reserve: s.reserve + blockAllowance}
	n, copyErr := io.Copy(w, contextReader{ctx, input})
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if n != int64(item.UncompressedSize64) {
		return io.ErrUnexpectedEOF
	}
	return closeErr
}
