package resourcegovernor

import (
	"math"
	"sort"
	"sync"
)

// Governor performs immediate hard admission against a fixed node resource
// vector. TryAcquire and Release never scan active leases; their cost is
// constant in the number of workloads and proportional only to requested
// device keys.
type Governor struct {
	mu          sync.RWMutex
	node        NodeResources
	usable      Resources
	used        Resources
	leases      map[uint64]leaseRecord
	nextLeaseID uint64
}

type leaseRecord struct {
	resources Resources
	metadata  Metadata
}

// Lease owns one admitted resource vector. Release is safe to call repeatedly
// and concurrently; exactly one call releases the accounting entry.
type Lease struct {
	governor  *Governor
	id        uint64
	resources Resources
	metadata  Metadata
	once      sync.Once
}

// LeaseSnapshot is the immutable observation form of an active lease.
type LeaseSnapshot struct {
	ID        uint64
	Resources Resources
	Metadata  Metadata
}

// Snapshot is a point-in-time, internally consistent view of the governor.
type Snapshot struct {
	Capacity  Resources
	Reserve   Resources
	Usable    Resources
	Used      Resources
	Available Resources
	Leases    []LeaseSnapshot
}

// New validates and copies a node resource vector. The caller may subsequently
// mutate its input maps without changing the governor.
func New(node NodeResources) (*Governor, error) {
	node = NodeResources{
		Capacity: node.Capacity.Clone(),
		Reserve:  node.Reserve.Clone(),
	}
	if issues := validateNode(node); len(issues) != 0 {
		return nil, &ConfigurationError{Issues: issues}
	}
	usable := subtractResources(node.Capacity, node.Reserve)
	used := Resources{Devices: make(map[string]int64, len(node.Capacity.Devices))}
	for name := range node.Capacity.Devices {
		used.Devices[name] = 0
	}
	return &Governor{
		node:   node,
		usable: usable,
		used:   used,
		leases: make(map[uint64]leaseRecord),
	}, nil
}

// TryAcquire admits request immediately or returns a structured *Rejection. It
// does not queue, block on future capacity, spawn work, or apply scheduling
// priority from Metadata.
func (governor *Governor) TryAcquire(request Request) (*Lease, error) {
	resources := request.Resources.Clone()
	if reasons := validateRequest(resources); len(reasons) != 0 {
		return nil, &Rejection{
			Code:     RejectionInvalidRequest,
			Metadata: request.Metadata,
			Reasons:  reasons,
		}
	}

	governor.mu.Lock()
	defer governor.mu.Unlock()

	if reasons := governor.insufficientReasonsLocked(resources); len(reasons) != 0 {
		return nil, &Rejection{
			Code:     RejectionInsufficientResources,
			Metadata: request.Metadata,
			Reasons:  reasons,
		}
	}
	if governor.nextLeaseID == math.MaxUint64 {
		return nil, &Rejection{
			Code:     RejectionLeaseIDExhausted,
			Metadata: request.Metadata,
		}
	}

	governor.nextLeaseID++
	id := governor.nextLeaseID
	addResources(&governor.used, resources)
	governor.leases[id] = leaseRecord{
		resources: resources.Clone(),
		metadata:  request.Metadata,
	}
	return &Lease{
		governor:  governor,
		id:        id,
		resources: resources,
		metadata:  request.Metadata,
	}, nil
}

// Acquire is the immediate-admission compatibility spelling of TryAcquire.
// Callers that need to make non-blocking behavior explicit should use
// TryAcquire.
func (governor *Governor) Acquire(request Request) (*Lease, error) {
	return governor.TryAcquire(request)
}

// ID returns the node-local monotonically increasing lease identifier.
func (lease *Lease) ID() uint64 {
	if lease == nil {
		return 0
	}
	return lease.id
}

// Resources returns a defensive copy of the admitted vector.
func (lease *Lease) Resources() Resources {
	if lease == nil {
		return Resources{}
	}
	return lease.resources.Clone()
}

// Metadata returns the workload and owner recorded at admission.
func (lease *Lease) Metadata() Metadata {
	if lease == nil {
		return Metadata{}
	}
	return lease.metadata
}

// Release returns true only for the call that released an active accounting
// entry. Repeated calls, copied stale leases, and concurrent calls are harmless.
func (lease *Lease) Release() bool {
	if lease == nil || lease.governor == nil || lease.id == 0 {
		return false
	}
	released := false
	lease.once.Do(func() {
		released = lease.governor.release(lease.id)
	})
	return released
}

func (governor *Governor) release(id uint64) bool {
	governor.mu.Lock()
	defer governor.mu.Unlock()
	record, exists := governor.leases[id]
	if !exists {
		return false
	}
	subtractResourcesInPlace(&governor.used, record.resources)
	delete(governor.leases, id)
	return true
}

// Snapshot returns copies of all resource maps and active lease records. Lease
// records are ordered by ID to make diagnostics and tests deterministic.
func (governor *Governor) Snapshot() Snapshot {
	governor.mu.RLock()
	snapshot := Snapshot{
		Capacity:  governor.node.Capacity.Clone(),
		Reserve:   governor.node.Reserve.Clone(),
		Usable:    governor.usable.Clone(),
		Used:      governor.used.Clone(),
		Available: subtractResources(governor.usable, governor.used),
		Leases:    make([]LeaseSnapshot, 0, len(governor.leases)),
	}
	for id, record := range governor.leases {
		snapshot.Leases = append(snapshot.Leases, LeaseSnapshot{
			ID:        id,
			Resources: record.resources.Clone(),
			Metadata:  record.metadata,
		})
	}
	governor.mu.RUnlock()

	sort.Slice(snapshot.Leases, func(left, right int) bool {
		return snapshot.Leases[left].ID < snapshot.Leases[right].ID
	})
	return snapshot
}

// Available returns the current usable-minus-used vector without scanning
// active leases. The scheduler uses it to build an aged-request reservation
// barrier while the governor remains the only accounting authority.
func (governor *Governor) Available() Resources {
	if governor == nil {
		return Resources{}
	}
	governor.mu.RLock()
	available := subtractResources(governor.usable, governor.used)
	governor.mu.RUnlock()
	return available
}

func validateNode(node NodeResources) []ConfigurationIssue {
	issues := make([]ConfigurationIssue, 0)
	capacityValues := scalarValues(node.Capacity)
	reserveValues := scalarValues(node.Reserve)
	for index, capacity := range capacityValues {
		reserve := reserveValues[index].value
		if capacity.value < 0 {
			issues = append(issues, ConfigurationIssue{
				Code: ConfigurationNegativeCapacity, Resource: capacity.name,
				Capacity: capacity.value, Reserve: reserve,
			})
		}
		if reserve < 0 {
			issues = append(issues, ConfigurationIssue{
				Code: ConfigurationNegativeReserve, Resource: capacity.name,
				Capacity: capacity.value, Reserve: reserve,
			})
		}
		if capacity.value >= 0 && reserve >= 0 && reserve > capacity.value {
			issues = append(issues, ConfigurationIssue{
				Code: ConfigurationReserveExceedsCapacity, Resource: capacity.name,
				Capacity: capacity.value, Reserve: reserve,
			})
		}
	}
	for name, capacity := range node.Capacity.Devices {
		reserve := node.Reserve.Devices[name]
		if !deviceNameValid(name) {
			issues = append(issues, ConfigurationIssue{
				Code: ConfigurationInvalidDevice, Resource: ResourceDevice,
				Device: name, Capacity: capacity, Reserve: reserve,
			})
		}
		if capacity < 0 {
			issues = append(issues, ConfigurationIssue{
				Code: ConfigurationNegativeCapacity, Resource: ResourceDevice,
				Device: name, Capacity: capacity, Reserve: reserve,
			})
		}
		if reserve < 0 {
			issues = append(issues, ConfigurationIssue{
				Code: ConfigurationNegativeReserve, Resource: ResourceDevice,
				Device: name, Capacity: capacity, Reserve: reserve,
			})
		}
		if capacity >= 0 && reserve >= 0 && reserve > capacity {
			issues = append(issues, ConfigurationIssue{
				Code: ConfigurationReserveExceedsCapacity, Resource: ResourceDevice,
				Device: name, Capacity: capacity, Reserve: reserve,
			})
		}
	}
	for name, reserve := range node.Reserve.Devices {
		if _, exists := node.Capacity.Devices[name]; exists {
			continue
		}
		code := ConfigurationReserveExceedsCapacity
		if !deviceNameValid(name) {
			code = ConfigurationInvalidDevice
		} else if reserve < 0 {
			code = ConfigurationNegativeReserve
		}
		issues = append(issues, ConfigurationIssue{
			Code: code, Resource: ResourceDevice, Device: name, Reserve: reserve,
		})
	}
	return issues
}

func validateRequest(resources Resources) []RejectionReason {
	reasons := make([]RejectionReason, 0)
	for _, scalar := range scalarValues(resources) {
		if scalar.value < 0 {
			reasons = append(reasons, RejectionReason{
				Code: ReasonNegativeRequest, Resource: scalar.name, Requested: scalar.value,
			})
		}
	}
	for name, amount := range resources.Devices {
		if !deviceNameValid(name) {
			reasons = append(reasons, RejectionReason{
				Code: ReasonInvalidDevice, Resource: ResourceDevice, Device: name, Requested: amount,
			})
			continue
		}
		if amount < 0 {
			reasons = append(reasons, RejectionReason{
				Code: ReasonNegativeRequest, Resource: ResourceDevice, Device: name, Requested: amount,
			})
		}
	}
	if len(reasons) == 0 && resourcesZero(resources) {
		reasons = append(reasons, RejectionReason{Code: ReasonEmptyRequest})
	}
	return reasons
}

func (governor *Governor) insufficientReasonsLocked(request Resources) []RejectionReason {
	reasons := make([]RejectionReason, 0)
	requestedValues := scalarValues(request)
	capacityValues := scalarValues(governor.node.Capacity)
	reserveValues := scalarValues(governor.node.Reserve)
	usedValues := scalarValues(governor.used)
	usableValues := scalarValues(governor.usable)
	for index, requested := range requestedValues {
		available := usableValues[index].value - usedValues[index].value
		if requested.value > available {
			reasons = append(reasons, RejectionReason{
				Code: ReasonInsufficientAmount, Resource: requested.name,
				Requested: requested.value, Available: available,
				Used: usedValues[index].value, Capacity: capacityValues[index].value,
				Reserve: reserveValues[index].value,
			})
		}
	}
	for name, requested := range request.Devices {
		if requested == 0 {
			continue
		}
		capacity, exists := governor.node.Capacity.Devices[name]
		if !exists {
			reasons = append(reasons, RejectionReason{
				Code: ReasonUnavailableDevice, Resource: ResourceDevice,
				Device: name, Requested: requested,
			})
			continue
		}
		reserve := governor.node.Reserve.Devices[name]
		used := governor.used.Devices[name]
		available := capacity - reserve - used
		if requested > available {
			reasons = append(reasons, RejectionReason{
				Code: ReasonInsufficientAmount, Resource: ResourceDevice, Device: name,
				Requested: requested, Available: available, Used: used,
				Capacity: capacity, Reserve: reserve,
			})
		}
	}
	return reasons
}

func subtractResources(left, right Resources) Resources {
	result := Resources{
		Slots:            left.Slots - right.Slots,
		DockerContainers: left.DockerContainers - right.DockerContainers,
		CPUMillicores:    left.CPUMillicores - right.CPUMillicores,
		MemoryBytes:      left.MemoryBytes - right.MemoryBytes,
		PIDs:             left.PIDs - right.PIDs,
		EphemeralBytes:   left.EphemeralBytes - right.EphemeralBytes,
		Inodes:           left.Inodes - right.Inodes,
		Devices:          make(map[string]int64, len(left.Devices)),
	}
	for name, amount := range left.Devices {
		result.Devices[name] = amount - right.Devices[name]
	}
	if left.Devices == nil && right.Devices == nil {
		result.Devices = nil
	}
	return result
}

func addResources(target *Resources, added Resources) {
	target.Slots += added.Slots
	target.DockerContainers += added.DockerContainers
	target.CPUMillicores += added.CPUMillicores
	target.MemoryBytes += added.MemoryBytes
	target.PIDs += added.PIDs
	target.EphemeralBytes += added.EphemeralBytes
	target.Inodes += added.Inodes
	for name, amount := range added.Devices {
		target.Devices[name] += amount
	}
}

func subtractResourcesInPlace(target *Resources, subtracted Resources) {
	target.Slots -= subtracted.Slots
	target.DockerContainers -= subtracted.DockerContainers
	target.CPUMillicores -= subtracted.CPUMillicores
	target.MemoryBytes -= subtracted.MemoryBytes
	target.PIDs -= subtracted.PIDs
	target.EphemeralBytes -= subtracted.EphemeralBytes
	target.Inodes -= subtracted.Inodes
	for name, amount := range subtracted.Devices {
		target.Devices[name] -= amount
	}
}
