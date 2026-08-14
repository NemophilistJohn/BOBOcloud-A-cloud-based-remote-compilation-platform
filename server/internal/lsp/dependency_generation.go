package lsp

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"bobocloud-server/internal/safefile"
)

const analysisDependencyGenerationFile = ".analysis-generation"
const maxAnalysisDependencyGenerationBytes = 4096

// BumpAnalysisDependencyGeneration publishes an O(1) invalidation marker in a
// server-owned dependency store. Runtime containers never receive this path as
// writable storage.
func BumpAnalysisDependencyGeneration(root string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" || strings.ContainsRune(root, '\x00') {
		return "", fmt.Errorf("analysis dependency root is required")
	}
	root, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return "", fmt.Errorf("resolve analysis dependency root: %w", err)
	}
	info, err := os.Lstat(root)
	if err != nil {
		return "", fmt.Errorf("inspect analysis dependency root: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("analysis dependency root must be a real directory")
	}

	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate analysis dependency revision: %w", err)
	}
	value := fmt.Sprintf("%d-%s", time.Now().UTC().UnixNano(), hex.EncodeToString(random))
	temporary, err := os.CreateTemp(root, ".analysis-generation-*")
	if err != nil {
		return "", fmt.Errorf("create analysis dependency revision: %w", err)
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err = temporary.Chmod(0600); err == nil {
		_, err = temporary.WriteString(value + "\n")
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", fmt.Errorf("write analysis dependency revision: %w", err)
	}
	target := filepath.Join(root, analysisDependencyGenerationFile)
	if err := os.Rename(name, target); err != nil {
		if removeErr := os.Remove(target); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return "", fmt.Errorf("replace analysis dependency revision: %w", err)
		}
		if err := os.Rename(name, target); err != nil {
			return "", fmt.Errorf("publish analysis dependency revision: %w", err)
		}
	}
	return value, nil
}

func analysisDependencyGeneration(root string) string {
	root = strings.TrimSpace(root)
	if root == "" || strings.ContainsRune(root, '\x00') {
		return ""
	}
	root, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return ""
	}
	rootInfo, err := os.Lstat(root)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return ""
	}
	data, err := safefile.ReadSmallRegular(root, analysisDependencyGenerationFile, maxAnalysisDependencyGenerationBytes)
	if err != nil {
		return ""
	}
	if len(data) > maxAnalysisDependencyGenerationBytes {
		return ""
	}
	value := strings.TrimSpace(string(data))
	if value == "" || strings.ContainsRune(value, '\x00') {
		return ""
	}
	return value
}

// trustedAnalysisDependencyGeneration only consumes a marker from a real
// server-authorized SnapshotRoot. Other path hints may still be passed to an
// adapter, but cannot influence the registry revision through this marker.
func trustedAnalysisDependencyGeneration(root string, allowedRoots []string) string {
	root = strings.TrimSpace(root)
	if root == "" || strings.ContainsRune(root, '\x00') || !filepath.IsAbs(root) {
		return ""
	}
	root = filepath.Clean(root)
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return ""
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil || !pathWithinAny(allowedRoots, resolved) {
		return ""
	}
	return analysisDependencyGeneration(resolved)
}
