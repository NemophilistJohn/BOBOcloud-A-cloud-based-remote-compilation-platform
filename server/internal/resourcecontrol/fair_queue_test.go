package resourcecontrol

import (
	"context"
	"errors"
	"testing"
	"time"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/hostresource"
	"bobocloud-server/internal/resourcegovernor"
)

const fairQueueTestTimeout = 2 * time.Second

type fairQueueAcquireResult struct {
	id    string
	lease *Lease
	err   error
}

func fairQueueTestPolicy(global, owner, project int) QueuePolicy {
	policy := QueuePolicy{
		Enabled:              true,
		MaxWaiting:           global,
		MaxWaitingPerOwner:   owner,
		MaxWaitingPerProject: project,
		AgingThreshold:       time.Second,
	}
	for workload := Workload(0); workload < workloadCount; workload++ {
		policy.Workloads[workload] = QueueWorkloadPolicy{
			Weight:     1,
			MaxWaiting: global,
			MaxWait:    fairQueueTestTimeout,
		}
	}
	return policy
}

func newFairQueueTestController(t *testing.T, capacity resourcegovernor.Resources, policy QueuePolicy) *Controller {
	t.Helper()
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{Capacity: capacity})
	if err != nil {
		t.Fatal(err)
	}
	profiles := make(Profiles, workloadCount)
	for workload := Workload(0); workload < workloadCount; workload++ {
		profiles[workload] = resourcegovernor.Resources{Slots: 1}
	}
	controller, err := NewWithQueue(governor, profiles, nil, policy)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { controller.BeginDrain(errors.New("test cleanup")) })
	return controller
}

func startFairQueueAcquire(ctx context.Context, controller *Controller, id, owner, project string, minimum resourcegovernor.Resources, results chan<- fairQueueAcquireResult) {
	startFairQueueAdmission(ctx, controller, Admission{
		Workload: WorkloadRun, OwnerID: owner, ScopeID: project,
		WorkloadID: id, Minimum: minimum,
	}, results)
}

func startFairQueueAdmission(ctx context.Context, controller *Controller, admission Admission, results chan<- fairQueueAcquireResult) {
	go func() {
		lease, err := controller.Acquire(ctx, admission)
		results <- fairQueueAcquireResult{id: admission.WorkloadID, lease: lease, err: err}
	}()
}

func waitForFairQueueDepth(t *testing.T, controller *Controller, want int) {
	t.Helper()
	deadline := time.Now().Add(fairQueueTestTimeout)
	for time.Now().Before(deadline) {
		if got := controller.QueueSnapshot().Total; got == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("queue depth = %d, want %d", controller.QueueSnapshot().Total, want)
}

func receiveFairQueueResult(t *testing.T, results <-chan fairQueueAcquireResult) fairQueueAcquireResult {
	t.Helper()
	select {
	case result := <-results:
		return result
	case <-time.After(fairQueueTestTimeout):
		t.Fatal("timed out waiting for an admission result")
		return fairQueueAcquireResult{}
	}
}

func requireFairQueueLease(t *testing.T, result fairQueueAcquireResult, wantID string) *Lease {
	t.Helper()
	if result.id != wantID || result.err != nil || result.lease == nil {
		t.Fatalf("admission result = id:%q lease:%v err:%v, want successful %q", result.id, result.lease, result.err, wantID)
	}
	return result.lease
}

func requireAdmissionErrorCode(t *testing.T, err error, want AdmissionErrorCode) {
	t.Helper()
	var admissionErr *AdmissionError
	if !errors.As(err, &admissionErr) || admissionErr.Code != want {
		t.Fatalf("admission error = %T %v, want code %q", err, err, want)
	}
}

func TestFairQueuePreservesProjectFIFOAndPreventsBarging(t *testing.T) {
	controller := newFairQueueTestController(t, resourcegovernor.Resources{Slots: 1}, fairQueueTestPolicy(8, 8, 8))
	holder, err := controller.TryAcquire(WorkloadRun, "holder", "holder")
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()

	results := make(chan fairQueueAcquireResult, 3)
	startFairQueueAcquire(context.Background(), controller, "first", "alice", "project", resourcegovernor.Resources{}, results)
	waitForFairQueueDepth(t, controller, 1)
	startFairQueueAcquire(context.Background(), controller, "second", "alice", "project", resourcegovernor.Resources{}, results)
	waitForFairQueueDepth(t, controller, 2)
	if bypass, bypassErr := controller.TryAcquire(WorkloadRun, "late", "no-wait-bypass"); bypassErr == nil {
		bypass.Release()
		t.Fatal("no-wait admission bypassed existing queue")
	} else {
		requireAdmissionErrorCode(t, bypassErr, AdmissionQueueFull)
	}

	holder.Release()
	first := requireFairQueueLease(t, receiveFairQueueResult(t, results), "first")
	startFairQueueAcquire(context.Background(), controller, "late", "alice", "project", resourcegovernor.Resources{}, results)
	waitForFairQueueDepth(t, controller, 2)

	first.Release()
	second := requireFairQueueLease(t, receiveFairQueueResult(t, results), "second")
	second.Release()
	late := requireFairQueueLease(t, receiveFairQueueResult(t, results), "late")
	late.Release()
}

func TestFairQueueRotatesAcrossOwnersAndProjects(t *testing.T) {
	controller := newFairQueueTestController(t, resourcegovernor.Resources{Slots: 1}, fairQueueTestPolicy(8, 8, 8))
	holder, err := controller.TryAcquire(WorkloadRun, "holder", "holder")
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()

	results := make(chan fairQueueAcquireResult, 4)
	requests := []struct {
		id, owner, project string
	}{
		{id: "alice-project-one-first", owner: "alice", project: "one"},
		{id: "alice-project-one-second", owner: "alice", project: "one"},
		{id: "alice-project-two", owner: "alice", project: "two"},
		{id: "bob-project-one", owner: "bob", project: "one"},
	}
	for index, request := range requests {
		startFairQueueAcquire(context.Background(), controller, request.id, request.owner, request.project, resourcegovernor.Resources{}, results)
		waitForFairQueueDepth(t, controller, index+1)
	}

	holder.Release()
	for _, want := range []string{
		"alice-project-one-first",
		"bob-project-one",
		"alice-project-two",
		"alice-project-one-second",
	} {
		lease := requireFairQueueLease(t, receiveFairQueueResult(t, results), want)
		lease.Release()
	}
}

func TestFairQueueHonorsWeightedWorkloadCycleAlongsideOwnerProjectRotation(t *testing.T) {
	policy := QueuePolicy{
		Enabled: true, MaxWaiting: 16, MaxWaitingPerOwner: 16,
		MaxWaitingPerProject: 16, AgingThreshold: time.Second,
	}
	for workload := Workload(0); workload < workloadCount; workload++ {
		policy.Workloads[workload] = QueueWorkloadPolicy{Weight: 1}
	}
	policy.Workloads[WorkloadRun] = QueueWorkloadPolicy{Weight: 4, MaxWaiting: 8, MaxWait: fairQueueTestTimeout}
	policy.Workloads[WorkloadTask] = QueueWorkloadPolicy{Weight: 2, MaxWaiting: 4, MaxWait: fairQueueTestTimeout}
	policy.Workloads[WorkloadPackage] = QueueWorkloadPolicy{Weight: 1, MaxWaiting: 2, MaxWait: fairQueueTestTimeout}

	controller := newFairQueueTestController(t, resourcegovernor.Resources{Slots: 1}, policy)
	holder, err := controller.TryAcquire(WorkloadMaintenance, "holder", "holder")
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()

	results := make(chan fairQueueAcquireResult, 7)
	requests := []Admission{
		{Workload: WorkloadRun, OwnerID: "alice", ScopeID: "one", WorkloadID: "run-alice-one-first"},
		{Workload: WorkloadRun, OwnerID: "alice", ScopeID: "one", WorkloadID: "run-alice-one-second"},
		{Workload: WorkloadRun, OwnerID: "alice", ScopeID: "two", WorkloadID: "run-alice-two"},
		{Workload: WorkloadRun, OwnerID: "bob", ScopeID: "one", WorkloadID: "run-bob-one"},
		{Workload: WorkloadTask, OwnerID: "alice", ScopeID: "one", WorkloadID: "task-alice-one"},
		{Workload: WorkloadTask, OwnerID: "bob", ScopeID: "one", WorkloadID: "task-bob-one"},
		{Workload: WorkloadPackage, OwnerID: "carol", ScopeID: "one", WorkloadID: "package-carol-one"},
	}
	for index, admission := range requests {
		startFairQueueAdmission(context.Background(), controller, admission, results)
		waitForFairQueueDepth(t, controller, index+1)
	}

	holder.Release()
	for _, want := range []string{
		"run-alice-one-first",
		"task-alice-one",
		"run-bob-one",
		"package-carol-one",
		"run-alice-two",
		"task-bob-one",
		"run-alice-one-second",
	} {
		lease := requireFairQueueLease(t, receiveFairQueueResult(t, results), want)
		lease.Release()
	}
}

func TestFairQueueEnforcesEveryBound(t *testing.T) {
	tests := []struct {
		name     string
		policy   QueuePolicy
		queued   []Admission
		rejected Admission
		want     AdmissionErrorCode
	}{
		{
			name:   "global",
			policy: fairQueueTestPolicy(2, 2, 2),
			queued: []Admission{
				{Workload: WorkloadRun, OwnerID: "alice", ScopeID: "one", WorkloadID: "one"},
				{Workload: WorkloadRun, OwnerID: "bob", ScopeID: "two", WorkloadID: "two"},
			},
			rejected: Admission{Workload: WorkloadRun, OwnerID: "carol", ScopeID: "three", WorkloadID: "three"},
			want:     AdmissionQueueFull,
		},
		{
			name:   "owner",
			policy: fairQueueTestPolicy(4, 2, 2),
			queued: []Admission{
				{Workload: WorkloadRun, OwnerID: "alice", ScopeID: "one", WorkloadID: "one"},
				{Workload: WorkloadRun, OwnerID: "alice", ScopeID: "two", WorkloadID: "two"},
			},
			rejected: Admission{Workload: WorkloadRun, OwnerID: "alice", ScopeID: "three", WorkloadID: "three"},
			want:     AdmissionOwnerQueueFull,
		},
		{
			name:   "project",
			policy: fairQueueTestPolicy(4, 4, 1),
			queued: []Admission{
				{Workload: WorkloadRun, OwnerID: "alice", ScopeID: "one", WorkloadID: "one"},
			},
			rejected: Admission{Workload: WorkloadRun, OwnerID: "alice", ScopeID: "one", WorkloadID: "two"},
			want:     AdmissionProjectQueueFull,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			controller := newFairQueueTestController(t, resourcegovernor.Resources{Slots: 1}, test.policy)
			holder, err := controller.TryAcquire(WorkloadRun, "holder", "holder")
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Release()
			results := make(chan fairQueueAcquireResult, len(test.queued))
			for index, admission := range test.queued {
				startFairQueueAcquire(context.Background(), controller, admission.WorkloadID, admission.OwnerID, admission.ScopeID, admission.Minimum, results)
				waitForFairQueueDepth(t, controller, index+1)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
			defer cancel()
			_, err = controller.Acquire(ctx, test.rejected)
			requireAdmissionErrorCode(t, err, test.want)
			if got := controller.QueueSnapshot().Total; got != len(test.queued) {
				t.Fatalf("rejected admission changed depth to %d, want %d", got, len(test.queued))
			}
		})
	}
}

func TestFairQueueRejectsRequestThatCannotFitNode(t *testing.T) {
	controller := newFairQueueTestController(t, resourcegovernor.Resources{Slots: 1}, fairQueueTestPolicy(4, 4, 4))
	lease, err := controller.Acquire(context.Background(), Admission{
		Workload: WorkloadRun, OwnerID: "alice", ScopeID: "project", WorkloadID: "impossible",
		Minimum: resourcegovernor.Resources{Slots: 2},
	})
	if lease != nil {
		lease.Release()
		t.Fatal("impossible request received a lease")
	}
	requireAdmissionErrorCode(t, err, AdmissionImpossible)
	if got := controller.QueueSnapshot().Total; got != 0 {
		t.Fatalf("impossible request entered queue: depth=%d", got)
	}
}

func TestFairQueueCancellationAndTimeoutRemoveWaiters(t *testing.T) {
	t.Run("caller cancellation", func(t *testing.T) {
		controller := newFairQueueTestController(t, resourcegovernor.Resources{Slots: 1}, fairQueueTestPolicy(4, 4, 4))
		holder, err := controller.TryAcquire(WorkloadRun, "holder", "holder")
		if err != nil {
			t.Fatal(err)
		}
		defer holder.Release()
		ctx, cancel := context.WithCancel(context.Background())
		results := make(chan fairQueueAcquireResult, 1)
		startFairQueueAcquire(ctx, controller, "cancelled", "alice", "project", resourcegovernor.Resources{}, results)
		waitForFairQueueDepth(t, controller, 1)
		cancel()
		result := receiveFairQueueResult(t, results)
		requireAdmissionErrorCode(t, result.err, AdmissionCancelled)
		waitForFairQueueDepth(t, controller, 0)
	})

	t.Run("workload timeout", func(t *testing.T) {
		policy := fairQueueTestPolicy(4, 4, 4)
		policy.Workloads[WorkloadRun] = QueueWorkloadPolicy{Weight: 1, MaxWaiting: 4, MaxWait: 30 * time.Millisecond}
		controller := newFairQueueTestController(t, resourcegovernor.Resources{Slots: 1}, policy)
		holder, err := controller.TryAcquire(WorkloadRun, "holder", "holder")
		if err != nil {
			t.Fatal(err)
		}
		defer holder.Release()
		results := make(chan fairQueueAcquireResult, 1)
		startFairQueueAcquire(context.Background(), controller, "timed-out", "alice", "project", resourcegovernor.Resources{}, results)
		waitForFairQueueDepth(t, controller, 1)
		result := receiveFairQueueResult(t, results)
		requireAdmissionErrorCode(t, result.err, AdmissionQueueTimeout)
		waitForFairQueueDepth(t, controller, 0)
	})
}

func TestFairQueueBeginDrainWakesWaitersAndRejectsNewWork(t *testing.T) {
	controller := newFairQueueTestController(t, resourcegovernor.Resources{Slots: 1}, fairQueueTestPolicy(4, 4, 4))
	holder, err := controller.TryAcquire(WorkloadRun, "holder", "holder")
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()
	results := make(chan fairQueueAcquireResult, 1)
	startFairQueueAcquire(context.Background(), controller, "waiting", "alice", "project", resourcegovernor.Resources{}, results)
	waitForFairQueueDepth(t, controller, 1)

	cause := errors.New("server shutdown")
	controller.BeginDrain(cause)
	result := receiveFairQueueResult(t, results)
	requireAdmissionErrorCode(t, result.err, AdmissionDraining)
	if !errors.Is(result.err, cause) {
		t.Fatalf("drain error does not wrap cause: %v", result.err)
	}
	if snapshot := controller.QueueSnapshot(); !snapshot.Draining || snapshot.Total != 0 {
		t.Fatalf("unexpected draining snapshot: %+v", snapshot)
	}
	_, err = controller.Acquire(context.Background(), Admission{
		Workload: WorkloadRun, OwnerID: "bob", ScopeID: "project", WorkloadID: "new",
	})
	requireAdmissionErrorCode(t, err, AdmissionDraining)
	if !holder.Release() {
		t.Fatal("active lease did not retain normal release ownership during drain")
	}
}

func TestFairQueueDispatchesWhenResourcesAreReleased(t *testing.T) {
	controller := newFairQueueTestController(t, resourcegovernor.Resources{Slots: 1}, fairQueueTestPolicy(4, 4, 4))
	holder, err := controller.TryAcquire(WorkloadRun, "holder", "holder")
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan fairQueueAcquireResult, 1)
	startFairQueueAcquire(context.Background(), controller, "waiting", "alice", "project", resourcegovernor.Resources{}, results)
	waitForFairQueueDepth(t, controller, 1)

	if !holder.Release() {
		t.Fatal("holder release failed")
	}
	result := receiveFairQueueResult(t, results)
	lease := requireFairQueueLease(t, result, "waiting")
	if lease.WaitDuration() <= 0 {
		t.Fatalf("queued lease wait duration = %s", lease.WaitDuration())
	}
	if snapshot := controller.QueueSnapshot(); snapshot.Total != 0 {
		t.Fatalf("queue did not drain after release: %+v", snapshot)
	}
	lease.Release()
}

func TestFairQueueAgedRequestReservesItsMissingResources(t *testing.T) {
	policy := fairQueueTestPolicy(8, 8, 8)
	policy.AgingThreshold = 20 * time.Millisecond
	controller := newFairQueueTestController(t, resourcegovernor.Resources{Slots: 2}, policy)
	holder, err := controller.TryAcquire(WorkloadRun, "holder", "holder")
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()

	oldResult := make(chan fairQueueAcquireResult, 1)
	startFairQueueAcquire(context.Background(), controller, "old-large", "alice", "large", resourcegovernor.Resources{Slots: 2}, oldResult)
	waitForFairQueueDepth(t, controller, 1)
	time.Sleep(2 * policy.AgingThreshold)

	youngResult := make(chan fairQueueAcquireResult, 1)
	startFairQueueAcquire(context.Background(), controller, "young-small", "bob", "small", resourcegovernor.Resources{}, youngResult)
	waitForFairQueueDepth(t, controller, 2)
	select {
	case result := <-youngResult:
		if result.lease != nil {
			result.lease.Release()
		}
		t.Fatalf("young request bypassed aged reservation: %+v", result)
	case <-time.After(20 * time.Millisecond):
	}

	holder.Release()
	oldLease := requireFairQueueLease(t, receiveFairQueueResult(t, oldResult), "old-large")
	select {
	case result := <-youngResult:
		if result.lease != nil {
			result.lease.Release()
		}
		t.Fatalf("young request ran while the aged request held all slots: %+v", result)
	case <-time.After(20 * time.Millisecond):
	}
	oldLease.Release()
	youngLease := requireFairQueueLease(t, receiveFairQueueResult(t, youngResult), "young-small")
	youngLease.Release()
}

func TestBuildUsesDockerMaxContainersAsIndependentCapacity(t *testing.T) {
	cfg := config.Default()
	cfg.DockerMaxContainers = 3
	controller, info, err := Build(cfg, hostresource.Capacity{
		CPUMillicores: 8_000, MemoryBytes: 16_000_000_000, PIDs: 32_000,
		EphemeralBytes: 100_000_000_000, Inodes: 1_000_000,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if controller == nil {
		t.Fatal("builder returned no controller")
	}
	if got := info.Node.Capacity.DockerContainers; got != int64(cfg.DockerMaxContainers) {
		t.Fatalf("Docker container capacity = %d, want %d", got, cfg.DockerMaxContainers)
	}
	for _, workload := range []Workload{WorkloadTask, WorkloadTerminal, WorkloadPackage} {
		if got := info.Profiles[workload].DockerContainers; got != 1 {
			t.Fatalf("%s Docker container demand = %d, want 1", workload, got)
		}
	}
	for _, workload := range []Workload{WorkloadRun, WorkloadLSP, WorkloadDAP, WorkloadMaintenance} {
		if got := info.Profiles[workload].DockerContainers; got != 0 {
			t.Fatalf("%s Docker container demand = %d, want 0", workload, got)
		}
	}
	if snapshot := controller.Snapshot(); snapshot.Usable.DockerContainers != int64(cfg.DockerMaxContainers) {
		t.Fatalf("usable Docker container capacity = %d, want %d", snapshot.Usable.DockerContainers, cfg.DockerMaxContainers)
	}
}
