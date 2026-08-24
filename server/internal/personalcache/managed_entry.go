package personalcache

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"bobocloud-server/internal/cachev2"
)

// InspectEntryPackageInventory reads an exact cache selector for management
// views. It never grants mutation authority over packages inside that digest.
func (m *Manager) InspectEntryPackageInventory(userID, relative string) (Entry, InventoryInspection, bool, error) {
	if m == nil {
		return Entry{}, InventoryInspection{State: "unavailable", Detail: "Project dependency cache inspection is unavailable"}, false, nil
	}
	gate := m.userGate(userID)
	gate.Lock()
	defer gate.Unlock()
	request, _, entry, err := m.resolveManagedEntryLocked(userID, relative, 0)
	if errors.Is(err, os.ErrNotExist) {
		return Entry{}, InventoryInspection{State: "missing", Detail: "Project dependency cache does not exist"}, false, nil
	}
	if err != nil {
		return Entry{}, InventoryInspection{State: "error", Detail: err.Error()}, false, err
	}
	return entry, m.inspectPackageInventoryEntryLocked(request, entry), true, nil
}

// resolveManagedEntryLocked resolves a cache-management selector without
// recomputing a workspace fingerprint. The caller must hold the user's gate.
func (m *Manager) resolveManagedEntryLocked(userID, relative string, quotaBytes int64) (Request, resolvedCacheRequest, Entry, error) {
	if strings.TrimSpace(userID) == "" {
		return Request{}, resolvedCacheRequest{}, Entry{}, fmt.Errorf("user id is required")
	}
	layout, err := m.ensureUserLayout(userID)
	if err != nil {
		return Request{}, resolvedCacheRequest{}, Entry{}, err
	}
	persistRoot := layout.Root
	managedRoot := filepath.Join(persistRoot, dependenciesDir)
	target := filepath.Clean(filepath.Join(persistRoot, filepath.FromSlash(relative)))
	if target == managedRoot || !strings.HasPrefix(target, managedRoot+string(filepath.Separator)) {
		return Request{}, resolvedCacheRequest{}, Entry{}, fmt.Errorf("path is not a project dependency namespace")
	}
	relativeManaged, err := filepath.Rel(managedRoot, target)
	parts := strings.Split(filepath.ToSlash(relativeManaged), "/")
	if err != nil || len(parts) != 4 {
		return Request{}, resolvedCacheRequest{}, Entry{}, fmt.Errorf("path is not an individual project dependency namespace")
	}
	if err := validateManagedDirectoryChain(m.root, target); err != nil {
		return Request{}, resolvedCacheRequest{}, Entry{}, err
	}
	data, err := readSmallRegularFile(filepath.Join(target, metadataFile), maxMetadataBytes)
	if err != nil {
		return Request{}, resolvedCacheRequest{}, Entry{}, err
	}
	var meta metadata
	if json.Unmarshal(data, &meta) != nil || !metadataMatchesPath(meta, userID, parts) {
		return Request{}, resolvedCacheRequest{}, Entry{}, fmt.Errorf("project dependency cache metadata does not match its path")
	}
	request := Request{
		UserID: meta.UserID, WorkspaceID: meta.WorkspaceID, WorkspaceName: meta.WorkspaceName,
		RuntimeID: meta.RuntimeID, RuntimeFingerprint: meta.RuntimeFingerprint, Language: meta.Language, QuotaBytes: quotaBytes,
	}
	resolved := resolvedCacheRequest{
		fingerprint: Fingerprint{Digest: meta.Digest, Source: meta.DigestSource, Manifests: append([]string(nil), meta.Manifests...)},
		key:         metadataKey(meta), persistRoot: persistRoot, hostRoot: target,
		relative: filepath.Clean(filepath.Join(dependenciesDir, relativeManaged)), workspace: parts[0], runtime: parts[1], language: parts[2],
	}
	m.mu.Lock()
	active, writing := m.active[resolved.key] > 0, m.writers[resolved.key] > 0
	m.mu.Unlock()
	id, err := cachev2.ReadPersistentCacheID(target)
	if err != nil {
		return Request{}, resolvedCacheRequest{}, Entry{}, err
	}
	binding, bound := readCurrentBinding(persistRoot, request)
	current := bound && binding.CacheID == id && binding.Digest == meta.Digest
	entry := Entry{
		ID: id.String(), Category: "dependency", Path: filepath.ToSlash(resolved.relative), WorkspaceID: meta.WorkspaceID, WorkspaceName: meta.WorkspaceName,
		RuntimeID: meta.RuntimeID, Language: meta.Language, Digest: meta.Digest, DigestSource: meta.DigestSource,
		LastUsed: meta.LastUsed, CreatedAt: meta.CreatedAt, Current: current, Superseded: !current,
		Active: active, Writing: writing, Generation: readGeneration(target), HostPath: target,
		key: resolved.key, absPath: target,
	}
	return request, resolved, entry, nil
}

func validateManagedDirectoryChain(root, target string) error {
	cleanRoot, cleanTarget := filepath.Clean(root), filepath.Clean(target)
	relative, err := filepath.Rel(cleanRoot, cleanTarget)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("project dependency cache path escapes manager root")
	}
	current := cleanRoot
	if info, statErr := os.Lstat(current); statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		if statErr != nil {
			return statErr
		}
		return fmt.Errorf("project dependency manager root is not a real directory")
	}
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("invalid project dependency cache path")
		}
		current = filepath.Join(current, part)
		info, statErr := os.Lstat(current)
		if statErr != nil {
			return statErr
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("project dependency cache path contains a non-directory or symlink")
		}
	}
	return nil
}
