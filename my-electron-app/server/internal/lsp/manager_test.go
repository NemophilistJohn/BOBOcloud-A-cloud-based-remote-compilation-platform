package lsp

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type testProcess struct {
	stdinR  *io.PipeReader
	stdinW  *io.PipeWriter
	stdoutR *io.PipeReader
	stdoutW *io.PipeWriter
	done    chan struct{}
	once    sync.Once
	killed  atomic.Bool
}

type drainingTestProcess struct {
	*testProcess
	waitRelease chan struct{}
}

func newDrainingTestProcess() *drainingTestProcess {
	return &drainingTestProcess{testProcess: newTestProcess(), waitRelease: make(chan struct{})}
}

func (p *drainingTestProcess) Wait() error {
	<-p.waitRelease
	return nil
}

func (p *drainingTestProcess) Kill() error {
	p.killed.Store(true)
	_ = p.stdoutW.Close()
	return nil
}

func newTestProcess() *testProcess {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	p := &testProcess{stdinR: stdinR, stdinW: stdinW, stdoutR: stdoutR, stdoutW: stdoutW, done: make(chan struct{})}
	go io.Copy(io.Discard, stdinR)
	return p
}

func (p *testProcess) Stdin() io.WriteCloser { return p.stdinW }
func (p *testProcess) Stdout() io.ReadCloser { return p.stdoutR }
func (p *testProcess) Wait() error           { <-p.done; return nil }
func (p *testProcess) exit() {
	p.once.Do(func() {
		_ = p.stdinW.Close()
		_ = p.stdinR.Close()
		_ = p.stdoutW.Close()
		close(p.done)
	})
}
func (p *testProcess) Kill() error {
	p.killed.Store(true)
	p.exit()
	return nil
}

type captureStarter struct{ launches chan LaunchSpec }

type blockingFirstStarter struct {
	entered chan struct{}
	release chan struct{}
	calls   atomic.Int32
}

func (starter *blockingFirstStarter) Start(_ context.Context, _ LaunchSpec) (Process, error) {
	if starter.calls.Add(1) == 1 {
		close(starter.entered)
		<-starter.release
	}
	return newTestProcess(), nil
}

type manualDependencyRefreshTimer struct {
	mu       sync.Mutex
	callback func()
	stopped  bool
	fired    bool
}

func (timer *manualDependencyRefreshTimer) Stop() bool {
	timer.mu.Lock()
	defer timer.mu.Unlock()
	if timer.stopped || timer.fired {
		return false
	}
	timer.stopped = true
	return true
}

func (timer *manualDependencyRefreshTimer) fire() bool {
	timer.mu.Lock()
	if timer.stopped || timer.fired {
		timer.mu.Unlock()
		return false
	}
	timer.fired = true
	callback := timer.callback
	timer.mu.Unlock()
	callback()
	return true
}

type manualDependencyRefreshScheduler struct {
	mu     sync.Mutex
	timers []*manualDependencyRefreshTimer
}

func (scheduler *manualDependencyRefreshScheduler) after(_ time.Duration, callback func()) dependencyRefreshTimer {
	timer := &manualDependencyRefreshTimer{callback: callback}
	scheduler.mu.Lock()
	scheduler.timers = append(scheduler.timers, timer)
	scheduler.mu.Unlock()
	return timer
}

func (scheduler *manualDependencyRefreshScheduler) timer(t *testing.T, index int) *manualDependencyRefreshTimer {
	t.Helper()
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	if index >= len(scheduler.timers) {
		t.Fatalf("dependency refresh timer %d was not scheduled; have %d", index, len(scheduler.timers))
	}
	return scheduler.timers[index]
}

func newDependencyRefreshTestManager(t *testing.T) (*Manager, *manualDependencyRefreshScheduler) {
	t.Helper()
	manager := NewManager(nil, nil, nil, ManagerOptions{CleanupInterval: time.Hour})
	scheduler := &manualDependencyRefreshScheduler{}
	manager.refreshAfter = scheduler.after
	manager.refreshDelay = 500 * time.Millisecond
	t.Cleanup(manager.Close)
	return manager, scheduler
}

func dependencyRefreshStateCount(manager *Manager) int {
	manager.refreshMu.Lock()
	defer manager.refreshMu.Unlock()
	return len(manager.refreshing)
}

func TestSessionNaturalExitDoesNotForceKillProcess(t *testing.T) {
	process := newTestProcess()
	_, cancel := context.WithCancel(context.Background())
	session := &Session{
		messages: make(chan []byte, 1),
		done:     make(chan struct{}),
		stopping: make(chan struct{}),
		process:  process,
		writer:   lockedWriter{w: process.Stdin()},
		cancel:   cancel,
		maxBytes: 1 << 20,
	}
	go session.readLoop()
	process.exit()
	select {
	case <-session.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("naturally exited session did not finish")
	}
	session.Stop()
	if process.killed.Load() {
		t.Fatal("naturally exited language server was force-killed")
	}
}

func TestStopUserKeepsDrainingSessionUntilResourcesRelease(t *testing.T) {
	process := newDrainingTestProcess()
	_, cancel := context.WithCancel(context.Background())
	manager := NewManager(nil, nil, nil, ManagerOptions{CleanupInterval: time.Hour})
	manager.resourceWait = 50 * time.Millisecond
	defer manager.Close()
	var released atomic.Bool
	session := &Session{
		Key: "draining", Context: SessionContext{UserID: "user-1", WorkspaceKind: "personal"},
		messages: make(chan []byte, 1), done: make(chan struct{}), resourcesDone: make(chan struct{}),
		stopping: make(chan struct{}), process: process, writer: lockedWriter{w: process.Stdin()}, cancel: cancel,
		sharedRelease: func() { released.Store(true) }, maxBytes: 1 << 20,
	}
	session.onClose = manager.remove
	manager.mu.Lock()
	manager.sessions[session.Key] = session
	manager.mu.Unlock()
	go session.readLoop()

	if err := manager.StopUser("user-1"); err == nil {
		t.Fatal("StopUser succeeded before the analyzer released its resources")
	}
	if released.Load() {
		t.Fatal("dependency resources were released before Process.Wait completed")
	}
	manager.mu.Lock()
	_, stillTracked := manager.sessions[session.Key]
	manager.mu.Unlock()
	if !stillTracked {
		t.Fatal("draining session was removed before its resources were released")
	}

	close(process.waitRelease)
	select {
	case <-session.ResourcesDone():
	case <-time.After(2 * time.Second):
		t.Fatal("resources were not released after Process.Wait completed")
	}
	if !released.Load() {
		t.Fatal("dependency release callback was not invoked")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		manager.mu.Lock()
		_, stillTracked = manager.sessions[session.Key]
		manager.mu.Unlock()
		if !stillTracked {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("drained session remained registered")
}

func (s *captureStarter) Start(_ context.Context, spec LaunchSpec) (Process, error) {
	s.launches <- spec
	return newTestProcess(), nil
}

func TestManagerPrefersManifestAnalyzerImageForLocalRuntime(t *testing.T) {
	catalog, err := NewCatalog(Manifest{Version: 1, Servers: []ServerSpec{{LanguageID: "rust", Command: []string{"rust-analyzer"}, Docker: DockerSpec{Image: "bobocloud/analyzer-rust:test", Command: []string{"rust-analyzer"}}}}})
	if err != nil {
		t.Fatal(err)
	}
	starter := &captureStarter{launches: make(chan LaunchSpec, 1)}
	manager := NewManager(catalog, NewCacheManager(t.TempDir(), 16, 7), starter, ManagerOptions{CleanupInterval: time.Hour})
	defer manager.Close()
	session, err := manager.Start(SessionContext{UserID: "u1", WorkspaceKind: "personal", FolderKey: "project", RuntimeID: "local", LanguageID: "rust", Mode: ModeStandard, RemoteRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	launch := <-starter.launches
	if !launch.Docker || launch.Server.Docker.Image != "bobocloud/analyzer-rust:test" {
		t.Fatalf("dedicated analyzer image was not preferred: %+v", launch)
	}
	if session.URIMapper() == nil || session.URIMapper().RootURI() != "file:///workspace" {
		t.Fatalf("Docker session did not use the analyzer mount root: %+v", session.URIMapper())
	}
	session.Stop()
	select {
	case <-session.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("session did not stop")
	}
}

func TestManagerUsesHostCommandWhenLocalManifestHasNoImage(t *testing.T) {
	catalog, _ := NewCatalog(Manifest{Version: 1, Servers: []ServerSpec{{LanguageID: "go", Command: []string{"gopls"}}}})
	starter := &captureStarter{launches: make(chan LaunchSpec, 1)}
	manager := NewManager(catalog, NewCacheManager(t.TempDir(), 16, 7), starter, ManagerOptions{CleanupInterval: time.Hour})
	defer manager.Close()
	session, err := manager.Start(SessionContext{UserID: "u1", WorkspaceKind: "personal", FolderKey: "project", RuntimeID: "local", LanguageID: "go", Mode: ModeStandard, RemoteRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if launch := <-starter.launches; launch.Docker {
		t.Fatal("host-only manifest unexpectedly used Docker")
	}
	if session.URIMapper() == nil || session.URIMapper().RootURI() == "file:///workspace" {
		t.Fatal("host session unexpectedly used the Docker workspace mapper")
	}
	session.Stop()
	<-session.Done()
}

func TestManagerRejectsUserDependencyMountsForHostAnalyzer(t *testing.T) {
	catalog, _ := NewCatalog(Manifest{Version: 1, Servers: []ServerSpec{{LanguageID: "python", Command: []string{"pyright-langserver", "--stdio"}}}})
	starter := &captureStarter{launches: make(chan LaunchSpec, 1)}
	manager := NewManager(catalog, NewCacheManager(t.TempDir(), 16, 7), starter, ManagerOptions{CleanupInterval: time.Hour})
	defer manager.Close()
	_, err := manager.Start(SessionContext{
		UserID: "u1", WorkspaceKind: "personal", FolderKey: "project", RuntimeID: "local", LanguageID: "python", Mode: ModeStandard,
		RemoteRoot: t.TempDir(), DependencyView: AnalysisDependencyView{Mounts: []AnalysisDependencyMount{{HostPath: t.TempDir(), ContainerPath: pythonLegacyPackagesContainer, ReadOnly: true}}},
	})
	if err == nil {
		t.Fatal("host analyzer accepted a user-controlled dependency mount")
	}
	select {
	case <-starter.launches:
		t.Fatal("host analyzer process started before dependency isolation rejection")
	default:
	}
}

func TestManagerRejectsDuplicateSessionWhileFirstStartIsPending(t *testing.T) {
	workspace := t.TempDir()
	lockPath := filepath.Join(workspace, "package-lock.json")
	if err := os.WriteFile(lockPath, []byte(`{"lockfileVersion":2}`), 0600); err != nil {
		t.Fatal(err)
	}
	catalog, err := NewCatalog(Manifest{Version: 1, Servers: []ServerSpec{{LanguageID: "node", Command: []string{"typescript-language-server", "--stdio"}}}})
	if err != nil {
		t.Fatal(err)
	}
	starter := &blockingFirstStarter{entered: make(chan struct{}), release: make(chan struct{})}
	manager := NewManager(catalog, NewCacheManager(t.TempDir(), 16, 7), starter, ManagerOptions{MaxSessions: 4, MaxPerUser: 4, CleanupInterval: time.Hour})
	defer manager.Close()
	context := SessionContext{UserID: "u1", WorkspaceKind: "personal", FolderKey: "project", RuntimeID: "local", LanguageID: "node", Mode: ModeStandard, RemoteRoot: workspace}
	firstResult := make(chan struct {
		session *Session
		err     error
	}, 1)
	go func() {
		session, startErr := manager.Start(context)
		firstResult <- struct {
			session *Session
			err     error
		}{session: session, err: startErr}
	}()
	<-starter.entered
	if err := os.WriteFile(lockPath, []byte(`{"lockfileVersion":3,"changed":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	if session, err := manager.Start(context); err == nil {
		if session != nil {
			session.Stop()
		}
		t.Fatal("duplicate session started while the same key was reserved")
	}
	if calls := starter.calls.Load(); calls != 1 {
		t.Fatalf("process starter calls = %d, want 1", calls)
	}
	close(starter.release)
	first := <-firstResult
	if first.err != nil {
		t.Fatal(first.err)
	}
	first.session.Stop()
	select {
	case <-first.session.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("first session did not stop")
	}
}

func TestManagerRefreshesOnlyChangedDependencyViews(t *testing.T) {
	root := t.TempDir()
	persist := makeDependencyDir(t, filepath.Join(root, "persist"))
	packages := makeDependencyDir(t, filepath.Join(persist, "pip-packages"))
	registry := NewDefaultDependencyRegistry()
	request := personalDependencyRequest(root, "python", "python:3.10")
	view, err := registry.Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	catalog, _ := NewCatalog(Manifest{Version: 1, Servers: []ServerSpec{{LanguageID: "python", Command: []string{"pyright-langserver", "--stdio"}}}})
	starter := &captureStarter{launches: make(chan LaunchSpec, 1)}
	manager := NewManager(catalog, NewCacheManager(t.TempDir(), 16, 7), starter, ManagerOptions{CleanupInterval: time.Hour})
	defer manager.Close()
	session, err := manager.Start(SessionContext{
		UserID: "user-1", WorkspaceKind: "personal", FolderKey: "project",
		RuntimeID: "python:3.10", LanguageID: "python", Mode: ModeStandard,
		RemoteRoot: t.TempDir(), DependencyRequest: request, DependencyView: view,
		DependencyResolved: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	<-starter.launches
	if restarted := manager.RefreshDependencyViews(registry, DependencyRefreshScope{UserID: "other"}); restarted != 0 {
		t.Fatalf("unrelated user restarted %d sessions", restarted)
	}
	if err := os.Mkdir(filepath.Join(packages, "numpy"), 0755); err != nil {
		t.Fatal(err)
	}
	if restarted := manager.RefreshDependencyViews(registry, DependencyRefreshScope{UserID: "user-1", RuntimeID: "python:3.10"}); restarted != 1 {
		t.Fatalf("changed dependency view restarted %d sessions", restarted)
	}
	status, ok := session.DependencyRestartStatus()
	if !ok || status.Revision == view.Revision || status.Status != "mixed" {
		t.Fatalf("missing dependency restart status: %+v, present=%v", status, ok)
	}
	select {
	case <-session.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("dependency refresh did not stop the old analyzer")
	}
}

type recordingDependencyAdapter struct {
	mu         sync.Mutex
	workspaces []string
}

func (adapter *recordingDependencyAdapter) Name() string        { return "recording-python" }
func (adapter *recordingDependencyAdapter) Languages() []string { return []string{"python"} }
func (adapter *recordingDependencyAdapter) Resolve(context DependencyAdapterContext) (DependencyAdapterResult, error) {
	adapter.mu.Lock()
	adapter.workspaces = append(adapter.workspaces, context.WorkspaceID)
	adapter.mu.Unlock()
	return DependencyAdapterResult{}, nil
}

func (adapter *recordingDependencyAdapter) reset() {
	adapter.mu.Lock()
	adapter.workspaces = nil
	adapter.mu.Unlock()
}

func (adapter *recordingDependencyAdapter) resolvedWorkspaces() []string {
	adapter.mu.Lock()
	defer adapter.mu.Unlock()
	return append([]string(nil), adapter.workspaces...)
}

func TestManagerDependencyRefreshMatchesProjectAndResolvesIdenticalRequestOnce(t *testing.T) {
	adapter := &recordingDependencyAdapter{}
	registry, err := NewDependencyRegistry(adapter)
	if err != nil {
		t.Fatal(err)
	}
	request := AnalysisDependencyRequest{
		OwnerKind: "team", OwnerID: "team-1", UserID: "user-1", WorkspaceID: "workspace-a",
		RuntimeID: "python:3.10", LanguageID: "python",
	}
	view, err := registry.Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	otherRequest := request
	otherRequest.WorkspaceID = "workspace-b"
	otherView, err := registry.Resolve(otherRequest)
	if err != nil {
		t.Fatal(err)
	}
	adapter.reset()

	manager := &Manager{sessions: map[string]*Session{
		"project-a-standard": {Context: SessionContext{
			UserID: "user-1", WorkspaceKind: "team", TeamID: "team-1", ProjectID: "project-a", Branch: "main",
			RuntimeID: "python:3.10", LanguageID: "python", DependencyRequest: request, DependencyView: view, DependencyResolved: true,
		}},
		"project-a-full": {Context: SessionContext{
			UserID: "user-1", WorkspaceKind: "team", TeamID: "team-1", ProjectID: "project-a", Branch: "main",
			RuntimeID: "python:3.10", LanguageID: "python", DependencyRequest: request, DependencyView: view, DependencyResolved: true,
		}},
		"project-b": {Context: SessionContext{
			UserID: "user-1", WorkspaceKind: "team", TeamID: "team-1", ProjectID: "project-b", Branch: "main",
			RuntimeID: "python:3.10", LanguageID: "python", DependencyRequest: otherRequest, DependencyView: otherView, DependencyResolved: true,
		}},
	}}
	restarted := manager.refreshDependencyViewsOnce(registry, DependencyRefreshScope{
		OwnerKind: "team", OwnerID: "team-1", ProjectID: "project-a", Branch: "main",
		RuntimeID: "python:3.10", LanguageID: "python",
	})
	if restarted != 0 {
		t.Fatalf("unchanged dependency view restarted %d sessions", restarted)
	}
	if workspaces := adapter.resolvedWorkspaces(); len(workspaces) != 1 || workspaces[0] != "workspace-a" {
		t.Fatalf("resolved workspaces = %v, want one project-a request", workspaces)
	}
}

func TestManagerFallbackRefreshUsesDeduplicatedActiveScopes(t *testing.T) {
	manager, _ := newDependencyRefreshTestManager(t)
	manager.mu.Lock()
	manager.sessions = map[string]*Session{
		"team-member-a":  {Context: SessionContext{UserID: "user-a", WorkspaceKind: "team", TeamID: "team-1", ProjectID: "project-a", Branch: "main", RuntimeID: "python:3.10", LanguageID: "python"}},
		"team-member-b":  {Context: SessionContext{UserID: "user-b", WorkspaceKind: "team", TeamID: "team-1", ProjectID: "project-a", Branch: "main", RuntimeID: "python:3.10", LanguageID: "python"}},
		"team-project-b": {Context: SessionContext{UserID: "user-a", WorkspaceKind: "team", TeamID: "team-1", ProjectID: "project-b", Branch: "main", RuntimeID: "python:3.10", LanguageID: "python"}},
		"personal":       {Context: SessionContext{UserID: "user-a", WorkspaceKind: "personal", FolderKey: "folder-a", RuntimeID: "go:1.22", LanguageID: "go"}},
	}
	manager.mu.Unlock()

	var mu sync.Mutex
	var scanned []DependencyRefreshScope
	manager.refreshScan = func(_ *DependencyRegistry, scope DependencyRefreshScope) int {
		mu.Lock()
		scanned = append(scanned, scope)
		mu.Unlock()
		return 0
	}
	manager.refreshActiveDependencyScopes(NewDefaultDependencyRegistry())
	manager.mu.Lock()
	manager.sessions = make(map[string]*Session)
	manager.mu.Unlock()

	mu.Lock()
	defer mu.Unlock()
	if len(scanned) != 3 {
		t.Fatalf("fallback scanned %d scopes, want 3: %+v", len(scanned), scanned)
	}
	seen := make(map[string]DependencyRefreshScope, len(scanned))
	for _, scope := range scanned {
		if scope.OwnerKind == "" || scope.OwnerID == "" || scope.RuntimeID == "" || scope.LanguageID == "" {
			t.Fatalf("fallback emitted an empty/global scope: %+v", scope)
		}
		seen[scope.key()] = scope
	}
	if len(seen) != len(scanned) {
		t.Fatalf("fallback emitted duplicate scopes: %+v", scanned)
	}
	teamProjects := make(map[string]bool)
	for _, scope := range scanned {
		if scope.OwnerKind == "team" {
			if scope.UserID != "" {
				t.Fatalf("team fallback scope was member-specific: %+v", scope)
			}
			teamProjects[scope.ProjectID] = true
		}
	}
	if !teamProjects["project-a"] || !teamProjects["project-b"] {
		t.Fatalf("fallback team projects = %v", teamProjects)
	}
}

func TestManagerDependencyFallbackDefaultsAreLowFrequencyAndJittered(t *testing.T) {
	manager := NewManager(nil, nil, nil, ManagerOptions{
		CleanupInterval:    time.Hour,
		DependencyRegistry: NewDefaultDependencyRegistry(),
	})
	defer manager.Close()
	if manager.opts.DependencyPollInterval != 15*time.Minute || manager.opts.DependencyPollJitter != 3*time.Minute {
		t.Fatalf("dependency fallback defaults = %s +/- %s", manager.opts.DependencyPollInterval, manager.opts.DependencyPollJitter)
	}
	for range 64 {
		delay := dependencyPollDelay(manager.opts.DependencyPollInterval, manager.opts.DependencyPollJitter)
		if delay < 12*time.Minute || delay > 18*time.Minute {
			t.Fatalf("dependency fallback delay %s is outside jitter bounds", delay)
		}
	}
}

func TestManagerDependencyRefreshKeepsCooldownChangesForOneTrailingScan(t *testing.T) {
	manager, scheduler := newDependencyRefreshTestManager(t)
	registry := NewDefaultDependencyRegistry()
	scope := DependencyRefreshScope{UserID: "user-1", RuntimeID: "python:3.10", LanguageID: "python"}
	var scans atomic.Int32
	manager.refreshScan = func(*DependencyRegistry, DependencyRefreshScope) int {
		return int(scans.Add(1))
	}

	if restarted := manager.RefreshDependencyViews(registry, scope); restarted != 1 {
		t.Fatalf("initial refresh returned %d", restarted)
	}
	if restarted := manager.RefreshDependencyViews(registry, scope); restarted != 0 {
		t.Fatalf("cooldown refresh returned %d", restarted)
	}
	if scans.Load() != 1 {
		t.Fatalf("cooldown trigger ran an immediate scan: %d", scans.Load())
	}
	if !scheduler.timer(t, 0).fire() {
		t.Fatal("cooldown timer did not fire")
	}
	if scans.Load() != 2 {
		t.Fatalf("dirty cooldown state ran %d total scans, want 2", scans.Load())
	}
	if !scheduler.timer(t, 1).fire() {
		t.Fatal("trailing scan cleanup timer did not fire")
	}
	if states := dependencyRefreshStateCount(manager); states != 0 {
		t.Fatalf("idle refresh state count = %d, want 0", states)
	}
}

func TestManagerDependencyRefreshCoalescesConcurrentTriggers(t *testing.T) {
	manager, scheduler := newDependencyRefreshTestManager(t)
	registry := NewDefaultDependencyRegistry()
	scope := DependencyRefreshScope{OwnerKind: "team", OwnerID: "team-1", LanguageID: "go"}
	entered := make(chan struct{})
	release := make(chan struct{})
	var scans atomic.Int32
	manager.refreshScan = func(*DependencyRegistry, DependencyRefreshScope) int {
		if scans.Add(1) == 1 {
			close(entered)
			<-release
		}
		return 0
	}
	firstDone := make(chan struct{})
	go func() {
		manager.RefreshDependencyViews(registry, scope)
		close(firstDone)
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("initial dependency scan did not start")
	}

	const concurrentTriggers = 16
	var callers sync.WaitGroup
	callers.Add(concurrentTriggers)
	for range concurrentTriggers {
		go func() {
			defer callers.Done()
			if restarted := manager.RefreshDependencyViews(registry, scope); restarted != 0 {
				t.Errorf("coalesced refresh returned %d", restarted)
			}
		}()
	}
	callers.Wait()
	close(release)
	select {
	case <-firstDone:
	case <-time.After(2 * time.Second):
		t.Fatal("initial dependency scan did not finish")
	}
	if scans.Load() != 1 {
		t.Fatalf("concurrent triggers ran %d immediate scans", scans.Load())
	}
	if !scheduler.timer(t, 0).fire() {
		t.Fatal("coalesced trailing timer did not fire")
	}
	if scans.Load() != 2 {
		t.Fatalf("concurrent triggers ran %d total scans, want 2", scans.Load())
	}
	if !scheduler.timer(t, 1).fire() {
		t.Fatal("coalesced refresh cleanup timer did not fire")
	}
}

func TestManagerDependencyRefreshCleansIdleScopeState(t *testing.T) {
	manager, scheduler := newDependencyRefreshTestManager(t)
	registry := NewDefaultDependencyRegistry()
	var scans atomic.Int32
	manager.refreshScan = func(*DependencyRegistry, DependencyRefreshScope) int {
		scans.Add(1)
		return 0
	}

	manager.RefreshDependencyViews(registry, DependencyRefreshScope{UserID: "idle-user"})
	if states := dependencyRefreshStateCount(manager); states != 1 {
		t.Fatalf("active refresh state count = %d, want 1", states)
	}
	if !scheduler.timer(t, 0).fire() {
		t.Fatal("idle cleanup timer did not fire")
	}
	if states := dependencyRefreshStateCount(manager); states != 0 {
		t.Fatalf("idle refresh state count = %d, want 0", states)
	}
	manager.RefreshDependencyViews(registry, DependencyRefreshScope{UserID: "idle-user"})
	if scans.Load() != 2 {
		t.Fatalf("cleaned scope did not admit a new scan: %d", scans.Load())
	}
}

func TestManagerCloseCancelsDependencyRefreshTimers(t *testing.T) {
	manager, scheduler := newDependencyRefreshTestManager(t)
	registry := NewDefaultDependencyRegistry()
	var scans atomic.Int32
	manager.refreshScan = func(*DependencyRegistry, DependencyRefreshScope) int {
		scans.Add(1)
		return 0
	}
	manager.RefreshDependencyViews(registry, DependencyRefreshScope{UserID: "closing-user"})
	timer := scheduler.timer(t, 0)
	manager.Close()
	if timer.fire() {
		t.Fatal("dependency refresh timer fired after manager close")
	}
	if states := dependencyRefreshStateCount(manager); states != 0 {
		t.Fatalf("closed manager retained %d refresh states", states)
	}
	if restarted := manager.RefreshDependencyViews(registry, DependencyRefreshScope{UserID: "closing-user"}); restarted != 0 {
		t.Fatalf("closed manager returned %d restarted sessions", restarted)
	}
	if scans.Load() != 1 {
		t.Fatalf("closed manager ran %d dependency scans", scans.Load())
	}
}

func TestManagerCloseWaitsForInFlightDependencyRefresh(t *testing.T) {
	manager, _ := newDependencyRefreshTestManager(t)
	registry := NewDefaultDependencyRegistry()
	entered := make(chan struct{})
	release := make(chan struct{})
	refreshDone := make(chan struct{})
	var releaseOnce sync.Once
	releaseScan := func() {
		releaseOnce.Do(func() { close(release) })
	}
	defer releaseScan()
	manager.refreshScan = func(*DependencyRegistry, DependencyRefreshScope) int {
		close(entered)
		<-release
		return 0
	}

	go func() {
		defer close(refreshDone)
		manager.RefreshDependencyViews(registry, DependencyRefreshScope{UserID: "closing-user"})
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("dependency refresh did not start")
	}

	closeDone := make(chan struct{})
	go func() {
		manager.Close()
		close(closeDone)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		manager.refreshMu.Lock()
		closed := manager.refreshClosed
		manager.refreshMu.Unlock()
		if closed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("manager close did not enter dependency shutdown")
		}
		runtime.Gosched()
	}
	select {
	case <-closeDone:
		t.Fatal("manager close returned while a dependency refresh was still running")
	default:
	}

	releaseScan()
	select {
	case <-refreshDone:
	case <-time.After(2 * time.Second):
		t.Fatal("dependency refresh did not finish")
	}
	select {
	case <-closeDone:
	case <-time.After(2 * time.Second):
		t.Fatal("manager close did not finish after dependency refresh completed")
	}
}
