package lsp

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"bobocloud-server/internal/resourcecontrol"
	"bobocloud-server/internal/resourcegovernor"
)

type lspResourceStarter struct {
	calls     atomic.Int32
	mu        sync.Mutex
	processes []*testProcess
	err       error
}

func (starter *lspResourceStarter) Start(_ context.Context, _ LaunchSpec) (Process, error) {
	starter.calls.Add(1)
	if starter.err != nil {
		return nil, starter.err
	}
	process := newTestProcess()
	starter.mu.Lock()
	starter.processes = append(starter.processes, process)
	starter.mu.Unlock()
	return process, nil
}

type fixedLSPResourceStarter struct {
	process Process
}

func (starter fixedLSPResourceStarter) Start(_ context.Context, _ LaunchSpec) (Process, error) {
	return starter.process, nil
}

type cancellableLSPResourceStarter struct {
	entered chan struct{}
}

func (starter cancellableLSPResourceStarter) Start(ctx context.Context, _ LaunchSpec) (Process, error) {
	close(starter.entered)
	<-ctx.Done()
	return nil, ctx.Err()
}

func newLSPResourceController(t *testing.T, slots int64) *resourcecontrol.Controller {
	t.Helper()
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{
		Capacity: resourcegovernor.Resources{Slots: slots},
	})
	if err != nil {
		t.Fatal(err)
	}
	profiles := resourcecontrol.Profiles{}
	for _, workload := range []resourcecontrol.Workload{
		resourcecontrol.WorkloadRun,
		resourcecontrol.WorkloadTask,
		resourcecontrol.WorkloadTerminal,
		resourcecontrol.WorkloadPackage,
		resourcecontrol.WorkloadLSP,
		resourcecontrol.WorkloadDAP,
		resourcecontrol.WorkloadMaintenance,
	} {
		profiles[workload] = resourcegovernor.Resources{Slots: 1}
	}
	controller, err := resourcecontrol.New(governor, profiles, nil)
	if err != nil {
		t.Fatal(err)
	}
	return controller
}

func newLSPResourceTestManager(t *testing.T, starter ProcessStarter, controller *resourcecontrol.Controller, maxSessions int) *Manager {
	t.Helper()
	catalog, err := NewCatalog(Manifest{Version: 1, Servers: []ServerSpec{{
		LanguageID: "go",
		Command:    []string{"gopls"},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	manager := NewManager(catalog, NewCacheManager(t.TempDir(), 16, 7), starter, ManagerOptions{
		MaxSessions: maxSessions, MaxPerUser: maxSessions, CleanupInterval: time.Hour,
		ResourceController: controller,
	})
	t.Cleanup(manager.Close)
	return manager
}

func lspResourceTestContext(workspace, userID, folderKey string) SessionContext {
	return SessionContext{
		UserID: userID, WorkspaceKind: "personal", FolderKey: folderKey,
		RuntimeID: "local", LanguageID: "go", Mode: ModeStandard, RemoteRoot: workspace,
	}
}

func waitForLSPResourceSlots(t *testing.T, controller *resourcecontrol.Controller, slots int64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if controller.Snapshot().Used.Slots == slots {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("resource slots in use = %d, want %d", controller.Snapshot().Used.Slots, slots)
}

func TestLSPResourceLeaseHeldUntilProcessWaitCompletes(t *testing.T) {
	controller := newLSPResourceController(t, 1)
	process := newDrainingTestProcess()
	manager := newLSPResourceTestManager(t, fixedLSPResourceStarter{process: process}, controller, 1)
	session, err := manager.Start(lspResourceTestContext(t.TempDir(), "user-lsp", "project-a"))
	if err != nil {
		t.Fatal(err)
	}
	snapshot := controller.Snapshot()
	if snapshot.Used.Slots != 1 || len(snapshot.Leases) != 1 {
		t.Fatalf("active LSP resource snapshot = %+v", snapshot)
	}
	if snapshot.Leases[0].Metadata.OwnerID != "user-lsp" || snapshot.Leases[0].Metadata.WorkloadID != session.ID {
		t.Fatalf("LSP resource lease metadata = %+v", snapshot.Leases[0].Metadata)
	}

	session.Stop()
	deadline := time.Now().Add(time.Second)
	for !process.killed.Load() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !process.killed.Load() {
		t.Fatal("LSP process was not asked to stop")
	}
	if slots := controller.Snapshot().Used.Slots; slots != 1 {
		t.Fatalf("resource slots released before Process.Wait completed: %d", slots)
	}

	close(process.waitRelease)
	select {
	case <-session.ResourcesDone():
	case <-time.After(2 * time.Second):
		t.Fatal("LSP resource lease was not released after Process.Wait completed")
	}
	waitForLSPResourceSlots(t, controller, 0)
}

func TestLSPStartCancellationPropagatesAndReleasesResourceLease(t *testing.T) {
	controller := newLSPResourceController(t, 1)
	starter := cancellableLSPResourceStarter{entered: make(chan struct{})}
	manager := newLSPResourceTestManager(t, starter, controller, 1)
	processContext, cancel := context.WithCancel(context.Background())
	sessionContext := lspResourceTestContext(t.TempDir(), "user-cancelled", "project")
	sessionContext.ProcessContext = processContext
	result := make(chan error, 1)
	go func() {
		_, err := manager.Start(sessionContext)
		result <- err
	}()
	select {
	case <-starter.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("language server starter was not reached")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled LSP start error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled LSP start did not return")
	}
	waitForLSPResourceSlots(t, controller, 0)
}

func TestLSPResourceAdmissionRejectsBeforeProcessStartAndRecovers(t *testing.T) {
	controller := newLSPResourceController(t, 1)
	starter := &lspResourceStarter{}
	manager := newLSPResourceTestManager(t, starter, controller, 2)
	first, err := manager.Start(lspResourceTestContext(t.TempDir(), "user-a", "project-a"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Start(lspResourceTestContext(t.TempDir(), "user-b", "project-b"))
	var rejection *resourcegovernor.Rejection
	if !errors.As(err, &rejection) {
		t.Fatalf("second LSP Start() error = %v, want resource rejection", err)
	}
	if calls := starter.calls.Load(); calls != 1 {
		t.Fatalf("language server start calls after rejection = %d, want 1", calls)
	}

	first.Stop()
	select {
	case <-first.ResourcesDone():
	case <-time.After(2 * time.Second):
		t.Fatal("first LSP resource lease did not release")
	}
	second, err := manager.Start(lspResourceTestContext(t.TempDir(), "user-b", "project-b"))
	if err != nil {
		t.Fatalf("LSP Start() after resource release = %v", err)
	}
	second.Stop()
	<-second.ResourcesDone()
}

func TestLSPDuplicateSessionDoesNotAcquireAnotherResourceLease(t *testing.T) {
	controller := newLSPResourceController(t, 2)
	starter := &lspResourceStarter{}
	manager := newLSPResourceTestManager(t, starter, controller, 2)
	context := lspResourceTestContext(t.TempDir(), "user-duplicate", "project")
	session, err := manager.Start(context)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context); err == nil {
		t.Fatal("duplicate LSP Start() unexpectedly succeeded")
	}
	if calls := starter.calls.Load(); calls != 1 {
		t.Fatalf("language server start calls for duplicate key = %d, want 1", calls)
	}
	if snapshot := controller.Snapshot(); snapshot.Used.Slots != 1 || len(snapshot.Leases) != 1 {
		t.Fatalf("duplicate LSP start changed resource leases: %+v", snapshot)
	}
	session.Stop()
	<-session.ResourcesDone()
}

func TestLSPResourceLeaseReleaseIsConcurrentAndIdempotent(t *testing.T) {
	controller := newLSPResourceController(t, 1)
	manager := newLSPResourceTestManager(t, &lspResourceStarter{}, controller, 1)
	session, err := manager.Start(lspResourceTestContext(t.TempDir(), "user-concurrent", "project"))
	if err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	for index := 0; index < 24; index++ {
		wait.Add(1)
		go func(stopThroughManager bool) {
			defer wait.Done()
			if stopThroughManager {
				_ = manager.StopUser("user-concurrent")
				return
			}
			session.Stop()
		}(index%2 == 0)
	}
	wait.Wait()
	select {
	case <-session.ResourcesDone():
	case <-time.After(2 * time.Second):
		t.Fatal("concurrent LSP stops did not release resources")
	}
	if snapshot := controller.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("resource lease remained after concurrent LSP stops: %+v", snapshot)
	}
}

func TestLSPResourceLeaseReleasedWhenProcessStartFails(t *testing.T) {
	controller := newLSPResourceController(t, 1)
	starter := &lspResourceStarter{err: errors.New("injected start failure")}
	manager := newLSPResourceTestManager(t, starter, controller, 1)
	if _, err := manager.Start(lspResourceTestContext(t.TempDir(), "user-failure", "project")); err == nil {
		t.Fatal("LSP Start() unexpectedly succeeded")
	}
	if snapshot := controller.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("failed LSP start leaked a resource lease: %+v", snapshot)
	}
}
