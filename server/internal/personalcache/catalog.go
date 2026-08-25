package personalcache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"bobocloud-server/internal/cachev2"
)

var (
	ErrCatalogRevisionMismatch = errors.New("personal cache catalog revision changed")
	ErrCacheNotFound           = errors.New("personal cache entry was not found")
	ErrCurrentCacheProtected   = errors.New("current project dependency cache must be changed through an environment transaction")
	ErrPackageInventoryType    = errors.New("cache entry does not expose package inventory")
)

type CatalogDeleteResult struct {
	DeletedIDs     []cachev2.CacheID `json:"deleted_ids"`
	ReclaimedBytes int64             `json:"reclaimed_bytes"`
	ReclaimedFiles int64             `json:"reclaimed_files"`
	Revision       string            `json:"revision"`
}

type catalogRecord struct {
	entry      cachev2.Entry
	root       string
	key        string
	request    Request
	build      BuildRequest
	dependency *metadata
	buildMeta  *buildMetadata
	toolMeta   *toolchainMetadata
	legacy     Entry
}

type catalogSnapshot struct {
	inventory cachev2.Inventory
	records   map[cachev2.CacheID]catalogRecord
}

type catalogActivity struct {
	active      map[string]int
	writers     map[string]int
	buildActive map[string]int
	paths       map[string]int
}

// Catalog returns the authoritative, host-path-free cache-v2 inventory.
func (m *Manager) Catalog(userID string, quotaBytes int64) (cachev2.Inventory, error) {
	if m == nil {
		return cachev2.Inventory{}, fmt.Errorf("personal cache manager is unavailable")
	}
	gate := m.userGate(userID)
	gate.Lock()
	defer gate.Unlock()
	snapshot, err := m.catalogLocked(userID, quotaBytes)
	if err != nil {
		return cachev2.Inventory{}, err
	}
	return snapshot.inventory, nil
}

func (m *Manager) catalogLocked(userID string, quotaBytes int64) (catalogSnapshot, error) {
	layout, err := m.ensureUserLayout(userID)
	if err != nil {
		return catalogSnapshot{}, err
	}
	activity, reservedBytes, reservedFiles := m.catalogActivity(userID)
	snapshot := catalogSnapshot{records: make(map[cachev2.CacheID]catalogRecord)}
	truncated := false
	if err := m.appendDependencyCatalog(&snapshot, layout, userID, activity, &truncated); err != nil {
		return catalogSnapshot{}, err
	}
	parents := make(map[string]cachev2.CacheID)
	if err := m.appendBuildCatalog(&snapshot, layout, userID, cachev2.CategoryIncremental, layout.Incremental, activity, parents, &truncated); err != nil {
		return catalogSnapshot{}, err
	}
	if err := m.appendBuildCatalog(&snapshot, layout, userID, cachev2.CategoryResults, layout.Results, activity, parents, &truncated); err != nil {
		return catalogSnapshot{}, err
	}
	if err := m.appendToolchainCatalog(&snapshot, layout, userID, activity, &truncated); err != nil {
		return catalogSnapshot{}, err
	}

	entries := make([]cachev2.Entry, 0, len(snapshot.records))
	var reclaimable int64
	for id, record := range snapshot.records {
		deletable := record.entry.ActiveReaders == 0 && !record.entry.Writing &&
			!(record.entry.Category == cachev2.CategoryDependencies && record.entry.State == cachev2.EntryStateCurrent)
		record.entry.Capabilities = map[string]bool{"details": true, "delete": deletable}
		snapshot.records[id] = record
		entries = append(entries, record.entry)
		if deletable {
			reclaimable += record.entry.SizeBytes
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		if (entries[i].State == cachev2.EntryStateCurrent) != (entries[j].State == cachev2.EntryStateCurrent) {
			return entries[i].State == cachev2.EntryStateCurrent
		}
		if entries[i].WorkspaceID != entries[j].WorkspaceID {
			return entries[i].WorkspaceID < entries[j].WorkspaceID
		}
		if entries[i].Category != entries[j].Category {
			return entries[i].Category < entries[j].Category
		}
		if !entries[i].LastUsedAt.Equal(entries[j].LastUsedAt) {
			return entries[i].LastUsedAt.After(entries[j].LastUsedAt)
		}
		return entries[i].ID < entries[j].ID
	})
	userUsage := m.directoryUsage(layout.UserRoot)
	managedUsage := m.directoryUsage(layout.Root)
	inventory := cachev2.Inventory{
		Schema: cachev2.SchemaVersion, OwnerKind: cachev2.OwnerKindUser, OwnerID: userID,
		QuotaBytes: quotaBytes, UsedBytes: userUsage.bytes, ReservedBytes: reservedBytes,
		QuotaFiles: m.options.MaxFiles, UsedFiles: userUsage.files, ReservedFiles: reservedFiles,
		ManagedBytes: managedUsage.bytes, ManagedFiles: managedUsage.files, ReclaimableBytes: reclaimable,
		ScanTruncated: truncated || userUsage.truncated || managedUsage.truncated,
		GeneratedAt:   time.Now().UTC(), Entries: entries,
		Capabilities: map[string]bool{"details": true, "delete": true, "clear": !truncated && !userUsage.truncated && !managedUsage.truncated},
	}
	inventory.Revision, err = catalogRevision(inventory)
	if err != nil {
		return catalogSnapshot{}, err
	}
	snapshot.inventory = inventory
	return snapshot, nil
}

func (m *Manager) catalogActivity(userID string) (catalogActivity, int64, int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	copyMap := func(source map[string]int) map[string]int {
		result := make(map[string]int, len(source))
		for key, value := range source {
			result[key] = value
		}
		return result
	}
	return catalogActivity{
		active: copyMap(m.active), writers: copyMap(m.writers),
		buildActive: copyMap(m.buildActive), paths: copyMap(m.activePaths),
	}, m.reserved[userID], m.reservedFiles[userID]
}

func (m *Manager) appendDependencyCatalog(snapshot *catalogSnapshot, layout cachev2.Layout, userID string, activity catalogActivity, truncated *bool) error {
	namespaces, _, scanTruncated := boundedNamespaceRoots(layout.Dependencies, m.scanLimit())
	*truncated = *truncated || scanTruncated
	for _, namespace := range namespaces {
		id, err := cachev2.EnsurePersistentCacheID(namespace.path)
		if err != nil {
			return err
		}
		usage := boundedDirectoryStats(namespace.path, m.scanLimit())
		*truncated = *truncated || usage.truncated
		data, readErr := readSmallRegularFile(filepath.Join(namespace.path, metadataFile), maxMetadataBytes)
		var meta metadata
		valid := readErr == nil && json.Unmarshal(data, &meta) == nil && metadataMatchesPath(meta, userID, namespace.parts)
		entry := cachev2.Entry{
			Schema: cachev2.SchemaVersion, ID: id, OwnerKind: cachev2.OwnerKindUser, OwnerID: userID,
			Category: cachev2.CategoryDependencies, State: cachev2.EntryStateOrphaned,
			SizeBytes: usage.bytes, Files: addOneSaturating(usage.files),
			LastUsedAt: fileModTime(namespace.path), ActiveReaders: activePathCount(namespace.path, activity.paths),
		}
		record := catalogRecord{entry: entry, root: namespace.path}
		if valid {
			key := metadataKey(meta)
			binding, bound := readCurrentBinding(layout.Root, Request{WorkspaceID: meta.WorkspaceID, RuntimeID: meta.RuntimeID, Language: meta.Language})
			current := bound && binding.CacheID == id && binding.Digest == meta.Digest
			state := cachev2.EntryStateSuperseded
			if current {
				state = cachev2.EntryStateCurrent
			}
			readers := activity.active[key] - activity.writers[key]
			if readers < 0 {
				readers = 0
			}
			entry.WorkspaceID, entry.WorkspaceName = meta.WorkspaceID, meta.WorkspaceName
			entry.RuntimeID, entry.RuntimeFingerprint = meta.RuntimeID, meta.RuntimeFingerprint
			entry.Language, entry.DependencyDigest = meta.Language, meta.Digest
			entry.Generation, entry.State = readGeneration(namespace.path), state
			entry.CreatedAt, entry.LastUsedAt = meta.CreatedAt, meta.LastUsed
			entry.ActiveReaders, entry.Writing = readers, activity.writers[key] > 0
			entry.PackageInventory = packageInventorySummary(namespace.path, meta)
			request := Request{
				UserID: userID, WorkspaceID: meta.WorkspaceID, WorkspaceName: meta.WorkspaceName,
				RuntimeID: meta.RuntimeID, RuntimeFingerprint: meta.RuntimeFingerprint, Language: meta.Language,
			}
			relative, _ := filepath.Rel(layout.Root, namespace.path)
			legacy := Entry{
				ID: id.String(), Category: "dependency", Path: filepath.ToSlash(relative), WorkspaceID: meta.WorkspaceID,
				WorkspaceName: meta.WorkspaceName, RuntimeID: meta.RuntimeID, Language: meta.Language,
				Digest: meta.Digest, DigestSource: meta.DigestSource, SizeBytes: usage.bytes,
				Files: boundedInt(addOneSaturating(usage.files)), LastUsed: meta.LastUsed, CreatedAt: meta.CreatedAt,
				Current: current, Superseded: !current, Active: readers > 0 || entry.Writing,
				Writing: entry.Writing, Generation: entry.Generation, HostPath: namespace.path,
				key: key, absPath: namespace.path,
			}
			metaCopy := meta
			record = catalogRecord{entry: entry, root: namespace.path, key: key, request: request, dependency: &metaCopy, legacy: legacy}
		}
		if err := addCatalogRecord(snapshot, record); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) appendBuildCatalog(snapshot *catalogSnapshot, layout cachev2.Layout, userID string, category cachev2.Category, root string, activity catalogActivity, parents map[string]cachev2.CacheID, truncated *bool) error {
	namespaces, _, scanTruncated := boundedNamespaceRoots(root, m.scanLimit())
	*truncated = *truncated || scanTruncated
	for _, namespace := range namespaces {
		id, err := cachev2.EnsurePersistentCacheID(namespace.path)
		if err != nil {
			return err
		}
		usage := boundedDirectoryStats(namespace.path, m.scanLimit())
		*truncated = *truncated || usage.truncated
		data, readErr := readSmallRegularFile(filepath.Join(namespace.path, buildMetadataFile), maxMetadataBytes)
		var meta buildMetadata
		valid := readErr == nil && json.Unmarshal(data, &meta) == nil && buildMetadataMatchesPath(meta, userID, namespace.parts)
		entry := cachev2.Entry{
			Schema: cachev2.SchemaVersion, ID: id, OwnerKind: cachev2.OwnerKindUser, OwnerID: userID,
			Category: category, State: cachev2.EntryStateOrphaned,
			SizeBytes: usage.bytes, Files: addOneSaturating(usage.files), LastUsedAt: fileModTime(namespace.path),
			ActiveReaders: activePathCount(namespace.path, activity.paths),
		}
		record := catalogRecord{entry: entry, root: namespace.path}
		identityKey := strings.Join(namespace.parts, "/")
		if valid {
			identity := shortDigest(meta.DependencyDigest, meta.Target)
			request := BuildRequest{
				UserID: userID, WorkspaceID: meta.WorkspaceID, WorkspaceName: meta.WorkspaceName,
				RuntimeID: meta.RuntimeID, RuntimeFingerprint: meta.RuntimeFingerprint, Language: meta.Language,
				DependencyDigest: meta.DependencyDigest, Target: meta.Target,
			}
			binding, bound := readBuildCurrentBinding(layout.Root, request)
			current := bound && binding.Identity == identity
			if category == cachev2.CategoryIncremental {
				current = current && binding.CacheID == id
				parents[identityKey] = id
			} else {
				current = current && binding.ResultCacheID == id
				entry.ParentID = parents[identityKey]
			}
			state := cachev2.EntryStateSuperseded
			if current {
				state = cachev2.EntryStateCurrent
			}
			key := buildKey(meta)
			entry.WorkspaceID, entry.WorkspaceName = meta.WorkspaceID, meta.WorkspaceName
			entry.RuntimeID, entry.RuntimeFingerprint = meta.RuntimeID, meta.RuntimeFingerprint
			entry.Language, entry.DependencyDigest = meta.Language, meta.DependencyDigest
			entry.BuildTarget, entry.ContentDigest = meta.Target, identity
			entry.Generation, entry.State = readGeneration(namespace.path), state
			entry.CreatedAt, entry.LastUsedAt = meta.CreatedAt, meta.LastUsed
			entry.Writing = activity.buildActive[key] > 0 || activePathCount(namespace.path, activity.paths) > 0
			if category == cachev2.CategoryResults {
				if result, resultErr := readBuildResult(namespace.path); resultErr == nil {
					entry.ContentDigest = result.Fingerprint
				}
			}
			metaCopy := meta
			record = catalogRecord{entry: entry, root: namespace.path, key: key, build: request, buildMeta: &metaCopy}
		}
		if err := addCatalogRecord(snapshot, record); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) appendToolchainCatalog(snapshot *catalogSnapshot, layout cachev2.Layout, userID string, activity catalogActivity, truncated *bool) error {
	namespaces, _, scanTruncated := boundedNamespaceRoots(layout.Toolchains, m.scanLimit())
	*truncated = *truncated || scanTruncated
	for _, namespace := range namespaces {
		id, err := cachev2.EnsurePersistentCacheID(namespace.path)
		if err != nil {
			return err
		}
		usage := boundedDirectoryStats(namespace.path, m.scanLimit())
		*truncated = *truncated || usage.truncated
		data, readErr := readSmallRegularFile(filepath.Join(namespace.path, toolchainMetadataFile), maxMetadataBytes)
		var meta toolchainMetadata
		valid := readErr == nil && json.Unmarshal(data, &meta) == nil && toolchainMetadataMatchesPath(meta, userID, namespace.parts)
		entry := cachev2.Entry{
			Schema: cachev2.SchemaVersion, ID: id, OwnerKind: cachev2.OwnerKindUser, OwnerID: userID,
			Category: cachev2.CategoryToolchains, State: cachev2.EntryStateOrphaned,
			SizeBytes: usage.bytes, Files: addOneSaturating(usage.files), LastUsedAt: fileModTime(namespace.path),
			ActiveReaders: activePathCount(namespace.path, activity.paths),
		}
		record := catalogRecord{entry: entry, root: namespace.path}
		if valid {
			key := toolchainKey(meta)
			entry.State = cachev2.EntryStateReady
			entry.RuntimeID, entry.RuntimeFingerprint = meta.RuntimeID, meta.RuntimeFingerprint
			entry.Language, entry.Tool = meta.Language, meta.Tool
			entry.ToolchainFingerprint = shortDigest(meta.RuntimeFingerprint, meta.Language, meta.Tool, meta.SourcePolicyDigest)
			entry.SourcePolicyDigest = meta.SourcePolicyDigest
			entry.Generation, entry.CreatedAt, entry.LastUsedAt = readGeneration(namespace.path), meta.CreatedAt, meta.LastUsed
			entry.Writing = activity.buildActive[key] > 0 || activePathCount(namespace.path, activity.paths) > 0
			metaCopy := meta
			record = catalogRecord{entry: entry, root: namespace.path, key: key, toolMeta: &metaCopy}
		}
		if err := addCatalogRecord(snapshot, record); err != nil {
			return err
		}
	}
	return nil
}

func addCatalogRecord(snapshot *catalogSnapshot, record catalogRecord) error {
	if record.entry.ID == "" || !record.entry.ID.Valid() {
		return cachev2.ErrInvalidCacheID
	}
	if _, duplicate := snapshot.records[record.entry.ID]; duplicate {
		return fmt.Errorf("duplicate persistent cache ID %q", record.entry.ID)
	}
	snapshot.records[record.entry.ID] = record
	return nil
}

func packageInventorySummary(root string, meta metadata) *cachev2.PackageInventorySummary {
	if !exactPackageInventoryLanguage(meta.Language) {
		return &cachev2.PackageInventorySummary{State: "unsupported"}
	}
	info, err := os.Lstat(filepath.Join(root, packageInventoryFile))
	if errors.Is(err, os.ErrNotExist) {
		return &cachev2.PackageInventorySummary{State: "missing"}
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > maxPackageInventoryBytes {
		return &cachev2.PackageInventorySummary{State: "corrupt"}
	}
	return &cachev2.PackageInventorySummary{State: "deferred", Deferred: true}
}

func buildMetadataMatchesPath(meta buildMetadata, userID string, parts []string) bool {
	return len(parts) == 4 && meta.Schema == cacheSchema && meta.UserID == userID &&
		safePart(meta.WorkspaceID) == parts[0] && safePart(meta.RuntimeFingerprint) == parts[1] &&
		safePart(meta.Language) == parts[2] && shortDigest(meta.DependencyDigest, meta.Target) == parts[3]
}

func buildKey(meta buildMetadata) string {
	return strings.Join([]string{
		"build", safePart(meta.UserID), safePart(meta.WorkspaceID), safePart(meta.RuntimeFingerprint),
		safePart(meta.Language), shortDigest(meta.DependencyDigest, meta.Target),
	}, "/")
}

func readBuildResult(root string) (buildResult, error) {
	data, err := readSmallRegularFile(filepath.Join(root, buildResultFile), maxMetadataBytes)
	if err != nil {
		return buildResult{}, err
	}
	var result buildResult
	if json.Unmarshal(data, &result) != nil || result.Schema != cacheSchema || strings.TrimSpace(result.Fingerprint) == "" {
		return buildResult{}, fmt.Errorf("invalid build result metadata")
	}
	return result, nil
}

func activePathCount(root string, paths map[string]int) int {
	root = filepath.Clean(root)
	count := 0
	for active, value := range paths {
		active = filepath.Clean(active)
		if active == root || strings.HasPrefix(active, root+string(filepath.Separator)) || strings.HasPrefix(root, active+string(filepath.Separator)) {
			count += value
		}
	}
	return count
}

func fileModTime(path string) time.Time {
	info, err := os.Lstat(path)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime().UTC()
}

func catalogRevision(inventory cachev2.Inventory) (string, error) {
	entries := append([]cachev2.Entry(nil), inventory.Entries...)
	sort.Slice(entries, func(i, j int) bool { return entries[i].ID < entries[j].ID })
	document := struct {
		Schema        int             `json:"schema"`
		OwnerID       string          `json:"owner_id"`
		QuotaBytes    int64           `json:"quota_bytes"`
		UsedBytes     int64           `json:"used_bytes"`
		ReservedBytes int64           `json:"reserved_bytes"`
		QuotaFiles    int64           `json:"quota_files"`
		UsedFiles     int64           `json:"used_files"`
		ReservedFiles int64           `json:"reserved_files"`
		Entries       []cachev2.Entry `json:"entries"`
	}{
		Schema: inventory.Schema, OwnerID: inventory.OwnerID, QuotaBytes: inventory.QuotaBytes,
		UsedBytes: inventory.UsedBytes, ReservedBytes: inventory.ReservedBytes,
		QuotaFiles: inventory.QuotaFiles, UsedFiles: inventory.UsedFiles, ReservedFiles: inventory.ReservedFiles,
		Entries: entries,
	}
	payload, err := json.Marshal(document)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(payload)
	return "pcv2_" + hex.EncodeToString(digest[:16]), nil
}

// InspectPackagesByID lazily verifies and returns packages for one dependency
// entry. The catalog call itself never scans package trees.
func (m *Manager) InspectPackagesByID(userID string, id cachev2.CacheID, expectedRevision string, quotaBytes int64) (cachev2.Entry, InventoryInspection, error) {
	if !id.Valid() || strings.TrimSpace(expectedRevision) == "" {
		return cachev2.Entry{}, InventoryInspection{}, fmt.Errorf("valid cache ID and catalog revision are required")
	}
	gate := m.userGate(userID)
	gate.Lock()
	snapshot, err := m.catalogLocked(userID, quotaBytes)
	if err != nil {
		gate.Unlock()
		return cachev2.Entry{}, InventoryInspection{}, err
	}
	if snapshot.inventory.Revision != expectedRevision {
		gate.Unlock()
		return cachev2.Entry{}, InventoryInspection{}, ErrCatalogRevisionMismatch
	}
	record, ok := snapshot.records[id]
	if !ok {
		gate.Unlock()
		return cachev2.Entry{}, InventoryInspection{}, ErrCacheNotFound
	}
	if record.dependency == nil {
		gate.Unlock()
		return record.entry, InventoryInspection{State: "unsupported", Detail: "This cache category has no package inventory"}, ErrPackageInventoryType
	}
	m.mu.Lock()
	writerWithoutBase := m.writers[record.key] > 0 && !m.writerHasBase[record.key]
	m.mu.Unlock()
	if writerWithoutBase {
		gate.Unlock()
		return record.entry, InventoryInspection{State: "busy", Detail: "The package inventory is changing"}, ErrCacheInUse
	}
	reader, err := m.retainInspectionReadLocked(record.request, record.legacy)
	gate.Unlock()
	if err != nil {
		return record.entry, InventoryInspection{}, err
	}
	defer reader.Release()
	entry := record.legacy
	entry.HostPath, entry.absPath = reader.HostRoot, reader.HostRoot
	inspection := m.inspectPackageInventoryEntryLocked(record.request, entry)
	if !reader.Stable() {
		inspection = InventoryInspection{State: "stale", Detail: "The dependency generation changed during package inspection"}
	}
	return record.entry, inspection, nil
}

// DeleteByID deletes one cache entry only when the caller holds the current
// catalog revision.
func (m *Manager) DeleteByID(userID string, id cachev2.CacheID, expectedRevision string, quotaBytes int64) (CatalogDeleteResult, error) {
	return m.ClearByIDs(userID, []cachev2.CacheID{id}, expectedRevision, quotaBytes)
}

// ClearByIDs performs an all-selected preflight before moving cache roots into
// a server-owned deletion transaction. It accepts no filesystem path selector.
func (m *Manager) ClearByIDs(userID string, ids []cachev2.CacheID, expectedRevision string, quotaBytes int64) (CatalogDeleteResult, error) {
	if m == nil || len(ids) == 0 {
		return CatalogDeleteResult{}, fmt.Errorf("cache IDs are required")
	}
	if strings.TrimSpace(expectedRevision) == "" {
		return CatalogDeleteResult{}, ErrCatalogRevisionMismatch
	}
	gate := m.userGate(userID)
	gate.Lock()
	defer gate.Unlock()
	snapshot, err := m.catalogLocked(userID, quotaBytes)
	if err != nil {
		return CatalogDeleteResult{}, err
	}
	if snapshot.inventory.Revision != expectedRevision {
		return CatalogDeleteResult{}, ErrCatalogRevisionMismatch
	}
	selected := make(map[cachev2.CacheID]catalogRecord)
	for _, id := range ids {
		if !id.Valid() {
			return CatalogDeleteResult{}, cachev2.ErrInvalidCacheID
		}
		record, ok := snapshot.records[id]
		if !ok {
			return CatalogDeleteResult{}, ErrCacheNotFound
		}
		selected[id] = record
	}
	expandCatalogChildren(snapshot, selected)
	for _, record := range selected {
		if record.entry.Category == cachev2.CategoryDependencies && record.entry.State == cachev2.EntryStateCurrent {
			return CatalogDeleteResult{}, ErrCurrentCacheProtected
		}
		if record.entry.ActiveReaders > 0 || record.entry.Writing {
			return CatalogDeleteResult{}, ErrCacheInUse
		}
	}
	result, err := m.deleteCatalogRecordsLocked(userID, selected)
	if err != nil {
		return CatalogDeleteResult{}, err
	}
	after, err := m.catalogLocked(userID, quotaBytes)
	if err != nil {
		return CatalogDeleteResult{}, err
	}
	result.Revision = after.inventory.Revision
	if m.options.OnEvicted != nil {
		m.options.OnEvicted()
	}
	return result, nil
}

func expandCatalogChildren(snapshot catalogSnapshot, selected map[cachev2.CacheID]catalogRecord) {
	for id, record := range snapshot.records {
		if record.entry.ParentID == "" {
			continue
		}
		if _, parentSelected := selected[record.entry.ParentID]; parentSelected {
			selected[id] = record
		}
	}
}

func catalogRecordInUse(record catalogRecord) bool {
	return record.entry.ActiveReaders > 0 || record.entry.Writing
}

func catalogRecordFamily(snapshot catalogSnapshot, id cachev2.CacheID) map[cachev2.CacheID]catalogRecord {
	selected := make(map[cachev2.CacheID]catalogRecord)
	if record, ok := snapshot.records[id]; ok {
		selected[id] = record
	}
	expandCatalogChildren(snapshot, selected)
	return selected
}

func (m *Manager) deleteCatalogRecordsLocked(userID string, selected map[cachev2.CacheID]catalogRecord) (CatalogDeleteResult, error) {
	layout, err := m.ensureUserLayout(userID)
	if err != nil {
		return CatalogDeleteResult{}, err
	}
	transactionID, err := cachev2.NewCacheID()
	if err != nil {
		return CatalogDeleteResult{}, err
	}
	transactionRoot := filepath.Join(layout.Transactions, "delete-"+transactionID.String())
	if err := ensureRealDirectory(transactionRoot); err != nil {
		return CatalogDeleteResult{}, err
	}
	type movedEntry struct {
		record      catalogRecord
		destination string
	}
	type bindingSnapshot struct {
		path    string
		data    []byte
		existed bool
	}
	moved := make([]movedEntry, 0, len(selected))
	bindingPaths := make(map[string]struct{})
	for _, record := range selected {
		if record.dependency != nil {
			request := Request{WorkspaceID: record.dependency.WorkspaceID, RuntimeID: record.dependency.RuntimeID, Language: record.dependency.Language}
			bindingPaths[currentBindingPath(layout.Root, request)] = struct{}{}
		}
		if record.buildMeta != nil {
			bindingPaths[buildCurrentBindingPath(layout.Root, record.build)] = struct{}{}
		}
	}
	bindingSnapshots := make([]bindingSnapshot, 0, len(bindingPaths))
	for bindingPath := range bindingPaths {
		data, readErr := os.ReadFile(bindingPath)
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			_ = os.RemoveAll(transactionRoot)
			return CatalogDeleteResult{}, fmt.Errorf("snapshot cache binding: %w", readErr)
		}
		bindingSnapshots = append(bindingSnapshots, bindingSnapshot{path: bindingPath, data: data, existed: readErr == nil})
	}
	restoreBindings := func() {
		for _, snapshot := range bindingSnapshots {
			if snapshot.existed {
				_ = atomicWriteFile(filepath.Dir(snapshot.path), filepath.Base(snapshot.path), snapshot.data, 0600)
				continue
			}
			_ = os.Remove(snapshot.path)
		}
	}
	rollback := func() {
		for index := len(moved) - 1; index >= 0; index-- {
			_ = os.MkdirAll(filepath.Dir(moved[index].record.root), 0700)
			_ = os.Rename(moved[index].destination, moved[index].record.root)
		}
		restoreBindings()
		_ = os.RemoveAll(transactionRoot)
	}
	ordered := make([]catalogRecord, 0, len(selected))
	for _, record := range selected {
		ordered = append(ordered, record)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].entry.ID < ordered[j].entry.ID })
	// Remove authoritative references before moving any cache root. A process
	// exit can then leave only an unreferenced historical root, never a binding
	// that points at a root startup recovery will delete.
	for _, record := range ordered {
		if record.dependency != nil {
			request := Request{WorkspaceID: record.dependency.WorkspaceID, RuntimeID: record.dependency.RuntimeID, Language: record.dependency.Language}
			if err := removeCurrentBindingIfMatches(layout.Root, request, record.dependency.Digest); err != nil {
				restoreBindings()
				_ = os.RemoveAll(transactionRoot)
				return CatalogDeleteResult{}, err
			}
		}
		if record.buildMeta != nil {
			if err := removeBuildCurrentReference(layout.Root, record.build, record.entry.ID); err != nil {
				restoreBindings()
				_ = os.RemoveAll(transactionRoot)
				return CatalogDeleteResult{}, err
			}
		}
	}
	for _, record := range ordered {
		destination := filepath.Join(transactionRoot, record.entry.ID.String())
		if err := os.Rename(record.root, destination); err != nil {
			rollback()
			return CatalogDeleteResult{}, fmt.Errorf("stage cache deletion: %w", err)
		}
		moved = append(moved, movedEntry{record: record, destination: destination})
	}
	if err := os.RemoveAll(transactionRoot); err != nil {
		// The logical deletion is committed once references are removed and roots
		// are hidden in the transaction directory. Startup recovery retries the
		// physical cleanup without resurrecting partially deleted cache entries.
		slog.Warn("Deferred physical cleanup for committed cache deletion", "user_id", userID, "transaction", transactionID.String(), "error", err)
	}
	result := CatalogDeleteResult{DeletedIDs: make([]cachev2.CacheID, 0, len(moved))}
	for _, item := range moved {
		result.DeletedIDs = append(result.DeletedIDs, item.record.entry.ID)
		result.ReclaimedBytes += item.record.entry.SizeBytes
		result.ReclaimedFiles += item.record.entry.Files
		if item.record.key != "" {
			m.mu.Lock()
			delete(m.mutations, item.record.key)
			m.mu.Unlock()
		}
	}
	return result, nil
}

// evictCacheV2Locked applies the same lifecycle rules as manual cache CRUD.
// The caller owns the per-user gate, so quota reservation and eviction observe
// one catalog revision.
func (m *Manager) evictCacheV2Locked(userID string, quotaBytes, targetBytes, targetFiles int64, retention time.Duration) bool {
	snapshot, err := m.catalogLocked(userID, quotaBytes)
	if err != nil {
		return false
	}
	entries := append([]cachev2.Entry(nil), snapshot.inventory.Entries...)
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].LastUsedAt.Equal(entries[j].LastUsedAt) {
			return entries[i].ID < entries[j].ID
		}
		return entries[i].LastUsedAt.Before(entries[j].LastUsedAt)
	})
	usedBytes, usedFiles := snapshot.inventory.UsedBytes, snapshot.inventory.UsedFiles
	cutoff := time.Now().UTC().Add(-retention)
	selected := make(map[cachev2.CacheID]catalogRecord)
	for _, entry := range entries {
		if _, alreadySelected := selected[entry.ID]; alreadySelected {
			continue
		}
		expired := retention > 0 && !entry.LastUsedAt.IsZero() && entry.LastUsedAt.Before(cutoff)
		overBytes := quotaBytes > 0 && usedBytes > targetBytes
		overFiles := usedFiles > targetFiles
		if !expired && !overBytes && !overFiles {
			continue
		}
		family := catalogRecordFamily(snapshot, entry.ID)
		if len(family) == 0 {
			continue
		}
		inUse := false
		for _, record := range family {
			if catalogRecordInUse(record) {
				inUse = true
				break
			}
		}
		if inUse {
			continue
		}
		for id, record := range family {
			if _, alreadySelected := selected[id]; alreadySelected {
				continue
			}
			selected[id] = record
			usedBytes = subtractFloorZero(usedBytes, record.entry.SizeBytes)
			usedFiles = subtractFloorZero(usedFiles, record.entry.Files)
		}
	}
	if len(selected) == 0 {
		return false
	}
	_, err = m.deleteCatalogRecordsLocked(userID, selected)
	return err == nil
}

func recoverCacheV2DeletionTransactions(layout cachev2.Layout) {
	_ = recoverCacheV2DeletionTransactionsContext(context.Background(), layout)
}

func recoverCacheV2DeletionTransactionsContext(ctx context.Context, layout cachev2.Layout) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	entries, err := os.ReadDir(layout.Transactions)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 && strings.HasPrefix(entry.Name(), "delete-cv2_") {
			if removeErr := removeRecoveryTreeContext(ctx, filepath.Join(layout.Transactions, entry.Name())); removeErr != nil && ctx.Err() != nil {
				return ctx.Err()
			}
		}
	}
	return ctx.Err()
}
