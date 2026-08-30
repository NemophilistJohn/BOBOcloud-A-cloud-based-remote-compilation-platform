package dap

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"bobocloud-server/internal/cachev2"
	"bobocloud-server/internal/safefile"
)

// CleanupUserDownloadCache removes one user's DAP adapter download cache.
// New lifecycle code should use CleanupUserDownloadCacheContext.
func CleanupUserDownloadCache(dataDir, userID string) error {
	return CleanupUserDownloadCacheContext(context.Background(), dataDir, userID)
}

// CleanupUserDownloadCacheContext removes only
// <dataDir>/dap-cache/downloads/<userID>. It deliberately does not share any
// path or cleanup behavior with the LSP cache.
func CleanupUserDownloadCacheContext(ctx context.Context, dataDir, userID string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(dataDir) == "" || strings.ContainsRune(dataDir, '\x00') {
		return fmt.Errorf("resolve DAP download cache: invalid data directory")
	}
	if err := cachev2.ValidatePathSegment(userID); err != nil {
		return fmt.Errorf("resolve DAP download cache: invalid user ID: %w", err)
	}

	dataRoot, err := filepath.Abs(filepath.Clean(dataDir))
	if err != nil {
		return fmt.Errorf("resolve DAP data directory: %w", err)
	}
	dapRoot := filepath.Join(dataRoot, "dap-cache")
	downloadsRoot := filepath.Join(dapRoot, "downloads")
	target := filepath.Join(downloadsRoot, userID)
	rel, err := filepath.Rel(downloadsRoot, target)
	if err != nil || rel != userID || filepath.IsAbs(rel) {
		return fmt.Errorf("resolve DAP download cache: path escapes download root")
	}

	for _, path := range []string{dataRoot, dapRoot, downloadsRoot, target} {
		exists, validateErr := validateExistingDAPCacheDirectory(path)
		if validateErr != nil {
			return validateErr
		}
		if !exists {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}

	if err := removeDAPDownloadTreeContext(ctx, downloadsRoot, userID); err != nil {
		return fmt.Errorf("remove DAP download cache for user %q: %w", userID, err)
	}
	return nil
}

func validateExistingDAPCacheDirectory(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect DAP cache directory %q: %w", path, err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, fmt.Errorf("DAP cache directory %q must be a real directory", path)
	}
	if _, err := safefile.RealDirectory(path); err != nil {
		return false, fmt.Errorf("DAP cache directory %q must not be redirected: %w", path, err)
	}
	return true, nil
}

func removeDAPDownloadTreeContext(ctx context.Context, downloadsRoot, userID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	downloadsInfo, err := os.Lstat(downloadsRoot)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !downloadsInfo.IsDir() || downloadsInfo.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("downloads root changed after validation")
	}
	downloads, err := os.OpenRoot(downloadsRoot)
	if err != nil {
		return err
	}
	defer downloads.Close()
	openedDownloadsInfo, err := downloads.Stat(".")
	if err != nil {
		return err
	}
	if !os.SameFile(downloadsInfo, openedDownloadsInfo) {
		return fmt.Errorf("downloads root changed while opening")
	}

	info, err := downloads.Lstat(userID)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("user cache changed after validation")
	}
	userRoot, err := downloads.OpenRoot(userID)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	openedInfo, err := userRoot.Stat(".")
	if err != nil {
		_ = userRoot.Close()
		return err
	}
	if !os.SameFile(info, openedInfo) {
		_ = userRoot.Close()
		return fmt.Errorf("user cache changed while opening")
	}
	if err := removeDAPDownloadRootContentsContext(ctx, userRoot, "."); err != nil {
		_ = userRoot.Close()
		return err
	}
	if err := userRoot.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	currentInfo, err := downloads.Lstat(userID)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !os.SameFile(info, currentInfo) {
		return fmt.Errorf("user cache changed before removal")
	}
	if err := downloads.Remove(userID); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func removeDAPDownloadRootContentsContext(ctx context.Context, root *os.Root, path string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	directory, err := root.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	entries, readErr := directory.ReadDir(-1)
	closeErr := directory.Close()
	if readErr != nil {
		return readErr
	}
	if closeErr != nil {
		return closeErr
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		child := filepath.Join(path, entry.Name())
		childInfo, err := root.Lstat(child)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if childInfo.IsDir() && childInfo.Mode()&os.ModeSymlink == 0 {
			if err := removeDAPDownloadRootContentsContext(ctx, root, child); err != nil {
				return err
			}
		}
		if err := root.Remove(child); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return ctx.Err()
}
