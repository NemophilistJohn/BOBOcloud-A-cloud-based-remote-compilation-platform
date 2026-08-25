package dap

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"bobocloud-server/internal/personalcache"
)

type managerTestProcess struct {
	stdinR  *io.PipeReader
	stdinW  *io.PipeWriter
	stdoutR *io.PipeReader
	stdoutW *io.PipeWriter
	done    chan struct{}
	once    sync.Once
}

func newManagerTestProcess() *managerTestProcess {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	return &managerTestProcess{stdinR: stdinR, stdinW: stdinW, stdoutR: stdoutR, stdoutW: stdoutW, done: make(chan struct{})}
}

func (process *managerTestProcess) Stdin() io.WriteCloser { return process.stdinW }
func (process *managerTestProcess) Stdout() io.ReadCloser { return process.stdoutR }
func (process *managerTestProcess) Wait() error           { <-process.done; return nil }
func (process *managerTestProcess) Kill() error {
	process.once.Do(func() {
		_ = process.stdinR.Close()
		_ = process.stdinW.Close()
		_ = process.stdoutW.Close()
		close(process.done)
	})
	return nil
}

type managerTestStarter struct {
	mu        sync.Mutex
	launches  []LaunchSpec
	processes []*managerTestProcess
}

type drainingManagerTestProcess struct {
	*managerTestProcess
	waitRelease chan struct{}
	killCalls   atomic.Int32
}

func newDrainingManagerTestProcess() *drainingManagerTestProcess {
	return &drainingManagerTestProcess{
		managerTestProcess: newManagerTestProcess(),
		waitRelease:        make(chan struct{}),
	}
}

func (process *drainingManagerTestProcess) Wait() error {
	<-process.waitRelease
	return nil
}

func (process *drainingManagerTestProcess) Kill() error {
	process.killCalls.Add(1)
	_ = process.stdinR.Close()
	_ = process.stdinW.Close()
	_ = process.stdoutW.Close()
	return errors.New("kill failed")
}

type drainingManagerTestStarter struct {
	process *drainingManagerTestProcess
}

func (starter drainingManagerTestStarter) Start(_ context.Context, _ LaunchSpec) (Process, error) {
	return starter.process, nil
}

func (starter *managerTestStarter) Start(_ context.Context, spec LaunchSpec) (Process, error) {
	process := newManagerTestProcess()
	starter.mu.Lock()
	starter.launches = append(starter.launches, spec)
	starter.processes = append(starter.processes, process)
	starter.mu.Unlock()
	return process, nil
}

func (starter *managerTestStarter) process(index int) *managerTestProcess {
	starter.mu.Lock()
	defer starter.mu.Unlock()
	return starter.processes[index]
}

func (starter *managerTestStarter) launch(index int) LaunchSpec {
	starter.mu.Lock()
	defer starter.mu.Unlock()
	return starter.launches[index]
}

func managerTestCatalog() *Catalog {
	spec := AdapterSpec{
		ID: "python-debugpy", LanguageID: "python", RuntimeID: "python:3.11",
		Image: "bobocloud/dap-python:test", Command: []string{"adapter"}, SupportsLaunch: true,
	}
	return &Catalog{version: CatalogVersion, byKey: map[string]AdapterSpec{catalogKey(spec.LanguageID, spec.RuntimeID): spec}}
}

func managerTestContext(workspace string, release func()) SessionContext {
	return SessionContext{
		UserID: "user-a", WorkspaceKind: "personal", FolderKey: "project-a",
		RuntimeID: "python:3.11", LanguageID: "python", RemoteRoot: workspace, Release: release,
	}
}

func TestManagerRoutesFramesEnforcesLimitsAndReleases(t *testing.T) {
	starter := &managerTestStarter{}
	manager := NewManager(managerTestCatalog(), starter, ManagerOptions{
		MaxSessions: 1, MaxPerUser: 1, MaxMessageBytes: 1024,
		Inspector: catalogTestInspector{available: true},
	})
	t.Cleanup(manager.Close)
	var releases atomic.Int32
	session, err := manager.Start(managerTestContext(t.TempDir(), func() { releases.Add(1) }))
	if err != nil {
		t.Fatal(err)
	}
	process := starter.process(0)

	clientPayload := []byte(`{"seq":1,"type":"request","command":"initialize"}`)
	type frameResult struct {
		payload []byte
		err     error
	}
	framedResult := make(chan frameResult, 1)
	go func() {
		payload, readErr := ReadFrame(bufio.NewReader(process.stdinR), 1024)
		framedResult <- frameResult{payload: payload, err: readErr}
	}()
	if err := session.Send(clientPayload); err != nil {
		t.Fatal(err)
	}
	framed := <-framedResult
	if framed.err != nil || string(framed.payload) != string(clientPayload) {
		t.Fatalf("adapter input = %s, %v", framed.payload, framed.err)
	}
	adapterPayload := []byte(`{"seq":1,"type":"event","event":"initialized"}`)
	if err := WriteFrame(process.stdoutW, adapterPayload); err != nil {
		t.Fatal(err)
	}
	select {
	case received := <-session.Messages():
		if string(received) != string(adapterPayload) {
			t.Fatalf("client output = %s", received)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for adapter output")
	}

	other := managerTestContext(t.TempDir(), nil)
	other.UserID, other.FolderKey = "user-b", "project-b"
	if _, err := manager.Start(other); err == nil || !strings.Contains(err.Error(), "global debug session limit") {
		t.Fatalf("second session error = %v", err)
	}
	if err := manager.StopUser("user-a"); err != nil {
		t.Fatal(err)
	}
	if releases.Load() != 1 {
		t.Fatalf("release count = %d", releases.Load())
	}
	if err := session.Send(clientPayload); err == nil {
		t.Fatal("stopped session accepted another message")
	}
}

func TestDAPSessionKeepsResourcesAndRegistrationUntilProcessWaits(t *testing.T) {
	process := newDrainingManagerTestProcess()
	manager := NewManager(managerTestCatalog(), drainingManagerTestStarter{process: process}, ManagerOptions{
		Inspector:          catalogTestInspector{available: true},
		processWaitTimeout: 10 * time.Millisecond,
		killWaitTimeout:    10 * time.Millisecond,
	})
	var releases atomic.Int32
	session, err := manager.Start(managerTestContext(t.TempDir(), func() { releases.Add(1) }))
	if err != nil {
		manager.Close()
		t.Fatal(err)
	}
	session.Stop()
	select {
	case <-session.Done():
	case <-time.After(2 * time.Second):
		close(process.waitRelease)
		manager.Close()
		t.Fatal("DAP session did not finish its client-facing shutdown")
	}
	select {
	case <-session.ResourcesDone():
		close(process.waitRelease)
		manager.Close()
		t.Fatal("DAP resources were released before the process Wait completed")
	case <-time.After(50 * time.Millisecond):
	}
	if releases.Load() != 0 {
		close(process.waitRelease)
		manager.Close()
		t.Fatalf("upper release count before Wait = %d", releases.Load())
	}
	if process.killCalls.Load() < 2 {
		close(process.waitRelease)
		manager.Close()
		t.Fatalf("kill calls = %d, want initial stop plus timed retry", process.killCalls.Load())
	}
	if active := manager.snapshot(nil); len(active) != 1 || active[0] != session {
		close(process.waitRelease)
		manager.Close()
		t.Fatalf("draining DAP session was removed early: %+v", active)
	}

	close(process.waitRelease)
	select {
	case <-session.ResourcesDone():
	case <-time.After(2 * time.Second):
		manager.Close()
		t.Fatal("DAP resources were not released after process Wait completed")
	}
	if releases.Load() != 1 {
		manager.Close()
		t.Fatalf("upper release count after Wait = %d", releases.Load())
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(manager.snapshot(nil)) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if active := manager.snapshot(nil); len(active) != 0 {
		manager.Close()
		t.Fatalf("completed DAP session remained registered: %+v", active)
	}
	manager.Close()
}

func TestStopUserContextCancelsResourceDrainWait(t *testing.T) {
	process := newDrainingManagerTestProcess()
	manager := NewManager(managerTestCatalog(), drainingManagerTestStarter{process: process}, ManagerOptions{
		Inspector:          catalogTestInspector{available: true},
		processWaitTimeout: 10 * time.Millisecond,
		killWaitTimeout:    10 * time.Millisecond,
	})
	defer manager.Close()
	var releaseProcess sync.Once
	release := func() { releaseProcess.Do(func() { close(process.waitRelease) }) }
	defer release()

	session, err := manager.Start(managerTestContext(t.TempDir(), nil))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- manager.StopUserContext(ctx, "user-a") }()
	select {
	case <-session.Done():
	case <-time.After(time.Second):
		t.Fatal("StopUserContext did not stop the debug session")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("StopUserContext() error = %v, want context cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("StopUserContext ignored cancellation while resources were draining")
	}

	release()
	select {
	case <-session.ResourcesDone():
	case <-time.After(time.Second):
		t.Fatal("debug resources did not finish after releasing the process")
	}
}

func TestCloseContextWaitsForSessionResourcesAndCanRetry(t *testing.T) {
	process := newDrainingManagerTestProcess()
	manager := NewManager(managerTestCatalog(), drainingManagerTestStarter{process: process}, ManagerOptions{
		Inspector:          catalogTestInspector{available: true},
		processWaitTimeout: 10 * time.Millisecond,
		killWaitTimeout:    10 * time.Millisecond,
	})
	defer manager.Close()
	var releaseProcess sync.Once
	release := func() { releaseProcess.Do(func() { close(process.waitRelease) }) }
	defer release()

	var releases atomic.Int32
	_, err := manager.Start(managerTestContext(t.TempDir(), func() { releases.Add(1) }))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	err = manager.CloseContext(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("CloseContext() error = %v, want deadline exceeded", err)
	}
	if releases.Load() != 0 {
		t.Fatal("CloseContext released a debug lease before Process.Wait completed")
	}

	release()
	retryCtx, cancelRetry := context.WithTimeout(context.Background(), time.Second)
	defer cancelRetry()
	if err := manager.CloseContext(retryCtx); err != nil {
		t.Fatalf("retry CloseContext() error = %v", err)
	}
	if releases.Load() != 1 {
		t.Fatalf("release count = %d, want 1", releases.Load())
	}
}

func TestSessionRecordsUnexpectedAdapterFrameFailure(t *testing.T) {
	starter := &managerTestStarter{}
	manager := NewManager(managerTestCatalog(), starter, ManagerOptions{Inspector: catalogTestInspector{available: true}})
	t.Cleanup(manager.Close)
	session, err := manager.Start(managerTestContext(t.TempDir(), nil))
	if err != nil {
		t.Fatal(err)
	}
	process := starter.process(0)
	if _, err := io.WriteString(process.stdoutW, "Invalid: frame\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-session.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("session did not stop after malformed adapter framing")
	}
	if session.Err() == nil || !strings.Contains(session.Err().Error(), "DAP stream") {
		t.Fatalf("terminal error = %v", session.Err())
	}
}

func TestManagerForwardsDependencyMountAndStopsOnePersonalWorkspace(t *testing.T) {
	starter := &managerTestStarter{}
	manager := NewManager(managerTestCatalog(), starter, ManagerOptions{
		MaxSessions: 2, MaxPerUser: 2, Inspector: catalogTestInspector{available: true},
	})
	t.Cleanup(manager.Close)
	var firstRelease atomic.Int32
	firstContext := managerTestContext(t.TempDir(), func() { firstRelease.Add(1) })
	firstContext.DependencyRoot = t.TempDir()
	firstContext.DependencyMountRoot = filepath.Join(t.TempDir(), "dap-cache", "mounts")
	firstContext.DependencyEnv = map[string]string{"PYTHONPATH": "/project-deps/python"}
	first, err := manager.Start(firstContext)
	if err != nil {
		t.Fatal(err)
	}
	secondContext := managerTestContext(t.TempDir(), nil)
	secondContext.FolderKey = "project-b"
	if _, err := manager.Start(secondContext); err != nil {
		t.Fatal(err)
	}
	launch := starter.launch(0)
	if launch.DependencyRoot != firstContext.DependencyRoot || launch.DependencyMountRoot != firstContext.DependencyMountRoot || launch.DependencyEnv["PYTHONPATH"] != "/project-deps/python" {
		t.Fatalf("dependency launch fields = %+v", launch)
	}
	if err := manager.StopUserWorkspace("user-a", "project-a"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-first.ResourcesDone():
	default:
		t.Fatal("workspace stop returned before dependency resources were released")
	}
	if firstRelease.Load() != 1 {
		t.Fatalf("first workspace release count = %d", firstRelease.Load())
	}
	if remaining := manager.snapshot(nil); len(remaining) != 1 || remaining[0].Context.FolderKey != "project-b" {
		t.Fatalf("remaining sessions = %+v", remaining)
	}
}

func TestDAPSessionStopsWhenPersonalCacheV2QuotaIsExceeded(t *testing.T) {
	dataDir := t.TempDir()
	cache := personalcache.NewManager(dataDir, personalcache.Options{ReservationBytes: 8, ScanInterval: 5 * time.Millisecond})
	operation, err := cache.BeginOperation(context.Background(), "user-a", 256)
	if err != nil {
		t.Fatal(err)
	}
	starter := &managerTestStarter{}
	manager := NewManager(managerTestCatalog(), starter, ManagerOptions{Inspector: catalogTestInspector{available: true}})
	t.Cleanup(manager.Close)
	sessionContext := managerTestContext(t.TempDir(), operation.Release)
	sessionContext.ProcessContext = operation.Context()
	session, err := manager.Start(sessionContext)
	if err != nil {
		operation.Release()
		t.Fatal(err)
	}
	payload := filepath.Join(dataDir, "users", "user-a", "cache-v2", "transactions", "dap-quota-test", "payload")
	if err := os.MkdirAll(filepath.Dir(payload), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(payload, make([]byte, 512), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-session.ResourcesDone():
	case <-time.After(2 * time.Second):
		t.Fatal("quota guard did not stop the DAP process")
	}
	if !errors.Is(operation.Err(), personalcache.ErrQuotaExceeded) {
		t.Fatalf("operation error = %v", operation.Err())
	}
}

func TestPersonalCacheLRUDoesNotCrossIntoDAPCache(t *testing.T) {
	dataDir := t.TempDir()
	cache := personalcache.NewManager(dataDir, personalcache.Options{ReservationBytes: 8})
	operation, err := cache.BeginOperation(context.Background(), "user-a", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	starter := &managerTestStarter{}
	manager := NewManager(managerTestCatalog(), starter, ManagerOptions{Inspector: catalogTestInspector{available: true}})
	t.Cleanup(manager.Close)
	sessionContext := managerTestContext(t.TempDir(), operation.Release)
	sessionContext.ProcessContext = operation.Context()
	session, err := manager.Start(sessionContext)
	if err != nil {
		operation.Release()
		t.Fatal(err)
	}
	payload := filepath.Join(dataDir, "dap-cache", "users", "user-a", "pip", "payload")
	if err := os.MkdirAll(filepath.Dir(payload), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(payload, make([]byte, 512), 0600); err != nil {
		t.Fatal(err)
	}
	cache.Enforce("user-a", 32)
	if _, err := os.Stat(payload); err != nil {
		t.Fatalf("personal cache LRU crossed into active DAP cache: %v", err)
	}
	session.Stop()
	select {
	case <-session.ResourcesDone():
	case <-time.After(2 * time.Second):
		t.Fatal("DAP resources did not release")
	}
	cache.Enforce("user-a", 32)
	if _, err := os.Stat(payload); err != nil {
		t.Fatalf("personal cache LRU crossed into idle DAP cache: %v", err)
	}
}
