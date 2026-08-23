package personalcache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

var (
	ErrCacheGenerationChanged   = errors.New("project dependency cache generation changed")
	ErrInventoryRevisionChanged = errors.New("project dependency inventory revision changed")
	ErrPackageNotFound          = errors.New("Python distribution was not found in the exact inventory")
	ErrPackageVersionChanged    = errors.New("Python distribution version changed")
	ErrPackageDeleteUnsupported = errors.New("package-level deletion is not supported for this cache")
)

type DeletePythonDistributionRequest struct {
	UserID                    string
	CachePath                 string
	Name                      string
	Version                   string
	ExpectedGeneration        string
	ExpectedInventoryRevision string
	QuotaBytes                int64
}

type DeletePythonDistributionResult struct {
	Name               string             `json:"name"`
	Version            string             `json:"version"`
	PreviousGeneration string             `json:"previous_generation"`
	Generation         string             `json:"generation"`
	InventoryRevision  string             `json:"inventory_revision"`
	Packages           []InventoryPackage `json:"packages"`
	FreedBytes         int64              `json:"freed_bytes"`
	FreedFiles         int                `json:"freed_files"`
}

func (m *Manager) InspectEntryPackageInventory(userID, relative string) (Entry, InventoryInspection, bool, error) {
	if m == nil || m.options.ScopeMode != "project-lock" {
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

func (m *Manager) DeletePythonDistribution(ctx context.Context, request DeletePythonDistributionRequest) (DeletePythonDistributionResult, error) {
	if m == nil || m.options.ScopeMode != "project-lock" {
		return DeletePythonDistributionResult{}, ErrPackageDeleteUnsupported
	}
	request.UserID = strings.TrimSpace(request.UserID)
	request.Name = normalizeInventoryPythonName(request.Name)
	request.Version = strings.TrimSpace(request.Version)
	request.ExpectedGeneration = strings.TrimSpace(request.ExpectedGeneration)
	request.ExpectedInventoryRevision = strings.TrimSpace(request.ExpectedInventoryRevision)
	if request.UserID == "" || strings.TrimSpace(request.CachePath) == "" || request.Name == "" || request.Version == "" || request.ExpectedGeneration == "" || request.ExpectedInventoryRevision == "" {
		return DeletePythonDistributionResult{}, fmt.Errorf("cache path, distribution name, version, generation, and inventory revision are required")
	}

	gate := m.userGate(request.UserID)
	gate.Lock()
	cacheRequest, resolved, entry, err := m.resolveManagedEntryLocked(request.UserID, request.CachePath, request.QuotaBytes)
	if err != nil {
		gate.Unlock()
		return DeletePythonDistributionResult{}, err
	}
	if !strings.EqualFold(entry.Language, "python") {
		gate.Unlock()
		return DeletePythonDistributionResult{}, ErrPackageDeleteUnsupported
	}
	if err := m.waitForWriter(ctx, resolved.key, gate); err != nil {
		gate.Unlock()
		return DeletePythonDistributionResult{}, err
	}
	cacheRequest, resolved, entry, err = m.resolveManagedEntryLocked(request.UserID, request.CachePath, request.QuotaBytes)
	if err != nil {
		gate.Unlock()
		return DeletePythonDistributionResult{}, err
	}
	baseGeneration := entry.Generation
	if baseGeneration == "" {
		baseGeneration = entry.Digest
	}
	if baseGeneration != request.ExpectedGeneration {
		gate.Unlock()
		return DeletePythonDistributionResult{}, ErrCacheGenerationChanged
	}
	inspection := m.inspectPackageInventoryEntryLocked(cacheRequest, entry)
	if inspection.State != "ready" || !inspection.Exact {
		gate.Unlock()
		return DeletePythonDistributionResult{}, fmt.Errorf("%w: inventory is %s", ErrPackageDeleteUnsupported, inspection.State)
	}
	if inspection.Revision != request.ExpectedInventoryRevision {
		gate.Unlock()
		return DeletePythonDistributionResult{}, ErrInventoryRevisionChanged
	}

	stagingRoot := filepath.Join(resolved.persistRoot, stagingDir)
	if err := ensureRealDirectory(stagingRoot); err != nil {
		gate.Unlock()
		return DeletePythonDistributionResult{}, err
	}
	workRoot, err := os.MkdirTemp(stagingRoot, "generation-")
	if err != nil {
		gate.Unlock()
		return DeletePythonDistributionResult{}, err
	}
	baseline, err := cloneDependencyTree(resolved.hostRoot, workRoot)
	if err != nil {
		_ = os.RemoveAll(workRoot)
		gate.Unlock()
		return DeletePythonDistributionResult{}, fmt.Errorf("stage project dependency cache deletion: %w", err)
	}
	generation, err := replaceGeneration(workRoot)
	if err == nil {
		cacheRequest.QuotaBytes = request.QuotaBytes
		entryMeta := metadata{
			Schema: 1, UserID: cacheRequest.UserID, WorkspaceID: cacheRequest.WorkspaceID, WorkspaceName: cacheRequest.WorkspaceName,
			RuntimeID: cacheRequest.RuntimeID, RuntimeFingerprint: cacheRequest.RuntimeFingerprint, Language: cacheRequest.Language,
			Digest: entry.Digest, DigestSource: entry.DigestSource, CreatedAt: entry.LastUsed, LastUsed: time.Now().UTC(),
		}
		if storedData, readErr := readSmallRegularFile(filepath.Join(resolved.hostRoot, metadataFile), maxMetadataBytes); readErr == nil {
			var stored metadata
			if json.Unmarshal(storedData, &stored) == nil {
				entryMeta = stored
				entryMeta.LastUsed = time.Now().UTC()
			}
		}
		err = writeMetadata(workRoot, entryMeta)
		if err == nil {
			err = markPackageInventoryDirty(workRoot, cacheRequest.Language, entry.Digest)
		}
		if err == nil {
			m.mu.Lock()
			m.active[resolved.key]++
			m.writers[resolved.key]++
			m.writerHasBase[resolved.key] = true
			m.activePaths[filepath.Clean(workRoot)]++
			m.activeUsers[request.UserID]++
			m.mu.Unlock()
			lease := &Lease{
				Key: resolved.key, ContainerKey: "personal/" + resolved.key + "@" + generation + ":rw", Generation: generation,
				HostRoot: workRoot, RelativePath: filepath.ToSlash(resolved.relative), DockerMounts: map[string]string{workRoot: "/project-deps"},
				DockerEnv: dependencyEnvironment(cacheRequest.Language), Fingerprint: resolved.fingerprint, Hit: true,
				manager: m, request: cacheRequest, meta: entryMeta, canonical: resolved.hostRoot, staged: true, writable: true,
				stageBaseline: baseline, reserved: false,
			}
			gate.Unlock()
			return m.deletePythonDistributionFromLease(lease, request)
		}
	}
	_ = os.RemoveAll(workRoot)
	gate.Unlock()
	return DeletePythonDistributionResult{}, err
}

func (m *Manager) deletePythonDistributionFromLease(lease *Lease, request DeletePythonDistributionRequest) (DeletePythonDistributionResult, error) {
	result := DeletePythonDistributionResult{
		Name: request.Name, Version: request.Version, PreviousGeneration: request.ExpectedGeneration, Generation: lease.Generation,
	}
	packages, revision, freedBytes, freedFiles, err := removePythonDistribution(filepath.Join(lease.HostRoot, "python"), request.Name, request.Version, request.ExpectedInventoryRevision)
	if err != nil {
		lease.Abort()
		lease.Release()
		return DeletePythonDistributionResult{}, err
	}
	result.Packages, result.InventoryRevision, result.FreedBytes, result.FreedFiles = packages, revision, freedBytes, freedFiles
	lease.Release()
	if !lease.Published() {
		return DeletePythonDistributionResult{}, fmt.Errorf("publish package deletion generation")
	}
	return result, nil
}

func removePythonDistribution(root, name, version, expectedRevision string) ([]InventoryPackage, string, int64, int, error) {
	tree, err := scanPythonPackageTreeDetailed(root)
	if err != nil {
		return nil, "", 0, 0, err
	}
	if tree.Revision != expectedRevision {
		return nil, "", 0, 0, ErrInventoryRevisionChanged
	}
	distribution := tree.Distributions[normalizeInventoryPythonName(name)]
	if distribution == nil {
		return nil, "", 0, 0, ErrPackageNotFound
	}
	if distribution.Package.Version != strings.TrimSpace(version) {
		return nil, "", 0, 0, ErrPackageVersionChanged
	}

	paths := make([]string, 0, len(distribution.OwnedPaths))
	for relative := range distribution.OwnedPaths {
		owned := tree.OwnedPaths[relative]
		if owned == nil {
			return nil, "", 0, 0, fmt.Errorf("Python distribution ownership graph is incomplete")
		}
		if len(owned.Owners) == 1 && owned.Owners[distribution.Package.Name] {
			paths = append(paths, relative)
			continue
		}
		if relative == distribution.MetadataRoot || strings.HasPrefix(relative, distribution.MetadataRoot+"/") {
			return nil, "", 0, 0, fmt.Errorf("Python distribution metadata is shared by another distribution")
		}
	}
	sort.Slice(paths, func(i, j int) bool {
		depthI, depthJ := strings.Count(paths[i], "/"), strings.Count(paths[j], "/")
		if depthI != depthJ {
			return depthI > depthJ
		}
		return paths[i] > paths[j]
	})
	var freedBytes int64
	for _, relative := range paths {
		owned := tree.OwnedPaths[relative]
		if err := removePythonInventoryFile(root, relative); err != nil {
			return nil, "", 0, 0, fmt.Errorf("delete Python distribution file %q: %w", relative, err)
		}
		freedBytes += owned.Size
	}
	if err := pruneEmptyPythonDirectories(root); err != nil {
		return nil, "", 0, 0, err
	}
	after, err := scanPythonPackageTreeDetailed(root)
	if err != nil {
		return nil, "", 0, 0, fmt.Errorf("verify Python package tree after deletion: %w", err)
	}
	if after.Distributions[distribution.Package.Name] != nil {
		return nil, "", 0, 0, fmt.Errorf("Python distribution metadata survived deletion")
	}
	return after.Packages, after.Revision, freedBytes, len(paths), nil
}

func pruneEmptyPythonDirectories(root string) error {
	directories := make([]string, 0)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Python package tree contains symlink %q", filepath.ToSlash(path))
		}
		if info.IsDir() {
			relative, relErr := filepath.Rel(root, path)
			if relErr != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
				return fmt.Errorf("Python package directory escapes target root")
			}
			directories = append(directories, filepath.ToSlash(relative))
		}
		return nil
	})
	if err != nil {
		return err
	}
	sort.Slice(directories, func(i, j int) bool {
		depthI, depthJ := strings.Count(directories[i], "/"), strings.Count(directories[j], "/")
		if depthI != depthJ {
			return depthI > depthJ
		}
		return directories[i] > directories[j]
	})
	for _, relative := range directories {
		if err := removePythonInventoryDirectory(root, relative); err != nil && !errors.Is(err, fs.ErrExist) && !errors.Is(err, syscall.ENOTEMPTY) {
			return err
		}
	}
	return nil
}

func (m *Manager) resolveManagedEntryLocked(userID, relative string, quotaBytes int64) (Request, resolvedCacheRequest, Entry, error) {
	if strings.TrimSpace(userID) == "" {
		return Request{}, resolvedCacheRequest{}, Entry{}, fmt.Errorf("user id is required")
	}
	persistRoot := filepath.Join(m.root, userID, "persist")
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
	entry := Entry{
		Path: filepath.ToSlash(resolved.relative), WorkspaceID: meta.WorkspaceID, WorkspaceName: meta.WorkspaceName,
		RuntimeID: meta.RuntimeID, Language: meta.Language, Digest: meta.Digest, DigestSource: meta.DigestSource,
		LastUsed: meta.LastUsed, Active: active, Writing: writing, Generation: readGeneration(target), HostPath: target,
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
