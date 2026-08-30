package personalcache

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// NewPortableReadPinnerForTests returns a path-stable snapshot pinner for
// unprivileged tests. Production managers leave Options.ReadPinner unset and
// therefore use the platform pinner (a kernel bind mount on Linux).
func NewPortableReadPinnerForTests() ReadPinner {
	return portableReadPinner{}
}

type portableReadPinner struct{}

func (portableReadPinner) pin(root, source string) (string, func(), error) {
	if err := ensureRealDirectory(source); err != nil {
		return "", nil, fmt.Errorf("validate published dependency generation: %w", err)
	}
	mountRoot := publishedDependencyPinRoot(root)
	if err := os.MkdirAll(mountRoot, 0700); err != nil {
		return "", nil, err
	}
	anchor, err := os.MkdirTemp(mountRoot, "reader-")
	if err != nil {
		return "", nil, err
	}
	if err := cloneDependencyTreePortable(source, anchor); err != nil {
		_ = removePortableReadPin(anchor)
		return "", nil, fmt.Errorf("snapshot published dependency generation: %w", err)
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			_ = removePortableReadPin(anchor)
		})
	}
	return anchor, release, nil
}

func (portableReadPinner) cleanup(ctx context.Context, root string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	mountRoot := publishedDependencyPinRoot(root)
	entries, err := os.ReadDir(mountRoot)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		if err := removePortableReadPin(filepath.Join(mountRoot, entry.Name())); err != nil {
			return err
		}
	}
	return ctx.Err()
}

func removePortableReadPin(root string) error {
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr == nil && entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
			_ = os.Chmod(path, 0700)
		}
		return nil
	})
	return os.RemoveAll(root)
}

func publishedDependencyPinRoot(root string) string {
	return filepath.Join(filepath.Dir(root), "personalcache-mounts")
}
