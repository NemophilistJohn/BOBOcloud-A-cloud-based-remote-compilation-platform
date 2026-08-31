package lsp

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"bobocloud-server/internal/resourcecontrol"
	"bobocloud-server/internal/resourcegovernor"
)

const (
	defaultDependencyPollInterval = 15 * time.Minute
	defaultDependencyPollJitter   = 3 * time.Minute
)

type ManagerOptions struct {
	MaxSessions            int
	MaxPerUser             int
	IdleTTL                time.Duration
	MaxMessageBytes        int
	MemoryLimit            string
	CPULimit               string
	CleanupInterval        time.Duration
	DependencyRegistry     *DependencyRegistry
	DependencyPollInterval time.Duration
	DependencyPollJitter   time.Duration
	ResourceController     *resourcecontrol.Controller
}

func (m *Manager) RequiresDocker(languageID, runtimeID string) bool {
	if m == nil || m.catalog == nil {
		return false
	}
	spec, ok := m.catalog.Lookup(languageID)
	return ok && (strings.TrimSpace(spec.Docker.Image) != "" || strings.TrimSpace(runtimeID) != "local")
}

type Session struct {
	ID                    string
	Key                   string
	Context               SessionContext
	Cache                 CacheNamespace
	Docker                bool
	messages              chan []byte
	done                  chan struct{}
	resourcesDone         chan struct{}
	stopping              chan struct{}
	process               Process
	writer                lockedWriter
	cancel                context.CancelFunc
	lease                 *CacheLease
	sharedRelease         func()
	dependencyRelease     func()
	storeRelease          func()
	resourceLease         *resourcecontrol.Lease
	maxBytes              int
	lastUsed              atomic.Int64
	stopOnce              sync.Once
	releaseOnce           sync.Once
	onClose               func(*Session)
	uriMapper             *URIMapper
	restartMu             sync.Mutex
	restartStatus         *AnalysisDependencyStatus
	dependencyIndexGate   sync.Mutex
	dependencyIndexClosed bool
	dependencyIndexMu     sync.Mutex
	dependencyIndex       *DependencyAPIIndex
	dependencyIndexTasks  atomic.Int32
}

func (s *Session) Messages() <-chan []byte { return s.messages }
func (s *Session) Done() <-chan struct{}   { return s.done }
func (s *Session) URIMapper() *URIMapper   { return s.uriMapper }

func (s *Session) ResourcesDone() <-chan struct{} {
	if s.resourcesDone != nil {
		return s.resourcesDone
	}
	return s.done
}

func (s *Session) DependencySettings() map[string]any {
	return s.Context.DependencyView.SettingsForAnalyzer(s.Docker, s.Cache.Path)
}

func (s *Session) DependencyInitializationOptions() map[string]any {
	return s.Context.DependencyView.InitializationOptionsForAnalyzer(s.Docker)
}

func (s *Session) DependencyStatus() AnalysisDependencyStatus {
	if !s.Context.DependencyResolved {
		return UnavailableDependencyStatus(s.Context.LanguageID, s.Context.RuntimeID)
	}
	kind, _ := s.Context.Owner()
	return s.Context.DependencyView.PublicStatus(s.Docker, kind)
}

func (s *Session) Touch() { s.lastUsed.Store(time.Now().UnixNano()) }

func (s *Session) LastUsed() time.Time {
	return time.Unix(0, s.lastUsed.Load())
}

func (s *Session) Send(payload []byte) error {
	if s.maxBytes > 0 && len(payload) > s.maxBytes {
		return fmt.Errorf("LSP message exceeds %d bytes", s.maxBytes)
	}
	select {
	case <-s.done:
		return fmt.Errorf("LSP session is closed")
	case <-s.stopping:
		return fmt.Errorf("LSP session is stopping")
	default:
	}
	s.Touch()
	return s.writer.frame(payload)
}

func (s *Session) Stop() {
	s.stopOnce.Do(func() {
		close(s.stopping)
		s.cancel()
		_ = s.process.Stdin().Close()
		_ = s.process.Kill()
	})
}

func (s *Session) releaseResources() {
	s.releaseOnce.Do(func() {
		// The dependency summary is written into the same namespace as the
		// analyzer cache. Give a bounded static scan time to finish before that
		// namespace becomes eligible for a manual clear or normal pruning.
		s.closeDependencyAPIIndex()
		s.waitDependencyAPIIndex(2 * time.Second)
		if s.lease != nil {
			s.lease.Release()
		}
		if s.sharedRelease != nil {
			s.sharedRelease()
		}
		if s.dependencyRelease != nil {
			s.dependencyRelease()
		}
		if s.storeRelease != nil {
			s.storeRelease()
		}
		if s.resourceLease != nil {
			s.resourceLease.Release()
		}
		if s.resourcesDone != nil {
			close(s.resourcesDone)
		}
	})
}

// RestartForDependency asks the gateway to reconnect this session with a new
// read-only dependency view. It never mutates the active process mounts.
func (s *Session) RestartForDependency(status AnalysisDependencyStatus) {
	s.restartMu.Lock()
	if s.restartStatus == nil {
		copy := status
		s.restartStatus = &copy
	}
	s.restartMu.Unlock()
	s.Stop()
}

func (s *Session) DependencyRestartStatus() (AnalysisDependencyStatus, bool) {
	s.restartMu.Lock()
	defer s.restartMu.Unlock()
	if s.restartStatus == nil {
		return AnalysisDependencyStatus{}, false
	}
	return *s.restartStatus, true
}

func (s *Session) readLoop() {
	naturalEOF := false
	defer func() {
		if naturalEOF {
			_ = s.process.Stdin().Close()
		} else {
			s.Stop()
		}
		_ = s.process.Stdout().Close()
		waitDone := make(chan struct{})
		go func() {
			_ = s.process.Wait()
			close(waitDone)
		}()
		waited := false
		select {
		case <-waitDone:
			waited = true
		case <-time.After(2 * time.Second):
			_ = s.process.Kill()
			select {
			case <-waitDone:
				waited = true
			case <-time.After(2 * time.Second):
			}
		}
		s.stopOnce.Do(func() {
			close(s.stopping)
			s.cancel()
			_ = s.process.Stdin().Close()
		})
		if waited {
			s.releaseResources()
		} else {
			// A timed-out process may still hold Docker bind mounts. Keep both
			// leases fail-closed and reap them only after Process.Wait confirms
			// the process is actually gone.
			go func() {
				<-waitDone
				s.releaseResources()
			}()
		}
		close(s.messages)
		close(s.done)
		if s.onClose != nil {
			if waited {
				s.onClose(s)
			} else {
				// Keep draining sessions discoverable by destructive lifecycle
				// operations until their bind mounts are genuinely released.
				go func() {
					<-s.ResourcesDone()
					s.onClose(s)
				}()
			}
		}
	}()
	reader := bufio.NewReader(s.process.Stdout())
	for {
		payload, err := readFrame(reader, s.maxBytes)
		if err != nil {
			naturalEOF = err == io.EOF
			if !naturalEOF {
				// The WebSocket handler reports process termination in its normal
				// close path; malformed/oversized frames terminate the process.
			}
			return
		}
		s.Touch()
		select {
		case s.messages <- payload:
		case <-s.stopping:
			return
		}
	}
}

type Manager struct {
	catalog          *Catalog
	cache            *CacheManager
	starter          ProcessStarter
	opts             ManagerOptions
	ctx              context.Context
	cancel           context.CancelFunc
	mu               sync.Mutex
	sessions         map[string]*Session
	starting         int
	startingByUser   map[string]int
	startingKeys     map[string]struct{}
	refreshMu        sync.Mutex
	refreshing       map[string]*dependencyRefreshState
	refreshGate      chan struct{}
	refreshScan      func(*DependencyRegistry, DependencyRefreshScope) int
	refreshAfter     func(time.Duration, func()) dependencyRefreshTimer
	refreshDelay     time.Duration
	refreshWG        sync.WaitGroup
	refreshRunWG     sync.WaitGroup
	refreshClosed    bool
	refreshCloseOnce sync.Once
	refreshCloseDone chan struct{}
	resourceWait     time.Duration
}

type dependencyRefreshTimer interface {
	Stop() bool
}

type dependencyRefreshState struct {
	running  bool
	dirty    bool
	timer    dependencyRefreshTimer
	registry *DependencyRegistry
	scope    DependencyRefreshScope
}

func NewManager(catalog *Catalog, cache *CacheManager, starter ProcessStarter, opts ManagerOptions) *Manager {
	if catalog == nil {
		catalog = DefaultCatalog()
	}
	if starter == nil {
		starter = ExecStarter{}
	}
	if opts.MaxSessions <= 0 {
		opts.MaxSessions = 8
	}
	if opts.MaxPerUser <= 0 {
		opts.MaxPerUser = 2
	}
	if opts.IdleTTL <= 0 {
		opts.IdleTTL = 15 * time.Minute
	}
	if opts.MaxMessageBytes <= 0 {
		opts.MaxMessageBytes = 1 << 20
	}
	if opts.CleanupInterval <= 0 {
		opts.CleanupInterval = time.Minute
	}
	if opts.DependencyRegistry != nil && opts.DependencyPollInterval <= 0 {
		opts.DependencyPollInterval = defaultDependencyPollInterval
		if opts.DependencyPollJitter == 0 {
			opts.DependencyPollJitter = defaultDependencyPollJitter
		}
	}
	if opts.DependencyPollJitter < 0 {
		opts.DependencyPollJitter = 0
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		catalog: catalog, cache: cache, starter: starter, opts: opts, ctx: ctx, cancel: cancel,
		sessions: make(map[string]*Session), startingByUser: make(map[string]int), startingKeys: make(map[string]struct{}),
		refreshing: make(map[string]*dependencyRefreshState), refreshGate: make(chan struct{}, 1),
		refreshAfter: func(delay time.Duration, callback func()) dependencyRefreshTimer {
			return time.AfterFunc(delay, callback)
		},
		refreshDelay:     500 * time.Millisecond,
		refreshCloseDone: make(chan struct{}),
		resourceWait:     3 * time.Second,
	}
	m.refreshScan = m.refreshDependencyViewsOnce
	go m.cleanupLoop()
	return m
}

func randomSessionID() (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate LSP session ID: %w", err)
	}
	return hex.EncodeToString(b), nil
}

func (m *Manager) reserve(userID, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.sessions[key]; exists {
		return fmt.Errorf("an LSP session is already active for this workspace")
	}
	if _, exists := m.startingKeys[key]; exists {
		return fmt.Errorf("an LSP session is already starting for this workspace")
	}
	if len(m.sessions)+m.starting >= m.opts.MaxSessions {
		return fmt.Errorf("global LSP session limit reached")
	}
	userCount := m.startingByUser[userID]
	for _, session := range m.sessions {
		if session.Context.UserID == userID {
			userCount++
		}
	}
	if userCount >= m.opts.MaxPerUser {
		return fmt.Errorf("user LSP session limit reached")
	}
	m.starting++
	m.startingByUser[userID]++
	m.startingKeys[key] = struct{}{}
	return nil
}

func (m *Manager) finishReservation(userID, key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.starting > 0 {
		m.starting--
	}
	if m.startingByUser[userID] > 1 {
		m.startingByUser[userID]--
	} else {
		delete(m.startingByUser, userID)
	}
	delete(m.startingKeys, key)
}

func (m *Manager) Start(ctx SessionContext) (*Session, error) {
	resourceLease := ctx.ResourceLease
	ctx.ResourceLease = nil
	resourceOwned := resourceLease != nil
	defer func() {
		if resourceOwned {
			resourceLease.Release()
		}
	}()
	sharedRelease := func() {}
	if ctx.SharedDependencies != nil && ctx.SharedDependencies.Release != nil {
		sharedRelease = ctx.SharedDependencies.Release
	}
	sharedOwned := true
	storeRelease := ctx.DependencyStoreRelease
	if storeRelease == nil {
		storeRelease = func() {}
	}
	storeOwned := true
	defer func() {
		if sharedOwned {
			sharedRelease()
		}
		if storeOwned {
			storeRelease()
		}
	}()
	if !ctx.Mode.RemoteEnabled() {
		return nil, fmt.Errorf("local mode does not start a remote language server")
	}
	spec, ok := m.catalog.Lookup(ctx.LanguageID)
	if !ok {
		return nil, fmt.Errorf("no language server is configured for %s", ctx.LanguageID)
	}
	ctx.LanguageID = normalizeLanguage(ctx.LanguageID)
	useDocker := spec.Docker.Image != "" || ctx.RuntimeID != "local"
	if !useDocker && len(ctx.DependencyView.Mounts) > 0 {
		return nil, fmt.Errorf("dependency-aware analysis requires an isolated Docker language server")
	}
	mapper, err := NewURIMapper(ctx.RemoteRoot)
	if useDocker {
		mapper, err = NewContainerURIMapper(dockerWorkspaceRoot(ctx.LanguageID))
	}
	if err != nil {
		return nil, fmt.Errorf("map analyzer workspace: %w", err)
	}
	key := SessionKey(ctx)
	if err := m.reserve(ctx.UserID, key); err != nil {
		return nil, err
	}
	defer m.finishReservation(ctx.UserID, key)
	id, err := randomSessionID()
	if err != nil {
		return nil, err
	}
	if resourceLease == nil && m.opts.ResourceController != nil {
		minimum := resourcegovernor.Resources{}
		if useDocker {
			minimum.DockerContainers = 1
		}
		resourceLease, err = m.opts.ResourceController.TryAcquireWithDemand(resourcecontrol.WorkloadLSP, ctx.UserID, id, minimum)
		if err != nil {
			return nil, fmt.Errorf("admit LSP session resources: %w", err)
		}
	}
	resourceOwned = resourceLease != nil
	lockHash, err := DependencyLockHash(ctx.RemoteRoot)
	if err != nil {
		return nil, fmt.Errorf("hash dependency locks: %w", err)
	}
	ownerKind, ownerID := ctx.Owner()
	cacheContext := CacheContext{OwnerKind: ownerKind, OwnerID: ownerID, UserID: ctx.UserID, ProjectID: ctx.ProjectID, Branch: ctx.Branch, FolderKey: ctx.FolderKey, RuntimeID: ctx.RuntimeID, LanguageID: ctx.LanguageID, Mode: ctx.Mode, ToolchainFingerprint: ToolchainFingerprint(spec, ctx.RuntimeID), LockHash: lockHash}
	lease, err := m.cache.Prepare(cacheContext)
	if err != nil {
		return nil, err
	}
	dependencyRelease, err := acquireDependencySnapshotMounts(ctx.DependencyView)
	if err != nil && m.opts.DependencyRegistry != nil {
		// A publisher may have advanced the immutable generation after the WS
		// request resolved its view but before the process acquired a reference.
		// Resolve once more under the current marker instead of starting with a
		// missing bind source.
		if refreshed, resolveErr := m.opts.DependencyRegistry.Resolve(ctx.DependencyRequest); resolveErr == nil {
			ctx.DependencyView = refreshed
			ctx.DependencyResolved = true
			dependencyRelease, err = acquireDependencySnapshotMounts(ctx.DependencyView)
		}
	}
	if err != nil {
		lease.Release()
		return nil, err
	}

	processParent := ctx.ProcessContext
	if processParent == nil {
		processParent = m.ctx
	}
	processCtx, processCancel := context.WithCancel(processParent)
	stopManagerCancellation := context.AfterFunc(m.ctx, processCancel)
	cancel := func() {
		stopManagerCancellation()
		processCancel()
	}
	process, err := m.starter.Start(processCtx, LaunchSpec{SessionID: id, UserID: ctx.UserID, Workspace: ctx.RemoteRoot, CacheDir: lease.Dir, MountRoot: filepath.Join(m.cache.root, "mounts"), LanguageID: ctx.LanguageID, Mode: ctx.Mode, RuntimeID: ctx.RuntimeID, RuntimeImage: ctx.RuntimeImage, Server: spec, Docker: useDocker, MemoryLimit: m.opts.MemoryLimit, CPULimit: m.opts.CPULimit, DependencyView: ctx.DependencyView, SharedDependencies: ctx.SharedDependencies})
	if err != nil {
		cancel()
		lease.Release()
		dependencyRelease()
		return nil, fmt.Errorf("start %s language server: %w", ctx.LanguageID, err)
	}
	session := &Session{ID: id, Key: key, Context: ctx, Cache: lease.Namespace, Docker: useDocker, messages: make(chan []byte, 16), done: make(chan struct{}), resourcesDone: make(chan struct{}), stopping: make(chan struct{}), process: process, writer: lockedWriter{w: process.Stdin()}, cancel: cancel, lease: lease, sharedRelease: sharedRelease, dependencyRelease: dependencyRelease, storeRelease: storeRelease, resourceLease: resourceLease, maxBytes: m.opts.MaxMessageBytes, uriMapper: mapper}
	resourceOwned = false
	session.Touch()
	session.onClose = m.remove
	m.mu.Lock()
	if _, exists := m.sessions[key]; exists {
		m.mu.Unlock()
		sharedOwned = false
		storeOwned = false
		go session.readLoop()
		session.Stop()
		<-session.Done()
		return nil, fmt.Errorf("an LSP session became active while starting")
	}
	m.sessions[key] = session
	m.mu.Unlock()
	sharedOwned = false
	storeOwned = false
	go session.readLoop()
	return session, nil
}

func (m *Manager) remove(session *Session) {
	m.mu.Lock()
	if m.sessions[session.Key] == session {
		delete(m.sessions, session.Key)
	}
	m.mu.Unlock()
}

func (m *Manager) cleanupLoop() {
	cleanupTicker := time.NewTicker(m.opts.CleanupInterval)
	defer cleanupTicker.Stop()
	var dependencyTimer *time.Timer
	var dependencyTick <-chan time.Time
	if m.opts.DependencyRegistry != nil && m.opts.DependencyPollInterval > 0 {
		dependencyTimer = time.NewTimer(dependencyPollDelay(m.opts.DependencyPollInterval, m.opts.DependencyPollJitter))
		dependencyTick = dependencyTimer.C
		defer dependencyTimer.Stop()
	}
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-dependencyTick:
			m.refreshActiveDependencyScopes(m.opts.DependencyRegistry)
			dependencyTimer.Reset(dependencyPollDelay(m.opts.DependencyPollInterval, m.opts.DependencyPollJitter))
		case now := <-cleanupTicker.C:
			m.mu.Lock()
			sessions := make([]*Session, 0, len(m.sessions))
			for _, session := range m.sessions {
				if now.Sub(session.LastUsed()) > m.opts.IdleTTL {
					sessions = append(sessions, session)
				}
			}
			m.mu.Unlock()
			for _, session := range sessions {
				session.Stop()
			}
			if m.cache != nil {
				for _, owner := range m.cache.Owners() {
					m.cache.Prune(owner[0], owner[1])
				}
			}
		}
	}
}

func dependencyPollDelay(interval, jitter time.Duration) time.Duration {
	if interval <= 0 || jitter <= 0 {
		return interval
	}
	if maximum := interval / 2; jitter > maximum {
		jitter = maximum
	}
	if upperRoom := time.Duration(1<<63-1) - interval; jitter > upperRoom {
		jitter = upperRoom
	}
	if jitter <= 0 {
		return interval
	}
	var entropy [8]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return interval
	}
	span := uint64(jitter)*2 + 1
	offset := time.Duration(binary.LittleEndian.Uint64(entropy[:])%span) - jitter
	return interval + offset
}

// DependencyRefreshScope selects sessions whose server-issued dependency view
// should be recomputed. Empty fields match all sessions.
type DependencyRefreshScope struct {
	UserID     string
	OwnerKind  string
	OwnerID    string
	ProjectID  string
	Branch     string
	FolderKey  string
	RuntimeID  string
	LanguageID string
}

func (scope DependencyRefreshScope) matches(context SessionContext) bool {
	if scope.UserID != "" && context.UserID != scope.UserID {
		return false
	}
	ownerKind, ownerID := context.Owner()
	if scope.OwnerKind != "" && ownerKind != scope.OwnerKind {
		return false
	}
	if scope.OwnerID != "" && ownerID != scope.OwnerID {
		return false
	}
	if scope.ProjectID != "" && context.ProjectID != scope.ProjectID {
		return false
	}
	if scope.Branch != "" && context.Branch != scope.Branch {
		return false
	}
	if scope.FolderKey != "" && context.FolderKey != scope.FolderKey {
		return false
	}
	if scope.RuntimeID != "" && context.RuntimeID != scope.RuntimeID {
		return false
	}
	if scope.LanguageID != "" {
		requested, active := normalizeLanguage(scope.LanguageID), normalizeLanguage(context.LanguageID)
		if requested != active && !((requested == "c" || requested == "cpp") && (active == "c" || active == "cpp")) {
			return false
		}
	}
	return true
}

func (scope DependencyRefreshScope) key() string {
	languageKey := normalizeLanguage(scope.LanguageID)
	if languageKey == "c" || languageKey == "cpp" {
		languageKey = "c/cpp"
	}
	return strings.Join([]string{
		strings.TrimSpace(scope.UserID), strings.TrimSpace(scope.OwnerKind),
		strings.TrimSpace(scope.OwnerID), strings.TrimSpace(scope.ProjectID),
		strings.TrimSpace(scope.Branch), strings.TrimSpace(scope.FolderKey),
		strings.TrimSpace(scope.RuntimeID),
		languageKey,
	}, "\x00")
}

func dependencyRefreshScopeForContext(context SessionContext) DependencyRefreshScope {
	ownerKind, ownerID := context.Owner()
	scope := DependencyRefreshScope{
		OwnerKind: ownerKind, OwnerID: ownerID,
		ProjectID: context.ProjectID, Branch: context.Branch, FolderKey: context.FolderKey,
		RuntimeID: context.RuntimeID, LanguageID: context.LanguageID,
	}
	if ownerKind == "user" {
		scope.UserID = context.UserID
	}
	return scope
}

func (m *Manager) activeDependencyRefreshScopes() []DependencyRefreshScope {
	m.mu.Lock()
	contexts := make([]SessionContext, 0, len(m.sessions))
	for _, session := range m.sessions {
		contexts = append(contexts, session.Context)
	}
	m.mu.Unlock()

	byKey := make(map[string]DependencyRefreshScope, len(contexts))
	for _, context := range contexts {
		scope := dependencyRefreshScopeForContext(context)
		if scope.OwnerID == "" || scope.RuntimeID == "" || scope.LanguageID == "" {
			continue
		}
		byKey[scope.key()] = scope
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	scopes := make([]DependencyRefreshScope, 0, len(keys))
	for _, key := range keys {
		scopes = append(scopes, byKey[key])
	}
	return scopes
}

func (m *Manager) refreshActiveDependencyScopes(registry *DependencyRegistry) int {
	restarted := 0
	for _, scope := range m.activeDependencyRefreshScopes() {
		restarted += m.RefreshDependencyViews(registry, scope)
	}
	return restarted
}

// RefreshDependencyViews compares the active immutable views against current
// package metadata. Changed sessions receive an orderly dependency restart;
// analyzer cache namespaces remain stable and are not deleted.
func (m *Manager) RefreshDependencyViews(registry *DependencyRegistry, scope DependencyRefreshScope) int {
	if registry == nil {
		return 0
	}
	key := scope.key()
	m.refreshMu.Lock()
	if m.refreshClosed {
		m.refreshMu.Unlock()
		return 0
	}
	state := m.refreshing[key]
	if state == nil {
		state = &dependencyRefreshState{}
		m.refreshing[key] = state
	}
	state.registry = registry
	state.scope = scope
	if state.running || state.timer != nil {
		state.dirty = true
		m.refreshMu.Unlock()
		return 0
	}
	state.running = true
	m.refreshRunWG.Add(1)
	m.refreshMu.Unlock()
	return m.runDependencyRefresh(key, state, registry, scope)
}

// RestartDependencyViews invalidates sessions whose immutable dependency
// generation was replaced by a project-cache transaction. The replacement
// path cannot be discovered from the old request because that request is
// deliberately pinned to the retired generation; reconnecting rebuilds the
// request from the newly published canonical generation.
func (m *Manager) RestartDependencyViews(scope DependencyRefreshScope) int {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		if scope.matches(session.Context) {
			sessions = append(sessions, session)
		}
	}
	m.mu.Unlock()
	for _, session := range sessions {
		session.RestartForDependency(session.DependencyStatus())
	}
	return len(sessions)
}

func (m *Manager) runDependencyRefresh(key string, state *dependencyRefreshState, registry *DependencyRegistry, scope DependencyRefreshScope) (restarted int) {
	defer m.refreshRunWG.Done()
	select {
	case m.refreshGate <- struct{}{}:
	case <-m.ctx.Done():
		m.finishDependencyRefresh(key, state)
		return 0
	}
	defer func() {
		<-m.refreshGate
		m.finishDependencyRefresh(key, state)
	}()
	if m.ctx.Err() != nil {
		return 0
	}
	return m.refreshScan(registry, scope)
}

func (m *Manager) finishDependencyRefresh(key string, state *dependencyRefreshState) {
	m.refreshMu.Lock()
	defer m.refreshMu.Unlock()
	if m.refreshing[key] != state {
		return
	}
	state.running = false
	if m.refreshClosed || m.ctx.Err() != nil {
		delete(m.refreshing, key)
		return
	}
	m.scheduleDependencyRefreshLocked(key, state)
}

func (m *Manager) scheduleDependencyRefreshLocked(key string, state *dependencyRefreshState) {
	if state.timer != nil || m.refreshClosed {
		return
	}
	m.refreshWG.Add(1)
	state.timer = m.refreshAfter(m.refreshDelay, func() {
		defer m.refreshWG.Done()
		m.runDependencyRefreshTimer(key, state)
	})
}

func (m *Manager) runDependencyRefreshTimer(key string, state *dependencyRefreshState) {
	m.refreshMu.Lock()
	if m.refreshing[key] != state {
		m.refreshMu.Unlock()
		return
	}
	state.timer = nil
	if m.refreshClosed || m.ctx.Err() != nil {
		delete(m.refreshing, key)
		m.refreshMu.Unlock()
		return
	}
	if !state.dirty {
		delete(m.refreshing, key)
		m.refreshMu.Unlock()
		return
	}
	state.dirty = false
	state.running = true
	m.refreshRunWG.Add(1)
	registry, scope := state.registry, state.scope
	m.refreshMu.Unlock()
	m.runDependencyRefresh(key, state, registry, scope)
}

func (m *Manager) refreshDependencyViewsOnce(registry *DependencyRegistry, scope DependencyRefreshScope) int {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		if scope.matches(session.Context) {
			sessions = append(sessions, session)
		}
	}
	m.mu.Unlock()
	type requestGroup struct {
		request  AnalysisDependencyRequest
		sessions []*Session
	}
	groups := make(map[string]*requestGroup, len(sessions))
	keys := make([]string, 0, len(sessions))
	for _, session := range sessions {
		encoded, err := json.Marshal(session.Context.DependencyRequest)
		if err != nil {
			continue
		}
		key := string(encoded)
		group := groups[key]
		if group == nil {
			group = &requestGroup{request: session.Context.DependencyRequest}
			groups[key] = group
			keys = append(keys, key)
		}
		group.sessions = append(group.sessions, session)
	}
	sort.Strings(keys)
	restarted := 0
	for _, key := range keys {
		group := groups[key]
		next, err := registry.Resolve(group.request)
		if err != nil {
			continue
		}
		for _, session := range group.sessions {
			if session.Context.DependencyResolved && next.Revision == session.Context.DependencyView.Revision {
				continue
			}
			ownerKind, _ := session.Context.Owner()
			session.RestartForDependency(next.PublicStatus(session.Docker, ownerKind))
			restarted++
		}
	}
	return restarted
}

func (m *Manager) CacheInfo(ownerKind, ownerID string) CacheInfo {
	return m.cache.Inspect(ownerKind, ownerID)
}

func (m *Manager) ClearCache(ownerKind, ownerID, scope, projectID, namespaceKey string) (CacheInfo, error) {
	if err := m.cache.Clear(ownerKind, ownerID, scope, projectID, namespaceKey); err != nil {
		return m.cache.Inspect(ownerKind, ownerID), err
	}
	return m.cache.Inspect(ownerKind, ownerID), nil
}

func (m *Manager) Languages() []string { return m.catalog.Languages() }

// CatalogVersion is a sanitized revision for capability negotiation. It does
// not expose manifest paths or executable commands.
func (m *Manager) CatalogVersion() int {
	if m == nil || m.catalog == nil {
		return 0
	}
	return m.catalog.Version()
}

// CatalogFingerprint returns an opaque revision of the public static catalog.
func (m *Manager) CatalogFingerprint() string {
	if m == nil || m.catalog == nil {
		return ""
	}
	return m.catalog.Fingerprint()
}

// StopOwner terminates matching processes before an account/team/project is
// deleted. It waits briefly so cache leases are released deterministically.
func (m *Manager) stopMatching(match func(*Session) bool) error {
	return m.stopMatchingContext(context.Background(), match)
}

func (m *Manager) stopMatchingContext(ctx context.Context, match func(*Session) bool) error {
	if ctx == nil {
		ctx = context.Background()
	}
	m.mu.Lock()
	sessions := make([]*Session, 0)
	for _, session := range m.sessions {
		if match(session) {
			sessions = append(sessions, session)
		}
	}
	m.mu.Unlock()
	for _, session := range sessions {
		session.Stop()
	}
	wait := m.resourceWait
	if wait <= 0 {
		wait = 3 * time.Second
	}
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for _, session := range sessions {
		select {
		case <-session.ResourcesDone():
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("analysis resources are still being released; retry shortly")
		}
	}
	return nil
}

// StopOwner terminates every session backed by an account, team, or team
// project. It waits briefly so cache and dependency leases are released before
// the owning files are removed.
func (m *Manager) StopOwner(ownerKind, ownerID, projectID string) error {
	return m.stopMatching(func(session *Session) bool {
		kind, id := session.Context.Owner()
		return kind == ownerKind && id == ownerID && (projectID == "" || session.Context.ProjectID == projectID)
	})
}

// StopUser terminates both personal and team sessions for one account.
func (m *Manager) StopUser(userID string) error {
	return m.StopUserContext(context.Background(), userID)
}

// StopUserContext terminates both personal and team sessions for one account
// and bounds the resource-drain wait by ctx as well as the manager timeout.
func (m *Manager) StopUserContext(ctx context.Context, userID string) error {
	return m.stopMatchingContext(ctx, func(session *Session) bool {
		return session.Context.UserID == userID
	})
}

// StopUserOwner revokes one user's sessions for a specific owner without
// disrupting the other members of a team.
func (m *Manager) StopUserOwner(userID, ownerKind, ownerID, projectID string) error {
	return m.stopMatching(func(session *Session) bool {
		kind, id := session.Context.Owner()
		return session.Context.UserID == userID && kind == ownerKind && id == ownerID &&
			(projectID == "" || session.Context.ProjectID == projectID)
	})
}

// StopUserWorkspace terminates one personal workspace without disturbing the
// user's other personal or team analysis sessions.
func (m *Manager) StopUserWorkspace(userID, folderKey string) error {
	return m.stopMatching(func(session *Session) bool {
		kind, id := session.Context.Owner()
		return kind == "user" && id == userID && session.Context.UserID == userID && session.Context.FolderKey == folderKey
	})
}

func (m *Manager) Close() {
	if m == nil {
		return
	}
	m.cancel()
	m.closeDependencyRefreshes()
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.mu.Unlock()
	for _, session := range sessions {
		session.Stop()
	}
}

// CloseContext stops new work and waits until every session and dependency
// refresh has released the resources it owns. Cleanup can be retried with a
// fresh context after a deadline.
func (m *Manager) CloseContext(ctx context.Context) error {
	if m == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	m.cancel()
	refreshDone := m.beginDependencyRefreshClose()
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.mu.Unlock()
	for _, session := range sessions {
		session.Stop()
	}

	select {
	case <-refreshDone:
	case <-ctx.Done():
		return fmt.Errorf("wait for language dependency refreshes: %w", ctx.Err())
	}
	for _, session := range sessions {
		select {
		case <-session.ResourcesDone():
		case <-ctx.Done():
			return fmt.Errorf("wait for language session resources: %w", ctx.Err())
		}
	}
	return nil
}

func (m *Manager) beginDependencyRefreshClose() <-chan struct{} {
	m.refreshMu.Lock()
	if !m.refreshClosed {
		m.refreshClosed = true
		for key, state := range m.refreshing {
			if state.timer != nil && state.timer.Stop() {
				m.refreshWG.Done()
			}
			state.timer = nil
			delete(m.refreshing, key)
		}
	}
	m.refreshMu.Unlock()
	m.refreshCloseOnce.Do(func() {
		go func() {
			m.refreshWG.Wait()
			m.refreshRunWG.Wait()
			close(m.refreshCloseDone)
		}()
	})
	return m.refreshCloseDone
}

func (m *Manager) closeDependencyRefreshes() {
	<-m.beginDependencyRefreshClose()
}
