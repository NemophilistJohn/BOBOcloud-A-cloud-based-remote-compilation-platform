package metrics

import (
	"sort"
	"time"
)

// Workload is deliberately a closed set. Resource-governance metrics must not
// contain user, project, image, runtime, or other attacker-controlled labels.
type Workload uint8

const (
	WorkloadRun Workload = iota
	WorkloadTask
	WorkloadTerminal
	WorkloadPackage
	WorkloadDocker
	WorkloadLSP
	WorkloadDAP
	WorkloadMaintenance
	WorkloadOther
	workloadCount
)

var workloadNames = [...]string{
	"run", "task", "terminal", "package", "docker", "lsp", "dap", "maintenance", "other",
}

func normalizeWorkload(value Workload) Workload {
	if value >= workloadCount {
		return WorkloadOther
	}
	return value
}

func (value Workload) String() string { return workloadNames[normalizeWorkload(value)] }

type AdmissionOutcome uint8

const (
	AdmissionAccepted AdmissionOutcome = iota
	AdmissionRejected
	AdmissionCancelled
	AdmissionOutcomeOther
	admissionOutcomeCount
)

var admissionOutcomeNames = [...]string{"accepted", "rejected", "cancelled", "other"}

func normalizeAdmissionOutcome(value AdmissionOutcome) AdmissionOutcome {
	if value >= admissionOutcomeCount {
		return AdmissionOutcomeOther
	}
	return value
}

func (value AdmissionOutcome) String() string {
	return admissionOutcomeNames[normalizeAdmissionOutcome(value)]
}

type AdmissionReason uint8

const (
	AdmissionReasonNone AdmissionReason = iota
	AdmissionReasonQueueFull
	AdmissionReasonQueueTimeout
	AdmissionReasonUserQuota
	AdmissionReasonGlobalCapacity
	AdmissionReasonResourcePressure
	AdmissionReasonDraining
	AdmissionReasonCancelled
	AdmissionReasonInternal
	AdmissionReasonOther
	admissionReasonCount
)

var admissionReasonNames = [...]string{
	"none", "queue_full", "queue_timeout", "user_quota", "global_capacity",
	"resource_pressure", "draining", "cancelled", "internal", "other",
}

func normalizeAdmissionReason(value AdmissionReason) AdmissionReason {
	if value >= admissionReasonCount {
		return AdmissionReasonOther
	}
	return value
}

func (value AdmissionReason) String() string {
	return admissionReasonNames[normalizeAdmissionReason(value)]
}

type ResourceKind uint8

const (
	ResourceSlots ResourceKind = iota
	ResourceDockerContainers
	ResourceCPUMillicores
	ResourceMemoryBytes
	ResourcePIDs
	ResourceEphemeralBytes
	ResourceInodes
	ResourceDevices
	ResourceLSPSessions
	ResourceDAPSessions
	ResourceOther
	resourceKindCount
)

var resourceKindNames = [...]string{
	"slots", "docker_containers", "cpu_millicores", "memory_bytes", "pids", "ephemeral_bytes", "inodes",
	"devices", "lsp_sessions", "dap_sessions", "other",
}

func normalizeResourceKind(value ResourceKind) ResourceKind {
	if value >= resourceKindCount {
		return ResourceOther
	}
	return value
}

func (value ResourceKind) String() string {
	return resourceKindNames[normalizeResourceKind(value)]
}

type rollingValues struct {
	count   int64
	total   int64
	max     int64
	samples []int64
	next    int
}

func (values *rollingValues) observe(value int64, window int) {
	if value < 0 {
		value = 0
	}
	values.count = saturatingAdd(values.count, 1)
	values.total = saturatingAdd(values.total, value)
	if value > values.max {
		values.max = value
	}
	if len(values.samples) < window {
		values.samples = append(values.samples, value)
		return
	}
	values.samples[values.next] = value
	values.next = (values.next + 1) % window
}

type resourceState struct {
	seen         bool
	inUse        int64
	capacity     int64
	peakInUse    int64
	observations int64
}

type queueState struct {
	current int64
	depths  rollingValues
}

type governanceState struct {
	admissions [workloadCount][admissionOutcomeCount]rollingValues
	rejections [workloadCount][admissionReasonCount]int64
	resources  [resourceKindCount]resourceState
	queues     [workloadCount]queueState
}

type GovernanceSnapshot struct {
	Admissions []AdmissionSnapshot `json:"admissions"`
	Rejections []RejectionSnapshot `json:"rejections"`
	Resources  []ResourceSnapshot  `json:"resources"`
	Queues     []QueueSnapshot     `json:"queues"`
}

type AdmissionSnapshot struct {
	Workload  string  `json:"workload"`
	Outcome   string  `json:"outcome"`
	Count     int64   `json:"count"`
	AverageMS float64 `json:"average_ms"`
	P50MS     float64 `json:"p50_ms"`
	P95MS     float64 `json:"p95_ms"`
	P99MS     float64 `json:"p99_ms"`
	MaxMS     float64 `json:"max_ms"`
}

type RejectionSnapshot struct {
	Workload string `json:"workload"`
	Reason   string `json:"reason"`
	Count    int64  `json:"count"`
}

type ResourceSnapshot struct {
	Resource     string  `json:"resource"`
	InUse        int64   `json:"in_use"`
	Capacity     int64   `json:"capacity"`
	PeakInUse    int64   `json:"peak_in_use"`
	Observations int64   `json:"observations"`
	Utilization  float64 `json:"utilization"`
	OverCapacity bool    `json:"over_capacity"`
}

type QueueSnapshot struct {
	Workload     string  `json:"workload"`
	Current      int64   `json:"current"`
	Peak         int64   `json:"peak"`
	Observations int64   `json:"observations"`
	Average      float64 `json:"average"`
	P50          int64   `json:"p50"`
	P95          int64   `json:"p95"`
	P99          int64   `json:"p99"`
}

// ResourceUsage is one scalar point-in-time resource gauge.
type ResourceUsage struct {
	InUse    int64
	Capacity int64
}

// ResourceObservationSnapshot mirrors the fixed scalar resource vector used by
// node admission without importing the governor package. Devices is an
// aggregate unit count; device names must never become metric labels.
type ResourceObservationSnapshot struct {
	Slots            ResourceUsage
	DockerContainers ResourceUsage
	CPUMillicores    ResourceUsage
	MemoryBytes      ResourceUsage
	PIDs             ResourceUsage
	EphemeralBytes   ResourceUsage
	Inodes           ResourceUsage
	Devices          ResourceUsage
}

func emptyGovernanceSnapshot() GovernanceSnapshot {
	return GovernanceSnapshot{
		Admissions: []AdmissionSnapshot{},
		Rejections: []RejectionSnapshot{},
		Resources:  []ResourceSnapshot{},
		Queues:     []QueueSnapshot{},
	}
}

// ObserveAdmission records one admission decision and the time spent reaching
// it. A rejection reason is retained only for rejected decisions.
func (r *Registry) ObserveAdmission(workload Workload, outcome AdmissionOutcome, reason AdmissionReason, elapsed time.Duration) {
	if !r.Enabled() {
		return
	}
	workload = normalizeWorkload(workload)
	outcome = normalizeAdmissionOutcome(outcome)
	reason = normalizeAdmissionReason(reason)
	if outcome == AdmissionRejected && reason == AdmissionReasonNone {
		reason = AdmissionReasonOther
	}
	nanos := elapsed.Nanoseconds()
	if nanos < 0 {
		nanos = 0
	}

	r.mu.Lock()
	r.governance.admissions[workload][outcome].observe(nanos, r.window)
	if outcome == AdmissionRejected {
		count := r.governance.rejections[workload][reason]
		r.governance.rejections[workload][reason] = saturatingAdd(count, 1)
	}
	r.mu.Unlock()
}

// ObserveResourceUsage updates a fixed global resource gauge. Capacity may be
// lower than in-use so temporary overcommit remains observable.
func (r *Registry) ObserveResourceUsage(resource ResourceKind, inUse, capacity int64) {
	if !r.Enabled() {
		return
	}
	resource = normalizeResourceKind(resource)
	r.mu.Lock()
	r.observeResourceUsageLocked(resource, inUse, capacity)
	r.mu.Unlock()
}

// ObserveResourceSnapshot updates the complete admission resource vector while
// taking the registry lock once. Controllers should prefer it after acquire or
// release instead of emitting seven independent gauge updates.
func (r *Registry) ObserveResourceSnapshot(snapshot ResourceObservationSnapshot) {
	if !r.Enabled() {
		return
	}
	updates := [...]struct {
		kind  ResourceKind
		usage ResourceUsage
	}{
		{ResourceSlots, snapshot.Slots},
		{ResourceDockerContainers, snapshot.DockerContainers},
		{ResourceCPUMillicores, snapshot.CPUMillicores},
		{ResourceMemoryBytes, snapshot.MemoryBytes},
		{ResourcePIDs, snapshot.PIDs},
		{ResourceEphemeralBytes, snapshot.EphemeralBytes},
		{ResourceInodes, snapshot.Inodes},
		{ResourceDevices, snapshot.Devices},
	}

	r.mu.Lock()
	for _, update := range updates {
		r.observeResourceUsageLocked(update.kind, update.usage.InUse, update.usage.Capacity)
	}
	r.mu.Unlock()
}

func (r *Registry) observeResourceUsageLocked(resource ResourceKind, inUse, capacity int64) {
	if inUse < 0 {
		inUse = 0
	}
	if capacity < 0 {
		capacity = 0
	}
	state := &r.governance.resources[resource]
	state.seen = true
	state.inUse = inUse
	state.capacity = capacity
	state.observations = saturatingAdd(state.observations, 1)
	if inUse > state.peakInUse {
		state.peakInUse = inUse
	}
}

// ObserveQueueDepth updates the current depth and a bounded rolling depth
// distribution for one fixed workload class.
func (r *Registry) ObserveQueueDepth(workload Workload, depth int64) {
	if !r.Enabled() {
		return
	}
	workload = normalizeWorkload(workload)
	if depth < 0 {
		depth = 0
	}

	r.mu.Lock()
	state := &r.governance.queues[workload]
	state.current = depth
	state.depths.observe(depth, r.window)
	r.mu.Unlock()
}

func (state *governanceState) snapshot() GovernanceSnapshot {
	result := emptyGovernanceSnapshot()
	for workload := Workload(0); workload < workloadCount; workload++ {
		for outcome := AdmissionOutcome(0); outcome < admissionOutcomeCount; outcome++ {
			values := &state.admissions[workload][outcome]
			if values.count == 0 {
				continue
			}
			snapshot := latencySnapshot(values)
			snapshot.Workload = workload.String()
			snapshot.Outcome = outcome.String()
			result.Admissions = append(result.Admissions, snapshot)
		}
		for reason := AdmissionReason(0); reason < admissionReasonCount; reason++ {
			count := state.rejections[workload][reason]
			if count == 0 {
				continue
			}
			result.Rejections = append(result.Rejections, RejectionSnapshot{
				Workload: workload.String(), Reason: reason.String(), Count: count,
			})
		}
		queue := &state.queues[workload]
		if queue.depths.count > 0 {
			result.Queues = append(result.Queues, queueSnapshot(workload, queue))
		}
	}
	for resource := ResourceKind(0); resource < resourceKindCount; resource++ {
		value := state.resources[resource]
		if !value.seen {
			continue
		}
		snapshot := ResourceSnapshot{
			Resource: resource.String(), InUse: value.inUse, Capacity: value.capacity,
			PeakInUse: value.peakInUse, Observations: value.observations,
			OverCapacity: value.capacity > 0 && value.inUse > value.capacity,
		}
		if value.capacity > 0 {
			snapshot.Utilization = float64(value.inUse) / float64(value.capacity)
		}
		result.Resources = append(result.Resources, snapshot)
	}
	return result
}

func latencySnapshot(values *rollingValues) AdmissionSnapshot {
	samples := sortedSamples(values.samples)
	result := AdmissionSnapshot{
		Count: values.count, MaxMS: millis(values.max),
	}
	if values.count > 0 {
		result.AverageMS = millis(values.total / values.count)
	}
	if len(samples) > 0 {
		result.P50MS = millis(percentile(samples, 0.50))
		result.P95MS = millis(percentile(samples, 0.95))
		result.P99MS = millis(percentile(samples, 0.99))
	}
	return result
}

func queueSnapshot(workload Workload, state *queueState) QueueSnapshot {
	samples := sortedSamples(state.depths.samples)
	result := QueueSnapshot{
		Workload: workload.String(), Current: state.current, Peak: state.depths.max,
		Observations: state.depths.count,
	}
	if state.depths.count > 0 {
		result.Average = float64(state.depths.total) / float64(state.depths.count)
	}
	if len(samples) > 0 {
		result.P50 = percentile(samples, 0.50)
		result.P95 = percentile(samples, 0.95)
		result.P99 = percentile(samples, 0.99)
	}
	return result
}

func sortedSamples(values []int64) []int64 {
	result := append([]int64(nil), values...)
	sort.Slice(result, func(left, right int) bool { return result[left] < result[right] })
	return result
}
