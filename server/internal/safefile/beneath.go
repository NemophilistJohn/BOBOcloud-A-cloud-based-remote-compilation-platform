package safefile

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

var (
	ErrPathEscape = errors.New("path escapes its root")
	ErrNotRegular = errors.New("path is not a regular file")
	ErrTooLarge   = errors.New("regular file exceeds the size limit")
)

// JoinBeneath performs the platform-neutral lexical half of a root-bounded
// operation. Filesystem operations must use the functions below so links in
// existing path components are checked at the open or mutation boundary.
func JoinBeneath(root, relative string) (string, error) {
	root, err := absolutePath(root)
	if err != nil {
		return "", err
	}
	relative, err = cleanRelative(relative, false)
	if err != nil {
		return "", err
	}
	return filepath.Join(root, relative), nil
}

// JoinChild is JoinBeneath for opaque identifiers such as personal workspace
// keys. Keeping those identifiers to one component removes an unnecessary
// path language from identity-bearing APIs.
func JoinChild(root, name string) (string, error) {
	if err := ValidateChildName(name); err != nil {
		return "", err
	}
	return JoinBeneath(root, name)
}

func ValidateChildName(name string) error {
	if name == "" || strings.ContainsAny(name, "/\\\x00") || name == "." || name == ".." {
		return fmt.Errorf("path key must be one non-empty component")
	}
	return nil
}

// ResolveDirectoryBeneath validates an existing directory at the open
// boundary and returns its lexical path. Production Linux builds use openat2
// with RESOLVE_BENEATH and RESOLVE_NO_SYMLINKS.
func ResolveDirectoryBeneath(root, relative string) (string, error) {
	target, err := JoinBeneath(root, relative)
	if err != nil {
		return "", err
	}
	if err := validateDirectoryBeneath(root, relative); err != nil {
		return "", err
	}
	return target, nil
}

// EnsureDirectoryBeneath creates a missing directory chain without accepting
// a link or reparse point in any existing component.
func EnsureDirectoryBeneath(root, relative string, mode fs.FileMode) (string, error) {
	target, err := JoinBeneath(root, relative)
	if err != nil {
		return "", err
	}
	if err := ensureDirectoryBeneath(root, relative, mode.Perm()); err != nil {
		return "", err
	}
	return target, nil
}

// OpenRegularBeneath opens one existing regular file without following links
// in the path. The returned file descriptor is the object that was checked,
// which closes the usual Lstat-to-Open race. A non-positive maxBytes disables
// the size check while retaining the regular-file requirement.
func OpenRegularBeneath(root, relative string, maxBytes int64) (*os.File, fs.FileInfo, error) {
	if _, err := JoinBeneath(root, relative); err != nil {
		return nil, nil, err
	}
	file, err := openRegularBeneath(root, relative)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, fmt.Errorf("inspect opened file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() < 0 {
		_ = file.Close()
		return nil, nil, ErrNotRegular
	}
	if maxBytes > 0 && info.Size() > maxBytes {
		_ = file.Close()
		return nil, nil, ErrTooLarge
	}
	return file, info, nil
}

// ReadRegularBeneath reads a bounded regular file from the descriptor that was
// validated by OpenRegularBeneath. The extra byte detects concurrent growth.
func ReadRegularBeneath(root, relative string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("regular file read limit must be positive")
	}
	file, _, err := OpenRegularBeneath(root, relative, maxBytes)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read regular file: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return nil, ErrTooLarge
	}
	return data, nil
}

// ReplaceRegularBeneath atomically replaces a root-bounded destination using
// data from source. Parent directories are created without following links;
// an existing destination link is replaced as an entry, never opened.
func ReplaceRegularBeneath(root, relative string, source io.Reader, mode fs.FileMode, maxBytes int64) error {
	return ReplaceRegularBeneathContext(context.Background(), root, relative, source, mode, maxBytes)
}

// ReplaceRegularBeneathContext is ReplaceRegularBeneath with cancellation
// checked during the copy and immediately before the atomic rename.
func ReplaceRegularBeneathContext(ctx context.Context, root, relative string, source io.Reader, mode fs.FileMode, maxBytes int64) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if source == nil {
		return fmt.Errorf("regular file source is required")
	}
	if _, err := JoinBeneath(root, relative); err != nil {
		return err
	}
	return replaceRegularBeneath(ctx, root, relative, &cancellableReader{ctx: ctx, reader: source}, normalizedFileMode(mode), maxBytes)
}

type cancellableReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader *cancellableReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	read, err := reader.reader.Read(buffer)
	if contextErr := reader.ctx.Err(); contextErr != nil {
		return read, contextErr
	}
	return read, err
}

// RemoveEntryBeneath removes one file-system entry through its validated
// parent directory. It never follows the final entry when that entry is a
// symbolic link.
func RemoveEntryBeneath(root, relative string) error {
	if _, err := JoinBeneath(root, relative); err != nil {
		return err
	}
	return removeEntryBeneath(root, relative)
}

// RemoveAllBeneath recursively removes one root-bounded entry. Linux walks by
// directory descriptors; portable builds validate real directories before
// falling back to os.RemoveAll.
func RemoveAllBeneath(root, relative string) error {
	if _, err := JoinBeneath(root, relative); err != nil {
		return err
	}
	return removeAllBeneath(root, relative)
}

func cleanRelative(relative string, allowRoot bool) (string, error) {
	if relative == "" || strings.ContainsRune(relative, '\x00') || filepath.IsAbs(relative) || filepath.VolumeName(relative) != "" {
		return "", fmt.Errorf("relative path is empty or invalid")
	}
	cleaned := filepath.Clean(relative)
	if cleaned == "." {
		if allowRoot {
			return cleaned, nil
		}
		return "", fmt.Errorf("path must be below its root")
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%w: %q", ErrPathEscape, relative)
	}
	return cleaned, nil
}

func normalizedFileMode(mode fs.FileMode) fs.FileMode {
	mode = mode.Perm()
	if mode == 0 {
		return 0644
	}
	return mode
}

func copyBounded(destination io.Writer, source io.Reader, maxBytes int64) error {
	if maxBytes <= 0 {
		_, err := io.Copy(destination, source)
		return err
	}
	written, err := io.Copy(destination, io.LimitReader(source, maxBytes+1))
	if err != nil {
		return err
	}
	if written > maxBytes {
		return ErrTooLarge
	}
	return nil
}
