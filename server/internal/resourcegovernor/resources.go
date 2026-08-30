// Package resourcegovernor provides a synchronous, in-memory admission ledger
// for node resources. It deliberately does not inspect Linux, cgroups, Docker,
// or filesystems; adapters supply the effective node capacity and enforce the
// acquired limits at the appropriate runtime boundary.
package resourcegovernor

import (
	"fmt"
	"strings"
)

// ResourceName identifies a scalar resource dimension.
type ResourceName string

const (
	ResourceSlots            ResourceName = "slots"
	ResourceDockerContainers ResourceName = "docker_containers"
	ResourceCPUMillicores    ResourceName = "cpu_millicores"
	ResourceMemoryBytes      ResourceName = "memory_bytes"
	ResourcePIDs             ResourceName = "pids"
	ResourceEphemeralBytes   ResourceName = "ephemeral_bytes"
	ResourceInodes           ResourceName = "inodes"
	ResourceDevice           ResourceName = "device"
)

// Resources is the resource vector admitted by Governor. All values are
// quantities, not limits or percentages, and must be non-negative.
type Resources struct {
	Slots            int64
	DockerContainers int64
	CPUMillicores    int64
	MemoryBytes      int64
	PIDs             int64
	EphemeralBytes   int64
	Inodes           int64
	Devices          map[string]int64
}

// Clone returns a copy whose Devices map is independent of the receiver.
func (resources Resources) Clone() Resources {
	cloned := resources
	cloned.Devices = cloneDevices(resources.Devices)
	return cloned
}

// Metadata identifies the admitted work without influencing admission order.
// Scheduling and activity-based policy belong above this package.
type Metadata struct {
	Workload   string
	WorkloadID string
	OwnerID    string
}

// Request is an immediate, non-blocking request for node resources.
type Request struct {
	Resources Resources
	Metadata  Metadata
}

// NodeResources describes the capacity observed by a platform adapter and the
// portion kept unavailable for the host. Usable capacity is Capacity-Reserve.
type NodeResources struct {
	Capacity Resources
	Reserve  Resources
}

// ConfigurationIssueCode classifies an invalid node resource configuration.
type ConfigurationIssueCode string

const (
	ConfigurationNegativeCapacity       ConfigurationIssueCode = "negative_capacity"
	ConfigurationNegativeReserve        ConfigurationIssueCode = "negative_reserve"
	ConfigurationReserveExceedsCapacity ConfigurationIssueCode = "reserve_exceeds_capacity"
	ConfigurationInvalidDevice          ConfigurationIssueCode = "invalid_device"
)

// ConfigurationIssue pinpoints one invalid resource dimension.
type ConfigurationIssue struct {
	Code     ConfigurationIssueCode
	Resource ResourceName
	Device   string
	Capacity int64
	Reserve  int64
}

// ConfigurationError contains every issue found in a node configuration.
type ConfigurationError struct {
	Issues []ConfigurationIssue
}

func (configurationError *ConfigurationError) Error() string {
	if configurationError == nil {
		return ""
	}
	return fmt.Sprintf("invalid resource governor configuration (%d issue(s))", len(configurationError.Issues))
}

// RejectionCode classifies an admission rejection.
type RejectionCode string

const (
	RejectionInvalidRequest        RejectionCode = "invalid_request"
	RejectionInsufficientResources RejectionCode = "insufficient_resources"
	RejectionLeaseIDExhausted      RejectionCode = "lease_id_exhausted"
)

// RejectionReasonCode classifies a single rejected resource dimension.
type RejectionReasonCode string

const (
	ReasonNegativeRequest    RejectionReasonCode = "negative_request"
	ReasonEmptyRequest       RejectionReasonCode = "empty_request"
	ReasonInvalidDevice      RejectionReasonCode = "invalid_device"
	ReasonUnavailableDevice  RejectionReasonCode = "unavailable_device"
	ReasonInsufficientAmount RejectionReasonCode = "insufficient_amount"
)

// RejectionReason exposes the complete accounting state for a rejected
// dimension. Device is populated only when Resource is ResourceDevice.
type RejectionReason struct {
	Code      RejectionReasonCode
	Resource  ResourceName
	Device    string
	Requested int64
	Available int64
	Used      int64
	Capacity  int64
	Reserve   int64
}

// Rejection is returned when an acquisition cannot be admitted. It implements
// error so callers can retain ordinary Go error handling while inspecting Code
// and Reasons with errors.As.
type Rejection struct {
	Code     RejectionCode
	Metadata Metadata
	Reasons  []RejectionReason
}

func (rejection *Rejection) Error() string {
	if rejection == nil {
		return ""
	}
	return fmt.Sprintf("resource admission rejected: %s (%d reason(s))", rejection.Code, len(rejection.Reasons))
}

func cloneDevices(devices map[string]int64) map[string]int64 {
	if devices == nil {
		return nil
	}
	cloned := make(map[string]int64, len(devices))
	for name, amount := range devices {
		cloned[name] = amount
	}
	return cloned
}

func scalarValues(resources Resources) []struct {
	name  ResourceName
	value int64
} {
	return []struct {
		name  ResourceName
		value int64
	}{
		{ResourceSlots, resources.Slots},
		{ResourceDockerContainers, resources.DockerContainers},
		{ResourceCPUMillicores, resources.CPUMillicores},
		{ResourceMemoryBytes, resources.MemoryBytes},
		{ResourcePIDs, resources.PIDs},
		{ResourceEphemeralBytes, resources.EphemeralBytes},
		{ResourceInodes, resources.Inodes},
	}
}

func deviceNameValid(name string) bool {
	return name != "" && strings.TrimSpace(name) == name
}

func resourcesZero(resources Resources) bool {
	if resources.Slots != 0 || resources.DockerContainers != 0 || resources.CPUMillicores != 0 || resources.MemoryBytes != 0 ||
		resources.PIDs != 0 || resources.EphemeralBytes != 0 || resources.Inodes != 0 {
		return false
	}
	for _, amount := range resources.Devices {
		if amount != 0 {
			return false
		}
	}
	return true
}
