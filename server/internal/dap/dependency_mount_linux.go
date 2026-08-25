//go:build linux

package dap

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

// pinDAPDependencyMount creates a DAP-owned kernel anchor. Docker never sees
// the mutable project-cache pathname, and this namespace is independent from
// the LSP analysis cache and its mount pins.
func pinDAPDependencyMount(mountRoot, sessionID, source string) (string, func(), error) {
	root, err := prepareDAPDependencyMountRoot(mountRoot)
	if err != nil {
		return "", func() {}, err
	}
	source, err = validateDAPDependencySource(source)
	if err != nil {
		return "", func() {}, err
	}
	prefix := "session-" + safeContainerLabel(sessionID) + "-"
	if prefix == "session--" {
		prefix = "session-"
	}
	sessionRoot, err := os.MkdirTemp(root, prefix)
	if err != nil {
		return "", func() {}, fmt.Errorf("create DAP dependency mount session: %w", err)
	}
	if err := os.Chmod(sessionRoot, 0700); err != nil {
		_ = os.Remove(sessionRoot)
		return "", func() {}, fmt.Errorf("protect DAP dependency mount session: %w", err)
	}
	anchor := filepath.Join(sessionRoot, "dependency")
	var once sync.Once
	release := func() {
		once.Do(func() {
			if err := releaseDAPDependencyMountAnchor(sessionRoot, anchor); err != nil {
				slog.Warn("Failed to release DAP dependency mount session", "path", sessionRoot, "error", err)
			}
		})
	}
	fd, err := unix.Open(source, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		_ = os.Remove(sessionRoot)
		return "", func() {}, fmt.Errorf("pin DAP dependency mount: %w", err)
	}
	descriptorPath := "/proc/" + strconv.Itoa(os.Getpid()) + "/fd/" + strconv.Itoa(fd)
	actual, readErr := os.Readlink(descriptorPath)
	if readErr != nil || strings.HasSuffix(actual, " (deleted)") || filepath.Clean(actual) != source {
		_ = unix.Close(fd)
		_ = os.Remove(sessionRoot)
		if readErr != nil {
			return "", func() {}, fmt.Errorf("verify DAP dependency mount: %w", readErr)
		}
		return "", func() {}, fmt.Errorf("DAP dependency mount changed while it was being anchored")
	}
	if err := os.Mkdir(anchor, 0700); err != nil {
		_ = unix.Close(fd)
		_ = os.Remove(sessionRoot)
		return "", func() {}, fmt.Errorf("create DAP dependency mount anchor: %w", err)
	}
	mountErr := unix.Mount(descriptorPath, anchor, "", unix.MS_BIND, "")
	_ = unix.Close(fd)
	if mountErr != nil {
		_ = os.Remove(anchor)
		_ = os.Remove(sessionRoot)
		return "", func() {}, fmt.Errorf("anchor DAP dependency mount: %w", mountErr)
	}
	return anchor, release, nil
}

func releaseDAPDependencyMountAnchor(sessionRoot, anchor string) error {
	return releaseDAPDependencyMountAnchorContext(context.Background(), sessionRoot, anchor)
}

func releaseDAPDependencyMountAnchorContext(ctx context.Context, sessionRoot, anchor string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := unix.Unmount(anchor, unix.MNT_DETACH); err != nil && err != unix.EINVAL && err != unix.ENOENT {
		return fmt.Errorf("unmount DAP dependency anchor %q: %w", anchor, err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.Remove(anchor); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove DAP dependency anchor %q: %w", anchor, err)
	}
	if err := os.Remove(sessionRoot); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove DAP dependency mount session %q: %w", sessionRoot, err)
	}
	return nil
}

// CleanupDependencyMountOrphans releases only DAP-managed anchors left after
// an unclean server exit. It never recursively removes a mounted directory.
func CleanupDependencyMountOrphans(mountRoot string) error {
	return CleanupDependencyMountOrphansContext(context.Background(), mountRoot)
}

// CleanupDependencyMountOrphansContext is the cancellable startup-recovery
// variant. Cancellation is checked between every managed session and anchor.
func CleanupDependencyMountOrphansContext(ctx context.Context, mountRoot string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	root, err := prepareDAPDependencyMountRoot(mountRoot)
	if err != nil {
		return fmt.Errorf("prepare DAP dependency mount cleanup: %w", err)
	}
	sessions, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("read DAP dependency mount root: %w", err)
	}
	var result error
	for _, session := range sessions {
		if err := ctx.Err(); err != nil {
			return errors.Join(result, err)
		}
		if !strings.HasPrefix(session.Name(), "session-") {
			continue
		}
		sessionRoot := filepath.Join(root, session.Name())
		if !session.IsDir() || session.Type()&os.ModeSymlink != 0 {
			result = errors.Join(result, fmt.Errorf("DAP dependency mount session %q is not a real directory", sessionRoot))
			continue
		}
		anchor := filepath.Join(sessionRoot, "dependency")
		info, statErr := os.Lstat(anchor)
		if os.IsNotExist(statErr) {
			if removeErr := os.Remove(sessionRoot); removeErr != nil && !os.IsNotExist(removeErr) {
				result = errors.Join(result, fmt.Errorf("remove empty DAP dependency mount session %q: %w", sessionRoot, removeErr))
			}
			continue
		}
		if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			if statErr != nil {
				result = errors.Join(result, fmt.Errorf("inspect DAP dependency anchor %q: %w", anchor, statErr))
			} else {
				result = errors.Join(result, fmt.Errorf("DAP dependency anchor %q is not a real directory", anchor))
			}
			continue
		}
		releaseErr := releaseDAPDependencyMountAnchorContext(ctx, sessionRoot, anchor)
		result = errors.Join(result, releaseErr)
		if ctx.Err() != nil {
			return errors.Join(result, ctx.Err())
		}
	}
	return result
}

func prepareDAPDependencyMountRoot(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("DAP dependency mount root is required")
	}
	root, err := filepath.Abs(value)
	if err != nil {
		return "", fmt.Errorf("resolve DAP dependency mount root: %w", err)
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", fmt.Errorf("create DAP dependency mount root: %w", err)
	}
	if err := os.Chmod(root, 0700); err != nil {
		return "", fmt.Errorf("protect DAP dependency mount root: %w", err)
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("DAP dependency mount root must be a real directory")
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil || filepath.Clean(resolved) != filepath.Clean(root) {
		return "", fmt.Errorf("DAP dependency mount root must not be redirected")
	}
	return root, nil
}
