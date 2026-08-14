package lsp

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/safefile"
)

const (
	cacheMetadataFile     = ".lsp-cache.json"
	cacheMetadataMaxBytes = 64 << 10
	cacheSizeScanEntries  = 200_000
	cacheSizeScanDuration = 2 * time.Second
	cacheQuickScanEntries = 4_096
	cacheQuickScanBudget  = 20 * time.Millisecond
	cacheNamespaceEntries = 16_384
	cacheNamespaceBudget  = 250 * time.Millisecond
	cacheOwnerScanEntries = 50_000
	cacheOwnerScanBudget  = 500 * time.Millisecond
	cacheEntryChargeBytes = int64(4096)
)

type CacheNamespace struct {
	Key        string    `json:"key"`
	OwnerKind  string    `json:"ownerKind"`
	OwnerID    string    `json:"ownerId"`
	UserID     string    `json:"userId"`
	ProjectID  string    `json:"projectId,omitempty"`
	Branch     string    `json:"branch,omitempty"`
	FolderKey  string    `json:"folderKey,omitempty"`
	RuntimeID  string    `json:"runtimeId"`
	LanguageID string    `json:"languageId"`
	Mode       Mode      `json:"mode"`
	LockHash   string    `json:"lockHash"`
	Toolchain  string    `json:"toolchain"`
	Path       string    `json:"-"`
	SizeBytes  int64     `json:"sizeBytes"`
	Entries    int64     `json:"entries"`
	LastUsed   time.Time `json:"lastUsed"`
	Active     bool      `json:"active"`
	Unknown    bool      `json:"unknown,omitempty"`
	Truncated  bool      `json:"truncated,omitempty"`
}

type CacheInfo struct {
	OwnerKind  string           `json:"ownerKind"`
	OwnerID    string           `json:"ownerId"`
	QuotaBytes int64            `json:"quotaBytes"`
	TotalBytes int64            `json:"totalBytes"`
	Entries    int64            `json:"entries"`
	Unknown    bool             `json:"unknown,omitempty"`
	Truncated  bool             `json:"truncated,omitempty"`
	Namespaces []CacheNamespace `json:"namespaces"`
}

type CacheLease struct {
	Namespace CacheNamespace
	Dir       string
	manager   *CacheManager
	released  sync.Once
}

func (l *CacheLease) Release() {
	if l == nil || l.manager == nil {
		return
	}
	l.released.Do(func() { l.manager.release(l.Namespace) })
}

type CacheManager struct {
	root             string
	quotaBytes       int64
	retention        time.Duration
	mu               sync.Mutex
	active           map[string]int
	ownerGates       map[string]*cacheOwnerGate
	epochs           map[string]uint64
	scanTTL          time.Duration
	scans            map[string]cacheScan
	sizeEntries      int
	sizeBudget       time.Duration
	namespaceEntries int
	namespaceBudget  time.Duration
	sizeRefreshes    map[string]*cacheSizeRefreshState
}

type cacheOwnerGate struct {
	mu sync.Mutex
}

type cacheScan struct {
	at   time.Time
	info CacheInfo
}

type cacheSizeRefreshRequest struct {
	namespace CacheNamespace
	epoch     uint64
}

type cacheSizeRefreshState struct {
	pending *cacheSizeRefreshRequest
}

func NewCacheManager(root string, quotaMB, retentionDays int) *CacheManager {
	if quotaMB <= 0 {
		quotaMB = 1024
	}
	if retentionDays <= 0 {
		retentionDays = 7
	}
	return &CacheManager{
		root: filepath.Clean(root), quotaBytes: int64(quotaMB) * 1_000_000,
		retention: time.Duration(retentionDays) * 24 * time.Hour,
		active:    make(map[string]int), ownerGates: make(map[string]*cacheOwnerGate),
		epochs: make(map[string]uint64), scanTTL: 5 * time.Minute, scans: make(map[string]cacheScan),
		sizeEntries: cacheSizeScanEntries, sizeBudget: cacheSizeScanDuration,
		namespaceEntries: cacheNamespaceEntries, namespaceBudget: cacheNamespaceBudget,
		sizeRefreshes: make(map[string]*cacheSizeRefreshState),
	}
}

func safeCachePart(value string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(value) {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
		if b.Len() >= 40 {
			break
		}
	}
	if b.Len() == 0 {
		b.WriteString("unknown")
	}
	sum := sha256.Sum256([]byte(value))
	return b.String() + "-" + hex.EncodeToString(sum[:6])
}

func (m *CacheManager) ownerRoot(kind, id string) string {
	directory := "users"
	if kind == "team" {
		directory = "teams"
	}
	return filepath.Join(m.root, directory, safeCachePart(id))
}

func cacheActiveKey(kind, id, key string) string { return kind + "\x00" + id + "\x00" + key }
func cacheOwnerKey(kind, id string) string       { return kind + "\x00" + id }

func cloneCacheInfo(info CacheInfo) CacheInfo {
	info.Namespaces = append([]CacheNamespace(nil), info.Namespaces...)
	return info
}

func (m *CacheManager) ownerGate(ownerKind, ownerID string) *cacheOwnerGate {
	key := cacheOwnerKey(ownerKind, ownerID)
	m.mu.Lock()
	defer m.mu.Unlock()
	gate := m.ownerGates[key]
	if gate == nil {
		gate = &cacheOwnerGate{}
		m.ownerGates[key] = gate
	}
	return gate
}

func (m *CacheManager) bumpOwnerLocked(ownerKind, ownerID string) {
	key := cacheOwnerKey(ownerKind, ownerID)
	m.epochs[key]++
	delete(m.scans, key)
}

func (m *CacheManager) invalidate(ownerKind, ownerID string) {
	m.mu.Lock()
	m.bumpOwnerLocked(ownerKind, ownerID)
	m.mu.Unlock()
}

func (m *CacheManager) Prepare(ctx CacheContext) (*CacheLease, error) {
	if ctx.OwnerKind == "" || ctx.OwnerID == "" || ctx.UserID == "" || ctx.RuntimeID == "" || ctx.LanguageID == "" {
		return nil, fmt.Errorf("incomplete LSP cache context")
	}
	gate := m.ownerGate(ctx.OwnerKind, ctx.OwnerID)
	gate.mu.Lock()
	defer gate.mu.Unlock()
	key := CacheKey(ctx)
	activeKey := cacheActiveKey(ctx.OwnerKind, ctx.OwnerID, key)
	m.mu.Lock()
	if m.active[activeKey] > 0 {
		m.mu.Unlock()
		return nil, fmt.Errorf("LSP analysis cache namespace is active")
	}
	m.active[activeKey] = 1
	m.bumpOwnerLocked(ctx.OwnerKind, ctx.OwnerID)
	m.mu.Unlock()
	rollback := func() {
		m.mu.Lock()
		delete(m.active, activeKey)
		m.bumpOwnerLocked(ctx.OwnerKind, ctx.OwnerID)
		m.mu.Unlock()
	}
	dir := filepath.Join(m.ownerRoot(ctx.OwnerKind, ctx.OwnerID), "namespaces", key)
	if err := os.MkdirAll(dir, 0755); err != nil {
		rollback()
		return nil, fmt.Errorf("create LSP cache namespace: %w", err)
	}
	ns := CacheNamespace{Key: key, OwnerKind: ctx.OwnerKind, OwnerID: ctx.OwnerID, UserID: ctx.UserID, ProjectID: ctx.ProjectID, Branch: ctx.Branch, FolderKey: ctx.FolderKey, RuntimeID: ctx.RuntimeID, LanguageID: normalizeLanguage(ctx.LanguageID), Mode: ctx.Mode, LockHash: ctx.LockHash, Toolchain: ctx.ToolchainFingerprint, Path: dir, LastUsed: time.Now().UTC(), Active: true}
	if data, readErr := safefile.ReadSmallRegular(dir, cacheMetadataFile, cacheMetadataMaxBytes); readErr == nil {
		var previous CacheNamespace
		if json.Unmarshal(data, &previous) == nil && previous.Key == key {
			ns.SizeBytes = previous.SizeBytes
		}
	}
	if err := writeCacheMetadata(dir, ns); err != nil {
		rollback()
		return nil, err
	}
	return &CacheLease{Namespace: ns, Dir: dir, manager: m}, nil
}

func writeCacheMetadata(dir string, ns CacheNamespace) error {
	data, err := json.Marshal(ns)
	if err != nil {
		return err
	}
	return safefile.WriteAtomic(dir, cacheMetadataFile, data, 0600)
}

func (m *CacheManager) release(ns CacheNamespace) {
	gate := m.ownerGate(ns.OwnerKind, ns.OwnerID)
	gate.mu.Lock()
	ns.Active = false
	ns.LastUsed = time.Now().UTC()
	_ = writeCacheMetadata(ns.Path, ns)
	key := cacheActiveKey(ns.OwnerKind, ns.OwnerID, ns.Key)
	m.mu.Lock()
	if m.active[key] > 1 {
		m.active[key]--
	} else {
		delete(m.active, key)
	}
	m.bumpOwnerLocked(ns.OwnerKind, ns.OwnerID)
	epoch := m.epochs[cacheOwnerKey(ns.OwnerKind, ns.OwnerID)]
	m.mu.Unlock()
	gate.mu.Unlock()

	// Size accounting is informational and may traverse analyzer-created data.
	// A tiny synchronous pass preserves warm-cache metadata for normal projects;
	// large trees continue in the background without holding lifecycle gates.
	if size, _, complete := directorySizeBounded(ns.Path, cacheQuickScanEntries, cacheQuickScanBudget); complete {
		m.commitReleasedNamespaceSize(ns, epoch, size)
	} else {
		m.requestReleasedNamespaceSize(ns, epoch)
	}
}

func (m *CacheManager) requestReleasedNamespaceSize(ns CacheNamespace, epoch uint64) {
	key := cacheActiveKey(ns.OwnerKind, ns.OwnerID, ns.Key)
	request := cacheSizeRefreshRequest{namespace: ns, epoch: epoch}
	m.mu.Lock()
	if state := m.sizeRefreshes[key]; state != nil {
		state.pending = &request
		m.mu.Unlock()
		return
	}
	m.sizeRefreshes[key] = &cacheSizeRefreshState{}
	m.mu.Unlock()
	go m.runReleasedNamespaceSizeRefresh(key, request)
}

func (m *CacheManager) runReleasedNamespaceSizeRefresh(key string, request cacheSizeRefreshRequest) {
	for {
		m.refreshReleasedNamespaceSize(request.namespace, request.epoch)
		m.mu.Lock()
		state := m.sizeRefreshes[key]
		if state == nil || state.pending == nil {
			delete(m.sizeRefreshes, key)
			m.mu.Unlock()
			return
		}
		request = *state.pending
		state.pending = nil
		m.mu.Unlock()
	}
}

func (m *CacheManager) refreshReleasedNamespaceSize(ns CacheNamespace, expectedEpoch uint64) {
	size, _, complete := directorySizeBounded(ns.Path, cacheSizeScanEntries, cacheSizeScanDuration)
	if !complete {
		return
	}
	m.commitReleasedNamespaceSize(ns, expectedEpoch, size)
}

func (m *CacheManager) commitReleasedNamespaceSize(ns CacheNamespace, expectedEpoch uint64, size int64) {
	gate := m.ownerGate(ns.OwnerKind, ns.OwnerID)
	gate.mu.Lock()
	defer gate.mu.Unlock()
	ownerKey := cacheOwnerKey(ns.OwnerKind, ns.OwnerID)
	activeKey := cacheActiveKey(ns.OwnerKind, ns.OwnerID, ns.Key)
	m.mu.Lock()
	unchanged := m.epochs[ownerKey] == expectedEpoch && m.active[activeKey] == 0
	m.mu.Unlock()
	if !unchanged {
		return
	}
	data, err := safefile.ReadSmallRegular(ns.Path, cacheMetadataFile, cacheMetadataMaxBytes)
	if err != nil {
		return
	}
	var current CacheNamespace
	if json.Unmarshal(data, &current) != nil || current.Key != ns.Key || current.Active || !current.LastUsed.Equal(ns.LastUsed) {
		return
	}
	current.Path = ns.Path
	current.SizeBytes = size
	_ = writeCacheMetadata(ns.Path, current)
	m.invalidate(ns.OwnerKind, ns.OwnerID)
}

type cacheTraversalBudget struct {
	remaining int
	deadline  time.Time
}

func newCacheTraversalBudget(maxEntries int, duration time.Duration) *cacheTraversalBudget {
	if maxEntries <= 0 {
		maxEntries = cacheSizeScanEntries
	}
	if duration <= 0 {
		duration = cacheSizeScanDuration
	}
	return &cacheTraversalBudget{remaining: maxEntries, deadline: time.Now().Add(duration)}
}

func (budget *cacheTraversalBudget) consume() bool {
	if budget == nil || budget.remaining <= 0 || time.Now().After(budget.deadline) {
		return false
	}
	budget.remaining--
	return true
}

func addCacheMetric(current, value int64) int64 {
	const maxInt64 = int64(1<<63 - 1)
	if value <= 0 {
		return current
	}
	if current > maxInt64-value {
		return maxInt64
	}
	return current + value
}

func directorySizeWithBudget(root string, budget *cacheTraversalBudget) (int64, int64, bool) {
	var size int64
	var visited int64
	queue := []string{root}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		directory, err := os.Open(current)
		if err != nil {
			return size, visited, false
		}
		for {
			entries, readErr := directory.ReadDir(256)
			for _, entry := range entries {
				if !budget.consume() {
					_ = directory.Close()
					return size, visited, false
				}
				visited++
				size = addCacheMetric(size, cacheEntryChargeBytes)
				path := filepath.Join(current, entry.Name())
				if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
					queue = append(queue, path)
					continue
				}
				if entry.Type().IsRegular() || entry.Type()&os.ModeSymlink != 0 {
					info, statErr := entry.Info()
					if statErr != nil {
						_ = directory.Close()
						return size, visited, false
					}
					if info.Size() > cacheEntryChargeBytes {
						size = addCacheMetric(size, info.Size()-cacheEntryChargeBytes)
					}
					continue
				}
				if entry.Type() != 0 {
					_ = directory.Close()
					return size, visited, false
				}
			}
			if readErr != nil {
				if errors.Is(readErr, io.EOF) {
					break
				}
				_ = directory.Close()
				return size, visited, false
			}
		}
		if err := directory.Close(); err != nil {
			return size, visited, false
		}
	}
	return size, visited, true
}

func directorySizeBounded(root string, maxEntries int, duration time.Duration) (int64, int64, bool) {
	return directorySizeWithBudget(root, newCacheTraversalBudget(maxEntries, duration))
}

type cacheDiskDirectory struct {
	name     string
	path     string
	modified time.Time
}

func realDirectoriesWithBudget(root string, budget *cacheTraversalBudget) ([]cacheDiskDirectory, bool, error) {
	directory, err := os.Open(root)
	if errors.Is(err, os.ErrNotExist) {
		return []cacheDiskDirectory{}, true, nil
	}
	if err != nil {
		return nil, false, err
	}
	defer directory.Close()
	result := make([]cacheDiskDirectory, 0)
	for {
		entries, readErr := directory.ReadDir(256)
		for _, entry := range entries {
			if !budget.consume() {
				return result, false, nil
			}
			if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
				continue
			}
			info, infoErr := entry.Info()
			if infoErr != nil {
				return result, false, infoErr
			}
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				continue
			}
			result = append(result, cacheDiskDirectory{name: entry.Name(), path: filepath.Join(root, entry.Name()), modified: info.ModTime().UTC()})
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return result, true, nil
			}
			return result, false, readErr
		}
	}
}

func failClosedCacheBytes(partial, quota int64) int64 {
	const maxInt64 = int64(1<<63 - 1)
	minimum := int64(1)
	if quota >= maxInt64 {
		minimum = maxInt64
	} else if quota >= 0 {
		minimum = quota + 1
	}
	if partial < minimum {
		return minimum
	}
	return partial
}

func readCacheNamespace(dir cacheDiskDirectory, ownerKind, ownerID string) CacheNamespace {
	ns := CacheNamespace{Key: dir.name, OwnerKind: ownerKind, OwnerID: ownerID, Path: dir.path, LastUsed: dir.modified, Unknown: true}
	data, err := safefile.ReadSmallRegular(dir.path, cacheMetadataFile, cacheMetadataMaxBytes)
	if err != nil {
		return ns
	}
	var metadata CacheNamespace
	if json.Unmarshal(data, &metadata) != nil || metadata.Key != dir.name || metadata.OwnerKind != ownerKind || metadata.OwnerID != ownerID {
		return ns
	}
	metadata.Key = dir.name
	metadata.Path = dir.path
	metadata.Unknown = false
	metadata.Truncated = false
	metadata.Entries = 0
	if metadata.LastUsed.IsZero() {
		metadata.LastUsed = dir.modified
	}
	return metadata
}

func (m *CacheManager) inspectOwnerDisk(ownerKind, ownerID string) CacheInfo {
	info := CacheInfo{OwnerKind: ownerKind, OwnerID: ownerID, QuotaBytes: m.quotaBytes, Namespaces: []CacheNamespace{}}
	root := filepath.Join(m.ownerRoot(ownerKind, ownerID), "namespaces")
	directories, enumerated, enumerateErr := realDirectoriesWithBudget(root, newCacheTraversalBudget(m.namespaceEntries, m.namespaceBudget))
	if !enumerated {
		info.Truncated = true
	}
	if enumerateErr != nil {
		info.Unknown = true
		info.Truncated = true
	}
	sizeBudget := newCacheTraversalBudget(m.sizeEntries, m.sizeBudget)
	for _, directory := range directories {
		ns := readCacheNamespace(directory, ownerKind, ownerID)
		size, entries, complete := directorySizeWithBudget(directory.path, sizeBudget)
		ns.Entries = entries
		ns.Truncated = !complete
		if !complete {
			size = failClosedCacheBytes(size, m.quotaBytes)
			info.Truncated = true
		}
		ns.SizeBytes = size
		info.Unknown = info.Unknown || ns.Unknown
		info.TotalBytes = addCacheMetric(info.TotalBytes, ns.SizeBytes)
		info.Entries = addCacheMetric(info.Entries, ns.Entries+1)
		info.Namespaces = append(info.Namespaces, ns)
	}
	if info.Truncated {
		info.TotalBytes = failClosedCacheBytes(info.TotalBytes, info.QuotaBytes)
	}
	sort.Slice(info.Namespaces, func(i, j int) bool { return info.Namespaces[i].LastUsed.After(info.Namespaces[j].LastUsed) })
	return info
}

func (m *CacheManager) Inspect(ownerKind, ownerID string) CacheInfo {
	ownerKey := cacheOwnerKey(ownerKind, ownerID)
	var latest CacheInfo
	for attempt := 0; attempt < 2; attempt++ {
		m.mu.Lock()
		if cached, ok := m.scans[ownerKey]; ok && time.Since(cached.at) < m.scanTTL {
			m.mu.Unlock()
			return cloneCacheInfo(cached.info)
		}
		epoch := m.epochs[ownerKey]
		m.mu.Unlock()

		info := m.inspectOwnerDisk(ownerKind, ownerID)
		m.mu.Lock()
		for index := range info.Namespaces {
			info.Namespaces[index].Active = m.active[cacheActiveKey(ownerKind, ownerID, info.Namespaces[index].Key)] > 0
		}
		if m.epochs[ownerKey] == epoch {
			m.scans[ownerKey] = cacheScan{at: time.Now(), info: cloneCacheInfo(info)}
			m.mu.Unlock()
			return cloneCacheInfo(info)
		}
		m.mu.Unlock()
		latest = info
	}
	return cloneCacheInfo(latest)
}

func pathInside(root, target string) bool {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	return target != root && strings.HasPrefix(target, root+string(filepath.Separator))
}

// Clear deletes only the dedicated analysis cache. Active namespaces are
// protected and build/dependency cache roots are structurally unreachable.
func (m *CacheManager) Clear(ownerKind, ownerID, scope, projectID, namespaceKey string) error {
	scope = strings.ToLower(strings.TrimSpace(scope))
	if scope != "all" && scope != "project" && scope != "namespace" {
		return fmt.Errorf("invalid LSP cache scope")
	}
	gate := m.ownerGate(ownerKind, ownerID)
	gate.mu.Lock()
	defer gate.mu.Unlock()
	namespacesRoot := filepath.Join(m.ownerRoot(ownerKind, ownerID), "namespaces")
	if scope == "all" {
		m.mu.Lock()
		active := m.ownerActiveLocked(ownerKind, ownerID)
		m.mu.Unlock()
		if active {
			return fmt.Errorf("LSP cache owner has active namespaces")
		}
		if err := os.RemoveAll(namespacesRoot); err != nil {
			return fmt.Errorf("clear LSP cache owner: %w", err)
		}
		m.invalidate(ownerKind, ownerID)
		return nil
	}
	if scope == "namespace" {
		namespaceKey = strings.TrimSpace(namespaceKey)
		if !trustedCacheNamespaceKey(namespaceKey) {
			return fmt.Errorf("invalid LSP cache namespace key")
		}
		m.mu.Lock()
		active := m.active[cacheActiveKey(ownerKind, ownerID, namespaceKey)] > 0
		m.mu.Unlock()
		if active {
			return fmt.Errorf("LSP cache namespace is active")
		}
		target := filepath.Join(namespacesRoot, namespaceKey)
		if filepath.Dir(target) != filepath.Clean(namespacesRoot) || !pathInside(m.ownerRoot(ownerKind, ownerID), target) {
			return fmt.Errorf("LSP cache target is outside owner root")
		}
		info, err := os.Lstat(target)
		if errors.Is(err, os.ErrNotExist) {
			m.invalidate(ownerKind, ownerID)
			return nil
		}
		if err != nil {
			return fmt.Errorf("inspect LSP cache namespace: %w", err)
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("LSP cache namespace is not a real directory")
		}
		if err := os.RemoveAll(target); err != nil {
			return fmt.Errorf("clear LSP cache namespace: %w", err)
		}
		m.invalidate(ownerKind, ownerID)
		return nil
	}
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return fmt.Errorf("project id is required")
	}
	// Project selection depends on metadata, so an incomplete or orphaned scan
	// cannot prove that every matching namespace was found.
	m.invalidate(ownerKind, ownerID)
	info := m.Inspect(ownerKind, ownerID)
	if info.Truncated || info.Unknown {
		return fmt.Errorf("LSP cache inspection is incomplete; clear all or a namespace instead")
	}
	keys := make([]string, 0)
	for _, ns := range info.Namespaces {
		if ns.ProjectID == projectID {
			if !trustedCacheNamespaceKey(ns.Key) {
				return fmt.Errorf("invalid LSP cache namespace key")
			}
			keys = append(keys, ns.Key)
		}
	}
	for _, key := range keys {
		m.mu.Lock()
		active := m.active[cacheActiveKey(ownerKind, ownerID, key)] > 0
		m.mu.Unlock()
		if active {
			return fmt.Errorf("LSP cache namespace is active")
		}
	}
	for _, key := range keys {
		target := filepath.Join(namespacesRoot, key)
		if err := os.RemoveAll(target); err != nil {
			return fmt.Errorf("clear LSP project cache: %w", err)
		}
	}
	m.invalidate(ownerKind, ownerID)
	return nil
}

func (m *CacheManager) ownerActiveLocked(ownerKind, ownerID string) bool {
	prefix := cacheActiveKey(ownerKind, ownerID, "")
	for key, count := range m.active {
		if count > 0 && strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

func trustedCacheNamespaceKey(key string) bool {
	if key == "" || len(key) > 96 || strings.ContainsRune(key, '\x00') || filepath.Base(key) != key {
		return false
	}
	separator := strings.LastIndexByte(key, '-')
	if separator <= 0 || len(key)-separator-1 != 24 {
		return false
	}
	for _, value := range key[:separator] {
		if (value < 'a' || value > 'z') && (value < '0' || value > '9') && value != '-' && value != '_' {
			return false
		}
	}
	digest, err := hex.DecodeString(key[separator+1:])
	return err == nil && len(digest) == 12
}

func (m *CacheManager) Prune(ownerKind, ownerID string) CacheInfo {
	m.invalidate(ownerKind, ownerID)
	info := m.Inspect(ownerKind, ownerID)
	cutoff := time.Now().UTC().Add(-m.retention)
	oldest := append([]CacheNamespace(nil), info.Namespaces...)
	sort.Slice(oldest, func(i, j int) bool { return oldest[i].LastUsed.Before(oldest[j].LastUsed) })
	changed := false
	remaining := info.TotalBytes
	for _, ns := range oldest {
		gate := m.ownerGate(ownerKind, ownerID)
		gate.mu.Lock()
		m.mu.Lock()
		active := m.active[cacheActiveKey(ownerKind, ownerID, ns.Key)] > 0
		m.mu.Unlock()
		if active {
			gate.mu.Unlock()
			continue
		}
		current, fresh := currentCacheNamespace(ns, ownerKind, ownerID)
		if !fresh || !pathInside(m.ownerRoot(ownerKind, ownerID), ns.Path) {
			gate.mu.Unlock()
			continue
		}
		shouldDelete := ns.LastUsed.Before(cutoff) || ns.Truncated || remaining > info.QuotaBytes
		if shouldDelete {
			if err := os.RemoveAll(ns.Path); err == nil {
				changed = true
				if !info.Truncated {
					remaining -= ns.SizeBytes
					if remaining < 0 {
						remaining = 0
					}
				}
			}
		} else if !current.Unknown && current.Active {
			current.Active = false
			current.Path = ns.Path
			if writeCacheMetadata(ns.Path, current) == nil {
				changed = true
			}
		}
		gate.mu.Unlock()
		if changed && info.Truncated {
			// A fresh bounded pass after one deletion determines whether the
			// fail-closed state remains without deleting an unbounded set.
			break
		}
	}
	if !changed {
		return info
	}
	m.invalidate(ownerKind, ownerID)
	return m.Inspect(ownerKind, ownerID)
}

func currentCacheNamespace(expected CacheNamespace, ownerKind, ownerID string) (CacheNamespace, bool) {
	info, err := os.Lstat(expected.Path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return CacheNamespace{}, false
	}
	current := readCacheNamespace(cacheDiskDirectory{name: expected.Key, path: expected.Path, modified: info.ModTime().UTC()}, ownerKind, ownerID)
	if expected.Unknown {
		return current, current.Unknown && current.LastUsed.Equal(expected.LastUsed)
	}
	return current, !current.Unknown && current.LastUsed.Equal(expected.LastUsed)
}

func (m *CacheManager) Owners() [][2]string {
	out := make([][2]string, 0)
	seen := make(map[string]bool)
	budget := newCacheTraversalBudget(cacheOwnerScanEntries, cacheOwnerScanBudget)
	for _, kind := range []string{"teams", "users"} {
		owners, complete, _ := realDirectoriesWithBudget(filepath.Join(m.root, kind), budget)
		for _, owner := range owners {
			namespaces, namespacesComplete, _ := realDirectoriesWithBudget(filepath.Join(owner.path, "namespaces"), budget)
			for _, namespace := range namespaces {
				dir := namespace.path
				data, err := safefile.ReadSmallRegular(dir, cacheMetadataFile, cacheMetadataMaxBytes)
				var meta CacheNamespace
				if err == nil && json.Unmarshal(data, &meta) == nil && meta.OwnerID != "" {
					key := cacheOwnerKey(meta.OwnerKind, meta.OwnerID)
					if !seen[key] {
						seen[key] = true
						out = append(out, [2]string{meta.OwnerKind, meta.OwnerID})
					}
					break
				}
			}
			if !namespacesComplete {
				return out
			}
		}
		if !complete {
			return out
		}
	}
	return out
}
