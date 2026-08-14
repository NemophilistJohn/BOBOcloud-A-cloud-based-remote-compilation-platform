package safefile

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func validDirectory(directory string) error {
	info, err := os.Lstat(directory)
	if err != nil {
		return fmt.Errorf("inspect safe file directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("safe file directory must be a real directory")
	}
	return nil
}

// WriteAtomic replaces one file inside an existing trusted directory without
// ever opening the destination for writing. This is safe when a sandboxed
// process can create files inside directory: a destination symlink or hardlink
// is replaced as a directory entry instead of being followed and truncated.
func WriteAtomic(directory, name string, data []byte, mode fs.FileMode) error {
	if strings.TrimSpace(directory) == "" || name == "" || name != filepath.Base(name) || strings.ContainsRune(name, '\x00') {
		return fmt.Errorf("valid atomic file destination is required")
	}
	if err := validDirectory(directory); err != nil {
		return err
	}

	temporary, err := os.CreateTemp(directory, ".bobo-meta-*")
	if err != nil {
		return fmt.Errorf("create atomic file: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err = temporary.Chmod(mode.Perm()); err == nil {
		_, err = temporary.Write(data)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("write atomic file: %w", err)
	}

	target := filepath.Join(directory, name)
	if targetInfo, statErr := os.Lstat(target); statErr == nil && targetInfo.IsDir() {
		return fmt.Errorf("atomic file destination is a directory")
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return fmt.Errorf("inspect atomic file destination: %w", statErr)
	}
	if err := os.Rename(temporaryName, target); err != nil {
		// Windows cannot replace an existing entry with Rename. Remove deletes
		// the entry itself, including a symlink, and never follows its target.
		if removeErr := os.Remove(target); removeErr != nil && !os.IsNotExist(removeErr) {
			return fmt.Errorf("replace atomic file: %w", err)
		}
		if err := os.Rename(temporaryName, target); err != nil {
			return fmt.Errorf("publish atomic file: %w", err)
		}
	}
	return nil
}

// ReadSmallRegular reads a bounded regular file without following its final
// path component. On Linux, where the production server runs, openNoFollow
// uses O_NOFOLLOW so a concurrent symlink swap cannot turn metadata reads into
// an unbounded device/host-file read.
func ReadSmallRegular(directory, name string, maxBytes int64) ([]byte, error) {
	if strings.TrimSpace(directory) == "" || name == "" || name != filepath.Base(name) || strings.ContainsRune(name, '\x00') || maxBytes <= 0 {
		return nil, fmt.Errorf("valid bounded file source is required")
	}
	if err := validDirectory(directory); err != nil {
		return nil, err
	}
	file, err := openNoFollow(filepath.Join(directory, name))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect bounded file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > maxBytes {
		return nil, fmt.Errorf("bounded file is not a small regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read bounded file: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("bounded file exceeds the size limit")
	}
	return data, nil
}
