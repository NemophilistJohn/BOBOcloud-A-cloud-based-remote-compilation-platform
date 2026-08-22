package personalcache

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/metrics"
)

var (
	ErrQuotaExceeded = errors.New("personal storage quota exceeded")
	ErrCacheInUse    = errors.New("project dependency cache is currently in use")
)

const (
	dependenciesDir     = "project-dependencies"
	metadataFile        = ".cache-meta.json"
	generationFile      = ".container-generation"
	maxMetadataBytes    = int64(1 << 20)
	maxGenerationBytes  = int64(128)
	defaultMaxFiles     = int64(250_000)
	defaultReserveFiles = int64(10_000)
)

type Options struct {
	ScopeMode        string
	ReservationBytes int64
	MaxFiles         int64
	ReservationFiles int64
	ScanInterval     time.Duration
	Retention        time.Duration
	Metrics          *metrics.Registry
	OnEvicted        func()
}

type Request struct {
	UserID        string
	WorkspaceID   string
	WorkspaceName string
	RuntimeID     string
	// RuntimeFingerprint is the immutable execution identity (normally the
	// runtime ID plus its Docker image reference). A mutable runtime tag must
	// not silently reuse binary dependencies produced by an older image.
	RuntimeFingerprint string
	Language           string
	WorkspaceRoot      string
	SetupCommands      []string
	QuotaBytes         int64
}

type metadata struct {
	Schema             int       `json:"schema"`
	UserID             string    `json:"user_id"`
	WorkspaceID        string    `json:"workspace_id"`
	WorkspaceName      string    `json:"workspace_name"`
	RuntimeID          string    `json:"runtime_id"`
	RuntimeFingerprint string    `json:"runtime_fingerprint,omitempty"`
	Language           string    `json:"language"`
	Digest             string    `json:"digest"`
	DigestSource       string    `json:"digest_source"`
	Manifests          []string  `json:"manifests,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
	LastUsed           time.Time `json:"last_used"`
}

type Entry struct {
	Path          string    `json:"path"`
	WorkspaceID   string    `json:"workspace_id"`
	WorkspaceName string    `json:"workspace_name"`
	RuntimeID     string    `json:"runtime_id"`
	Language      string    `json:"language"`
	Digest        string    `json:"digest"`
	DigestSource  string    `json:"digest_source"`
	SizeBytes     int64     `json:"size_bytes"`
	Files         int       `json:"files"`
	LastUsed      time.Time `json:"last_used"`
	Active        bool      `json:"active"`
	Writing       bool      `json:"writing"`
	Orphaned      bool      `json:"orphaned"`
	HostPath      string    `json:"-"`
	key           string
	absPath       string
}

type Info struct {
	QuotaBytes    int64   `json:"quota_bytes"`
	UsedBytes     int64   `json:"used_bytes"`
	PersistBytes  int64   `json:"persist_bytes"`
	ReservedBytes int64   `json:"reserved_bytes"`
	QuotaFiles    int64   `json:"quota_files"`
	UsedFiles     int64   `json:"used_files"`
	PersistFiles  int64   `json:"persist_files"`
	ReservedFiles int64   `json:"reserved_files"`
	ScanTruncated bool    `json:"scan_truncated,omitempty"`
	Entries       []Entry `json:"entries"`
}

type Manager struct {
	root             string
	options          Options
	mu               sync.Mutex
	active           map[string]int
	writers          map[string]int
	mutations        map[string]uint64
	activePaths      map[string]int
	activeUsers      map[string]int
	reserved         map[string]int64
	reservedFiles    map[string]int64
	writerDone       map[string]chan struct{}
	protectedReaders map[string]int
	userGates        sync.Map
}

type Lease struct {
	Key          string
	ContainerKey string
	HostRoot     string
	RelativePath string
	DockerMounts map[string]string
	DockerEnv    map[string]string
	Fingerprint  Fingerprint
	Hit          bool
	manager      *Manager
	request      Request
	meta         metadata
	guard        *Guard
	released     sync.Once
}

// ReadLease keeps an exact project dependency namespace alive while a
// language server reads it. It does not mark the package inventory dirty and
// does not reserve write quota.
type ReadLease struct {
	Key       string
	HostRoot  string
	manager   *Manager
	request   Request
	version   uint64
	protected bool
	released  sync.Once
}

type leaseContextKey struct{}

func WithLease(ctx context.Context, lease *Lease) context.Context {
	return context.WithValue(ctx, leaseContextKey{}, lease)
}

func LeaseFromContext(ctx context.Context) *Lease {
	if ctx == nil {
		return nil
	}
	lease, _ := ctx.Value(leaseContextKey{}).(*Lease)
	return lease
}

type Guard struct {
	Context context.Context
	cancel  context.CancelCauseFunc
	done    chan struct{}
	once    sync.Once
	manager *Manager
	userID  string
	before  int64
	mu      sync.Mutex
	err     error
}

type Operation struct {
	manager  *Manager
	userID   string
	quota    int64
	guard    *Guard
	released sync.Once
}

func NewManager(dataDir string, options Options) *Manager {
	if options.ScopeMode == "" {
		options.ScopeMode = "project-lock"
	}
	if options.ReservationBytes <= 0 {
		options.ReservationBytes = 256_000_000
	}
	if options.MaxFiles <= 0 {
		options.MaxFiles = defaultMaxFiles
	}
	if options.ReservationFiles <= 0 {
		options.ReservationFiles = defaultReserveFiles
	}
	if options.ReservationFiles > options.MaxFiles {
		options.ReservationFiles = options.MaxFiles
	}
	if options.ScanInterval <= 0 {
		options.ScanInterval = 250 * time.Millisecond
	}
	return &Manager{
		root: filepath.Join(filepath.Clean(dataDir), "users"), options: options,
		active: make(map[string]int), writers: make(map[string]int), mutations: make(map[string]uint64), activePaths: make(map[string]int),
		activeUsers: make(map[string]int), reserved: make(map[string]int64), reservedFiles: make(map[string]int64), writerDone: make(map[string]chan struct{}),
		protectedReaders: make(map[string]int),
	}
}

func (m *Manager) ScopeMode() string {
	if m == nil {
		return "legacy-user"
	}
	return m.options.ScopeMode
}

func (m *Manager) Prepare(ctx context.Context, request Request) (*Lease, error) {
	if m == nil || m.options.ScopeMode != "project-lock" {
		return nil, nil
	}
	if strings.TrimSpace(request.UserID) == "" || strings.TrimSpace(request.WorkspaceID) == "" || strings.TrimSpace(request.RuntimeID) == "" {
		return nil, fmt.Errorf("personal dependency cache requires user, workspace, and runtime")
	}
	fingerprint, err := DependencyFingerprintWithRuntime(request.WorkspaceRoot, request.Language, request.SetupCommands, request.RuntimeFingerprint)
	if err != nil {
		return nil, err
	}
	workspacePart := safePart(request.WorkspaceID)
	runtimePart := safePart(request.RuntimeID)
	languagePart := safePart(request.Language)
	key := strings.Join([]string{safePart(request.UserID), workspacePart, runtimePart, languagePart, fingerprint.Digest}, "/")
	persistRoot := filepath.Join(m.root, request.UserID, "persist")
	hostRoot := filepath.Join(persistRoot, dependenciesDir, workspacePart, runtimePart, languagePart, fingerprint.Digest)
	relative, _ := filepath.Rel(persistRoot, hostRoot)
	gate := m.userGate(request.UserID)
	gate.Lock()
	defer gate.Unlock()
	if err := m.waitForWriter(ctx, key, gate); err != nil {
		return nil, err
	}
	m.mu.Lock()
	protected := m.protectedReaders[key] > 0
	m.mu.Unlock()
	if protected {
		return nil, ErrCacheInUse
	}
	if err := m.reserveLocked(request.UserID, request.QuotaBytes); err != nil {
		return nil, err
	}
	releaseReservation := true
	defer func() {
		if releaseReservation {
			m.releaseReservation(request.UserID, key)
		}
	}()
	hit, stored := readValidMetadata(hostRoot, request, fingerprint)
	now := time.Now().UTC()
	meta := metadata{
		Schema: 1, UserID: request.UserID, WorkspaceID: request.WorkspaceID, WorkspaceName: request.WorkspaceName,
		RuntimeID: request.RuntimeID, RuntimeFingerprint: request.RuntimeFingerprint, Language: request.Language, Digest: fingerprint.Digest,
		DigestSource: fingerprint.Source, Manifests: fingerprint.Manifests, CreatedAt: now, LastUsed: now,
	}
	if hit {
		meta.CreatedAt = stored.CreatedAt
	}
	userRoot := filepath.Join(m.root, request.UserID)
	for _, dir := range []string{
		filepath.Dir(m.root), m.root, userRoot, persistRoot, filepath.Join(persistRoot, dependenciesDir),
		filepath.Join(persistRoot, dependenciesDir, workspacePart),
		filepath.Join(persistRoot, dependenciesDir, workspacePart, runtimePart),
		filepath.Join(persistRoot, dependenciesDir, workspacePart, runtimePart, languagePart),
		hostRoot, filepath.Join(hostRoot, "python"), filepath.Join(hostRoot, "node_modules"),
		filepath.Join(hostRoot, "go"), filepath.Join(hostRoot, "go", "pkg"),
		filepath.Join(hostRoot, "go", "pkg", "mod"), filepath.Join(hostRoot, "cargo"),
		filepath.Join(hostRoot, "cargo-target"), filepath.Join(hostRoot, "maven"), filepath.Join(hostRoot, "gradle"),
	} {
		if err := ensureRealDirectory(dir); err != nil {
			return nil, err
		}
	}
	generation, err := ensureGeneration(hostRoot)
	if err != nil {
		return nil, err
	}
	if err := writeMetadata(hostRoot, meta); err != nil {
		return nil, err
	}
	if err := markPackageInventoryDirty(hostRoot, request.Language, fingerprint.Digest); err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.mutations[key]++
	m.active[key]++
	m.writers[key]++
	m.activePaths[filepath.Clean(hostRoot)]++
	m.activeUsers[request.UserID]++
	m.mu.Unlock()
	lease := &Lease{
		Key: key, ContainerKey: "personal/" + key + "@" + generation,
		HostRoot: hostRoot, RelativePath: filepath.ToSlash(relative),
		DockerMounts: map[string]string{hostRoot: "/project-deps"},
		DockerEnv:    dependencyEnvironment(request.Language),
		Fingerprint:  fingerprint, Hit: hit, manager: m, request: request, meta: meta,
	}
	releaseReservation = false
	if m.options.Metrics != nil {
		m.options.Metrics.Cache("dependency.cache", hit)
	}
	_ = ctx
	return lease, nil
}

func dependencyEnvironment(language string) map[string]string {
	switch strings.ToLower(strings.TrimSpace(language)) {
	case "python":
		return map[string]string{"PIP_TARGET": "/project-deps/python", "PYTHONPATH": "/project-deps/python"}
	case "node":
		return map[string]string{"NODE_PATH": "/workspace/node_modules", "BOBOCLOUD_NODE_MODULES": "/project-deps/node_modules"}
	case "go":
		return map[string]string{"GOPATH": "/project-deps/go", "GOMODCACHE": "/project-deps/go/pkg/mod"}
	case "rust":
		return map[string]string{"CARGO_HOME": "/project-deps/cargo", "CARGO_TARGET_DIR": "/project-deps/cargo-target"}
	case "java":
		return map[string]string{"MAVEN_OPTS": "-Dmaven.repo.local=/project-deps/maven", "GRADLE_USER_HOME": "/project-deps/gradle"}
	default:
		return map[string]string{}
	}
}

func (l *Lease) StartGuard(parent context.Context) *Guard {
	if l == nil || l.manager == nil {
		return nil
	}
	if l.guard != nil {
		return l.guard
	}
	guard := l.manager.newGuard(parent, l.request.UserID, l.request.QuotaBytes)
	l.guard = guard
	return guard
}

func (m *Manager) newGuard(parent context.Context, userID string, quotaBytes int64) *Guard {
	ctx, cancel := context.WithCancelCause(parent)
	guard := &Guard{
		Context: ctx, cancel: cancel, done: make(chan struct{}),
		manager: m, userID: userID,
		before: m.directoryUsage(filepath.Join(m.root, userID)).bytes,
	}
	go func() {
		defer close(guard.done)
		ticker := time.NewTicker(m.options.ScanInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				usage := m.directoryUsage(filepath.Join(m.root, userID))
				if (quotaBytes > 0 && usage.bytes > quotaBytes) || usage.truncated || usage.files > m.options.MaxFiles {
					guard.mu.Lock()
					guard.err = ErrQuotaExceeded
					guard.mu.Unlock()
					cancel(ErrQuotaExceeded)
					return
				}
			}
		}
	}()
	return guard
}

func (m *Manager) BeginOperation(parent context.Context, userID string, quotaBytes int64) (*Operation, error) {
	if m == nil || strings.TrimSpace(userID) == "" {
		return nil, nil
	}
	gate := m.userGate(userID)
	gate.Lock()
	err := m.reserveLocked(userID, quotaBytes)
	if err != nil {
		gate.Unlock()
		return nil, err
	}
	m.mu.Lock()
	m.activeUsers[userID]++
	m.mu.Unlock()
	gate.Unlock()
	return &Operation{manager: m, userID: userID, quota: quotaBytes, guard: m.newGuard(parent, userID, quotaBytes)}, nil
}

func (o *Operation) Context() context.Context {
	if o == nil || o.guard == nil {
		return context.Background()
	}
	return o.guard.Context
}

func (o *Operation) Err() error {
	if o == nil || o.guard == nil {
		return nil
	}
	return o.guard.Err()
}

func (o *Operation) Release() {
	if o == nil || o.manager == nil {
		return
	}
	o.released.Do(func() {
		o.guard.Stop()
		gate := o.manager.userGate(o.userID)
		gate.Lock()
		o.manager.mu.Lock()
		if o.manager.activeUsers[o.userID] > 1 {
			o.manager.activeUsers[o.userID]--
		} else {
			delete(o.manager.activeUsers, o.userID)
		}
		o.manager.mu.Unlock()
		o.manager.releaseReservation(o.userID, "")
		gate.Unlock()
		o.manager.Enforce(o.userID, o.quota)
	})
}

func (g *Guard) Stop() {
	if g == nil {
		return
	}
	g.once.Do(func() {
		g.cancel(context.Canceled)
		<-g.done
		if g.manager != nil && g.manager.options.Metrics != nil {
			after := g.manager.directoryUsage(filepath.Join(g.manager.root, g.userID)).bytes
			g.manager.options.Metrics.AddBytes("persist.growth", after-g.before)
		}
	})
}

func (g *Guard) Err() error {
	if g == nil {
		return nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.err
}

func (l *Lease) Release() {
	if l == nil || l.manager == nil {
		return
	}
	l.released.Do(func() {
		if l.guard != nil {
			l.guard.Stop()
		}
		_ = l.publishInventory()
		gate := l.manager.userGate(l.request.UserID)
		gate.Lock()
		l.meta.LastUsed = time.Now().UTC()
		_ = writeMetadata(l.HostRoot, l.meta)
		l.manager.mu.Lock()
		if l.manager.writers[l.Key] > 1 {
			l.manager.writers[l.Key]--
		} else {
			delete(l.manager.writers, l.Key)
			if done := l.manager.writerDone[l.Key]; done != nil {
				close(done)
				delete(l.manager.writerDone, l.Key)
			}
		}
		if l.manager.active[l.Key] > 1 {
			l.manager.active[l.Key]--
		} else {
			delete(l.manager.active, l.Key)
		}
		cleanRoot := filepath.Clean(l.HostRoot)
		if l.manager.activePaths[cleanRoot] > 1 {
			l.manager.activePaths[cleanRoot]--
		} else {
			delete(l.manager.activePaths, cleanRoot)
		}
		if l.manager.activeUsers[l.request.UserID] > 1 {
			l.manager.activeUsers[l.request.UserID]--
		} else {
			delete(l.manager.activeUsers, l.request.UserID)
		}
		l.manager.mu.Unlock()
		l.manager.releaseReservation(l.request.UserID, l.Key)
		gate.Unlock()
		l.manager.Enforce(l.request.UserID, l.request.QuotaBytes)
	})
}

// waitForWriter serializes package-manager mutations for one exact namespace.
// The per-user gate is temporarily released so the active writer can publish
// its inventory and release its lease. Different digests remain independent.
func (m *Manager) waitForWriter(ctx context.Context, key string, gate *sync.Mutex) error {
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		m.mu.Lock()
		if m.writers[key] == 0 {
			m.mu.Unlock()
			return nil
		}
		done := m.writerDone[key]
		if done == nil {
			done = make(chan struct{})
			m.writerDone[key] = done
		}
		m.mu.Unlock()

		gate.Unlock()
		select {
		case <-ctx.Done():
			gate.Lock()
			return fmt.Errorf("wait for project dependency cache writer: %w", ctx.Err())
		case <-done:
			gate.Lock()
		}
	}
}

func (m *Manager) reserveLocked(userID string, quotaBytes int64) error {
	m.mu.Lock()
	reservedBytes := m.reserved[userID]
	reservedFiles := m.reservedFiles[userID]
	m.mu.Unlock()
	targetBytes := quotaBytes
	if targetBytes > 0 {
		targetBytes -= reservedBytes + m.options.ReservationBytes
	}
	targetFiles := m.options.MaxFiles - reservedFiles - m.options.ReservationFiles
	m.enforceLocked(userID, quotaBytes, targetBytes, targetFiles)
	usage := m.directoryUsage(filepath.Join(m.root, userID))
	m.mu.Lock()
	reservedBytes = m.reserved[userID]
	reservedFiles = m.reservedFiles[userID]
	if quotaBytes > 0 && usage.bytes+reservedBytes+m.options.ReservationBytes > quotaBytes {
		m.mu.Unlock()
		return fmt.Errorf("%w: used_bytes=%d reserved_bytes=%d requested_bytes=%d quota_bytes=%d", ErrQuotaExceeded, usage.bytes, reservedBytes, m.options.ReservationBytes, quotaBytes)
	}
	if usage.truncated || usage.files+reservedFiles+m.options.ReservationFiles > m.options.MaxFiles {
		m.mu.Unlock()
		return fmt.Errorf("%w: used_files=%d reserved_files=%d requested_files=%d file_quota=%d scan_truncated=%t", ErrQuotaExceeded, usage.files, reservedFiles, m.options.ReservationFiles, m.options.MaxFiles, usage.truncated)
	}
	m.reserved[userID] += m.options.ReservationBytes
	m.reservedFiles[userID] += m.options.ReservationFiles
	m.mu.Unlock()
	return nil
}

func (m *Manager) releaseReservation(userID, _ string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reserved[userID] -= m.options.ReservationBytes
	if m.reserved[userID] <= 0 {
		delete(m.reserved, userID)
	}
	m.reservedFiles[userID] -= m.options.ReservationFiles
	if m.reservedFiles[userID] <= 0 {
		delete(m.reservedFiles, userID)
	}
}

func (m *Manager) Enforce(userID string, quotaBytes int64) Info {
	if m == nil || strings.TrimSpace(userID) == "" {
		return Info{}
	}
	gate := m.userGate(userID)
	gate.Lock()
	defer gate.Unlock()
	target := quotaBytes
	m.mu.Lock()
	fileTarget := m.options.MaxFiles - m.reservedFiles[userID]
	if target > 0 {
		target -= m.reserved[userID]
	}
	m.mu.Unlock()
	if target < 0 {
		target = 0
	}
	if fileTarget < 0 {
		fileTarget = 0
	}
	m.enforceLocked(userID, quotaBytes, target, fileTarget)
	return m.inspectLocked(userID, quotaBytes)
}

func (m *Manager) enforceLocked(userID string, quotaBytes, targetBytes, targetFiles int64) {
	if targetBytes < 0 {
		targetBytes = 0
	}
	if targetFiles < 0 {
		targetFiles = 0
	}
	info := m.inspectLocked(userID, quotaBytes)
	cutoff := time.Now().UTC().Add(-m.options.Retention)
	evicted := false
	for _, entry := range oldestEntries(info.Entries) {
		if entry.Active {
			continue
		}
		expired := m.options.Retention > 0 && !entry.LastUsed.IsZero() && entry.LastUsed.Before(cutoff)
		overBytes := quotaBytes > 0 && info.UsedBytes > targetBytes
		overFiles := info.ScanTruncated || info.UsedFiles > targetFiles
		if !expired && !overBytes && !overFiles {
			continue
		}
		if os.RemoveAll(entry.absPath) == nil {
			info.UsedBytes = subtractFloorZero(info.UsedBytes, entry.SizeBytes)
			info.UsedFiles = subtractFloorZero(info.UsedFiles, int64(entry.Files))
			if entry.key != "" {
				m.mu.Lock()
				delete(m.mutations, entry.key)
				m.mu.Unlock()
			}
			evicted = true
		}
	}
	m.mu.Lock()
	userActive := m.activeUsers[userID] > 0
	m.mu.Unlock()
	if userActive {
		if evicted && m.options.OnEvicted != nil {
			m.options.OnEvicted()
		}
		return
	}
	candidates, candidatesTruncated := m.legacyCandidates(filepath.Join(m.root, userID, "persist"))
	if candidatesTruncated {
		info.ScanTruncated = true
	}
	for _, candidate := range candidates {
		expired := m.options.Retention > 0 && !candidate.lastUsed.IsZero() && candidate.lastUsed.Before(cutoff)
		overBytes := quotaBytes > 0 && info.UsedBytes > targetBytes
		overFiles := info.ScanTruncated || info.UsedFiles > targetFiles
		if !expired && !overBytes && !overFiles {
			continue
		}
		if os.RemoveAll(candidate.path) == nil {
			info.UsedBytes = subtractFloorZero(info.UsedBytes, candidate.size)
			info.UsedFiles = subtractFloorZero(info.UsedFiles, candidate.files)
			evicted = true
		}
	}
	if evicted && m.options.OnEvicted != nil {
		m.options.OnEvicted()
	}
}

func (m *Manager) Inspect(userID string, quotaBytes int64) Info {
	if m == nil || strings.TrimSpace(userID) == "" {
		return Info{}
	}
	gate := m.userGate(userID)
	gate.Lock()
	defer gate.Unlock()
	return m.inspectLocked(userID, quotaBytes)
}

func (m *Manager) inspectLocked(userID string, quotaBytes int64) Info {
	userRoot := filepath.Join(m.root, userID)
	persistRoot := filepath.Join(userRoot, "persist")
	userUsage := m.directoryUsage(userRoot)
	persistUsage := m.directoryUsage(persistRoot)
	info := Info{
		QuotaBytes: quotaBytes, UsedBytes: userUsage.bytes, PersistBytes: persistUsage.bytes,
		QuotaFiles: m.options.MaxFiles, UsedFiles: userUsage.files, PersistFiles: persistUsage.files,
		ScanTruncated: userUsage.truncated || persistUsage.truncated,
	}
	m.mu.Lock()
	info.ReservedBytes = m.reserved[userID]
	info.ReservedFiles = m.reservedFiles[userID]
	active := make(map[string]bool, len(m.active))
	for key, count := range m.active {
		active[key] = count > 0
	}
	writing := make(map[string]bool, len(m.writers))
	for key, count := range m.writers {
		writing[key] = count > 0
	}
	activePaths := make(map[string]bool, len(m.activePaths))
	for path, count := range m.activePaths {
		activePaths[path] = count > 0
	}
	m.mu.Unlock()
	root := filepath.Join(persistRoot, dependenciesDir)
	namespaces, scanned, namespaceScanTruncated := boundedNamespaceRoots(root, m.scanLimit())
	if namespaceScanTruncated {
		info.ScanTruncated = true
	}
	remaining := m.scanLimit() - scanned
	if remaining < 0 {
		remaining = 0
	}
	for _, namespace := range namespaces {
		path := namespace.path
		parts := namespace.parts
		data, err := readSmallRegularFile(filepath.Join(path, metadataFile), maxMetadataBytes)
		var meta metadata
		valid := err == nil && json.Unmarshal(data, &meta) == nil && metadataMatchesPath(meta, userID, parts)
		entryUsage := boundedDirectoryStats(path, remaining)
		consumed := entryUsage.files
		if consumed > remaining {
			consumed = remaining
		}
		remaining -= consumed
		if entryUsage.truncated {
			info.ScanTruncated = true
		}
		entryFiles := boundedInt(addOneSaturating(entryUsage.files))
		if !valid {
			relative, _ := filepath.Rel(persistRoot, path)
			lastUsed := time.Time{}
			pathActive := activePaths[filepath.Clean(path)]
			if stat, statErr := os.Stat(path); statErr == nil {
				lastUsed = stat.ModTime().UTC()
			}
			info.Entries = append(info.Entries, Entry{
				Path: filepath.ToSlash(relative), WorkspaceName: "Unattributed project cache",
				RuntimeID: parts[1], Language: parts[2], Digest: parts[3], DigestSource: "unknown",
				SizeBytes: entryUsage.bytes, Files: entryFiles, LastUsed: lastUsed, Active: pathActive, Writing: pathActive,
				Orphaned: true, HostPath: path, absPath: path,
			})
			if entryUsage.truncated {
				break
			}
			continue
		}
		relative, _ := filepath.Rel(persistRoot, path)
		key := metadataKey(meta)
		info.Entries = append(info.Entries, Entry{
			Path: filepath.ToSlash(relative), WorkspaceID: meta.WorkspaceID, WorkspaceName: meta.WorkspaceName,
			RuntimeID: meta.RuntimeID, Language: meta.Language, Digest: meta.Digest, DigestSource: meta.DigestSource,
			SizeBytes: entryUsage.bytes, Files: entryFiles, LastUsed: meta.LastUsed, Active: active[key], Writing: writing[key], HostPath: path, key: key, absPath: path,
		})
		if entryUsage.truncated {
			break
		}
	}
	sort.Slice(info.Entries, func(i, j int) bool { return info.Entries[i].LastUsed.After(info.Entries[j].LastUsed) })
	return info
}

func (l *ReadLease) Release() {
	if l == nil || l.manager == nil {
		return
	}
	l.released.Do(func() {
		gate := l.manager.userGate(l.request.UserID)
		gate.Lock()
		data, err := readSmallRegularFile(filepath.Join(l.HostRoot, metadataFile), maxMetadataBytes)
		var current metadata
		if err == nil && json.Unmarshal(data, &current) == nil && metadataKey(current) == l.Key {
			current.LastUsed = time.Now().UTC()
			_ = writeMetadata(l.HostRoot, current)
		}
		l.manager.mu.Lock()
		if l.manager.active[l.Key] > 1 {
			l.manager.active[l.Key]--
		} else {
			delete(l.manager.active, l.Key)
		}
		cleanRoot := filepath.Clean(l.HostRoot)
		if l.manager.activePaths[cleanRoot] > 1 {
			l.manager.activePaths[cleanRoot]--
		} else {
			delete(l.manager.activePaths, cleanRoot)
		}
		if l.protected {
			if l.manager.protectedReaders[l.Key] > 1 {
				l.manager.protectedReaders[l.Key]--
			} else {
				delete(l.manager.protectedReaders, l.Key)
			}
		}
		l.manager.mu.Unlock()
		gate.Unlock()
		l.manager.Enforce(l.request.UserID, l.request.QuotaBytes)
	})
}

// Stable reports whether no writer started after this read lease was
// acquired. Callers that scan a live namespace can use it to reject a result
// raced by an installation.
func (l *ReadLease) Stable() bool {
	if l == nil || l.manager == nil {
		return false
	}
	l.manager.mu.Lock()
	defer l.manager.mu.Unlock()
	return l.manager.writers[l.Key] == 0 && l.manager.mutations[l.Key] == l.version
}

func (m *Manager) retainReadLocked(request Request, entry Entry) *ReadLease {
	return m.retainReadModeLocked(request, entry, false)
}

func (m *Manager) retainProtectedReadLocked(request Request, entry Entry) *ReadLease {
	return m.retainReadModeLocked(request, entry, true)
}

func (m *Manager) retainReadModeLocked(request Request, entry Entry, protected bool) *ReadLease {
	m.mu.Lock()
	version := m.mutations[entry.key]
	m.active[entry.key]++
	m.activePaths[filepath.Clean(entry.absPath)]++
	if protected {
		m.protectedReaders[entry.key]++
	}
	m.mu.Unlock()
	return &ReadLease{Key: entry.key, HostRoot: entry.absPath, manager: m, request: request, version: version, protected: protected}
}

// AcquireRead retains an exact project/runtime/digest namespace for a
// read-only consumer. It refuses to begin while a writer is already active.
func (m *Manager) AcquireRead(request Request) (*ReadLease, Entry, bool, error) {
	if m == nil || m.options.ScopeMode != "project-lock" {
		return nil, Entry{}, false, nil
	}
	gate := m.userGate(request.UserID)
	gate.Lock()
	defer gate.Unlock()
	entry, exists, err := m.lookupLocked(request)
	if err != nil || !exists {
		return nil, entry, exists, err
	}
	if entry.Writing {
		return nil, entry, true, ErrCacheInUse
	}
	reader := m.retainReadLocked(request, entry)
	entry.Active = true
	return reader, entry, true, nil
}

func (m *Manager) Lookup(request Request) (Entry, bool, error) {
	if m == nil {
		return Entry{}, false, nil
	}
	gate := m.userGate(request.UserID)
	gate.Lock()
	defer gate.Unlock()
	return m.lookupLocked(request)
}

func (m *Manager) lookupLocked(request Request) (Entry, bool, error) {
	fingerprint, err := DependencyFingerprintWithRuntime(request.WorkspaceRoot, request.Language, request.SetupCommands, request.RuntimeFingerprint)
	if err != nil {
		return Entry{}, false, err
	}
	info := m.inspectLocked(request.UserID, request.QuotaBytes)
	for _, entry := range info.Entries {
		if entry.WorkspaceID == request.WorkspaceID && entry.RuntimeID == request.RuntimeID && strings.EqualFold(entry.Language, request.Language) && entry.Digest == fingerprint.Digest {
			return entry, true, nil
		}
	}
	return Entry{WorkspaceID: request.WorkspaceID, WorkspaceName: request.WorkspaceName, RuntimeID: request.RuntimeID, Language: request.Language, Digest: fingerprint.Digest, DigestSource: fingerprint.Source}, false, nil
}

func (m *Manager) Delete(userID, relative string) error {
	if m == nil || strings.TrimSpace(userID) == "" {
		return nil
	}
	gate := m.userGate(userID)
	gate.Lock()
	defer gate.Unlock()
	persistRoot := filepath.Join(m.root, userID, "persist")
	target := filepath.Clean(filepath.Join(persistRoot, filepath.FromSlash(relative)))
	managedRoot := filepath.Join(persistRoot, dependenciesDir)
	if target == managedRoot || !strings.HasPrefix(target, managedRoot+string(filepath.Separator)) {
		return fmt.Errorf("path is not a project dependency namespace")
	}
	relativeManaged, err := filepath.Rel(managedRoot, target)
	parts := strings.Split(filepath.ToSlash(relativeManaged), "/")
	if err != nil || len(parts) != 4 {
		return fmt.Errorf("path is not an individual project dependency namespace")
	}
	m.mu.Lock()
	activePath := m.activePaths[filepath.Clean(target)] > 0
	m.mu.Unlock()
	if activePath {
		return ErrCacheInUse
	}
	data, err := readSmallRegularFile(filepath.Join(target, metadataFile), maxMetadataBytes)
	var meta metadata
	key := ""
	if err == nil && json.Unmarshal(data, &meta) == nil && metadataMatchesPath(meta, userID, parts) {
		key = metadataKey(meta)
		m.mu.Lock()
		active := m.active[key] > 0
		m.mu.Unlock()
		if active {
			return ErrCacheInUse
		}
	}
	if err := os.RemoveAll(target); err != nil {
		return err
	}
	if key != "" {
		m.mu.Lock()
		delete(m.mutations, key)
		m.mu.Unlock()
	}
	return nil
}

func (m *Manager) DeleteWorkspace(userID, workspaceID string) error {
	if m == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(workspaceID) == "" {
		return nil
	}
	gate := m.userGate(userID)
	gate.Lock()
	defer gate.Unlock()
	prefix := strings.Join([]string{safePart(userID), safePart(workspaceID)}, "/") + "/"
	m.mu.Lock()
	for key, count := range m.active {
		if count > 0 && strings.HasPrefix(key, prefix) {
			m.mu.Unlock()
			return ErrCacheInUse
		}
	}
	m.mu.Unlock()
	target := filepath.Join(m.root, userID, "persist", dependenciesDir, safePart(workspaceID))
	if err := os.RemoveAll(target); err != nil {
		return err
	}
	m.mu.Lock()
	for key := range m.mutations {
		if strings.HasPrefix(key, prefix) {
			delete(m.mutations, key)
		}
	}
	m.mu.Unlock()
	return nil
}

func (m *Manager) userGate(userID string) *sync.Mutex {
	created := &sync.Mutex{}
	actual, _ := m.userGates.LoadOrStore(userID, created)
	return actual.(*sync.Mutex)
}

func readValidMetadata(root string, request Request, fingerprint Fingerprint) (bool, metadata) {
	data, err := readSmallRegularFile(filepath.Join(root, metadataFile), maxMetadataBytes)
	if err != nil {
		return false, metadata{}
	}
	var meta metadata
	if json.Unmarshal(data, &meta) != nil {
		return false, metadata{}
	}
	return meta.Schema == 1 && meta.UserID == request.UserID && meta.WorkspaceID == request.WorkspaceID &&
		meta.RuntimeID == request.RuntimeID && strings.EqualFold(meta.Language, request.Language) && meta.Digest == fingerprint.Digest, meta
}

func metadataMatchesPath(meta metadata, userID string, parts []string) bool {
	return len(parts) == 4 && meta.Schema == 1 && meta.UserID == userID && meta.Digest != "" &&
		safePart(meta.WorkspaceID) == parts[0] && safePart(meta.RuntimeID) == parts[1] &&
		safePart(meta.Language) == parts[2] && meta.Digest == parts[3]
}

func metadataKey(meta metadata) string {
	return strings.Join([]string{safePart(meta.UserID), safePart(meta.WorkspaceID), safePart(meta.RuntimeID), safePart(meta.Language), meta.Digest}, "/")
}

func writeMetadata(root string, meta metadata) error {
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(root, metadataFile, append(data, '\n'), 0600)
}

func ensureGeneration(root string) (string, error) {
	path := filepath.Join(root, generationFile)
	if data, readErr := readSmallRegularFile(path, maxGenerationBytes); readErr == nil {
		if len(strings.TrimSpace(string(data))) == 32 {
			return strings.TrimSpace(string(data)), nil
		}
	}
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	encoded := hex.EncodeToString(value)
	return encoded, atomicWriteFile(root, generationFile, []byte(encoded+"\n"), 0600)
}

func readSmallRegularFile(path string, maxBytes int64) ([]byte, error) {
	if maxBytes < 0 {
		return nil, fmt.Errorf("invalid file size limit")
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Size() > maxBytes {
		return nil, fmt.Errorf("file is not a small regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || after.Size() > maxBytes || !os.SameFile(before, after) {
		return nil, fmt.Errorf("file changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("file exceeds %d bytes", maxBytes)
	}
	return data, nil
}

func ensureRealDirectory(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return os.Mkdir(path, 0700)
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("personal dependency cache path is not a real directory: %s", path)
	}
	return nil
}

func atomicWriteFile(root, name string, data []byte, mode fs.FileMode) (err error) {
	temporary, err := os.CreateTemp(root, "."+name+".tmp-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()
	if err = temporary.Chmod(mode); err != nil {
		return err
	}
	if _, err = temporary.Write(data); err != nil {
		return err
	}
	if err = temporary.Sync(); err != nil {
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, filepath.Join(root, name))
}

func safePart(value string) string {
	readable := make([]rune, 0, 24)
	for _, char := range strings.TrimSpace(value) {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' {
			readable = append(readable, char)
		}
		if len(readable) >= 24 {
			break
		}
	}
	if len(readable) == 0 {
		readable = append(readable, 'x')
	}
	digest := sha256.Sum256([]byte(value))
	return string(readable) + "-" + hex.EncodeToString(digest[:6])
}

type directoryUsage struct {
	bytes     int64
	files     int64
	truncated bool
}

func (m *Manager) scanLimit() int64 {
	if m == nil || m.options.MaxFiles <= 0 {
		return defaultMaxFiles
	}
	return m.options.MaxFiles
}

func (m *Manager) directoryUsage(root string) directoryUsage {
	return boundedDirectoryStats(root, m.scanLimit())
}

// boundedDirectoryStats counts every descendant filesystem entry, including
// directories and symlinks, because all of them consume inodes. It stops after
// limit+1 entries and reads directories in fixed batches so quota checks remain
// bounded even when one directory contains millions of children.
func boundedDirectoryStats(root string, limit int64) directoryUsage {
	if limit < 0 {
		limit = 0
	}
	usage := directoryUsage{}
	stack := []string{filepath.Clean(root)}
	for len(stack) > 0 {
		directoryPath := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		directory, exists, err := openRealDirectory(directoryPath)
		if err != nil {
			return failedDirectoryUsage(usage, limit)
		}
		if !exists {
			continue
		}
		for {
			entries, readErr := directory.ReadDir(128)
			for _, entry := range entries {
				usage.files++
				if usage.files > limit {
					_ = directory.Close()
					usage.truncated = true
					return usage
				}
				entryInfo, infoErr := entry.Info()
				if infoErr != nil {
					_ = directory.Close()
					return failedDirectoryUsage(usage, limit)
				}
				if entryInfo.IsDir() && entryInfo.Mode()&os.ModeSymlink == 0 {
					stack = append(stack, filepath.Join(directoryPath, entry.Name()))
					continue
				}
				usage.bytes += entryInfo.Size()
			}
			if errors.Is(readErr, io.EOF) {
				break
			}
			if readErr != nil {
				_ = directory.Close()
				return failedDirectoryUsage(usage, limit)
			}
			if len(entries) == 0 {
				_ = directory.Close()
				return failedDirectoryUsage(usage, limit)
			}
		}
		if closeErr := directory.Close(); closeErr != nil {
			return failedDirectoryUsage(usage, limit)
		}
	}
	return usage
}

type namespaceRoot struct {
	path  string
	parts []string
}

type namespaceScanNode struct {
	path  string
	parts []string
}

// boundedNamespaceRoots enumerates only the fixed four-level project cache
// hierarchy. Namespace contents are scanned separately with the same shared
// budget, so malformed trees cannot turn an inspection into an unbounded walk.
func boundedNamespaceRoots(root string, limit int64) ([]namespaceRoot, int64, bool) {
	if limit < 0 {
		limit = 0
	}
	stack := []namespaceScanNode{{path: filepath.Clean(root)}}
	result := make([]namespaceRoot, 0)
	var scanned int64
	for len(stack) > 0 {
		node := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		directory, exists, err := openRealDirectory(node.path)
		if err != nil {
			return result, overLimitCount(limit), true
		}
		if !exists {
			continue
		}
		for {
			entries, readErr := directory.ReadDir(128)
			for _, entry := range entries {
				scanned++
				if scanned > limit {
					_ = directory.Close()
					return result, scanned, true
				}
				entryInfo, infoErr := entry.Info()
				if infoErr != nil {
					_ = directory.Close()
					return result, overLimitCount(limit), true
				}
				if !entryInfo.IsDir() || entryInfo.Mode()&os.ModeSymlink != 0 {
					continue
				}
				parts := append(append([]string(nil), node.parts...), entry.Name())
				path := filepath.Join(node.path, entry.Name())
				if len(parts) == 4 {
					result = append(result, namespaceRoot{path: path, parts: parts})
					continue
				}
				stack = append(stack, namespaceScanNode{path: path, parts: parts})
			}
			if errors.Is(readErr, io.EOF) {
				break
			}
			if readErr != nil {
				_ = directory.Close()
				return result, overLimitCount(limit), true
			}
			if len(entries) == 0 {
				_ = directory.Close()
				return result, overLimitCount(limit), true
			}
		}
		if closeErr := directory.Close(); closeErr != nil {
			return result, overLimitCount(limit), true
		}
	}
	return result, scanned, false
}

func openRealDirectory(path string) (*os.File, bool, error) {
	before, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, false, fmt.Errorf("path is not a real directory: %s", path)
	}
	directory, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	after, err := directory.Stat()
	if err != nil || !after.IsDir() || !os.SameFile(before, after) {
		_ = directory.Close()
		return nil, false, fmt.Errorf("directory changed while opening: %s", path)
	}
	return directory, true, nil
}

func failedDirectoryUsage(usage directoryUsage, limit int64) directoryUsage {
	usage.truncated = true
	usage.files = overLimitCount(limit)
	return usage
}

func overLimitCount(limit int64) int64 {
	return addOneSaturating(limit)
}

func addOneSaturating(value int64) int64 {
	if value == int64(^uint64(0)>>1) {
		return value
	}
	return value + 1
}

func boundedInt(value int64) int {
	maxInt := int64(^uint(0) >> 1)
	if value > maxInt {
		return int(maxInt)
	}
	if value < 0 {
		return 0
	}
	return int(value)
}

func subtractFloorZero(value, decrement int64) int64 {
	if decrement >= value {
		return 0
	}
	return value - decrement
}

func oldestEntries(entries []Entry) []Entry {
	result := append([]Entry(nil), entries...)
	sort.Slice(result, func(i, j int) bool { return result[i].LastUsed.Before(result[j].LastUsed) })
	return result
}

type legacyCandidate struct {
	path     string
	size     int64
	files    int64
	lastUsed time.Time
}

func (m *Manager) legacyCandidates(persistRoot string) ([]legacyCandidate, bool) {
	directory, exists, err := openRealDirectory(persistRoot)
	if !exists && err == nil {
		return nil, false
	}
	if err != nil {
		return nil, true
	}
	defer func() { _ = directory.Close() }()
	remaining := m.scanLimit()
	result := make([]legacyCandidate, 0)
	truncated := false
	for remaining > 0 {
		entries, readErr := directory.ReadDir(128)
		for index, entry := range entries {
			if remaining <= 0 {
				truncated = true
				break
			}
			remaining--
			if entry.Name() == dependenciesDir {
				if remaining <= 0 {
					truncated = index < len(entries)-1
					break
				}
				continue
			}
			info, infoErr := entry.Info()
			if infoErr != nil {
				truncated = true
				break
			}
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				if remaining <= 0 {
					truncated = index < len(entries)-1
					break
				}
				continue
			}
			path := filepath.Join(persistRoot, entry.Name())
			usage := boundedDirectoryStats(path, remaining)
			consumed := usage.files
			if consumed > remaining {
				consumed = remaining
			}
			remaining -= consumed
			result = append(result, legacyCandidate{path: path, size: usage.bytes, files: addOneSaturating(usage.files), lastUsed: info.ModTime().UTC()})
			if usage.truncated {
				truncated = true
				break
			}
			if remaining <= 0 {
				truncated = index < len(entries)-1
				break
			}
		}
		if truncated || errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			truncated = true
			break
		}
		if len(entries) == 0 {
			truncated = true
			break
		}
		if remaining <= 0 {
			if _, readErr = directory.ReadDir(1); !errors.Is(readErr, io.EOF) {
				truncated = true
			}
			break
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].lastUsed.Before(result[j].lastUsed) })
	return result, truncated
}
