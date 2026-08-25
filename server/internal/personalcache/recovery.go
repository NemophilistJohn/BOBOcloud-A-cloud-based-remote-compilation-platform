package personalcache

import (
	"context"
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
	_ = recoverDependencyTransactionsContext(context.Background(), managerRoot)
}

func recoverDependencyTransactionsContext(ctx context.Context, managerRoot string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	users, err := os.ReadDir(managerRoot)
	if err != nil {
		return nil
	}
	for _, user := range users {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !user.IsDir() || user.Type()&os.ModeSymlink != 0 {
			continue
		}
		layout, _, layoutErr := cachev2.EnsureUserLayout(filepath.Dir(managerRoot), user.Name())
		if layoutErr != nil {
			slog.Warn("Skipped invalid personal cache-v2 namespace during recovery", "user_id", user.Name(), "error", layoutErr)
			continue
		}
		if err := recoverCacheV2DeletionTransactionsContext(ctx, layout); err != nil {
			return err
		}
		persistRoot := layout.Root
		for _, internal := range []string{stagingDir, retiredDir} {
			if err := recoverDependencyTransactionDirectoryContext(ctx, managerRoot, persistRoot, user.Name(), internal); err != nil {
				return err
			}
		}
	}
	return ctx.Err()
}

func recoverDependencyTransactionDirectory(managerRoot, persistRoot, userID, name string) {
	_ = recoverDependencyTransactionDirectoryContext(context.Background(), managerRoot, persistRoot, userID, name)
}

func recoverDependencyTransactionDirectoryContext(ctx context.Context, managerRoot, persistRoot, userID, name string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	root := filepath.Join(persistRoot, name)
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		candidate := filepath.Join(root, entry.Name())
		if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
			target, ok, targetErr := recoverableDependencyTargetContext(ctx, persistRoot, userID, candidate)
			if targetErr != nil {
				return targetErr
			}
			if ok {
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
		if removeErr := removeRecoveryTreeContext(ctx, candidate); removeErr != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			slog.Warn("Failed to remove stale project dependency transaction", "path", candidate, "error", removeErr)
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	_ = os.Remove(root)
	return nil
}

func recoverableDependencyTarget(persistRoot, userID, candidate string) (string, bool) {
	target, ok, _ := recoverableDependencyTargetContext(context.Background(), persistRoot, userID, candidate)
	return target, ok
}

func recoverableDependencyTargetContext(ctx context.Context, persistRoot, userID, candidate string) (string, bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return "", false, err
	}
	data, err := readSmallRegularFile(filepath.Join(candidate, metadataFile), maxMetadataBytes)
	if err != nil {
		return "", false, nil
	}
	var meta metadata
	if json.Unmarshal(data, &meta) != nil || meta.Schema != cacheSchema || meta.UserID != userID || strings.TrimSpace(meta.WorkspaceID) == "" || strings.TrimSpace(meta.RuntimeID) == "" || strings.TrimSpace(meta.Language) == "" {
		return "", false, nil
	}
	if len(meta.Digest) != 32 {
		return "", false, nil
	}
	if _, err := hex.DecodeString(meta.Digest); err != nil {
		return "", false, nil
	}
	if exactPackageInventoryLanguage(meta.Language) {
		document, readErr := readPackageInventory(candidate)
		if readErr != nil || document.Schema != packageInventorySchema || document.State != "ready" ||
			document.Digest != meta.Digest || !strings.EqualFold(document.Language, meta.Language) {
			return "", false, nil
		}
		_, revision, _, scanErr := scanManagedPackageTreeContext(ctx, candidate, meta.Language)
		if ctx.Err() != nil {
			return "", false, ctx.Err()
		}
		if scanErr != nil || revision != document.TreeRevision {
			return "", false, nil
		}
	}
	target := filepath.Join(persistRoot, dependenciesDir, safePart(meta.WorkspaceID), safePart(meta.RuntimeID), safePart(meta.Language), meta.Digest)
	return target, true, nil
}

// removeRecoveryTreeContext mirrors os.RemoveAll for recovery-owned paths but
// checks cancellation before every directory entry. A partial removal is safe:
// the remaining transaction stays hidden and is retried on the next startup.
func removeRecoveryTreeContext(ctx context.Context, path string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return os.Remove(path)
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := removeRecoveryTreeContext(ctx, filepath.Join(path, entry.Name())); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return os.Remove(path)
}
