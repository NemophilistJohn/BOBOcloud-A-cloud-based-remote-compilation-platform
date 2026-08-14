package handler

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/lsp"
)

func publishPersonalGradleDependencySnapshot(cfg *config.Config, users auth.UserStore, userID, runtimeID string) (lsp.DependencySnapshotResult, error) {
	if cfg == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(runtimeID) == "" {
		return lsp.DependencySnapshotResult{}, nil
	}
	userRoot := filepath.Join(cfg.DataDir, "users", userID)
	modulesRoot := filepath.Join(userRoot, "persist", "gradle", "caches", "modules-2")
	info, err := os.Lstat(modulesRoot)
	if os.IsNotExist(err) {
		return lsp.DependencySnapshotResult{}, nil
	}
	if err != nil {
		return lsp.DependencySnapshotResult{}, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return lsp.DependencySnapshotResult{}, fmt.Errorf("Gradle dependency root must be a real directory")
	}
	lease, err := lsp.AcquirePersonalDependencyStore(cfg.DataDir, userID)
	if err != nil {
		return lsp.DependencySnapshotResult{}, err
	}
	defer lease.Release()
	quotaBytes := int64(0)
	if users != nil {
		if user, userErr := users.Get(userID); userErr == nil && user.DiskQuotaMB > 0 {
			quotaBytes = int64(user.DiskQuotaMB) * 1_000_000
		}
	}
	gradleBytes := dirSizeOnDisk(filepath.Join(lease.Root, "gradle"))
	otherBytes := dirSizeOnDisk(userRoot) - gradleBytes
	return lsp.PublishGradleDependencySnapshotWithPolicy(
		lease.Root, runtimeID, modulesRoot, gradleDependencySnapshotPolicy(quotaBytes, otherBytes),
	)
}
