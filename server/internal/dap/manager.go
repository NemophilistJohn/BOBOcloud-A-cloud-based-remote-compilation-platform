package dap

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type SessionContext struct {
	UserID         string
	WorkspaceKind  string
	TeamID         string
	ProjectID      string
	Branch         string
	FolderKey      string
	RuntimeID      string
	LanguageID     string
	RemoteRoot     string
	PersistDir     string
	DependencyRoot string
	DependencyEnv  map[string]string
	ProcessContext context.Context
	Release        func()
}

func (c SessionContext) Owner() (string, string) {
	if c.TeamID != "" {
		return "team", c.TeamID
	}
	return "user", c.UserID
}

func (c SessionContext) WorkspaceKey() string {
	if c.TeamID != "" {
		return strings.Join([]string{"team", c.TeamID, c.ProjectID, c.Branch}, "\x00")
	}
	return strings.Join([]string{"user", c.UserID, c.FolderKey}, "\x00")
}

type ManagerOptions struct {
	MaxSessions     int
	MaxPerUser      int
	IdleTTL         time.Duration
	MaxSession      time.Duration
	CleanupInterval time.Duration
	MaxMessageBytes int
	MemoryLimit     string
	CPULimit        string
	NetworkEnable   bool
	Inspector       ImageInspector
}

type Session struct {
	ID      string
	Key     string
	Context SessionContext
	Adapter AdapterSpec

	messages      chan []byte
	done          chan struct{}
	resourcesDone chan struct{}
	stopping      chan struct{}
	process       Process
	writer        *LockedFrameWriter
	cancel        context.CancelFunc
	maxBytes      int
	created       time.Time
	lastUsed      atomic.Int64
	stopOnce      sync.Once
	releaseOnce   sync.Once
	errMu         sync.RWMutex
	terminalErr   error
	onClose       func(*Session)
}

// ChildSession owns one additional DAP connection for an adapter-managed
// debuggee. js-debug uses this shape when the root process creates a Node
// target. It is deliberately separate from LSP session handling.
type ChildSession struct {
	messages chan []byte
	done     chan struct{}
	conn     io.ReadWriteCloser
	writer   *LockedFrameWriter
	maxBytes int
	errMu    sync.RWMutex
	err      error
	stopOnce sync.Once
}

func newChildSession(conn io.ReadWriteCloser, maxBytes int) *ChildSession {
	child := &ChildSession{messages: make(chan []byte, 32), done: make(chan struct{}), conn: conn, writer: NewLockedFrameWriter(conn), maxBytes: maxBytes}
	go child.readLoop()
	return child
}

func (s *Session) OpenChild(ctx context.Context) (*ChildSession, error) {
	provider, ok := s.process.(ChildConnectionProvider)
	if !ok || !s.Adapter.SupportsChildSessions {
		return nil, fmt.Errorf("this debug adapter does not support child DAP sessions")
	}
	select {
	case <-s.stopping:
		return nil, fmt.Errorf("DAP session is stopping")
	default:
	}
	connection, err := provider.OpenChild(ctx)
	if err != nil {
		return nil, fmt.Errorf("open DAP child session: %w", err)
	}
	return newChildSession(connection, s.maxBytes), nil
}

func (s *ChildSession) Messages() <-chan []byte { return s.messages }
func (s *ChildSession) Done() <-chan struct{}   { return s.done }
func (s *ChildSession) Err() error {
	s.errMu.RLock()
	defer s.errMu.RUnlock()
	return s.err
}
func (s *ChildSession) Send(payload []byte) error {
	if s.maxBytes > 0 && len(payload) > s.maxBytes {
		return fmt.Errorf("DAP message exceeds %d bytes", s.maxBytes)
	}
	select {
	case <-s.done:
		return fmt.Errorf("DAP child session is closed")
	default:
	}
	return s.writer.Write(payload)
}
func (s *ChildSession) Stop() {
	s.stopOnce.Do(func() { _ = s.conn.Close() })
}
func (s *ChildSession) readLoop() {
	defer func() {
		s.Stop()
		close(s.messages)
		close(s.done)
	}()
	reader := bufio.NewReader(s.conn)
	for {
		payload, err := ReadFrame(reader, s.maxBytes)
		if err != nil {
			s.errMu.Lock()
			s.err = err
			s.errMu.Unlock()
			return
		}
		select {
		case s.messages <- payload:
		case <-s.done:
			return
		}
	}
}

func (s *Session) Messages() <-chan []byte        { return s.messages }
func (s *Session) Done() <-chan struct{}          { return s.done }
func (s *Session) ResourcesDone() <-chan struct{} { return s.resourcesDone }
func (s *Session) Touch()                         { s.lastUsed.Store(time.Now().UnixNano()) }
func (s *Session) LastUsed() time.Time            { return time.Unix(0, s.lastUsed.Load()) }

func (s *Session) Err() error {
	s.errMu.RLock()
	defer s.errMu.RUnlock()
	return s.terminalErr
}

func (s *Session) setTerminalError(err error) {
	if err == nil {
		return
	}
	s.errMu.Lock()
	if s.terminalErr == nil {
		s.terminalErr = err
	}
	s.errMu.Unlock()
}

func (s *Session) Send(payload []byte) error {
	if s.maxBytes > 0 && len(payload) > s.maxBytes {
		return fmt.Errorf("DAP message exceeds %d bytes", s.maxBytes)
	}
	select {
	case <-s.stopping:
		return fmt.Errorf("DAP session is stopping")
	default:
	}
	s.Touch()
	return s.writer.Write(payload)
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
		if s.Context.Release != nil {
			s.Context.Release()
		}
		close(s.resourcesDone)
	})
}

func (s *Session) readLoop() {
	defer func() {
		s.Stop()
		_ = s.process.Stdout().Close()
		waitDone := make(chan struct{})
		go func() {
			_ = s.process.Wait()
			close(waitDone)
		}()
		select {
		case <-waitDone:
		case <-time.After(5 * time.Second):
			_ = s.process.Kill()
			select {
			case <-waitDone:
			case <-time.After(2 * time.Second):
			}
		}
		s.releaseResources()
		close(s.messages)
		close(s.done)
		if s.onClose != nil {
			s.onClose(s)
		}
	}()
	reader := bufio.NewReader(s.process.Stdout())
	for {
		payload, err := ReadFrame(reader, s.maxBytes)
		if err != nil {
			select {
			case <-s.stopping:
			default:
				s.setTerminalError(fmt.Errorf("read debug adapter DAP stream: %w", err))
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
	catalog   *Catalog
	starter   ProcessStarter
	opts      ManagerOptions
	inspector ImageInspector
	ctx       context.Context
	cancel    context.CancelFunc

	mu             sync.Mutex
	sessions       map[string]*Session
	starting       int
	startingByUser map[string]int
	startingKeys   map[string]struct{}
}

func NewManager(catalog *Catalog, starter ProcessStarter, opts ManagerOptions) *Manager {
	if starter == nil {
		starter = ExecStarter{}
	}
	if opts.MaxSessions <= 0 {
		opts.MaxSessions = 1
	}
	if opts.MaxPerUser <= 0 {
		opts.MaxPerUser = 1
	}
	if opts.IdleTTL <= 0 {
		opts.IdleTTL = 15 * time.Minute
	}
	if opts.MaxSession <= 0 {
		opts.MaxSession = time.Hour
	}
	if opts.CleanupInterval <= 0 {
		opts.CleanupInterval = 30 * time.Second
	}
	if opts.MaxMessageBytes <= 0 {
		opts.MaxMessageBytes = 1 << 20
	}
	inspector := opts.Inspector
	if inspector == nil {
		inspector = &DockerImageInspector{TTL: 30 * time.Second}
	}
	ctx, cancel := context.WithCancel(context.Background())
	manager := &Manager{catalog: catalog, starter: starter, opts: opts, inspector: inspector, ctx: ctx, cancel: cancel, sessions: make(map[string]*Session), startingByUser: make(map[string]int), startingKeys: make(map[string]struct{})}
	go manager.cleanupLoop()
	return manager
}

func (m *Manager) CatalogVersion() string {
	if m == nil || m.catalog == nil {
		return CatalogVersion
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

func (m *Manager) Capabilities(ctx context.Context) []Capability {
	if m == nil || m.catalog == nil {
		return []Capability{}
	}
	return m.catalog.Capabilities(ctx, m.inspector)
}

func randomID() string {
	value := make([]byte, 12)
	_, _ = rand.Read(value)
	return hex.EncodeToString(value)
}

func (m *Manager) reserve(userID, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.sessions[key]; exists {
		return fmt.Errorf("a debug session is already active for this workspace")
	}
	if _, exists := m.startingKeys[key]; exists {
		return fmt.Errorf("a debug session is already starting for this workspace")
	}
	if len(m.sessions)+m.starting >= m.opts.MaxSessions {
		return fmt.Errorf("global debug session limit reached")
	}
	count := m.startingByUser[userID]
	for _, session := range m.sessions {
		if session.Context.UserID == userID {
			count++
		}
	}
	if count >= m.opts.MaxPerUser {
		return fmt.Errorf("user debug session limit reached")
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

func (m *Manager) Start(sessionContext SessionContext) (*Session, error) {
	if m == nil || m.catalog == nil {
		return nil, fmt.Errorf("remote debugging is disabled")
	}
	sessionContext.UserID = strings.TrimSpace(sessionContext.UserID)
	sessionContext.RuntimeID = strings.TrimSpace(sessionContext.RuntimeID)
	sessionContext.LanguageID = normalizeLanguage(sessionContext.LanguageID)
	sessionContext.RemoteRoot = strings.TrimSpace(sessionContext.RemoteRoot)
	if sessionContext.UserID == "" || sessionContext.RemoteRoot == "" || sessionContext.RuntimeID == "" || sessionContext.LanguageID == "" {
		return nil, fmt.Errorf("debug session identity, workspace, runtime, and language are required")
	}
	spec, ok := m.catalog.Lookup(sessionContext.LanguageID, sessionContext.RuntimeID)
	if !ok {
		return nil, fmt.Errorf("no managed debug adapter is configured for %s on %s", sessionContext.LanguageID, sessionContext.RuntimeID)
	}
	available, reason := m.inspector.Available(m.ctx, spec.Image)
	if !available {
		if reason == "" {
			reason = "managed debug adapter image is not installed"
		}
		return nil, fmt.Errorf("debug adapter unavailable: %s", reason)
	}
	absoluteRoot, err := filepath.Abs(sessionContext.RemoteRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve debug workspace: %w", err)
	}
	sessionContext.RemoteRoot = absoluteRoot
	key := sessionContext.WorkspaceKey()
	if err := m.reserve(sessionContext.UserID, key); err != nil {
		return nil, err
	}
	defer m.finishReservation(sessionContext.UserID, key)

	processParent := sessionContext.ProcessContext
	if processParent == nil {
		processParent = m.ctx
	}
	processCtx, timeoutCancel := context.WithTimeout(processParent, m.opts.MaxSession)
	stopManagerCancellation := context.AfterFunc(m.ctx, timeoutCancel)
	cancel := func() {
		stopManagerCancellation()
		timeoutCancel()
	}
	id := randomID()
	dependencyEnv := make(map[string]string, len(sessionContext.DependencyEnv))
	for key, value := range sessionContext.DependencyEnv {
		dependencyEnv[key] = value
	}
	process, err := m.starter.Start(processCtx, LaunchSpec{
		SessionID: id, UserID: sessionContext.UserID, Workspace: sessionContext.RemoteRoot,
		PersistDir: sessionContext.PersistDir, DependencyRoot: sessionContext.DependencyRoot,
		DependencyEnv: dependencyEnv, Adapter: spec, MemoryLimit: m.opts.MemoryLimit,
		CPULimit: m.opts.CPULimit, NetworkEnable: m.opts.NetworkEnable,
	})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("start managed debug adapter: %w", err)
	}
	session := &Session{ID: id, Key: key, Context: sessionContext, Adapter: spec, messages: make(chan []byte, 32), done: make(chan struct{}), resourcesDone: make(chan struct{}), stopping: make(chan struct{}), process: process, writer: NewLockedFrameWriter(process.Stdin()), cancel: cancel, maxBytes: m.opts.MaxMessageBytes, created: time.Now()}
	session.Touch()
	session.onClose = m.remove
	m.mu.Lock()
	if _, exists := m.sessions[key]; exists {
		m.mu.Unlock()
		go session.readLoop()
		session.Stop()
		<-session.Done()
		return nil, fmt.Errorf("a debug session became active while starting")
	}
	m.sessions[key] = session
	m.mu.Unlock()
	go session.readLoop()
	go func() {
		select {
		case <-processCtx.Done():
			session.Stop()
		case <-session.Done():
		}
	}()
	return session, nil
}

func (m *Manager) remove(session *Session) {
	m.mu.Lock()
	if m.sessions[session.Key] == session {
		delete(m.sessions, session.Key)
	}
	m.mu.Unlock()
}

func (m *Manager) snapshot(match func(*Session) bool) []*Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]*Session, 0)
	for _, session := range m.sessions {
		if match == nil || match(session) {
			result = append(result, session)
		}
	}
	return result
}

func stopAndWait(sessions []*Session, timeout time.Duration) error {
	for _, session := range sessions {
		session.Stop()
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for _, session := range sessions {
		select {
		case <-session.ResourcesDone():
		case <-deadline.C:
			return fmt.Errorf("timed out waiting for debug session resources to stop")
		}
	}
	return nil
}

func (m *Manager) StopUser(userID string) error {
	if m == nil {
		return nil
	}
	return stopAndWait(m.snapshot(func(session *Session) bool { return session.Context.UserID == userID }), 7*time.Second)
}

func (m *Manager) StopUserWorkspace(userID, folderKey string) error {
	if m == nil {
		return nil
	}
	userID = strings.TrimSpace(userID)
	folderKey = strings.TrimSpace(folderKey)
	return stopAndWait(m.snapshot(func(session *Session) bool {
		return session.Context.TeamID == "" && session.Context.UserID == userID && session.Context.FolderKey == folderKey
	}), 7*time.Second)
}

func (m *Manager) StopUserOwner(userID, ownerKind, ownerID string) error {
	if m == nil {
		return nil
	}
	return stopAndWait(m.snapshot(func(session *Session) bool {
		kind, id := session.Context.Owner()
		return session.Context.UserID == userID && kind == ownerKind && id == ownerID
	}), 7*time.Second)
}

func (m *Manager) cleanupLoop() {
	ticker := time.NewTicker(m.opts.CleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case now := <-ticker.C:
			for _, session := range m.snapshot(nil) {
				if now.Sub(session.LastUsed()) > m.opts.IdleTTL || now.Sub(session.created) > m.opts.MaxSession {
					session.Stop()
				}
			}
		}
	}
}

func (m *Manager) Close() {
	if m == nil {
		return
	}
	m.cancel()
	_ = stopAndWait(m.snapshot(nil), 7*time.Second)
}
