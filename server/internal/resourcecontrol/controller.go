// Package resourcecontrol binds stable BOBOCLOUD workload classes to the
// generic node resource ledger and adds bounded, context-aware fair admission.
package resourcecontrol

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/metrics"
	"bobocloud-server/internal/resourcegovernor"
)

type Workload uint8

const (
	WorkloadRun Workload = iota
	WorkloadTask
	WorkloadTerminal
	WorkloadPackage
	WorkloadLSP
	WorkloadDAP
	WorkloadMaintenance
	workloadCount
)

var workloadNames = [...]string{
	"run", "task", "terminal", "package", "lsp", "dap", "maintenance",
}

func (workload Workload) String() string {
	if workload >= workloadCount {
		return "unknown"
	}
	return workloadNames[workload]
}

type Profiles map[Workload]resourcegovernor.Resources

type Controller struct {
	governor *resourcegovernor.Governor
	metrics  *metrics.Registry
	profiles [workloadCount]resourcegovernor.Resources
	usable   resourcegovernor.Resources
	queue    *fairQueue

	mu       sync.Mutex
	used     resourcegovernor.Resources
	draining bool
}

type Lease struct {
	controller *Controller
	inner      *resourcegovernor.Lease
	workload   Workload
	resources  resourcegovernor.Resources
	wait       time.Duration
	once       sync.Once
}

type QueueSnapshot struct {
	Enabled  bool
	Draining bool
	Total    int
	Depths   map[string]int
}

type admissionObservation struct {
	workload Workload
	outcome  metrics.AdmissionOutcome
	reason   metrics.AdmissionReason
	elapsed  time.Duration
}

func New(governor *resourcegovernor.Governor, profiles Profiles, registry *metrics.Registry) (*Controller, error) {
	return newController(governor, profiles, registry, QueuePolicy{})
}

func NewWithQueue(governor *resourcegovernor.Governor, profiles Profiles, registry *metrics.Registry, policy QueuePolicy) (*Controller, error) {
	return newController(governor, profiles, registry, policy)
}

func newController(governor *resourcegovernor.Governor, profiles Profiles, registry *metrics.Registry, policy QueuePolicy) (*Controller, error) {
	if governor == nil {
		return nil, fmt.Errorf("resource governor is required")
	}
	if err := validateQueuePolicy(policy); err != nil {
		return nil, err
	}
	controller := &Controller{governor: governor, metrics: registry}
	for workload := Workload(0); workload < workloadCount; workload++ {
		resources, exists := profiles[workload]
		if !exists {
			return nil, fmt.Errorf("resource profile %s is required", workload)
		}
		if resources.Slots <= 0 {
			return nil, fmt.Errorf("resource profile %s must reserve at least one slot", workload)
		}
		if err := validateMinimumDemand(resources); err != nil {
			return nil, fmt.Errorf("resource profile %s: %w", workload, err)
		}
		controller.profiles[workload] = resources.Clone()
	}
	controller.usable = governor.Snapshot().Usable
	if policy.Enabled {
		controller.queue = newFairQueue(policy)
	}
	controller.observeUsage(resourcegovernor.Resources{})
	return controller, nil
}

func validateQueuePolicy(policy QueuePolicy) error {
	if !policy.Enabled {
		return nil
	}
	if policy.MaxWaiting <= 0 || policy.MaxWaiting > 4096 {
		return fmt.Errorf("resource queue max waiting must be between 1 and 4096")
	}
	if policy.MaxWaitingPerOwner <= 0 || policy.MaxWaitingPerOwner > policy.MaxWaiting {
		return fmt.Errorf("resource queue owner limit must be positive and no larger than the global limit")
	}
	if policy.MaxWaitingPerProject <= 0 || policy.MaxWaitingPerProject > policy.MaxWaitingPerOwner {
		return fmt.Errorf("resource queue project limit must be positive and no larger than the owner limit")
	}
	if policy.AgingThreshold < 0 || policy.AgingThreshold > 10*time.Minute {
		return fmt.Errorf("resource queue aging threshold must be between zero and ten minutes")
	}
	for workload := Workload(0); workload < workloadCount; workload++ {
		entry := policy.Workloads[workload]
		if entry.Weight <= 0 || entry.Weight > 32 {
			return fmt.Errorf("resource queue workload %s weight must be between 1 and 32", workload)
		}
		if entry.MaxWaiting < 0 || entry.MaxWaiting > policy.MaxWaiting {
			return fmt.Errorf("resource queue workload %s waiting limit is invalid", workload)
		}
		if entry.MaxWait < 0 || entry.MaxWait > 10*time.Minute {
			return fmt.Errorf("resource queue workload %s timeout is invalid", workload)
		}
		if entry.MaxWaiting > 0 && entry.MaxWait <= 0 {
			return fmt.Errorf("resource queue workload %s requires a positive timeout", workload)
		}
	}
	return nil
}

func (controller *Controller) QueueEnabled() bool {
	return controller != nil && controller.queue != nil
}

// TryAcquire is the compatibility no-wait path. It never bypasses existing
// waiters; production interactive paths use Acquire when waiting is allowed.
func (controller *Controller) TryAcquire(workload Workload, ownerID, workloadID string) (*Lease, error) {
	return controller.TryAcquireWithDemand(workload, ownerID, workloadID, resourcegovernor.Resources{})
}

func (controller *Controller) TryAcquireWithDemand(workload Workload, ownerID, workloadID string, minimum resourcegovernor.Resources) (*Lease, error) {
	return controller.TryAcquireAdmission(Admission{
		Workload: workload, OwnerID: ownerID, ScopeID: "default", WorkloadID: workloadID, Minimum: minimum,
	})
}

func (controller *Controller) TryAcquireAdmission(admission Admission) (*Lease, error) {
	started := time.Now()
	admission, resources, err := controller.prepareAdmission(admission)
	if err != nil {
		controller.observeAdmission(admission.Workload, metrics.AdmissionRejected, metrics.AdmissionReasonInternal, time.Since(started))
		return nil, err
	}
	controller.mu.Lock()
	if controller.draining {
		controller.mu.Unlock()
		err := newAdmissionError(AdmissionDraining, admission, nil)
		controller.observeAdmission(admission.Workload, metrics.AdmissionRejected, metrics.AdmissionReasonDraining, time.Since(started))
		return nil, err
	}
	if controller.queue != nil && controller.queue.total > 0 {
		controller.mu.Unlock()
		err := newAdmissionError(AdmissionQueueFull, admission, nil)
		controller.observeAdmission(admission.Workload, metrics.AdmissionRejected, metrics.AdmissionReasonQueueFull, time.Since(started))
		return nil, err
	}
	inner, err := controller.governor.TryAcquire(governorRequest(admission, resources))
	if err != nil {
		controller.mu.Unlock()
		controller.observeAdmission(admission.Workload, metrics.AdmissionRejected, admissionReason(err), time.Since(started))
		return nil, err
	}
	add(&controller.used, resources)
	used := controller.used.Clone()
	controller.mu.Unlock()
	lease := &Lease{controller: controller, inner: inner, workload: admission.Workload, resources: resources}
	controller.observeUsage(used)
	controller.observeAdmission(admission.Workload, metrics.AdmissionAccepted, metrics.AdmissionReasonNone, time.Since(started))
	return lease, nil
}

// Acquire waits in the bounded fair queue only when immediate capacity is not
// available. The caller context and workload timeout both cancel the wait.
func (controller *Controller) Acquire(ctx context.Context, admission Admission) (*Lease, error) {
	started := time.Now()
	ctx = nonNilContext(ctx)
	admission, resources, err := controller.prepareAdmission(admission)
	if err != nil {
		controller.observeAdmission(admission.Workload, metrics.AdmissionRejected, metrics.AdmissionReasonInternal, time.Since(started))
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		admissionErr := newAdmissionError(AdmissionCancelled, admission, err)
		controller.observeAdmission(admission.Workload, metrics.AdmissionCancelled, metrics.AdmissionReasonCancelled, time.Since(started))
		return nil, admissionErr
	}
	if controller.queue == nil || controller.queue.policy.Workloads[admission.Workload].MaxWaiting == 0 {
		return controller.TryAcquireAdmission(admission)
	}

	waitCtx, cancel := context.WithTimeout(ctx, controller.queue.policy.Workloads[admission.Workload].MaxWait)
	defer cancel()
	item := &queuedAdmission{
		admission: admission, resources: resources, ctx: waitCtx, started: started,
		enqueuedAt: time.Now(), result: make(chan queuedResult, 1), state: queuedWaiting,
	}

	controller.mu.Lock()
	if controller.draining {
		controller.mu.Unlock()
		err := newAdmissionError(AdmissionDraining, admission, nil)
		controller.observeAdmission(admission.Workload, metrics.AdmissionRejected, metrics.AdmissionReasonDraining, time.Since(started))
		return nil, err
	}
	if controller.queue.total == 0 {
		inner, acquireErr := controller.governor.TryAcquire(governorRequest(admission, resources))
		if acquireErr == nil {
			add(&controller.used, resources)
			used := controller.used.Clone()
			controller.mu.Unlock()
			lease := &Lease{controller: controller, inner: inner, workload: admission.Workload, resources: resources}
			controller.observeUsage(used)
			controller.observeAdmission(admission.Workload, metrics.AdmissionAccepted, metrics.AdmissionReasonNone, time.Since(started))
			return lease, nil
		}
		if !isInsufficient(acquireErr) {
			controller.mu.Unlock()
			controller.observeAdmission(admission.Workload, metrics.AdmissionRejected, admissionReason(acquireErr), time.Since(started))
			return nil, acquireErr
		}
	}
	if !resourcesFit(resources, controller.usable) {
		controller.mu.Unlock()
		err := newAdmissionError(AdmissionImpossible, admission, nil)
		controller.observeAdmission(admission.Workload, metrics.AdmissionRejected, metrics.AdmissionReasonGlobalCapacity, time.Since(started))
		return nil, err
	}
	if code := controller.queue.canEnqueue(admission); code != "" {
		controller.mu.Unlock()
		err := newAdmissionError(code, admission, nil)
		controller.observeAdmission(admission.Workload, metrics.AdmissionRejected, queueLimitReason(code), time.Since(started))
		return nil, err
	}
	controller.queue.enqueue(item)
	events := controller.dispatchLocked(time.Now())
	depths := controller.queue.depths()
	used := controller.used.Clone()
	controller.mu.Unlock()
	controller.publish(events, depths, true, used, len(events) > 0)

	select {
	case result := <-item.result:
		return result.lease, result.err
	case <-waitCtx.Done():
		controller.mu.Lock()
		if item.state == queuedWaiting && controller.queue.remove(item) {
			item.state = queuedFinished
			events = controller.dispatchLocked(time.Now())
			depths = controller.queue.depths()
			used = controller.used.Clone()
			controller.mu.Unlock()
			code := AdmissionCancelled
			reason := metrics.AdmissionReasonCancelled
			outcome := metrics.AdmissionCancelled
			if errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
				code = AdmissionQueueTimeout
				reason = metrics.AdmissionReasonQueueTimeout
				outcome = metrics.AdmissionRejected
			}
			controller.publish(events, depths, true, used, len(events) > 0)
			controller.observeAdmission(admission.Workload, outcome, reason, time.Since(started))
			return nil, newAdmissionError(code, admission, waitCtx.Err())
		}
		state := item.state
		controller.mu.Unlock()
		if state == queuedGranted || state == queuedFinished {
			result := <-item.result
			return result.lease, result.err
		}
		return nil, newAdmissionError(AdmissionCancelled, admission, waitCtx.Err())
	}
}

func (controller *Controller) prepareAdmission(admission Admission) (Admission, resourcegovernor.Resources, error) {
	if controller == nil || controller.governor == nil || admission.Workload >= workloadCount {
		return admission, resourcegovernor.Resources{}, fmt.Errorf("resource control is unavailable for workload %d", admission.Workload)
	}
	if err := validateMinimumDemand(admission.Minimum); err != nil {
		return admission, resourcegovernor.Resources{}, err
	}
	admission = normalizeAdmission(admission)
	return admission, raiseToMinimum(controller.profiles[admission.Workload], admission.Minimum), nil
}

func governorRequest(admission Admission, resources resourcegovernor.Resources) resourcegovernor.Request {
	return resourcegovernor.Request{Resources: resources, Metadata: resourcegovernor.Metadata{
		Workload: admission.Workload.String(), OwnerID: admission.OwnerID, WorkloadID: admission.WorkloadID,
	}}
}

func (controller *Controller) dispatchLocked(now time.Time) []admissionObservation {
	if controller.queue == nil || controller.draining {
		return nil
	}
	events := make([]admissionObservation, 0)
	for controller.queue.total > 0 {
		progressed := false
		var barrier resourcegovernor.Resources
		aged := controller.queue.agedCandidates(now)
		if len(aged) > 0 {
			candidate := aged[0]
			granted, terminal, event := controller.tryCandidateLocked(candidate, now)
			if event != nil {
				events = append(events, *event)
			}
			if granted || terminal {
				progressed = true
				continue
			}
			barrier = resourceDeficit(candidate.item.resources, controller.governor.Available())
		}

		for _, workload := range controller.queue.weightedWorkloads() {
			for _, candidate := range controller.queue.candidates(workload) {
				if consumesDeficit(candidate.item.resources, barrier) {
					continue
				}
				granted, terminal, event := controller.tryCandidateLocked(candidate, now)
				if event != nil {
					events = append(events, *event)
				}
				if granted {
					controller.queue.advanceAfter(workload)
					progressed = true
					break
				}
				if terminal {
					progressed = true
					break
				}
			}
			if progressed {
				break
			}
		}
		if !progressed {
			break
		}
	}
	return events
}

func (controller *Controller) tryCandidateLocked(candidate queueCandidate, now time.Time) (granted, terminal bool, event *admissionObservation) {
	item := candidate.item
	if err := item.ctx.Err(); err != nil {
		if controller.queue.pop(candidate) == nil {
			return false, false, nil
		}
		item.state = queuedFinished
		admissionErr := newAdmissionError(AdmissionCancelled, item.admission, err)
		item.result <- queuedResult{err: admissionErr}
		outcome := metrics.AdmissionCancelled
		reason := metrics.AdmissionReasonCancelled
		if errors.Is(err, context.DeadlineExceeded) {
			outcome = metrics.AdmissionRejected
			reason = metrics.AdmissionReasonQueueTimeout
		}
		return false, true, &admissionObservation{workload: item.admission.Workload, outcome: outcome, reason: reason, elapsed: now.Sub(item.started)}
	}
	inner, err := controller.governor.TryAcquire(governorRequest(item.admission, item.resources))
	if err != nil {
		if isInsufficient(err) {
			return false, false, nil
		}
		if controller.queue.pop(candidate) == nil {
			return false, false, nil
		}
		item.state = queuedFinished
		item.result <- queuedResult{err: err}
		return false, true, &admissionObservation{workload: item.admission.Workload, outcome: metrics.AdmissionRejected, reason: admissionReason(err), elapsed: now.Sub(item.started)}
	}
	if controller.queue.pop(candidate) == nil {
		inner.Release()
		return false, false, nil
	}
	add(&controller.used, item.resources)
	lease := &Lease{
		controller: controller, inner: inner, workload: item.admission.Workload,
		resources: item.resources, wait: now.Sub(item.enqueuedAt),
	}
	item.state = queuedGranted
	item.result <- queuedResult{lease: lease}
	return true, false, &admissionObservation{workload: item.admission.Workload, outcome: metrics.AdmissionAccepted, reason: metrics.AdmissionReasonNone, elapsed: now.Sub(item.started)}
}

// BeginDrain rejects new admissions and wakes every queued caller. Active
// leases remain owned by their workloads and release through normal cleanup.
func (controller *Controller) BeginDrain(cause error) {
	if controller == nil {
		return
	}
	controller.mu.Lock()
	if controller.draining {
		controller.mu.Unlock()
		return
	}
	controller.draining = true
	events := make([]admissionObservation, 0)
	if controller.queue != nil {
		for workload := Workload(0); workload < workloadCount; workload++ {
			for controller.queue.classes[workload].depth > 0 {
				candidates := controller.queue.candidates(workload)
				if len(candidates) == 0 {
					break
				}
				item := controller.queue.pop(candidates[0])
				if item == nil {
					break
				}
				item.state = queuedFinished
				item.result <- queuedResult{err: newAdmissionError(AdmissionDraining, item.admission, cause)}
				events = append(events, admissionObservation{
					workload: item.admission.Workload, outcome: metrics.AdmissionRejected,
					reason: metrics.AdmissionReasonDraining, elapsed: time.Since(item.started),
				})
			}
		}
	}
	depths := controller.queueDepthsLocked()
	controller.mu.Unlock()
	controller.publish(events, depths, true, resourcegovernor.Resources{}, false)
}

func (controller *Controller) Close() { controller.BeginDrain(nil) }

func (lease *Lease) WaitDuration() time.Duration {
	if lease == nil {
		return 0
	}
	return lease.wait
}

func (lease *Lease) Release() bool {
	if lease == nil || lease.inner == nil || lease.controller == nil {
		return false
	}
	released := false
	lease.once.Do(func() {
		if !lease.inner.Release() {
			return
		}
		released = true
		controller := lease.controller
		controller.mu.Lock()
		subtract(&controller.used, lease.resources)
		events := controller.dispatchLocked(time.Now())
		depths := controller.queueDepthsLocked()
		used := controller.used.Clone()
		controller.mu.Unlock()
		controller.publish(events, depths, controller.queue != nil, used, true)
	})
	return released
}

func (controller *Controller) Snapshot() resourcegovernor.Snapshot {
	if controller == nil || controller.governor == nil {
		return resourcegovernor.Snapshot{}
	}
	return controller.governor.Snapshot()
}

func (controller *Controller) QueueSnapshot() QueueSnapshot {
	if controller == nil {
		return QueueSnapshot{Depths: map[string]int{}}
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	result := QueueSnapshot{Enabled: controller.queue != nil, Draining: controller.draining, Depths: make(map[string]int)}
	if controller.queue != nil {
		result.Total = controller.queue.total
		for workload := Workload(0); workload < workloadCount; workload++ {
			result.Depths[workload.String()] = controller.queue.classes[workload].depth
		}
	}
	return result
}

func validateMinimumDemand(value resourcegovernor.Resources) error {
	if value.Slots < 0 || value.DockerContainers < 0 || value.CPUMillicores < 0 || value.MemoryBytes < 0 || value.PIDs < 0 || value.EphemeralBytes < 0 || value.Inodes < 0 {
		return fmt.Errorf("resource demand must be non-negative")
	}
	for name, amount := range value.Devices {
		if name == "" || strings.TrimSpace(name) != name || amount < 0 {
			return fmt.Errorf("resource demand contains an invalid device")
		}
	}
	return nil
}

func raiseToMinimum(profile, minimum resourcegovernor.Resources) resourcegovernor.Resources {
	result := profile.Clone()
	result.Slots = max(result.Slots, minimum.Slots)
	result.DockerContainers = max(result.DockerContainers, minimum.DockerContainers)
	result.CPUMillicores = max(result.CPUMillicores, minimum.CPUMillicores)
	result.MemoryBytes = max(result.MemoryBytes, minimum.MemoryBytes)
	result.PIDs = max(result.PIDs, minimum.PIDs)
	result.EphemeralBytes = max(result.EphemeralBytes, minimum.EphemeralBytes)
	result.Inodes = max(result.Inodes, minimum.Inodes)
	if len(minimum.Devices) > 0 && result.Devices == nil {
		result.Devices = make(map[string]int64, len(minimum.Devices))
	}
	for name, amount := range minimum.Devices {
		result.Devices[name] = max(result.Devices[name], amount)
	}
	return result
}

func resourcesFit(request, available resourcegovernor.Resources) bool {
	if request.Slots > available.Slots || request.DockerContainers > available.DockerContainers ||
		request.CPUMillicores > available.CPUMillicores || request.MemoryBytes > available.MemoryBytes ||
		request.PIDs > available.PIDs || request.EphemeralBytes > available.EphemeralBytes || request.Inodes > available.Inodes {
		return false
	}
	for name, amount := range request.Devices {
		if amount > available.Devices[name] {
			return false
		}
	}
	return true
}

func resourceDeficit(request, available resourcegovernor.Resources) resourcegovernor.Resources {
	result := resourcegovernor.Resources{Devices: make(map[string]int64)}
	if request.Slots > available.Slots {
		result.Slots = request.Slots - available.Slots
	}
	if request.DockerContainers > available.DockerContainers {
		result.DockerContainers = request.DockerContainers - available.DockerContainers
	}
	if request.CPUMillicores > available.CPUMillicores {
		result.CPUMillicores = request.CPUMillicores - available.CPUMillicores
	}
	if request.MemoryBytes > available.MemoryBytes {
		result.MemoryBytes = request.MemoryBytes - available.MemoryBytes
	}
	if request.PIDs > available.PIDs {
		result.PIDs = request.PIDs - available.PIDs
	}
	if request.EphemeralBytes > available.EphemeralBytes {
		result.EphemeralBytes = request.EphemeralBytes - available.EphemeralBytes
	}
	if request.Inodes > available.Inodes {
		result.Inodes = request.Inodes - available.Inodes
	}
	for name, amount := range request.Devices {
		if amount > available.Devices[name] {
			result.Devices[name] = amount - available.Devices[name]
		}
	}
	return result
}

func consumesDeficit(request, deficit resourcegovernor.Resources) bool {
	if (deficit.Slots > 0 && request.Slots > 0) || (deficit.DockerContainers > 0 && request.DockerContainers > 0) ||
		(deficit.CPUMillicores > 0 && request.CPUMillicores > 0) || (deficit.MemoryBytes > 0 && request.MemoryBytes > 0) ||
		(deficit.PIDs > 0 && request.PIDs > 0) || (deficit.EphemeralBytes > 0 && request.EphemeralBytes > 0) ||
		(deficit.Inodes > 0 && request.Inodes > 0) {
		return true
	}
	for name, amount := range deficit.Devices {
		if amount > 0 && request.Devices[name] > 0 {
			return true
		}
	}
	return false
}

func isInsufficient(err error) bool {
	var rejection *resourcegovernor.Rejection
	return errors.As(err, &rejection) && rejection.Code == resourcegovernor.RejectionInsufficientResources
}

func newAdmissionError(code AdmissionErrorCode, admission Admission, cause error) *AdmissionError {
	return &AdmissionError{Code: code, Workload: admission.Workload, OwnerID: admission.OwnerID, ScopeID: admission.ScopeID, Cause: cause}
}

func queueLimitReason(code AdmissionErrorCode) metrics.AdmissionReason {
	if code == AdmissionOwnerQueueFull || code == AdmissionProjectQueueFull {
		return metrics.AdmissionReasonUserQuota
	}
	return metrics.AdmissionReasonQueueFull
}

func admissionReason(err error) metrics.AdmissionReason {
	if isInsufficient(err) {
		return metrics.AdmissionReasonResourcePressure
	}
	return metrics.AdmissionReasonInternal
}

func (controller *Controller) publish(events []admissionObservation, depths [workloadCount]int64, observeDepths bool, used resourcegovernor.Resources, observeUsage bool) {
	if observeDepths {
		controller.observeQueueDepths(depths)
	}
	if observeUsage {
		controller.observeUsage(used)
	}
	for _, event := range events {
		controller.observeAdmission(event.workload, event.outcome, event.reason, event.elapsed)
	}
}

func (controller *Controller) queueDepthsLocked() [workloadCount]int64 {
	if controller.queue == nil {
		return [workloadCount]int64{}
	}
	return controller.queue.depths()
}

func (controller *Controller) observeQueueDepths(depths [workloadCount]int64) {
	if controller.metrics == nil {
		return
	}
	for workload := Workload(0); workload < workloadCount; workload++ {
		controller.metrics.ObserveQueueDepth(metricsWorkload(workload), depths[workload])
	}
}

func (controller *Controller) observeAdmission(workload Workload, outcome metrics.AdmissionOutcome, reason metrics.AdmissionReason, elapsed time.Duration) {
	if controller == nil || controller.metrics == nil {
		return
	}
	controller.metrics.ObserveAdmission(metricsWorkload(workload), outcome, reason, elapsed)
}

func (controller *Controller) observeUsage(used resourcegovernor.Resources) {
	if controller == nil || controller.metrics == nil {
		return
	}
	controller.metrics.ObserveResourceSnapshot(metrics.ResourceObservationSnapshot{
		Slots:            metrics.ResourceUsage{InUse: used.Slots, Capacity: controller.usable.Slots},
		DockerContainers: metrics.ResourceUsage{InUse: used.DockerContainers, Capacity: controller.usable.DockerContainers},
		CPUMillicores:    metrics.ResourceUsage{InUse: used.CPUMillicores, Capacity: controller.usable.CPUMillicores},
		MemoryBytes:      metrics.ResourceUsage{InUse: used.MemoryBytes, Capacity: controller.usable.MemoryBytes},
		PIDs:             metrics.ResourceUsage{InUse: used.PIDs, Capacity: controller.usable.PIDs},
		EphemeralBytes:   metrics.ResourceUsage{InUse: used.EphemeralBytes, Capacity: controller.usable.EphemeralBytes},
		Inodes:           metrics.ResourceUsage{InUse: used.Inodes, Capacity: controller.usable.Inodes},
		Devices:          metrics.ResourceUsage{InUse: totalDevices(used.Devices), Capacity: totalDevices(controller.usable.Devices)},
	})
}

func totalDevices(devices map[string]int64) int64 {
	var total int64
	for _, amount := range devices {
		if amount > 0 && total > math.MaxInt64-amount {
			return math.MaxInt64
		}
		total += amount
	}
	return total
}

func metricsWorkload(workload Workload) metrics.Workload {
	switch workload {
	case WorkloadRun:
		return metrics.WorkloadRun
	case WorkloadTask:
		return metrics.WorkloadTask
	case WorkloadTerminal:
		return metrics.WorkloadTerminal
	case WorkloadPackage:
		return metrics.WorkloadPackage
	case WorkloadLSP:
		return metrics.WorkloadLSP
	case WorkloadDAP:
		return metrics.WorkloadDAP
	case WorkloadMaintenance:
		return metrics.WorkloadMaintenance
	default:
		return metrics.WorkloadOther
	}
}

func add(target *resourcegovernor.Resources, resources resourcegovernor.Resources) {
	target.Slots += resources.Slots
	target.DockerContainers += resources.DockerContainers
	target.CPUMillicores += resources.CPUMillicores
	target.MemoryBytes += resources.MemoryBytes
	target.PIDs += resources.PIDs
	target.EphemeralBytes += resources.EphemeralBytes
	target.Inodes += resources.Inodes
	if len(resources.Devices) > 0 && target.Devices == nil {
		target.Devices = make(map[string]int64, len(resources.Devices))
	}
	for name, amount := range resources.Devices {
		target.Devices[name] += amount
	}
}

func subtract(target *resourcegovernor.Resources, resources resourcegovernor.Resources) {
	target.Slots -= resources.Slots
	target.DockerContainers -= resources.DockerContainers
	target.CPUMillicores -= resources.CPUMillicores
	target.MemoryBytes -= resources.MemoryBytes
	target.PIDs -= resources.PIDs
	target.EphemeralBytes -= resources.EphemeralBytes
	target.Inodes -= resources.Inodes
	for name, amount := range resources.Devices {
		target.Devices[name] -= amount
	}
}
