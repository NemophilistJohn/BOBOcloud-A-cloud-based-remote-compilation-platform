package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

const (
	ResourceGovernanceAuto  = "auto"
	ResourceGovernanceFixed = "fixed"
	ResourceGovernanceOff   = "off"
)

type ResourceProfileConfig struct {
	CPUMillicores int64            `json:"cpu_millicores"`
	MemoryMB      int64            `json:"memory_mb"`
	PIDs          int64            `json:"pids"`
	EphemeralMB   int64            `json:"ephemeral_mb"`
	Inodes        int64            `json:"inodes"`
	Devices       map[string]int64 `json:"devices,omitempty"`
}

type ResourceQueueWorkloadConfig struct {
	Weight         int `json:"weight"`
	MaxWaiting     int `json:"max_waiting"`
	TimeoutSeconds int `json:"timeout_seconds"`
}

type ResourceQueueConfig struct {
	Enabled               bool                                   `json:"enabled"`
	MaxWaiting            int                                    `json:"max_waiting"`
	MaxWaitingPerOwner    int                                    `json:"max_waiting_per_owner"`
	MaxWaitingPerProject  int                                    `json:"max_waiting_per_project"`
	AgingThresholdSeconds int                                    `json:"aging_threshold_seconds"`
	Workloads             map[string]ResourceQueueWorkloadConfig `json:"workloads"`
}

func (value *ResourceQueueConfig) UnmarshalJSON(data []byte) error {
	type rawResourceQueueConfig ResourceQueueConfig
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode((*rawResourceQueueConfig)(value)); err != nil {
		return fmt.Errorf("invalid resource_governance.queue: %w", err)
	}
	return nil
}

// ResourceGovernanceConfig controls node-wide admission. Auto uses capacities
// visible to this process (including cgroups); positive capacity fields override
// individual detected dimensions. Fixed requires explicit scalar capacities.
type ResourceGovernanceConfig struct {
	Mode                    string                           `json:"mode"`
	SlotCapacity            int64                            `json:"slot_capacity"`
	CPUCapacityMillicores   int64                            `json:"cpu_capacity_millicores"`
	MemoryCapacityMB        int64                            `json:"memory_capacity_mb"`
	PIDCapacity             int64                            `json:"pid_capacity"`
	EphemeralCapacityMB     int64                            `json:"ephemeral_capacity_mb"`
	InodeCapacity           int64                            `json:"inode_capacity"`
	CPUReservePercent       int                              `json:"cpu_reserve_percent"`
	MemoryReservePercent    int                              `json:"memory_reserve_percent"`
	PIDReservePercent       int                              `json:"pid_reserve_percent"`
	EphemeralReservePercent int                              `json:"ephemeral_reserve_percent"`
	InodeReservePercent     int                              `json:"inode_reserve_percent"`
	Devices                 map[string]int64                 `json:"devices,omitempty"`
	DeviceReserve           map[string]int64                 `json:"device_reserve,omitempty"`
	Queue                   ResourceQueueConfig              `json:"queue"`
	Workloads               map[string]ResourceProfileConfig `json:"workloads"`
}

// UnmarshalJSON keeps this safety-critical subtree strict even though the
// legacy top-level config accepts underscore-prefixed documentation fields.
// Misspelled capacity or reserve keys must not silently fall back to defaults.
func (value *ResourceGovernanceConfig) UnmarshalJSON(data []byte) error {
	type rawResourceGovernanceConfig ResourceGovernanceConfig
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode((*rawResourceGovernanceConfig)(value)); err != nil {
		return fmt.Errorf("invalid resource_governance: %w", err)
	}
	return nil
}

func DefaultResourceGovernance() ResourceGovernanceConfig {
	queueWorkloads := map[string]ResourceQueueWorkloadConfig{
		"run":         {Weight: 4, MaxWaiting: 48, TimeoutSeconds: 60},
		"task":        {Weight: 3, MaxWaiting: 24, TimeoutSeconds: 60},
		"terminal":    {Weight: 8, MaxWaiting: 24, TimeoutSeconds: 20},
		"package":     {Weight: 2, MaxWaiting: 16, TimeoutSeconds: 120},
		"lsp":         {Weight: 8, MaxWaiting: 16, TimeoutSeconds: 20},
		"dap":         {Weight: 6, MaxWaiting: 8, TimeoutSeconds: 20},
		"maintenance": {Weight: 1, MaxWaiting: 0, TimeoutSeconds: 0},
	}
	return ResourceGovernanceConfig{
		Mode:              ResourceGovernanceAuto,
		CPUReservePercent: 10, MemoryReservePercent: 15, PIDReservePercent: 10,
		EphemeralReservePercent: 10, InodeReservePercent: 10,
		Devices: make(map[string]int64), DeviceReserve: make(map[string]int64),
		Queue: ResourceQueueConfig{
			Enabled: true, MaxWaiting: 128, MaxWaitingPerOwner: 8,
			MaxWaitingPerProject: 4, AgingThresholdSeconds: 15,
			Workloads: queueWorkloads,
		},
		Workloads: map[string]ResourceProfileConfig{
			"run":         {PIDs: 256, EphemeralMB: 64, Inodes: 4_096},
			"task":        {PIDs: 256, EphemeralMB: 64, Inodes: 4_096},
			"terminal":    {PIDs: 256, EphemeralMB: 64, Inodes: 4_096},
			"package":     {PIDs: 256, EphemeralMB: 256, Inodes: 16_384},
			"lsp":         {PIDs: 256, EphemeralMB: 32, Inodes: 2_048},
			"dap":         {PIDs: 256, EphemeralMB: 64, Inodes: 4_096},
			"maintenance": {CPUMillicores: 250, MemoryMB: 128, PIDs: 64, EphemeralMB: 32, Inodes: 1_024},
		},
	}
}

func normalizeResourceGovernance(value *ResourceGovernanceConfig) error {
	if value == nil {
		return fmt.Errorf("resource governance config is required")
	}
	defaults := DefaultResourceGovernance()
	value.Mode = strings.ToLower(strings.TrimSpace(value.Mode))
	if value.Mode == "" {
		value.Mode = defaults.Mode
	}
	if value.Mode != ResourceGovernanceAuto && value.Mode != ResourceGovernanceFixed && value.Mode != ResourceGovernanceOff {
		return fmt.Errorf("resource_governance.mode must be auto, fixed, or off")
	}
	if err := normalizeResourceQueue(&value.Queue, defaults.Queue); err != nil {
		return err
	}
	for name, amount := range map[string]int64{
		"slot_capacity":           value.SlotCapacity,
		"cpu_capacity_millicores": value.CPUCapacityMillicores,
		"memory_capacity_mb":      value.MemoryCapacityMB,
		"pid_capacity":            value.PIDCapacity,
		"ephemeral_capacity_mb":   value.EphemeralCapacityMB,
		"inode_capacity":          value.InodeCapacity,
	} {
		if amount < 0 {
			return fmt.Errorf("resource_governance.%s must be non-negative", name)
		}
	}
	const bytesPerMegabyte = int64(1_000_000)
	if value.MemoryCapacityMB > math.MaxInt64/bytesPerMegabyte {
		return fmt.Errorf("resource_governance.memory_capacity_mb is too large")
	}
	if value.EphemeralCapacityMB > math.MaxInt64/bytesPerMegabyte {
		return fmt.Errorf("resource_governance.ephemeral_capacity_mb is too large")
	}
	for name, percent := range map[string]int{
		"cpu_reserve_percent":       value.CPUReservePercent,
		"memory_reserve_percent":    value.MemoryReservePercent,
		"pid_reserve_percent":       value.PIDReservePercent,
		"ephemeral_reserve_percent": value.EphemeralReservePercent,
		"inode_reserve_percent":     value.InodeReservePercent,
	} {
		if percent < 0 || percent >= 100 {
			return fmt.Errorf("resource_governance.%s must be between 0 and 99", name)
		}
	}
	if value.Mode == ResourceGovernanceFixed {
		if value.SlotCapacity <= 0 || value.CPUCapacityMillicores <= 0 || value.MemoryCapacityMB <= 0 || value.PIDCapacity <= 0 || value.EphemeralCapacityMB <= 0 || value.InodeCapacity <= 0 {
			return fmt.Errorf("resource_governance fixed mode requires every scalar capacity")
		}
	}
	for name, amount := range value.Devices {
		if strings.TrimSpace(name) != name || name == "" || amount < 0 {
			return fmt.Errorf("resource_governance device capacities must use non-empty trimmed names and non-negative values")
		}
	}
	for name, amount := range value.DeviceReserve {
		capacity, exists := value.Devices[name]
		if strings.TrimSpace(name) != name || name == "" || amount < 0 || !exists || amount > capacity {
			return fmt.Errorf("resource_governance device reserve %q is invalid", name)
		}
	}
	if value.Workloads == nil {
		value.Workloads = make(map[string]ResourceProfileConfig, len(defaults.Workloads))
	}
	for name, profile := range defaults.Workloads {
		configured, exists := value.Workloads[name]
		if !exists {
			value.Workloads[name] = profile
			continue
		}
		if configured.PIDs == 0 {
			configured.PIDs = profile.PIDs
		}
		if configured.EphemeralMB == 0 {
			configured.EphemeralMB = profile.EphemeralMB
		}
		if configured.Inodes == 0 {
			configured.Inodes = profile.Inodes
		}
		value.Workloads[name] = configured
	}
	for name, profile := range value.Workloads {
		if _, known := defaults.Workloads[name]; !known {
			return fmt.Errorf("resource_governance.workloads contains unknown workload %q", name)
		}
		if profile.CPUMillicores < 0 || profile.MemoryMB < 0 || profile.PIDs <= 0 || profile.EphemeralMB < 0 || profile.Inodes < 0 {
			return fmt.Errorf("resource_governance workload %q has invalid scalar resources", name)
		}
		if profile.MemoryMB > math.MaxInt64/bytesPerMegabyte || profile.EphemeralMB > math.MaxInt64/bytesPerMegabyte {
			return fmt.Errorf("resource_governance workload %q has a size that is too large", name)
		}
		for device, amount := range profile.Devices {
			if strings.TrimSpace(device) != device || device == "" || amount < 0 {
				return fmt.Errorf("resource_governance workload %q has an invalid device request", name)
			}
			capacity, exists := value.Devices[device]
			if amount > 0 && (!exists || amount > capacity-value.DeviceReserve[device]) {
				return fmt.Errorf("resource_governance workload %q requests unavailable device %q", name, device)
			}
		}
	}
	return nil
}

func normalizeResourceQueue(value *ResourceQueueConfig, defaults ResourceQueueConfig) error {
	if value.MaxWaiting == 0 {
		value.MaxWaiting = defaults.MaxWaiting
	}
	if value.MaxWaitingPerOwner == 0 {
		value.MaxWaitingPerOwner = defaults.MaxWaitingPerOwner
	}
	if value.MaxWaitingPerProject == 0 {
		value.MaxWaitingPerProject = defaults.MaxWaitingPerProject
	}
	if value.MaxWaiting < 0 || value.MaxWaiting > 4096 || value.MaxWaitingPerOwner < 0 || value.MaxWaitingPerProject < 0 || value.AgingThresholdSeconds < 0 || value.AgingThresholdSeconds > 600 {
		return fmt.Errorf("resource_governance.queue limits must be non-negative")
	}
	if value.Enabled && (value.MaxWaiting == 0 || value.MaxWaitingPerOwner == 0 || value.MaxWaitingPerProject == 0) {
		return fmt.Errorf("resource_governance.queue enabled mode requires positive global, owner, and project limits")
	}
	if value.MaxWaitingPerOwner > value.MaxWaiting {
		return fmt.Errorf("resource_governance.queue.max_waiting_per_owner cannot exceed max_waiting")
	}
	if value.MaxWaitingPerProject > value.MaxWaitingPerOwner {
		return fmt.Errorf("resource_governance.queue.max_waiting_per_project cannot exceed max_waiting_per_owner")
	}
	if value.Workloads == nil {
		value.Workloads = make(map[string]ResourceQueueWorkloadConfig, len(defaults.Workloads))
	}
	for name, fallback := range defaults.Workloads {
		configured, exists := value.Workloads[name]
		if !exists {
			value.Workloads[name] = fallback
			continue
		}
		if configured.Weight == 0 {
			configured.Weight = fallback.Weight
		}
		if configured.MaxWaiting == 0 && name != "maintenance" {
			configured.MaxWaiting = fallback.MaxWaiting
		}
		if configured.TimeoutSeconds == 0 && name != "maintenance" {
			configured.TimeoutSeconds = fallback.TimeoutSeconds
		}
		value.Workloads[name] = configured
	}
	for name, workload := range value.Workloads {
		if _, known := defaults.Workloads[name]; !known {
			return fmt.Errorf("resource_governance.queue.workloads contains unknown workload %q", name)
		}
		if workload.Weight <= 0 || workload.Weight > 32 || workload.MaxWaiting < 0 || workload.TimeoutSeconds < 0 || workload.TimeoutSeconds > 600 {
			return fmt.Errorf("resource_governance.queue workload %q is invalid", name)
		}
		if workload.MaxWaiting > value.MaxWaiting {
			return fmt.Errorf("resource_governance.queue workload %q max_waiting exceeds the global limit", name)
		}
		if value.Enabled && name != "maintenance" && (workload.MaxWaiting == 0 || workload.TimeoutSeconds == 0) {
			return fmt.Errorf("resource_governance.queue workload %q requires positive waiting and timeout limits", name)
		}
	}
	return nil
}
