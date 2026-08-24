package personalcache

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"bobocloud-server/internal/cachev2"
)

type buildCurrentBinding struct {
	Schema        int             `json:"schema"`
	CacheID       cachev2.CacheID `json:"cache_id"`
	ResultCacheID cachev2.CacheID `json:"result_cache_id,omitempty"`
	Identity      string          `json:"identity"`
	UpdatedAt     time.Time       `json:"updated_at"`
}

func currentBindingPath(cacheRoot string, request Request) string {
	return filepath.Join(cacheRoot, bindingsDir, safePart(request.WorkspaceID), safePart(request.RuntimeID), safePart(request.Language)+".json")
}

func readCurrentDigest(cacheRoot string, request Request) string {
	binding, ok := readCurrentBinding(cacheRoot, request)
	if !ok {
		return ""
	}
	return strings.TrimSpace(binding.Digest)
}

func readCurrentBinding(cacheRoot string, request Request) (currentBinding, bool) {
	data, err := readSmallRegularFile(currentBindingPath(cacheRoot, request), maxMetadataBytes)
	if err != nil {
		return currentBinding{}, false
	}
	var binding currentBinding
	if json.Unmarshal(data, &binding) != nil || binding.Schema != cacheSchema || !binding.CacheID.Valid() {
		return currentBinding{}, false
	}
	return binding, true
}

func (m *Manager) writeCurrentBindingLocked(request Request, resolved resolvedCacheRequest) error {
	id, err := cachev2.ReadPersistentCacheID(resolved.hostRoot)
	if err != nil {
		return err
	}
	binding := currentBinding{Schema: cacheSchema, CacheID: id, Digest: resolved.fingerprint.Digest, UpdatedAt: time.Now().UTC()}
	data, err := json.MarshalIndent(binding, "", "  ")
	if err != nil {
		return err
	}
	path := currentBindingPath(resolved.persistRoot, request)
	directories := []string{
		filepath.Join(resolved.persistRoot, "registry"),
		filepath.Join(resolved.persistRoot, bindingsDir),
		filepath.Join(resolved.persistRoot, bindingsDir, safePart(request.WorkspaceID)),
		filepath.Dir(path),
	}
	for _, directory := range directories {
		if err := ensureRealDirectory(directory); err != nil {
			return err
		}
	}
	return atomicWriteFile(filepath.Dir(path), filepath.Base(path), data, 0600)
}

func buildCurrentBindingPath(cacheRoot string, request BuildRequest) string {
	return filepath.Join(cacheRoot, bindingsDir, "build", safePart(request.WorkspaceID), safePart(request.RuntimeFingerprint), safePart(request.Language), safePart(request.Target)+".json")
}

func readBuildCurrentBinding(cacheRoot string, request BuildRequest) (buildCurrentBinding, bool) {
	data, err := readSmallRegularFile(buildCurrentBindingPath(cacheRoot, request), maxMetadataBytes)
	if err != nil {
		return buildCurrentBinding{}, false
	}
	var binding buildCurrentBinding
	if json.Unmarshal(data, &binding) != nil || binding.Schema != cacheSchema || strings.TrimSpace(binding.Identity) == "" ||
		!binding.CacheID.Valid() || (binding.ResultCacheID != "" && !binding.ResultCacheID.Valid()) {
		return buildCurrentBinding{}, false
	}
	return binding, true
}

func (m *Manager) writeBuildCurrentBindingLocked(request BuildRequest, identity, cacheRoot string) error {
	incrementalRoot := filepath.Join(cacheRoot, incrementalDir, safePart(request.WorkspaceID), safePart(request.RuntimeFingerprint), safePart(request.Language), identity)
	resultRoot := filepath.Join(cacheRoot, cachev2.ResultsRelativePath, safePart(request.WorkspaceID), safePart(request.RuntimeFingerprint), safePart(request.Language), identity)
	cacheID, err := cachev2.ReadPersistentCacheID(incrementalRoot)
	if err != nil {
		return err
	}
	resultCacheID, err := cachev2.ReadPersistentCacheID(resultRoot)
	if err != nil {
		return err
	}
	binding := buildCurrentBinding{
		Schema: cacheSchema, CacheID: cacheID, ResultCacheID: resultCacheID,
		Identity: identity, UpdatedAt: time.Now().UTC(),
	}
	data, err := json.MarshalIndent(binding, "", "  ")
	if err != nil {
		return err
	}
	path := buildCurrentBindingPath(cacheRoot, request)
	for _, directory := range []string{
		filepath.Join(cacheRoot, "registry"), filepath.Join(cacheRoot, bindingsDir),
		filepath.Join(cacheRoot, bindingsDir, "build"),
		filepath.Join(cacheRoot, bindingsDir, "build", safePart(request.WorkspaceID)),
		filepath.Join(cacheRoot, bindingsDir, "build", safePart(request.WorkspaceID), safePart(request.RuntimeFingerprint)),
		filepath.Dir(path),
	} {
		if err := ensureRealDirectory(directory); err != nil {
			return err
		}
	}
	return atomicWriteFile(filepath.Dir(path), filepath.Base(path), data, 0600)
}

func removeBuildCurrentBindingIfMatches(cacheRoot string, request BuildRequest, cacheID cachev2.CacheID) error {
	binding, ok := readBuildCurrentBinding(cacheRoot, request)
	if !ok || (binding.CacheID != cacheID && binding.ResultCacheID != cacheID) {
		return nil
	}
	if err := os.Remove(buildCurrentBindingPath(cacheRoot, request)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove build cache current binding: %w", err)
	}
	return nil
}

func removeBuildCurrentReference(cacheRoot string, request BuildRequest, cacheID cachev2.CacheID) error {
	binding, ok := readBuildCurrentBinding(cacheRoot, request)
	if !ok || (binding.CacheID != cacheID && binding.ResultCacheID != cacheID) {
		return nil
	}
	path := buildCurrentBindingPath(cacheRoot, request)
	if binding.CacheID == cacheID {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove build cache current binding: %w", err)
		}
		return nil
	}
	binding.ResultCacheID = ""
	binding.UpdatedAt = time.Now().UTC()
	data, err := json.MarshalIndent(binding, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(filepath.Dir(path), filepath.Base(path), data, 0600)
}

func removeCurrentBindingIfMatches(cacheRoot string, request Request, digest string) error {
	path := currentBindingPath(cacheRoot, request)
	if readCurrentDigest(cacheRoot, request) != digest {
		return nil
	}
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// pruneSupersededLocked bounds immutable dependency history per
// project/runtime/language binding. The authoritative current digest and every
// active reader/writer remain protected regardless of age.
func (m *Manager) pruneSupersededLocked(request Request, resolved resolvedCacheRequest) bool {
	if m == nil || m.options.MaxGenerations <= 0 {
		return false
	}
	root := filepath.Dir(resolved.hostRoot)
	directories, err := os.ReadDir(root)
	if err != nil || len(directories) <= m.options.MaxGenerations {
		return false
	}
	type candidate struct {
		path     string
		key      string
		digest   string
		lastUsed time.Time
		active   bool
	}
	current := readCurrentDigest(resolved.persistRoot, request)
	candidates := make([]candidate, 0, len(directories))
	m.mu.Lock()
	for _, directory := range directories {
		if !directory.IsDir() || directory.Type()&os.ModeSymlink != 0 {
			continue
		}
		path := filepath.Join(root, directory.Name())
		data, readErr := readSmallRegularFile(filepath.Join(path, metadataFile), maxMetadataBytes)
		var meta metadata
		if readErr != nil || json.Unmarshal(data, &meta) != nil || meta.Schema != cacheSchema {
			continue
		}
		key := metadataKey(meta)
		candidates = append(candidates, candidate{
			path: path, key: key, digest: meta.Digest, lastUsed: meta.LastUsed,
			active: m.active[key] > 0 || m.writers[key] > 0,
		})
	}
	m.mu.Unlock()
	if len(candidates) <= m.options.MaxGenerations {
		return false
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].lastUsed.After(candidates[j].lastUsed) })
	kept := 0
	removed := false
	for _, candidate := range candidates {
		protected := candidate.digest == current || candidate.active
		if protected || kept < m.options.MaxGenerations {
			kept++
			continue
		}
		if os.RemoveAll(candidate.path) == nil {
			m.mu.Lock()
			delete(m.mutations, candidate.key)
			m.mu.Unlock()
			removed = true
		}
	}
	return removed
}
