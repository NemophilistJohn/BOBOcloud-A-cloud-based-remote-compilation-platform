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
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"bobocloud-server/internal/cachev2"
	"bobocloud-server/internal/metrics"
)

var (
	ErrQuotaExceeded = errors.New("personal storage quota exceeded")
	ErrCacheInUse    = errors.New("project dependency cache is currently in use")
)

const (
	cacheSchema         = cachev2.SchemaVersion
	cacheRootDir        = cachev2.RootDirectoryName
	dependenciesDir     = cachev2.DependenciesRelativePath
	stagingDir          = "transactions/dependencies"
	retiredDir          = "retired/dependencies"
	bindingsDir         = "registry/current"
	incrementalDir      = cachev2.IncrementalRelativePath
	toolchainsDir       = cachev2.ToolchainsRelativePath
	metadataFile        = ".cache-meta.json"
	generationFile      = ".container-generation"
	maxMetadataBytes    = int64(1 << 20)
	maxGenerationBytes  = int64(128)
	defaultMaxFiles     = int64(250_000)
	defaultReserveFiles = int64(10_000)
)

type Options struct {
	// ScopeMode is retained only as an internal call-site shim. cache-v2 always
	// uses project-lock identity and never opens legacy user-level stores.
	ScopeMode        string
	ReservationBytes int64
	MaxFiles         int64
	ReservationFiles int64
	MaxGenerations   int
	ScanInterval     time.Duration
	Retention        time.Duration
	// NodeMaterializationPolicy is applied centrally to every Node cache
	// request, including run, terminal, Environment Center, DAP, and LSP reads.
	// An empty value selects the current default installer policy.
	NodeMaterializationPolicy string
	Metrics                   *metrics.Registry
	OnEvicted                 func()
	OnGenerationChanged       func(cacheKey, currentGeneration string, publication uint64)
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
	// MaterializationPolicy optionally pins a controlled transaction to the
	// same server-side installer policy used by all ordinary cache consumers.
	// It only affects Node fingerprints.
	MaterializationPolicy string
	// ManifestSnapshot binds a controlled mutation to reviewed immutable bytes.
	// When present, fingerprinting never re-reads the concurrently writable
	// workspace tree.
	ManifestSnapshot []ManifestSnapshot
	// OperationID binds a controlled package mutation to the generation that
	// eventually becomes canonical. It is not part of the dependency digest.
	OperationID string
	// FreshGeneration preserves the previous published generation for readers
	// but skips cloning it into staging. Full package-manager installs use this
	// because they replace the entire dependency tree before publication.
	FreshGeneration bool
	QuotaBytes      int64
}

type ManifestSnapshot struct {
	Path    string
	Content []byte
	Lock    bool
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
	OperationID        string    `json:"operation_id,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
	LastUsed           time.Time `json:"last_used"`
}

type currentBinding struct {
	Schema    int             `json:"schema"`
	CacheID   cachev2.CacheID `json:"cache_id"`
	Digest    string          `json:"digest"`
	UpdatedAt time.Time       `json:"updated_at"`
}

type Entry struct {
	ID            string    `json:"id"`
	Category      string    `json:"category"`
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
	CreatedAt     time.Time `json:"created_at"`
	Current       bool      `json:"current"`
	Superseded    bool      `json:"superseded"`
	Active        bool      `json:"active"`
	Writing       bool      `json:"writing"`
	Orphaned      bool      `json:"orphaned"`
	Generation    string    `json:"generation,omitempty"`
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
	dataDir                  string
	root                     string
	options                  Options
	mu                       sync.Mutex
	active                   map[string]int
	writers                  map[string]int
	mutations                map[string]uint64
	publicationSeq           uint64
	activePaths              map[string]int
	activeUsers              map[string]int
	reserved                 map[string]int64
	reservedFiles            map[string]int64
	writerDone               map[string]chan struct{}
	protectedReaders         map[string]int
	readers                  map[dependencyGeneration]int
	writerHasBase            map[string]bool
	retired                  map[dependencyGeneration][]string
	buildLocks               map[string]*cacheLock
	buildActive              map[string]int
	testBeforeReleaseCleanup func([]string)
	userGates                sync.Map
}

type dependencyGeneration struct {
	cacheKey   string
	generation string
}

type cacheLock struct {
	token chan struct{}
}

type Lease struct {
	Key           string
	ContainerKey  string
	Generation    string
	HostRoot      string
	RelativePath  string
	DockerMounts  map[string]string
	DockerEnv     map[string]string
	Fingerprint   Fingerprint
	Hit           bool
	manager       *Manager
	request       Request
	resolved      resolvedCacheRequest
	meta          metadata
	guard         *Guard
	reader        *ReadLease
	canonical     string
	staged        bool
	writable      bool
	stageBaseline directoryUsage
	reserved      bool
	aborted       atomic.Bool
	published     atomic.Bool
	inventoryMu   sync.Mutex
	inventorySeal *packageInventoryDocument
	released      sync.Once
}

// ReadLease keeps an exact project dependency namespace alive while a
// language server reads it. It does not mark the package inventory dirty and
// does not reserve write quota.
type ReadLease struct {
	Key        string
	HostRoot   string
	Generation string
	sourceRoot string
	manager    *Manager
	request    Request
	version    uint64
	protected  bool
	releasePin func()
	released   sync.Once
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
	Context        context.Context
	cancel         context.CancelCauseFunc
	done           chan struct{}
	once           sync.Once
	manager        *Manager
	userID         string
	before         int64
	allowanceBytes int64
	allowanceFiles int64
	mu             sync.Mutex
	err            error
}

type Operation struct {
	manager  *Manager
	userID   string
	quota    int64
	guard    *Guard
	released sync.Once
}

func NewManager(dataDir string, options Options) *Manager {
	if strings.TrimSpace(options.NodeMaterializationPolicy) == "" {
		options.NodeMaterializationPolicy = NodeDependencyMaterializationPolicy(true, "")
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
	if options.MaxGenerations <= 0 {
		options.MaxGenerations = 2
	}
	if options.ScanInterval <= 0 {
		options.ScanInterval = 250 * time.Millisecond
	}
	cleanDataDir := filepath.Clean(dataDir)
	managerRoot := filepath.Join(cleanDataDir, cachev2.UsersDirectoryName)
	return &Manager{
		dataDir: cleanDataDir, root: managerRoot, options: options,
		active: make(map[string]int), writers: make(map[string]int), mutations: make(map[string]uint64), activePaths: make(map[string]int),
		activeUsers: make(map[string]int), reserved: make(map[string]int64), reservedFiles: make(map[string]int64), writerDone: make(map[string]chan struct{}),
		protectedReaders: make(map[string]int), readers: make(map[dependencyGeneration]int), writerHasBase: make(map[string]bool), retired: make(map[dependencyGeneration][]string),
		buildLocks: make(map[string]*cacheLock), buildActive: make(map[string]int),
	}
}

// RecoverOrphanedTransactions must run only after all Docker containers from
// the previous server process have been confirmed removed.
func (m *Manager) RecoverOrphanedTransactions() {
	_ = m.RecoverOrphanedTransactionsContext(context.Background())
}

// RecoverOrphanedTransactionsContext performs startup recovery while allowing
// process shutdown to interrupt mount cleanup, inventory scans, and stale-tree
// removal. The legacy method above preserves the original best-effort API.
func (m *Manager) RecoverOrphanedTransactionsContext(ctx context.Context) error {
	if m == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := cleanupPublishedDependencyPinsContext(ctx, m.root); err != nil {
		return err
	}
	return recoverDependencyTransactionsContext(ctx, m.root)
}

func (m *Manager) ScopeMode() string {
	if m == nil {
		return ""
	}
	return "project-lock"
}

type resolvedCacheRequest struct {
	fingerprint Fingerprint
	key         string
	persistRoot string
	hostRoot    string
	relative    string
	workspace   string
	runtime     string
	language    string
}

func (m *Manager) resolveRequest(request Request) (resolvedCacheRequest, error) {
	if strings.TrimSpace(request.UserID) == "" || strings.TrimSpace(request.WorkspaceID) == "" || strings.TrimSpace(request.RuntimeID) == "" {
		return resolvedCacheRequest{}, fmt.Errorf("personal dependency cache requires user, workspace, and runtime")
	}
	if strings.TrimSpace(request.RuntimeFingerprint) == "" {
		return resolvedCacheRequest{}, fmt.Errorf("trusted immutable runtime identity is unavailable")
	}
	layout, err := m.ensureUserLayout(request.UserID)
	if err != nil {
		return resolvedCacheRequest{}, err
	}
	var fingerprint Fingerprint
	materializationPolicy := request.MaterializationPolicy
	if strings.EqualFold(strings.TrimSpace(request.Language), "node") && strings.TrimSpace(materializationPolicy) == "" {
		materializationPolicy = m.options.NodeMaterializationPolicy
	}
	if len(request.ManifestSnapshot) > 0 {
		fingerprint, err = DependencyFingerprintFromSnapshotWithPolicy(request.Language, request.SetupCommands, request.RuntimeFingerprint, materializationPolicy, request.ManifestSnapshot)
	} else {
		fingerprint, err = DependencyFingerprintWithRuntimeAndPolicy(request.WorkspaceRoot, request.Language, request.SetupCommands, request.RuntimeFingerprint, materializationPolicy)
	}
	if err != nil {
		return resolvedCacheRequest{}, err
	}
	workspacePart := safePart(request.WorkspaceID)
	runtimePart := safePart(request.RuntimeID)
	languagePart := safePart(request.Language)
	persistRoot := layout.Root
	hostRoot := filepath.Join(persistRoot, dependenciesDir, workspacePart, runtimePart, languagePart, fingerprint.Digest)
	relative, _ := filepath.Rel(persistRoot, hostRoot)
	return resolvedCacheRequest{
		fingerprint: fingerprint,
		key:         strings.Join([]string{safePart(request.UserID), workspacePart, runtimePart, languagePart, fingerprint.Digest}, "/"),
		persistRoot: persistRoot, hostRoot: hostRoot, relative: relative,
		workspace: workspacePart, runtime: runtimePart, language: languagePart,
	}, nil
}

// PrepareReadOnly retains the last published project dependency generation.
// A concurrent controlled setup writes a staging generation, so an existing
// published generation remains stable and immediately reusable.
func (m *Manager) PrepareReadOnly(ctx context.Context, request Request) (*Lease, error) {
	if m == nil {
		return nil, nil
	}
	started := time.Now()
	resolved, err := m.resolveRequest(request)
	if err != nil {
		return nil, err
	}
	gate := m.userGate(request.UserID)
	gate.Lock()
	for {
		entry, exists, lookupErr := m.lookupResolvedLocked(request, resolved)
		if lookupErr != nil {
			gate.Unlock()
			return nil, lookupErr
		}
		m.mu.Lock()
		writerActive := m.writers[resolved.key] > 0
		hasPublishedBase := m.writerHasBase[resolved.key]
		m.mu.Unlock()
		if exists && (!writerActive || hasPublishedBase) {
			reader, retainErr := m.retainReadLocked(request, entry)
			if retainErr != nil {
				gate.Unlock()
				return nil, retainErr
			}
			generation := reader.Generation
			gate.Unlock()
			lease := &Lease{
				Key: entry.key, ContainerKey: "personal/" + entry.key + "@" + generation + ":ro", Generation: generation,
				HostRoot: reader.HostRoot, RelativePath: entry.Path,
				DockerMounts: readOnlyProjectDependencyMounts(reader.HostRoot),
				DockerEnv:    ReadOnlyDependencyDockerEnvironment(request.Language), Fingerprint: resolved.fingerprint,
				Hit: true, manager: m, request: request, meta: metadata{}, reader: reader,
				canonical: entry.absPath, writable: false,
			}
			if m.options.Metrics != nil {
				m.options.Metrics.Cache("dependency.cache", true)
				m.options.Metrics.Observe("dependency.cache.prepare.read", time.Since(started))
			}
			return lease, nil
		}
		if writerActive && !hasPublishedBase {
			if err := m.waitForWriter(ctx, resolved.key, gate); err != nil {
				gate.Unlock()
				return nil, err
			}
			continue
		}
		gate.Unlock()
		// Import/run/LSP/DAP probes must not manufacture a persistent empty
		// generation. Only an explicit managed package operation may write one.
		if m.options.Metrics != nil {
			m.options.Metrics.Cache("dependency.cache", false)
			m.options.Metrics.Observe("dependency.cache.prepare.read", time.Since(started))
		}
		return nil, nil
	}
}

func (l *Lease) Writable() bool { return l != nil && l.writable }

// Published reports whether Release successfully made this writable lease the
// canonical generation. Callers use it after Release to restart consumers that
// are intentionally pinned to the previous immutable generation.
func (l *Lease) Published() bool { return l != nil && l.published.Load() }

// Abort prevents a writable staging generation from replacing the last good
// published generation. It is used when dependency setup or quota validation
// fails; Release still drops reservations and removes the staging tree.
func (l *Lease) Abort() {
	if l != nil && l.writable {
		l.aborted.Store(true)
	}
}

func (m *Manager) Prepare(ctx context.Context, request Request) (*Lease, error) {
	if m == nil {
		return nil, nil
	}
	started := time.Now()
	resolved, err := m.resolveRequest(request)
	if err != nil {
		return nil, err
	}
	gate := m.userGate(request.UserID)
	gate.Lock()
	defer gate.Unlock()
	if err := m.waitForWriter(ctx, resolved.key, gate); err != nil {
		return nil, err
	}
	if err := m.reserveLocked(request.UserID, request.QuotaBytes); err != nil {
		return nil, err
	}
	releaseReservation := true
	defer func() {
		if releaseReservation {
			m.releaseReservation(request.UserID, resolved.key)
		}
	}()
	hit, stored := readValidMetadata(resolved.hostRoot, request, resolved.fingerprint)
	if !hit {
		if err := m.resetInvalidCanonicalLocked(resolved); err != nil {
			return nil, err
		}
	}
	now := time.Now().UTC()
	meta := metadata{
		Schema: cacheSchema, UserID: request.UserID, WorkspaceID: request.WorkspaceID, WorkspaceName: request.WorkspaceName,
		RuntimeID: request.RuntimeID, RuntimeFingerprint: request.RuntimeFingerprint, Language: request.Language, Digest: resolved.fingerprint.Digest,
		DigestSource: resolved.fingerprint.Source, Manifests: resolved.fingerprint.Manifests, OperationID: strings.TrimSpace(request.OperationID), CreatedAt: now, LastUsed: now,
	}
	if hit {
		meta.CreatedAt = stored.CreatedAt
	}
	if err := ensureCacheParents(m.root, request.UserID, resolved); err != nil {
		return nil, err
	}
	workRoot := resolved.hostRoot
	staged := false
	leaseBaseline := directoryUsage{}
	if hit {
		stagingRoot := filepath.Join(resolved.persistRoot, stagingDir)
		if err := ensureRealDirectory(stagingRoot); err != nil {
			return nil, err
		}
		workRoot, err = os.MkdirTemp(stagingRoot, "generation-")
		if err != nil {
			return nil, err
		}
		staged = true
		if !request.FreshGeneration {
			cloneStarted := time.Now()
			var baseline directoryUsage
			baseline, err = cloneDependencyTree(resolved.hostRoot, workRoot)
			if err != nil {
				if m.options.Metrics != nil {
					m.options.Metrics.Cache("dependency.cache.stage.clone", false)
					m.options.Metrics.Observe("dependency.cache.stage.clone", time.Since(cloneStarted))
				}
				_ = os.RemoveAll(workRoot)
				return nil, fmt.Errorf("stage project dependency cache: %w", err)
			}
			if m.options.Metrics != nil {
				m.options.Metrics.Cache("dependency.cache.stage.clone", true)
				m.options.Metrics.Observe("dependency.cache.stage.clone", time.Since(cloneStarted))
			}
			leaseBaseline = baseline
		}
	}
	if err := ensureDependencyDirectories(workRoot); err != nil {
		if staged {
			_ = os.RemoveAll(workRoot)
		}
		return nil, err
	}
	if _, err := cachev2.EnsurePersistentCacheID(workRoot); err != nil {
		if staged {
			_ = os.RemoveAll(workRoot)
		}
		return nil, err
	}
	generation, err := replaceGeneration(workRoot)
	if err != nil {
		if staged {
			_ = os.RemoveAll(workRoot)
		}
		return nil, err
	}
	if err := writeMetadata(workRoot, meta); err != nil {
		if staged {
			_ = os.RemoveAll(workRoot)
		}
		return nil, err
	}
	if err := markPackageInventoryDirty(workRoot, request.Language, resolved.fingerprint.Digest); err != nil {
		if staged {
			_ = os.RemoveAll(workRoot)
		}
		return nil, err
	}
	m.mu.Lock()
	m.active[resolved.key]++
	m.writers[resolved.key]++
	m.writerHasBase[resolved.key] = hit
	m.activePaths[filepath.Clean(workRoot)]++
	m.activeUsers[request.UserID]++
	m.mu.Unlock()
	lease := &Lease{
		Key: resolved.key, ContainerKey: "personal/" + resolved.key + "@" + generation + ":rw", Generation: generation,
		HostRoot: workRoot, RelativePath: filepath.ToSlash(resolved.relative),
		DockerMounts: map[string]string{workRoot: "/project-deps"},
		DockerEnv:    dependencyEnvironment(request.Language),
		Fingerprint:  resolved.fingerprint, Hit: hit, manager: m, request: request, resolved: resolved, meta: meta,
		canonical: resolved.hostRoot, staged: staged, writable: true, stageBaseline: leaseBaseline, reserved: true,
	}
	releaseReservation = false
	if m.options.Metrics != nil {
		m.options.Metrics.Cache("dependency.cache", hit)
		m.options.Metrics.Observe("dependency.cache.prepare.write", time.Since(started))
	}
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
		return map[string]string{"CARGO_HOME": "/project-deps/cargo"}
	case "java":
		return map[string]string{"MAVEN_OPTS": "-Dmaven.repo.local=/project-deps/maven", "GRADLE_USER_HOME": "/project-deps/gradle"}
	default:
		return map[string]string{}
	}
}

func readOnlyProjectDependencyMounts(dependencyRoot string) map[string]string {
	return map[string]string{dependencyRoot: "/project-deps:ro"}
}

func (l *Lease) StartGuard(parent context.Context) *Guard {
	if l == nil || l.manager == nil || !l.writable {
		return nil
	}
	if l.guard != nil {
		return l.guard
	}
	guard := l.manager.newGuard(parent, l.request.UserID, l.request.QuotaBytes, l.stageBaseline)
	l.guard = guard
	return guard
}

func (m *Manager) newGuard(parent context.Context, userID string, quotaBytes int64, allowance directoryUsage) *Guard {
	ctx, cancel := context.WithCancelCause(parent)
	initial := m.directoryUsage(filepath.Join(m.root, userID))
	guard := &Guard{
		Context: ctx, cancel: cancel, done: make(chan struct{}),
		manager: m, userID: userID,
		before:         subtractFloorZero(initial.bytes, allowance.bytes),
		allowanceBytes: allowance.bytes, allowanceFiles: allowance.files,
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
				logicalBytes := subtractFloorZero(usage.bytes, guard.allowanceBytes)
				logicalFiles := subtractFloorZero(usage.files, guard.allowanceFiles)
				if (quotaBytes > 0 && logicalBytes > quotaBytes) || usage.truncated || logicalFiles > m.options.MaxFiles {
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
	if _, err := m.ensureUserLayout(userID); err != nil {
		return nil, err
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
	return &Operation{manager: m, userID: userID, quota: quotaBytes, guard: m.newGuard(parent, userID, quotaBytes, directoryUsage{})}, nil
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
			after := g.manager.directoryUsage(filepath.Join(g.manager.root, g.userID))
			g.manager.options.Metrics.AddBytes("persist.growth", subtractFloorZero(after.bytes, g.allowanceBytes)-g.before)
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
		if l.reader != nil {
			l.reader.Release()
			return
		}
		if l.guard != nil {
			l.guard.Stop()
		}
		committed := !l.aborted.Load()
		if committed {
			if err := l.publishInventory(); err != nil {
				// A writer based on an existing good generation is transactional:
				// never replace that generation with an unverifiable tree. A first
				// generation remains visible as explicitly incomplete so users can
				// inspect, repair, or delete it instead of creating hidden disk data.
				if l.staged {
					committed = false
				}
				slog.Warn("Project dependency inventory publication was incomplete", "user_id", l.request.UserID, "workspace_id", l.request.WorkspaceID, "runtime", l.request.RuntimeID, "language", l.request.Language, "error", err)
			}
		}
		leaseRoot := filepath.Clean(l.HostRoot)
		cleanupPaths := make([]string, 0, 2)
		invalidatesIdleMounts := false
		publication := uint64(0)
		retiredPath := ""
		retiredGeneration := ""
		gate := l.manager.userGate(l.request.UserID)
		gate.Lock()
		if committed {
			l.meta.LastUsed = time.Now().UTC()
			if err := writeMetadata(l.HostRoot, l.meta); err != nil {
				committed = false
				slog.Warn("Project dependency metadata commit failed", "user_id", l.request.UserID, "workspace_id", l.request.WorkspaceID, "error", err)
			}
		}
		if committed && l.staged {
			var swapErr error
			retiredPath, retiredGeneration, swapErr = l.manager.publishStagedLocked(l)
			if swapErr != nil {
				committed = false
				slog.Warn("Project dependency generation commit failed", "user_id", l.request.UserID, "workspace_id", l.request.WorkspaceID, "error", swapErr)
			} else {
				invalidatesIdleMounts = true
			}
		}
		if committed {
			if bindErr := l.manager.writeCurrentBindingLocked(l.request, l.resolved); bindErr != nil {
				slog.Warn("Project dependency current binding update failed", "user_id", l.request.UserID, "workspace_id", l.request.WorkspaceID, "error", bindErr)
			}
		}
		if !committed {
			if l.staged {
				cleanupPaths = append(cleanupPaths, leaseRoot)
			} else if !l.Hit {
				failedPath, detachErr := l.manager.detachFailedCanonicalLocked(l)
				if detachErr != nil {
					slog.Error("Failed to detach rejected initial dependency generation", "user_id", l.request.UserID, "workspace_id", l.request.WorkspaceID, "error", detachErr)
				}
				if failedPath != "" {
					cleanupPaths = append(cleanupPaths, failedPath)
				}
			}
		}
		l.published.Store(committed)
		l.manager.mu.Lock()
		if committed {
			l.manager.mutations[l.Key]++
			l.manager.publicationSeq++
			publication = l.manager.publicationSeq
		}
		if retiredPath != "" {
			retiredKey := dependencyGeneration{cacheKey: l.Key, generation: retiredGeneration}
			if l.manager.readers[retiredKey] > 0 {
				l.manager.retired[retiredKey] = append(l.manager.retired[retiredKey], retiredPath)
			} else {
				cleanupPaths = append(cleanupPaths, retiredPath)
			}
		}
		if l.manager.writers[l.Key] > 1 {
			l.manager.writers[l.Key]--
		} else {
			delete(l.manager.writers, l.Key)
			delete(l.manager.writerHasBase, l.Key)
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
		if l.manager.activePaths[leaseRoot] > 1 {
			l.manager.activePaths[leaseRoot]--
		} else {
			delete(l.manager.activePaths, leaseRoot)
		}
		if l.manager.activeUsers[l.request.UserID] > 1 {
			l.manager.activeUsers[l.request.UserID]--
		} else {
			delete(l.manager.activeUsers, l.request.UserID)
		}
		l.manager.mu.Unlock()
		if committed && l.manager.pruneSupersededLocked(l.request, l.resolved) {
			invalidatesIdleMounts = true
		}
		if l.reserved {
			l.manager.releaseReservation(l.request.UserID, l.Key)
		}
		gate.Unlock()
		if len(cleanupPaths) > 0 && l.manager.testBeforeReleaseCleanup != nil {
			l.manager.testBeforeReleaseCleanup(cleanupPaths)
		}
		if committed && l.manager.options.OnGenerationChanged != nil {
			l.manager.options.OnGenerationChanged(l.Key, l.Generation, publication)
		} else if invalidatesIdleMounts {
			if l.manager.options.OnEvicted != nil {
				l.manager.options.OnEvicted()
			}
		}
		for _, path := range cleanupPaths {
			_ = os.RemoveAll(path)
		}
		l.manager.Enforce(l.request.UserID, l.request.QuotaBytes)
	})
}

func (m *Manager) publishStagedLocked(lease *Lease) (string, string, error) {
	if m == nil || lease == nil || !lease.staged {
		return "", "", nil
	}
	retiredGeneration := readGeneration(lease.canonical)
	if retiredGeneration == "" {
		retiredGeneration = lease.Fingerprint.Digest
	}
	retiredRoot := filepath.Join(m.root, lease.request.UserID, cacheRootDir, retiredDir)
	if err := os.MkdirAll(retiredRoot, 0700); err != nil {
		return "", "", err
	}
	retiredPath, err := uniqueDependencyPath(retiredRoot, "generation-")
	if err != nil {
		return "", "", err
	}
	if err := publishDependencyGeneration(lease.canonical, lease.HostRoot, retiredPath); err != nil {
		return "", "", err
	}
	lease.HostRoot = lease.canonical
	lease.DockerMounts = map[string]string{lease.canonical: "/project-deps"}
	lease.staged = false
	return retiredPath, retiredGeneration, nil
}

// detachFailedCanonicalLocked removes a rejected first generation from the
// canonical pathname before waiters are notified. The metadata is removed
// first, so even an unusual rename/delete failure cannot make the rejected
// tree look like a valid cache hit to the next writer.
func (m *Manager) detachFailedCanonicalLocked(lease *Lease) (string, error) {
	if m == nil || lease == nil {
		return "", nil
	}
	canonical := filepath.Clean(lease.canonical)
	if canonical == "." || canonical != filepath.Clean(lease.HostRoot) {
		return "", fmt.Errorf("rejected initial generation is not canonical")
	}
	if _, err := os.Lstat(canonical); os.IsNotExist(err) {
		return "", nil
	} else if err != nil {
		return "", fmt.Errorf("inspect rejected initial generation: %w", err)
	}
	metadataErr := os.Remove(filepath.Join(canonical, metadataFile))
	if metadataErr != nil && !os.IsNotExist(metadataErr) {
		metadataErr = fmt.Errorf("invalidate rejected initial generation: %w", metadataErr)
	} else {
		metadataErr = nil
	}
	retiredRoot := filepath.Join(m.root, lease.request.UserID, cacheRootDir, retiredDir)
	if err := ensureRealDirectory(retiredRoot); err == nil {
		failedPath, allocateErr := uniqueDependencyPath(retiredRoot, "failed-")
		if allocateErr == nil {
			if renameErr := os.Rename(canonical, failedPath); renameErr == nil {
				return failedPath, metadataErr
			}
		}
	}
	if removeErr := os.RemoveAll(canonical); removeErr != nil {
		return "", errors.Join(metadataErr, fmt.Errorf("remove rejected initial generation: %w", removeErr))
	}
	return "", metadataErr
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
	evicted := m.evictCacheV2Locked(userID, quotaBytes, targetBytes, targetFiles, m.options.Retention)
	m.mu.Lock()
	userActive := m.activeUsers[userID] > 0
	m.mu.Unlock()
	if userActive {
		if evicted && m.options.OnEvicted != nil {
			m.options.OnEvicted()
		}
		return
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
	persistRoot := filepath.Join(userRoot, cacheRootDir)
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
				Category: "dependency", Path: filepath.ToSlash(relative), WorkspaceName: "Unattributed project cache",
				RuntimeID: parts[1], Language: parts[2], Digest: parts[3], DigestSource: "unknown",
				SizeBytes: entryUsage.bytes, Files: entryFiles, LastUsed: lastUsed, Active: pathActive, Writing: pathActive,
				Orphaned: true, Generation: readGeneration(path), HostPath: path, absPath: path,
			})
			if entryUsage.truncated {
				break
			}
			continue
		}
		relative, _ := filepath.Rel(persistRoot, path)
		key := metadataKey(meta)
		bindingRequest := Request{WorkspaceID: meta.WorkspaceID, RuntimeID: meta.RuntimeID, Language: meta.Language}
		current := readCurrentDigest(persistRoot, bindingRequest) == meta.Digest
		info.Entries = append(info.Entries, Entry{
			Category: "dependency", Path: filepath.ToSlash(relative), WorkspaceID: meta.WorkspaceID, WorkspaceName: meta.WorkspaceName,
			RuntimeID: meta.RuntimeID, Language: meta.Language, Digest: meta.Digest, DigestSource: meta.DigestSource,
			SizeBytes: entryUsage.bytes, Files: entryFiles, LastUsed: meta.LastUsed, CreatedAt: meta.CreatedAt,
			Current: current, Superseded: !current, Active: active[key], Writing: writing[key], Generation: readGeneration(path), HostPath: path, key: key, absPath: path,
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
		cleanup := []string(nil)
		gate := l.manager.userGate(l.request.UserID)
		gate.Lock()
		l.manager.mu.Lock()
		if l.manager.active[l.Key] > 1 {
			l.manager.active[l.Key]--
		} else {
			delete(l.manager.active, l.Key)
		}
		cleanRoot := filepath.Clean(l.sourceRoot)
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
		generationKey := dependencyGeneration{cacheKey: l.Key, generation: l.Generation}
		if l.manager.readers[generationKey] > 1 {
			l.manager.readers[generationKey]--
		} else {
			delete(l.manager.readers, generationKey)
			cleanup = append(cleanup, l.manager.retired[generationKey]...)
			delete(l.manager.retired, generationKey)
		}
		l.manager.mu.Unlock()
		gate.Unlock()
		if l.releasePin != nil {
			l.releasePin()
		}
		for _, path := range cleanup {
			_ = os.RemoveAll(path)
		}
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
	return l.manager.mutations[l.Key] == l.version
}

func (m *Manager) retainReadLocked(request Request, entry Entry) (*ReadLease, error) {
	return m.retainReadModeLocked(request, entry, false, true)
}

func (m *Manager) retainProtectedReadLocked(request Request, entry Entry) (*ReadLease, error) {
	return m.retainReadModeLocked(request, entry, true, true)
}

func (m *Manager) retainInspectionReadLocked(request Request, entry Entry) (*ReadLease, error) {
	return m.retainReadModeLocked(request, entry, false, false)
}

func (m *Manager) retainReadModeLocked(request Request, entry Entry, protected, touchLRU bool) (*ReadLease, error) {
	if touchLRU {
		if err := touchDependencyMetadata(entry.absPath, request); err != nil {
			slog.Warn("Project dependency cache access time update failed", "user_id", request.UserID, "workspace_id", request.WorkspaceID, "error", err)
		}
	}
	generation := readGeneration(entry.absPath)
	if generation == "" {
		generation = entry.Digest
	}
	pinnedRoot, releasePin, err := pinPublishedDependency(m.root, entry.absPath)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	version := m.mutations[entry.key]
	m.active[entry.key]++
	m.readers[dependencyGeneration{cacheKey: entry.key, generation: generation}]++
	m.activePaths[filepath.Clean(entry.absPath)]++
	if protected {
		m.protectedReaders[entry.key]++
	}
	m.mu.Unlock()
	return &ReadLease{Key: entry.key, HostRoot: pinnedRoot, Generation: generation, sourceRoot: entry.absPath, manager: m, request: request, version: version, protected: protected, releasePin: releasePin}, nil
}

func touchDependencyMetadata(root string, request Request) error {
	data, err := readSmallRegularFile(filepath.Join(root, metadataFile), maxMetadataBytes)
	if err != nil {
		return err
	}
	var meta metadata
	if json.Unmarshal(data, &meta) != nil || meta.Schema != cacheSchema || meta.UserID != request.UserID ||
		meta.WorkspaceID != request.WorkspaceID || meta.RuntimeID != request.RuntimeID || !strings.EqualFold(meta.Language, request.Language) {
		return fmt.Errorf("project dependency metadata no longer matches its request")
	}
	meta.LastUsed = time.Now().UTC()
	return writeMetadata(root, meta)
}

// AcquireRead retains the last published exact project/runtime/digest
// namespace. A writer with a staging base does not block this immutable view.
func (m *Manager) AcquireRead(request Request) (*ReadLease, Entry, bool, error) {
	if m == nil {
		return nil, Entry{}, false, nil
	}
	gate := m.userGate(request.UserID)
	gate.Lock()
	defer gate.Unlock()
	resolved, err := m.resolveRequest(request)
	if err != nil {
		return nil, Entry{}, false, err
	}
	entry, exists, err := m.lookupResolvedLocked(request, resolved)
	if err != nil || !exists {
		return nil, entry, exists, err
	}
	m.mu.Lock()
	writerWithoutBase := m.writers[entry.key] > 0 && !m.writerHasBase[entry.key]
	m.mu.Unlock()
	if writerWithoutBase {
		return nil, entry, true, ErrCacheInUse
	}
	reader, retainErr := m.retainReadLocked(request, entry)
	if retainErr != nil {
		return nil, entry, true, retainErr
	}
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
	resolved, err := m.resolveRequest(request)
	if err != nil {
		return Entry{}, false, err
	}
	return m.lookupResolvedLocked(request, resolved)
}

func (m *Manager) lookupResolvedLocked(request Request, resolved resolvedCacheRequest) (Entry, bool, error) {
	hit, meta := readValidMetadata(resolved.hostRoot, request, resolved.fingerprint)
	if !hit {
		return Entry{WorkspaceID: request.WorkspaceID, WorkspaceName: request.WorkspaceName, RuntimeID: request.RuntimeID, Language: request.Language, Digest: resolved.fingerprint.Digest, DigestSource: resolved.fingerprint.Source}, false, nil
	}
	if err := m.writeCurrentBindingLocked(request, resolved); err != nil {
		slog.Warn("Project dependency current binding refresh failed", "user_id", request.UserID, "workspace_id", request.WorkspaceID, "error", err)
	}
	m.mu.Lock()
	active := m.active[resolved.key] > 0
	writing := m.writers[resolved.key] > 0
	m.mu.Unlock()
	id, err := cachev2.ReadPersistentCacheID(resolved.hostRoot)
	if err != nil {
		return Entry{}, false, err
	}
	return Entry{
		ID: id.String(), Category: "dependency", Path: filepath.ToSlash(resolved.relative), WorkspaceID: meta.WorkspaceID, WorkspaceName: meta.WorkspaceName,
		RuntimeID: meta.RuntimeID, Language: meta.Language, Digest: meta.Digest, DigestSource: meta.DigestSource,
		LastUsed: meta.LastUsed, CreatedAt: meta.CreatedAt, Current: true, Active: active, Writing: writing, Generation: readGeneration(resolved.hostRoot), HostPath: resolved.hostRoot,
		key: resolved.key, absPath: resolved.hostRoot,
	}, true, nil
}

func (m *Manager) Delete(userID, relative string) error {
	if m == nil || strings.TrimSpace(userID) == "" {
		return nil
	}
	gate := m.userGate(userID)
	gate.Lock()
	defer gate.Unlock()
	persistRoot := filepath.Join(m.root, userID, cacheRootDir)
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
		request := Request{WorkspaceID: meta.WorkspaceID, RuntimeID: meta.RuntimeID, Language: meta.Language}
		if err := removeCurrentBindingIfMatches(persistRoot, request, meta.Digest); err != nil {
			return err
		}
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
	cacheRoot := filepath.Join(m.root, userID, cacheRootDir)
	for _, target := range []string{
		filepath.Join(cacheRoot, dependenciesDir, safePart(workspaceID)),
		filepath.Join(cacheRoot, incrementalDir, safePart(workspaceID)),
		filepath.Join(cacheRoot, "artifacts", "results", safePart(workspaceID)),
		filepath.Join(cacheRoot, bindingsDir, safePart(workspaceID)),
	} {
		if err := os.RemoveAll(target); err != nil {
			return err
		}
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

func ensureCacheParents(managerRoot, userID string, resolved resolvedCacheRequest) error {
	userRoot := filepath.Join(managerRoot, userID)
	for _, directory := range []string{
		filepath.Dir(managerRoot), managerRoot, userRoot, resolved.persistRoot,
		filepath.Join(resolved.persistRoot, "artifacts"),
		filepath.Join(resolved.persistRoot, dependenciesDir),
		filepath.Join(resolved.persistRoot, "transactions"),
		filepath.Join(resolved.persistRoot, stagingDir),
		filepath.Join(resolved.persistRoot, "retired"),
		filepath.Join(resolved.persistRoot, retiredDir),
		filepath.Join(resolved.persistRoot, "registry"),
		filepath.Join(resolved.persistRoot, bindingsDir),
		filepath.Join(resolved.persistRoot, dependenciesDir, resolved.workspace),
		filepath.Join(resolved.persistRoot, dependenciesDir, resolved.workspace, resolved.runtime),
		filepath.Join(resolved.persistRoot, dependenciesDir, resolved.workspace, resolved.runtime, resolved.language),
	} {
		if err := ensureRealDirectory(directory); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) resetInvalidCanonicalLocked(resolved resolvedCacheRequest) error {
	info, err := os.Lstat(resolved.hostRoot)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect invalid project dependency namespace: %w", err)
	}
	m.mu.Lock()
	active := m.active[resolved.key] > 0 || m.activePaths[filepath.Clean(resolved.hostRoot)] > 0
	m.mu.Unlock()
	if active {
		return ErrCacheInUse
	}
	if info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
		if err := os.RemoveAll(resolved.hostRoot); err != nil {
			return fmt.Errorf("clear invalid project dependency namespace: %w", err)
		}
		return nil
	}
	if err := os.Remove(resolved.hostRoot); err != nil {
		return fmt.Errorf("clear invalid project dependency namespace: %w", err)
	}
	return nil
}

func ensureDependencyDirectories(root string) error {
	for _, directory := range []string{
		root, filepath.Join(root, "python"), filepath.Join(root, "node_modules"),
		filepath.Join(root, "go"), filepath.Join(root, "go", "pkg"), filepath.Join(root, "go", "pkg", "mod"),
		filepath.Join(root, "cargo"), filepath.Join(root, "cargo-target"), filepath.Join(root, "maven"), filepath.Join(root, "gradle"),
	} {
		if err := ensureRealDirectory(directory); err != nil {
			return err
		}
	}
	return nil
}

func cloneDependencyTree(source, destination string) (directoryUsage, error) {
	info, err := os.Lstat(source)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return directoryUsage{}, fmt.Errorf("published dependency root is not a real directory")
	}
	usage := directoryUsage{}
	err = filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fmt.Errorf("dependency staging path escapes source")
		}
		if relative == "." {
			return nil
		}
		entryInfo, err := entry.Info()
		if err != nil {
			return err
		}
		usage.files++
		if !entryInfo.IsDir() {
			usage.bytes += entryInfo.Size()
		}
		switch {
		case entryInfo.Mode()&os.ModeSymlink != 0:
			_, readErr := os.Readlink(path)
			return readErr
		case entryInfo.IsDir():
			return nil
		case entryInfo.Mode().IsRegular():
			return nil
		default:
			return fmt.Errorf("dependency tree contains unsupported file %q", filepath.ToSlash(relative))
		}
	})
	if err != nil {
		return usage, err
	}
	if used, fastErr := cloneDependencyTreeFast(source, destination); used {
		if fastErr != nil {
			return usage, fastErr
		}
		return usage, nil
	}
	if err := cloneDependencyTreePortable(source, destination); err != nil {
		return usage, err
	}
	return usage, nil
}

type clonedDirectoryMetadata struct {
	path    string
	mode    fs.FileMode
	modTime time.Time
}

func cloneDependencyTreePortable(source, destination string) error {
	directories := make([]clonedDirectoryMetadata, 0, 32)
	err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, relErr := filepath.Rel(source, path)
		if relErr != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fmt.Errorf("dependency staging path escapes source")
		}
		entryInfo, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		if relative == "." {
			directories = append(directories, clonedDirectoryMetadata{path: destination, mode: entryInfo.Mode().Perm(), modTime: entryInfo.ModTime()})
			return nil
		}
		target := filepath.Join(destination, relative)
		switch {
		case entryInfo.Mode()&os.ModeSymlink != 0:
			linkTarget, readErr := os.Readlink(path)
			if readErr != nil {
				return readErr
			}
			return os.Symlink(linkTarget, target)
		case entryInfo.IsDir():
			if err := os.Mkdir(target, entryInfo.Mode().Perm()|0700); err != nil {
				return err
			}
			directories = append(directories, clonedDirectoryMetadata{path: target, mode: entryInfo.Mode().Perm(), modTime: entryInfo.ModTime()})
			return nil
		case entryInfo.Mode().IsRegular():
			return cloneRegularFile(path, target, entryInfo)
		default:
			return fmt.Errorf("dependency tree contains unsupported file %q", filepath.ToSlash(relative))
		}
	})
	if err != nil {
		return err
	}
	for index := len(directories) - 1; index >= 0; index-- {
		directory := directories[index]
		if err := os.Chmod(directory.path, directory.mode); err != nil {
			return err
		}
		if err := os.Chtimes(directory.path, directory.modTime, directory.modTime); err != nil {
			return err
		}
	}
	return nil
}

func cloneRegularFile(source, destination string, info fs.FileInfo) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Chmod(destination, info.Mode().Perm()); err != nil {
		return err
	}
	return os.Chtimes(destination, info.ModTime(), info.ModTime())
}

func replaceGeneration(root string) (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	encoded := hex.EncodeToString(value)
	return encoded, atomicWriteFile(root, generationFile, []byte(encoded+"\n"), 0600)
}

func readGeneration(root string) string {
	data, err := readSmallRegularFile(filepath.Join(root, generationFile), maxGenerationBytes)
	if err != nil {
		return ""
	}
	value := strings.TrimSpace(string(data))
	if len(value) != 32 {
		return ""
	}
	if _, err := hex.DecodeString(value); err != nil {
		return ""
	}
	return value
}

func uniqueDependencyPath(root, prefix string) (string, error) {
	for attempts := 0; attempts < 8; attempts++ {
		value := make([]byte, 16)
		if _, err := rand.Read(value); err != nil {
			return "", err
		}
		candidate := filepath.Join(root, prefix+hex.EncodeToString(value))
		if _, err := os.Lstat(candidate); os.IsNotExist(err) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("allocate dependency generation path")
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
	if _, err := cachev2.ReadPersistentCacheID(root); err != nil {
		return false, metadata{}
	}
	return meta.Schema == cacheSchema && meta.UserID == request.UserID && meta.WorkspaceID == request.WorkspaceID &&
		meta.RuntimeID == request.RuntimeID && strings.EqualFold(meta.Language, request.Language) && meta.Digest == fingerprint.Digest, meta
}

func metadataMatchesPath(meta metadata, userID string, parts []string) bool {
	return len(parts) == 4 && meta.Schema == cacheSchema && meta.UserID == userID && meta.Digest != "" &&
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
	started := time.Now()
	usage := boundedDirectoryStats(root, m.scanLimit())
	if m != nil && m.options.Metrics != nil {
		m.options.Metrics.Observe("persist.quota.scan", time.Since(started))
	}
	return usage
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
			if isManagedDependencyDirectory(entry.Name()) {
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

func isManagedDependencyDirectory(name string) bool {
	return name == dependenciesDir || name == stagingDir || name == retiredDir
}
