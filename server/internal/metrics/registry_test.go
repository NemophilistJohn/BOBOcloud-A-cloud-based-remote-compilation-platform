package metrics

import (
	"fmt"
	"math"
	"sync"
	"testing"
	"time"
)

func TestRegistryKeepsBoundedSamplesAndCounters(t *testing.T) {
	r := New(true, 3)
	for _, value := range []time.Duration{time.Millisecond, 2 * time.Millisecond, 3 * time.Millisecond, 20 * time.Millisecond} {
		r.Observe("compile", value)
	}
	r.Cache("dependency.cache", true)
	r.Cache("dependency.cache", false)
	r.AddBytes("persist.growth", 42)
	snapshot := r.Snapshot()
	if got := snapshot.Stages["compile"]; got.Count != 4 || got.MaxMS != 20 || got.P95MS != 20 {
		t.Fatalf("compile snapshot = %+v", got)
	}
	if got := snapshot.Stages["dependency.cache"]; got.CacheHits != 1 || got.CacheMisses != 1 || got.HitRate != .5 {
		t.Fatalf("cache snapshot = %+v", got)
	}
	if got := snapshot.Stages["persist.growth"].Bytes; got != 42 {
		t.Fatalf("growth bytes = %d", got)
	}
}

func TestDisabledRegistryDoesNotCollect(t *testing.T) {
	r := New(false, 10)
	r.Observe("run", time.Second)
	r.ObserveAdmission(WorkloadRun, AdmissionAccepted, AdmissionReasonNone, time.Second)
	r.ObserveQueueDepth(WorkloadRun, 4)
	r.ObserveResourceUsage(ResourceSlots, 1, 2)
	snapshot := r.Snapshot()
	if len(snapshot.Stages) != 0 {
		t.Fatal("disabled registry collected observations")
	}
	if len(snapshot.Governance.Admissions) != 0 || len(snapshot.Governance.Queues) != 0 || len(snapshot.Governance.Resources) != 0 {
		t.Fatalf("disabled registry collected governance metrics: %+v", snapshot.Governance)
	}
}

func TestRegistryCapsLegacyStageCardinality(t *testing.T) {
	r := New(true, 2)
	total := maxStageSeries * 4
	for index := 0; index < total; index++ {
		r.Observe(fmt.Sprintf("dynamic.%d", index), time.Millisecond)
	}
	snapshot := r.Snapshot()
	if len(snapshot.Stages) != maxStageSeries {
		t.Fatalf("stage series = %d, want fixed maximum %d", len(snapshot.Stages), maxStageSeries)
	}
	if got := snapshot.Stages[overflowStageName].Count; got != int64(total-(maxStageSeries-1)) {
		t.Fatalf("overflow count = %d", got)
	}
}

func TestRegistryCapsConfiguredWindow(t *testing.T) {
	r := New(true, maxWindowSize*10)
	for index := 0; index < maxWindowSize+100; index++ {
		r.Observe("run", time.Millisecond)
		r.ObserveAdmission(WorkloadRun, AdmissionAccepted, AdmissionReasonNone, time.Millisecond)
		r.ObserveQueueDepth(WorkloadRun, int64(index))
	}
	if snapshot := r.Snapshot(); snapshot.WindowSize != maxWindowSize {
		t.Fatalf("window = %d, want maximum %d", snapshot.WindowSize, maxWindowSize)
	}
	r.mu.Lock()
	stageSamples := len(r.stages["run"].samples)
	admissionSamples := len(r.governance.admissions[WorkloadRun][AdmissionAccepted].samples)
	queueSamples := len(r.governance.queues[WorkloadRun].depths.samples)
	r.mu.Unlock()
	if stageSamples != maxWindowSize || admissionSamples != maxWindowSize || queueSamples != maxWindowSize {
		t.Fatalf("bounded samples: stage=%d admission=%d queue=%d", stageSamples, admissionSamples, queueSamples)
	}
}

func TestRegistryCountersSaturateInsteadOfWrapping(t *testing.T) {
	r := New(true, 2)
	r.mu.Lock()
	stage := r.stageLocked("run")
	stage.count = math.MaxInt64
	stage.totalNanos = math.MaxInt64
	stage.bytes = math.MinInt64 + 1
	r.governance.admissions[WorkloadRun][AdmissionAccepted].count = math.MaxInt64
	r.governance.admissions[WorkloadRun][AdmissionAccepted].total = math.MaxInt64
	r.governance.rejections[WorkloadRun][AdmissionReasonQueueFull] = math.MaxInt64
	r.governance.resources[ResourceSlots].observations = math.MaxInt64
	r.mu.Unlock()

	r.Observe("run", time.Second)
	r.AddBytes("run", -10)
	r.ObserveAdmission(WorkloadRun, AdmissionAccepted, AdmissionReasonNone, time.Second)
	r.ObserveAdmission(WorkloadRun, AdmissionRejected, AdmissionReasonQueueFull, time.Second)
	r.ObserveResourceUsage(ResourceSlots, 1, 2)

	r.mu.Lock()
	defer r.mu.Unlock()
	if stage.count != math.MaxInt64 || stage.totalNanos != math.MaxInt64 || stage.bytes != math.MinInt64 {
		t.Fatalf("legacy counters wrapped: %+v", stage)
	}
	if r.governance.admissions[WorkloadRun][AdmissionAccepted].count != math.MaxInt64 ||
		r.governance.admissions[WorkloadRun][AdmissionAccepted].total != math.MaxInt64 ||
		r.governance.rejections[WorkloadRun][AdmissionReasonQueueFull] != math.MaxInt64 ||
		r.governance.resources[ResourceSlots].observations != math.MaxInt64 {
		t.Fatal("governance counters wrapped")
	}
}

func TestRegistryGovernanceSnapshot(t *testing.T) {
	r := New(true, 3)
	for _, elapsed := range []time.Duration{time.Millisecond, 2 * time.Millisecond, 3 * time.Millisecond, 20 * time.Millisecond} {
		r.ObserveAdmission(WorkloadRun, AdmissionAccepted, AdmissionReasonNone, elapsed)
	}
	r.ObserveAdmission(WorkloadPackage, AdmissionRejected, AdmissionReasonQueueFull, 5*time.Millisecond)
	r.ObserveAdmission(WorkloadTerminal, AdmissionRejected, AdmissionReasonNone, 7*time.Millisecond)

	for _, depth := range []int64{1, 2, 3, 9} {
		r.ObserveQueueDepth(WorkloadRun, depth)
	}
	r.ObserveResourceUsage(ResourceMemoryBytes, 12, 10)

	snapshot := r.Snapshot().Governance
	accepted := findAdmission(t, snapshot, "run", "accepted")
	if accepted.Count != 4 || accepted.MaxMS != 20 || accepted.P95MS != 20 {
		t.Fatalf("accepted snapshot = %+v", accepted)
	}
	rejection := findRejection(t, snapshot, "package", "queue_full")
	if rejection.Count != 1 {
		t.Fatalf("queue-full rejection = %+v", rejection)
	}
	if got := findRejection(t, snapshot, "terminal", "other").Count; got != 1 {
		t.Fatalf("unspecified rejection count = %d", got)
	}
	queue := findQueue(t, snapshot, "run")
	if queue.Current != 9 || queue.Peak != 9 || queue.Observations != 4 || queue.P95 != 9 {
		t.Fatalf("queue snapshot = %+v", queue)
	}
	resource := findResource(t, snapshot, "memory_bytes")
	if resource.InUse != 12 || resource.Capacity != 10 || resource.PeakInUse != 12 || !resource.OverCapacity || resource.Utilization != 1.2 {
		t.Fatalf("resource snapshot = %+v", resource)
	}
}

func TestRegistryObserveResourceSnapshotUpdatesFixedVector(t *testing.T) {
	r := New(true, 4)
	r.ObserveResourceSnapshot(ResourceObservationSnapshot{
		Slots:            ResourceUsage{InUse: 2, Capacity: 10},
		DockerContainers: ResourceUsage{InUse: 1, Capacity: 6},
		CPUMillicores:    ResourceUsage{InUse: 1500, Capacity: 4000},
		MemoryBytes:      ResourceUsage{InUse: 3_000, Capacity: 8_000},
		PIDs:             ResourceUsage{InUse: 20, Capacity: 100},
		EphemeralBytes:   ResourceUsage{InUse: 4_000, Capacity: 20_000},
		Inodes:           ResourceUsage{InUse: 30, Capacity: 1_000},
		Devices:          ResourceUsage{InUse: 1, Capacity: 2},
	})

	snapshot := r.Snapshot().Governance
	wants := map[string]ResourceUsage{
		"slots":             {InUse: 2, Capacity: 10},
		"docker_containers": {InUse: 1, Capacity: 6},
		"cpu_millicores":    {InUse: 1500, Capacity: 4000},
		"memory_bytes":      {InUse: 3_000, Capacity: 8_000},
		"pids":              {InUse: 20, Capacity: 100},
		"ephemeral_bytes":   {InUse: 4_000, Capacity: 20_000},
		"inodes":            {InUse: 30, Capacity: 1_000},
		"devices":           {InUse: 1, Capacity: 2},
	}
	if len(snapshot.Resources) != len(wants) {
		t.Fatalf("resource series = %d, want %d: %+v", len(snapshot.Resources), len(wants), snapshot.Resources)
	}
	for resource, want := range wants {
		got := findResource(t, snapshot, resource)
		if got.InUse != want.InUse || got.Capacity != want.Capacity || got.Observations != 1 {
			t.Fatalf("resource %s = %+v, want %+v", resource, got, want)
		}
	}
}

func TestRegistryGovernanceInvalidEnumsCollapseToOther(t *testing.T) {
	r := New(true, 2)
	for index := 0; index < 1000; index++ {
		r.ObserveAdmission(Workload(255), AdmissionOutcome(255), AdmissionReason(255), time.Millisecond)
		r.ObserveQueueDepth(Workload(255), int64(index))
		r.ObserveResourceUsage(ResourceKind(255), int64(index), 1000)
	}
	snapshot := r.Snapshot().Governance
	if len(snapshot.Admissions) != 1 || snapshot.Admissions[0].Workload != "other" || snapshot.Admissions[0].Outcome != "other" {
		t.Fatalf("invalid admission dimensions escaped fixed labels: %+v", snapshot.Admissions)
	}
	if len(snapshot.Queues) != 1 || snapshot.Queues[0].Workload != "other" {
		t.Fatalf("invalid queue dimensions escaped fixed labels: %+v", snapshot.Queues)
	}
	if len(snapshot.Resources) != 1 || snapshot.Resources[0].Resource != "other" {
		t.Fatalf("invalid resource dimensions escaped fixed labels: %+v", snapshot.Resources)
	}
}

func TestRegistryGovernanceConcurrentCollection(t *testing.T) {
	r := New(true, 8)
	const workers = 16
	const iterations = 250
	var wait sync.WaitGroup
	wait.Add(workers)
	for worker := 0; worker < workers; worker++ {
		go func() {
			defer wait.Done()
			for index := 0; index < iterations; index++ {
				r.ObserveAdmission(WorkloadRun, AdmissionAccepted, AdmissionReasonNone, time.Millisecond)
				r.ObserveQueueDepth(WorkloadRun, int64(index%5))
				r.ObserveResourceUsage(ResourceSlots, int64(index%4), 4)
				if index%25 == 0 {
					_ = r.Snapshot()
				}
			}
		}()
	}
	wait.Wait()

	snapshot := r.Snapshot().Governance
	want := int64(workers * iterations)
	if got := findAdmission(t, snapshot, "run", "accepted").Count; got != want {
		t.Fatalf("admission count = %d, want %d", got, want)
	}
	if got := findQueue(t, snapshot, "run").Observations; got != want {
		t.Fatalf("queue observations = %d, want %d", got, want)
	}
	if got := findResource(t, snapshot, "slots").Observations; got != want {
		t.Fatalf("resource observations = %d, want %d", got, want)
	}
}

func findAdmission(t *testing.T, snapshot GovernanceSnapshot, workload, outcome string) AdmissionSnapshot {
	t.Helper()
	for _, value := range snapshot.Admissions {
		if value.Workload == workload && value.Outcome == outcome {
			return value
		}
	}
	t.Fatalf("admission %s/%s not found in %+v", workload, outcome, snapshot.Admissions)
	return AdmissionSnapshot{}
}

func findRejection(t *testing.T, snapshot GovernanceSnapshot, workload, reason string) RejectionSnapshot {
	t.Helper()
	for _, value := range snapshot.Rejections {
		if value.Workload == workload && value.Reason == reason {
			return value
		}
	}
	t.Fatalf("rejection %s/%s not found in %+v", workload, reason, snapshot.Rejections)
	return RejectionSnapshot{}
}

func findQueue(t *testing.T, snapshot GovernanceSnapshot, workload string) QueueSnapshot {
	t.Helper()
	for _, value := range snapshot.Queues {
		if value.Workload == workload {
			return value
		}
	}
	t.Fatalf("queue %s not found in %+v", workload, snapshot.Queues)
	return QueueSnapshot{}
}

func findResource(t *testing.T, snapshot GovernanceSnapshot, resource string) ResourceSnapshot {
	t.Helper()
	for _, value := range snapshot.Resources {
		if value.Resource == resource {
			return value
		}
	}
	t.Fatalf("resource %s not found in %+v", resource, snapshot.Resources)
	return ResourceSnapshot{}
}
