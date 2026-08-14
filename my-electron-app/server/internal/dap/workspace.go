package dap

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

var ErrWorkspaceCopyLimit = errors.New("debug workspace exceeds the copy size limit")

var ignoredWorkspaceDirs = map[string]bool{
	".git": true, ".bobocloud": true, "node_modules": true, "target": true,
	"__pycache__": true, ".venv": true, "venv": true,
}

func CopyWorkspace(ctx context.Context, source, destination string, maxBytes int64) error {
	if maxBytes <= 0 {
		maxBytes = 512 << 20
	}
	source, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	destination, err = filepath.Abs(destination)
	if err != nil {
		return err
	}
	info, err := os.Lstat(source)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("debug workspace source must be a real directory")
	}
	relativeDestination, err := filepath.Rel(source, destination)
	if err != nil {
		return fmt.Errorf("resolve debug workspace destination: %w", err)
	}
	if relativeDestination == "." || (relativeDestination != ".." && !strings.HasPrefix(relativeDestination, ".."+string(filepath.Separator))) {
		return fmt.Errorf("debug workspace destination must be outside the source")
	}
	var copied int64
	return filepath.WalkDir(source, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if current == source {
			return os.MkdirAll(destination, 0755)
		}
		if entry.IsDir() && ignoredWorkspaceDirs[entry.Name()] {
			return filepath.SkipDir
		}
		relative, err := filepath.Rel(source, current)
		if err != nil || relative == ".." || filepath.IsAbs(relative) {
			return fmt.Errorf("resolve debug workspace copy path")
		}
		target := filepath.Join(destination, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			// A copied link could point outside the isolated tree or at a host-only
			// absolute path. Managed debugging starts from regular project files.
			return nil
		}
		if entry.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if info.Size() < 0 || copied+info.Size() > maxBytes {
			return ErrWorkspaceCopyLimit
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		input, err := os.Open(current)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
		if err != nil {
			_ = input.Close()
			return err
		}
		remaining := maxBytes - copied
		written, copyErr := io.Copy(output, io.LimitReader(&contextReader{ctx: ctx, reader: input}, remaining+1))
		closeErr := output.Close()
		_ = input.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if written > remaining {
			return ErrWorkspaceCopyLimit
		}
		copied += written
		return nil
	})
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader *contextReader) Read(buffer []byte) (int, error) {
	select {
	case <-reader.ctx.Done():
		return 0, reader.ctx.Err()
	default:
		return reader.reader.Read(buffer)
	}
}
