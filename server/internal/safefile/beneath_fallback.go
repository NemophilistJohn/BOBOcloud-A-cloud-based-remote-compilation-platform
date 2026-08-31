package safefile

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func validateDirectoryBeneathFallback(root, relative string) error {
	target, err := JoinBeneath(root, relative)
	if err != nil {
		return err
	}
	validated, err := RealDirectory(target)
	if err != nil {
		return err
	}
	within, err := PathWithin(root, validated)
	if err != nil {
		return err
	}
	if !within || SameFile(root, validated) {
		return ErrPathEscape
	}
	return nil
}

func ensureDirectoryBeneathFallback(root, relative string, mode fs.FileMode) error {
	validatedRoot, err := RealDirectory(root)
	if err != nil {
		return err
	}
	cleaned, err := cleanRelative(relative, false)
	if err != nil {
		return err
	}
	current := validatedRoot
	for _, component := range strings.Split(cleaned, string(filepath.Separator)) {
		current = filepath.Join(current, component)
		if err := os.Mkdir(current, mode); err != nil && !os.IsExist(err) {
			return err
		}
		validated, err := RealDirectory(current)
		if err != nil {
			return err
		}
		within, err := PathWithin(validatedRoot, validated)
		if err != nil || !within {
			if err != nil {
				return err
			}
			return ErrPathEscape
		}
	}
	return nil
}

func openRegularBeneathFallback(root, relative string) (*os.File, error) {
	cleaned, err := cleanRelative(relative, false)
	if err != nil {
		return nil, err
	}
	parentRelative := filepath.Dir(cleaned)
	parent := root
	if parentRelative != "." {
		parent, err = ResolveDirectoryBeneath(root, parentRelative)
	} else {
		parent, err = RealDirectory(root)
	}
	if err != nil {
		return nil, err
	}
	file, err := openNoFollow(filepath.Join(parent, filepath.Base(cleaned)))
	if err != nil {
		return nil, err
	}
	// Revalidate the parent after opening so a portable-platform directory
	// swap is detected before the descriptor is used.
	var after string
	if parentRelative == "." {
		after, err = RealDirectory(root)
	} else {
		after, err = ResolveDirectoryBeneath(root, parentRelative)
	}
	if err != nil || !SameFile(parent, after) {
		_ = file.Close()
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("file parent changed while opening")
	}
	return file, nil
}

func replaceRegularBeneathFallback(ctx context.Context, root, relative string, source io.Reader, mode fs.FileMode, maxBytes int64) error {
	cleaned, err := cleanRelative(relative, false)
	if err != nil {
		return err
	}
	parentRelative := filepath.Dir(cleaned)
	if parentRelative != "." {
		if err := ensureDirectoryBeneathFallback(root, parentRelative, 0755); err != nil {
			return err
		}
	}
	parent := root
	if parentRelative == "." {
		parent, err = RealDirectory(root)
	} else {
		parent, err = ResolveDirectoryBeneath(root, parentRelative)
	}
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(parent, ".bobo-copy-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err = temporary.Chmod(mode); err == nil {
		err = copyBounded(temporary, source, maxBytes)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	target := filepath.Join(parent, filepath.Base(cleaned))
	if info, statErr := os.Lstat(target); statErr == nil && info.IsDir() {
		return fmt.Errorf("regular file destination is a directory")
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return statErr
	}
	if err := os.Rename(temporaryName, target); err != nil {
		if removeErr := os.Remove(target); removeErr != nil && !os.IsNotExist(removeErr) {
			return err
		}
		if err := os.Rename(temporaryName, target); err != nil {
			return err
		}
	}
	return nil
}

func removeEntryBeneathFallback(root, relative string) error {
	cleaned, err := cleanRelative(relative, false)
	if err != nil {
		return err
	}
	parentRelative := filepath.Dir(cleaned)
	parent := root
	if parentRelative == "." {
		parent, err = RealDirectory(root)
	} else {
		parent, err = ResolveDirectoryBeneath(root, parentRelative)
	}
	if err != nil {
		return err
	}
	return os.Remove(filepath.Join(parent, filepath.Base(cleaned)))
}

func removeAllBeneathFallback(root, relative string) error {
	target, err := ResolveDirectoryBeneath(root, relative)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return os.RemoveAll(target)
}
