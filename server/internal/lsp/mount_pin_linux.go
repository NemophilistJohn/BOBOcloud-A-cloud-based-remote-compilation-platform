//go:build linux

package lsp

import (
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

// pinDockerDependencyMounts anchors each already-validated source with a
// kernel bind mount in a server-owned directory. Docker receives the anchor,
// so replacing the original path after validation cannot redirect the mount.
func pinDockerDependencyMounts(mountRoot, sessionID string, mounts []AnalysisDependencyMount) ([]AnalysisDependencyMount, func(), error) {
	pinned := append([]AnalysisDependencyMount(nil), mounts...)
	if len(pinned) == 0 {
		return pinned, func() {}, nil
	}
	root, err := prepareDependencyMountRoot(mountRoot)
	if err != nil {
		return nil, func() {}, err
	}
	prefix := "session-" + safeLabel(sessionID) + "-"
	if prefix == "session--" {
		prefix = "session-"
	}
	sessionRoot, err := os.MkdirTemp(root, prefix)
	if err != nil {
		return nil, func() {}, fmt.Errorf("create dependency mount session: %w", err)
	}
	if err := os.Chmod(sessionRoot, 0700); err != nil {
		_ = os.Remove(sessionRoot)
		return nil, func() {}, fmt.Errorf("protect dependency mount session: %w", err)
	}

	anchors := make([]string, 0, len(pinned))
	var once sync.Once
	release := func() {
		once.Do(func() {
			if err := releaseDependencyMountAnchors(sessionRoot, anchors); err != nil {
				slog.Warn("Failed to release LSP dependency mount session", "path", sessionRoot, "error", err)
			}
		})
	}
	for index := range pinned {
		source := filepath.Clean(pinned[index].HostPath)
		fd, openErr := unix.Open(source, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if openErr != nil {
			release()
			return nil, func() {}, fmt.Errorf("pin dependency mount %q: %w", pinned[index].Role, openErr)
		}
		descriptorPath := "/proc/" + strconv.Itoa(os.Getpid()) + "/fd/" + strconv.Itoa(fd)
		actual, readErr := os.Readlink(descriptorPath)
		if readErr != nil || strings.HasSuffix(actual, " (deleted)") || filepath.Clean(actual) != source {
			_ = unix.Close(fd)
			release()
			if readErr != nil {
				return nil, func() {}, fmt.Errorf("verify dependency mount %q: %w", pinned[index].Role, readErr)
			}
			return nil, func() {}, fmt.Errorf("dependency mount %q changed while it was being anchored", pinned[index].Role)
		}

		anchor := filepath.Join(sessionRoot, fmt.Sprintf("mount-%03d", index))
		if mkdirErr := os.Mkdir(anchor, 0700); mkdirErr != nil {
			_ = unix.Close(fd)
			release()
			return nil, func() {}, fmt.Errorf("create dependency mount anchor %q: %w", pinned[index].Role, mkdirErr)
		}
		mountErr := unix.Mount(descriptorPath, anchor, "", unix.MS_BIND, "")
		_ = unix.Close(fd)
		if mountErr != nil {
			_ = os.Remove(anchor)
			release()
			return nil, func() {}, fmt.Errorf("anchor dependency mount %q: %w", pinned[index].Role, mountErr)
		}
		anchors = append(anchors, anchor)
		pinned[index].HostPath = anchor
		pinned[index].Pinned = true
	}
	return pinned, release, nil
}

func prepareDependencyMountRoot(value string) (string, error) {
	root, err := filepath.Abs(strings.TrimSpace(value))
	if err != nil || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("resolve dependency mount root")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", fmt.Errorf("create dependency mount root: %w", err)
	}
	if err := os.Chmod(root, 0700); err != nil {
		return "", fmt.Errorf("protect dependency mount root: %w", err)
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("dependency mount root must be a real directory")
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil || filepath.Clean(resolved) != filepath.Clean(root) {
		return "", fmt.Errorf("dependency mount root must not be redirected")
	}
	return root, nil
}

func releaseDependencyMountAnchors(sessionRoot string, anchors []string) error {
	var result error
	for index := len(anchors) - 1; index >= 0; index-- {
		anchor := anchors[index]
		if err := unix.Unmount(anchor, unix.MNT_DETACH); err != nil && err != unix.EINVAL && err != unix.ENOENT {
			result = errors.Join(result, fmt.Errorf("unmount LSP dependency anchor %q: %w", anchor, err))
			continue
		}
		if err := os.Remove(anchor); err != nil && !os.IsNotExist(err) {
			result = errors.Join(result, fmt.Errorf("remove LSP dependency anchor %q: %w", anchor, err))
		}
	}
	if result == nil {
		if err := os.Remove(sessionRoot); err != nil && !os.IsNotExist(err) {
			result = fmt.Errorf("remove LSP dependency mount session %q: %w", sessionRoot, err)
		}
	}
	return result
}

// CleanupDependencyMountOrphans releases anchors left after an unclean server
// exit. It never recursively removes a mounted directory.
func CleanupDependencyMountOrphans(mountRoot string) error {
	root, err := prepareDependencyMountRoot(mountRoot)
	if err != nil {
		return fmt.Errorf("prepare LSP dependency mount cleanup: %w", err)
	}
	sessions, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("read LSP dependency mount root: %w", err)
	}
	var result error
	for _, session := range sessions {
		if !strings.HasPrefix(session.Name(), "session-") {
			continue
		}
		sessionRoot := filepath.Join(root, session.Name())
		if !session.IsDir() || session.Type()&os.ModeSymlink != 0 {
			result = errors.Join(result, fmt.Errorf("LSP dependency mount session %q is not a real directory", sessionRoot))
			continue
		}
		entries, readErr := os.ReadDir(sessionRoot)
		if readErr != nil {
			result = errors.Join(result, fmt.Errorf("read LSP dependency mount session %q: %w", sessionRoot, readErr))
			continue
		}
		anchors := make([]string, 0, len(entries))
		for _, entry := range entries {
			if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 && strings.HasPrefix(entry.Name(), "mount-") {
				anchors = append(anchors, filepath.Join(sessionRoot, entry.Name()))
			}
		}
		result = errors.Join(result, releaseDependencyMountAnchors(sessionRoot, anchors))
	}
	return result
}
