//go:build linux

package personalcache

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/sys/unix"
)

// pinPublishedDependency gives a reader a path-stable view before a writer can
// atomically replace the canonical pathname. Docker still mounts this anchor
// read-only; the bind mount exists only to retain the selected generation.
func pinPublishedDependency(root, source string) (string, func(), error) {
	mountRoot := publishedDependencyPinRoot(root)
	if err := os.MkdirAll(mountRoot, 0700); err != nil {
		return "", nil, err
	}
	anchor, err := os.MkdirTemp(mountRoot, "reader-")
	if err != nil {
		return "", nil, err
	}
	if err := unix.Mount(source, anchor, "", unix.MS_BIND|unix.MS_REC, ""); err != nil {
		_ = os.Remove(anchor)
		return "", nil, fmt.Errorf("pin published dependency generation: %w", err)
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			_ = unix.Unmount(anchor, unix.MNT_DETACH)
			_ = os.Remove(anchor)
		})
	}
	return anchor, release, nil
}

func cleanupPublishedDependencyPins(root string) {
	_ = cleanupPublishedDependencyPinsContext(context.Background(), root)
}

func cleanupPublishedDependencyPinsContext(ctx context.Context, root string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	mountRoot := publishedDependencyPinRoot(root)
	entries, err := os.ReadDir(mountRoot)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		path := filepath.Join(mountRoot, entry.Name())
		_ = unix.Unmount(path, unix.MNT_DETACH)
		_ = os.Remove(path)
	}
	return ctx.Err()
}
