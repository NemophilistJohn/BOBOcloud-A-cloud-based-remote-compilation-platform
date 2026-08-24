package personalcache

import (
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"bobocloud-server/internal/cachev2"
)

// recoverDependencyTransactions handles an unclean exit between inventory
// publication and generation retirement. Completed staged generations are
// restored only when the canonical path is absent; everything else is stale
// transaction data and is removed so it cannot become hidden quota usage.
func recoverDependencyTransactions(managerRoot string) {
	users, err := os.ReadDir(managerRoot)
	if err != nil {
		return
	}
	for _, user := range users {
		if !user.IsDir() || user.Type()&os.ModeSymlink != 0 {
			continue
		}
		layout, _, layoutErr := cachev2.EnsureUserLayout(filepath.Dir(managerRoot), user.Name())
		if layoutErr != nil {
			slog.Warn("Skipped invalid personal cache-v2 namespace during recovery", "user_id", user.Name(), "error", layoutErr)
			continue
		}
		recoverCacheV2DeletionTransactions(layout)
		persistRoot := layout.Root
		for _, internal := range []string{stagingDir, retiredDir} {
			recoverDependencyTransactionDirectory(managerRoot, persistRoot, user.Name(), internal)
		}
	}
}

func recoverDependencyTransactionDirectory(managerRoot, persistRoot, userID, name string) {
	root := filepath.Join(persistRoot, name)
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		candidate := filepath.Join(root, entry.Name())
		if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
			if target, ok := recoverableDependencyTarget(persistRoot, userID, candidate); ok {
				if _, statErr := os.Lstat(target); os.IsNotExist(statErr) {
					resolved := resolvedCacheRequest{
						persistRoot: persistRoot, workspace: filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(target)))),
						runtime: filepath.Base(filepath.Dir(filepath.Dir(target))), language: filepath.Base(filepath.Dir(target)),
					}
					if parentErr := ensureCacheParents(managerRoot, userID, resolved); parentErr == nil {
						if renameErr := os.Rename(candidate, target); renameErr == nil {
							slog.Info("Recovered published project dependency generation", "user_id", userID, "path", filepath.ToSlash(strings.TrimPrefix(target, persistRoot+string(filepath.Separator))))
							continue
						}
					}
				}
			}
		}
		if removeErr := os.RemoveAll(candidate); removeErr != nil {
			slog.Warn("Failed to remove stale project dependency transaction", "path", candidate, "error", removeErr)
		}
	}
	_ = os.Remove(root)
}

func recoverableDependencyTarget(persistRoot, userID, candidate string) (string, bool) {
	data, err := readSmallRegularFile(filepath.Join(candidate, metadataFile), maxMetadataBytes)
	if err != nil {
		return "", false
	}
	var meta metadata
	if json.Unmarshal(data, &meta) != nil || meta.Schema != cacheSchema || meta.UserID != userID || strings.TrimSpace(meta.WorkspaceID) == "" || strings.TrimSpace(meta.RuntimeID) == "" || strings.TrimSpace(meta.Language) == "" {
		return "", false
	}
	if len(meta.Digest) != 32 {
		return "", false
	}
	if _, err := hex.DecodeString(meta.Digest); err != nil {
		return "", false
	}
	if strings.EqualFold(meta.Language, "python") {
		document, readErr := readPackageInventory(candidate)
		if readErr != nil || document.State != "ready" || document.Digest != meta.Digest {
			return "", false
		}
	}
	target := filepath.Join(persistRoot, dependenciesDir, safePart(meta.WorkspaceID), safePart(meta.RuntimeID), safePart(meta.Language), meta.Digest)
	return target, true
}
