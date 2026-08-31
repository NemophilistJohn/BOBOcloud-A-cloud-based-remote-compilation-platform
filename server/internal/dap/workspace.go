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

	"bobocloud-server/internal/safefile"
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
	source, err := safefile.RealDirectory(source)
	if err != nil {
		return fmt.Errorf("debug workspace source must be a real directory: %w", err)
	}
	destination, err = filepath.Abs(destination)
	if err != nil {
		return err
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
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		input, openedInfo, err := safefile.OpenRegularBeneath(source, relative, 0)
		if err != nil {
			return err
		}
		if openedInfo.Size() < 0 || copied+openedInfo.Size() > maxBytes {
			_ = input.Close()
			return ErrWorkspaceCopyLimit
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, openedInfo.Mode().Perm())
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
