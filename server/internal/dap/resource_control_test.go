package dap

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

type fixedDAPResourceStarter struct {
	process Process
	err     error
	calls   atomic.Int32
}

func (starter *fixedDAPResourceStarter) Start(_ context.Context, _ LaunchSpec) (Process, error) {
	starter.calls.Add(1)
	return starter.process, starter.err
}

type pendingDAPStartError struct {
	done <-chan struct{}
}

func (err *pendingDAPStartError) Error() string                { return "injected pending Docker cleanup" }
func (err *pendingDAPStartError) CleanupDone() <-chan struct{} { return err.done }

func newDAPResourceController(t *testing.T, slots int64) *resourcecontrol.Controller {
	t.Helper()
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{
		Capacity: resourcegovernor.Resources{Slots: slots, DockerContainers: slots},
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

func newDAPResourceTestManager(t *testing.T, starter ProcessStarter, controller *resourcecontrol.Controller, maxSessions int) *Manager {
	t.Helper()
	manager := NewManager(managerTestCatalog(), starter, ManagerOptions{
		MaxSessions: maxSessions, MaxPerUser: maxSessions,
		Inspector: catalogTestInspector{available: true}, ResourceController: controller,
		processWaitTimeout: 10 * time.Millisecond, killWaitTimeout: 10 * time.Millisecond,
	})
	t.Cleanup(manager.Close)
	return manager
}

func waitForDAPResourceSlots(t *testing.T, controller *resourcecontrol.Controller, slots int64) {
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

func TestDAPResourceLeaseHeldUntilProcessWaitCompletes(t *testing.T) {
	controller := newDAPResourceController(t, 1)
	process := newDrainingManagerTestProcess()
	starter := &fixedDAPResourceStarter{process: process}
	manager := newDAPResourceTestManager(t, starter, controller, 1)
	session, err := manager.Start(managerTestContext(t.TempDir(), nil))
	if err != nil {
		t.Fatal(err)
	}
	snapshot := controller.Snapshot()
	if snapshot.Used.Slots != 1 || snapshot.Used.DockerContainers != 1 || len(snapshot.Leases) != 1 {
		t.Fatalf("active DAP resource snapshot = %+v", snapshot)
	}
	if snapshot.Leases[0].Metadata.OwnerID != "user-a" || snapshot.Leases[0].Metadata.WorkloadID != session.ID {
		t.Fatalf("DAP resource lease metadata = %+v", snapshot.Leases[0].Metadata)
	}

	session.Stop()
	select {
	case <-session.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("DAP session did not finish client-facing shutdown")
	}
	if slots := controller.Snapshot().Used.Slots; slots != 1 {
		t.Fatalf("resource slots released before Process.Wait completed: %d", slots)
	}
	close(process.waitRelease)
	select {
	case <-session.ResourcesDone():
	case <-time.After(2 * time.Second):
		t.Fatal("DAP resource lease was not released after Process.Wait completed")
	}
	waitForDAPResourceSlots(t, controller, 0)
}

func TestDAPResourceAdmissionRejectsBeforeProcessStartAndRecovers(t *testing.T) {
	controller := newDAPResourceController(t, 1)
	starter := &managerTestStarter{}
	manager := newDAPResourceTestManager(t, starter, controller, 2)
	first, err := manager.Start(managerTestContext(t.TempDir(), nil))
	if err != nil {
		t.Fatal(err)
	}
	secondContext := managerTestContext(t.TempDir(), nil)
	secondContext.UserID, secondContext.FolderKey = "user-b", "project-b"
	_, err = manager.Start(secondContext)
	var rejection *resourcegovernor.Rejection
	if !errors.As(err, &rejection) {
		t.Fatalf("second DAP Start() error = %v, want resource rejection", err)
	}
	starter.mu.Lock()
	startCalls := len(starter.launches)
	starter.mu.Unlock()
	if startCalls != 1 {
		t.Fatalf("debug adapter start calls after rejection = %d, want 1", startCalls)
	}

	first.Stop()
	select {
	case <-first.ResourcesDone():
	case <-time.After(2 * time.Second):
		t.Fatal("first DAP resource lease did not release")
	}
	second, err := manager.Start(secondContext)
	if err != nil {
		t.Fatalf("DAP Start() after resource release = %v", err)
	}
	second.Stop()
	<-second.ResourcesDone()
}

func TestDAPDuplicateSessionDoesNotAcquireAnotherResourceLease(t *testing.T) {
	controller := newDAPResourceController(t, 2)
	starter := &managerTestStarter{}
	manager := newDAPResourceTestManager(t, starter, controller, 2)
	context := managerTestContext(t.TempDir(), nil)
	session, err := manager.Start(context)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context); err == nil {
		t.Fatal("duplicate DAP Start() unexpectedly succeeded")
	}
	starter.mu.Lock()
	startCalls := len(starter.launches)
	starter.mu.Unlock()
	if startCalls != 1 {
		t.Fatalf("debug adapter start calls for duplicate key = %d, want 1", startCalls)
	}
	if snapshot := controller.Snapshot(); snapshot.Used.Slots != 1 || len(snapshot.Leases) != 1 {
		t.Fatalf("duplicate DAP start changed resource leases: %+v", snapshot)
	}
	session.Stop()
	<-session.ResourcesDone()
}

func TestDAPResourceLeaseReleaseIsConcurrentAndIdempotent(t *testing.T) {
	controller := newDAPResourceController(t, 1)
	manager := newDAPResourceTestManager(t, &managerTestStarter{}, controller, 1)
	session, err := manager.Start(managerTestContext(t.TempDir(), nil))
	if err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	for index := 0; index < 24; index++ {
		wait.Add(1)
		go func(stopThroughManager bool) {
			defer wait.Done()
			if stopThroughManager {
				_ = manager.StopUser("user-a")
				return
			}
			session.Stop()
		}(index%2 == 0)
	}
	wait.Wait()
	select {
	case <-session.ResourcesDone():
	case <-time.After(2 * time.Second):
		t.Fatal("concurrent DAP stops did not release resources")
	}
	if snapshot := controller.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("resource lease remained after concurrent DAP stops: %+v", snapshot)
	}
}

func TestDAPStartFailureRetainsResourceLeaseUntilContainerCleanup(t *testing.T) {
	controller := newDAPResourceController(t, 1)
	cleanupDone := make(chan struct{})
	starter := &fixedDAPResourceStarter{err: &pendingDAPStartError{done: cleanupDone}}
	manager := newDAPResourceTestManager(t, starter, controller, 1)
	if _, err := manager.Start(managerTestContext(t.TempDir(), nil)); err == nil {
		t.Fatal("DAP Start() unexpectedly succeeded")
	}
	if slots := controller.Snapshot().Used.Slots; slots != 1 {
		t.Fatalf("failed DAP start released resources before container cleanup: %d", slots)
	}
	close(cleanupDone)
	waitForDAPResourceSlots(t, controller, 0)
}

func TestDAPResourceLeaseReleasedWhenAdapterIsUnavailable(t *testing.T) {
	controller := newDAPResourceController(t, 1)
	starter := &fixedDAPResourceStarter{}
	manager := NewManager(managerTestCatalog(), starter, ManagerOptions{
		MaxSessions: 1, MaxPerUser: 1,
		Inspector:          catalogTestInspector{available: false, reason: "missing image"},
		ResourceController: controller,
	})
	t.Cleanup(manager.Close)
	if _, err := manager.Start(managerTestContext(t.TempDir(), nil)); err == nil {
		t.Fatal("DAP Start() unexpectedly succeeded with an unavailable adapter")
	}
	if calls := starter.calls.Load(); calls != 0 {
		t.Fatalf("debug adapter start calls while image unavailable = %d, want 0", calls)
	}
	if snapshot := controller.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("unavailable DAP adapter leaked a resource lease: %+v", snapshot)
	}
}
