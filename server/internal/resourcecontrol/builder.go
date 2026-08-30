package resourcecontrol

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/hostresource"
	"bobocloud-server/internal/metrics"
	"bobocloud-server/internal/resourcegovernor"
	"bobocloud-server/internal/resourceunit"
)

const (
	bytesPerMegabyte          = int64(1_000_000)
	containerProcessHardLimit = int64(256)
)

type BuildInfo struct {
	Mode     string
	Detected hostresource.Capacity
	Node     resourcegovernor.NodeResources
	Profiles Profiles
}

func Build(cfg *config.Config, detected hostresource.Capacity, registry *metrics.Registry) (*Controller, BuildInfo, error) {
	if cfg == nil {
		return nil, BuildInfo{}, fmt.Errorf("server config is required")
	}
	settings := cfg.ResourceGovernance
	info := BuildInfo{Mode: settings.Mode, Detected: detected}
	if settings.Mode == config.ResourceGovernanceOff {
		return nil, info, nil
	}

	dockerCPU, err := parseCPUMillicores(cfg.DockerCPULimit)
	if err != nil {
		return nil, info, fmt.Errorf("parse docker_cpu_limit: %w", err)
	}
	dockerMemory, err := parseBytes(cfg.DockerMemoryLimit)
	if err != nil {
		return nil, info, fmt.Errorf("parse docker_memory_limit: %w", err)
	}
	lspCPU, err := parseCPUMillicores(cfg.LSPCPULimit)
	if err != nil {
		return nil, info, fmt.Errorf("parse lsp_cpu_limit: %w", err)
	}
	lspMemory, err := parseBytes(cfg.LSPMemoryLimit)
	if err != nil {
		return nil, info, fmt.Errorf("parse lsp_memory_limit: %w", err)
	}
	dapCPU, err := parseCPUMillicores(cfg.DAPCPULimit)
	if err != nil {
		return nil, info, fmt.Errorf("parse dap_cpu_limit: %w", err)
	}
	dapMemory, err := parseBytes(cfg.DAPMemoryLimit)
	if err != nil {
		return nil, info, fmt.Errorf("parse dap_memory_limit: %w", err)
	}
	profiles := make(Profiles, workloadCount)
	for workload := Workload(0); workload < workloadCount; workload++ {
		profile := settings.Workloads[workload.String()]
		fallbackCPU, fallbackMemory := dockerCPU, dockerMemory
		pids := profile.PIDs
		switch workload {
		case WorkloadLSP:
			fallbackCPU, fallbackMemory = lspCPU, lspMemory
			pids = containerProcessHardLimit
		case WorkloadDAP:
			fallbackCPU, fallbackMemory = dapCPU, dapMemory
			pids = containerProcessHardLimit
		case WorkloadMaintenance:
			fallbackCPU, fallbackMemory = 250, 128*bytesPerMegabyte
		default:
			if cfg.DockerHardening {
				pids = containerProcessHardLimit
			}
		}
		cpu := profile.CPUMillicores
		if cpu == 0 {
			cpu = fallbackCPU
		} else if workload != WorkloadMaintenance {
			cpu = max(cpu, fallbackCPU)
		}
		memory, err := megabytesToBytes(profile.MemoryMB)
		if err != nil {
			return nil, info, fmt.Errorf("resource profile %s memory: %w", workload, err)
		}
		if memory == 0 {
			memory = fallbackMemory
		} else if workload != WorkloadMaintenance {
			memory = max(memory, fallbackMemory)
		}
		ephemeral, err := megabytesToBytes(profile.EphemeralMB)
		if err != nil {
			return nil, info, fmt.Errorf("resource profile %s ephemeral storage: %w", workload, err)
		}
		resources := resourcegovernor.Resources{
			Slots: 1, CPUMillicores: cpu, MemoryBytes: memory, PIDs: pids,
			EphemeralBytes: ephemeral, Inodes: profile.Inodes,
			Devices: cloneDevices(profile.Devices),
		}
		switch workload {
		case WorkloadTask, WorkloadTerminal, WorkloadPackage:
			resources.DockerContainers = 1
		}
		profiles[workload] = resources
	}
	info.Profiles = profiles

	dockerSlots := int64(max(cfg.DockerMaxContainers, 1))
	configuredSlots := dockerSlots
	if cfg.LSPEnabled {
		configuredSlots, err = addNonnegative(configuredSlots, int64(max(cfg.LSPMaxSessions, 0)))
		if err != nil {
			return nil, info, fmt.Errorf("configured LSP slots: %w", err)
		}
	}
	if cfg.DAPEnabled {
		configuredSlots, err = addNonnegative(configuredSlots, int64(max(cfg.DAPMaxSessions, 0)))
		if err != nil {
			return nil, info, fmt.Errorf("configured DAP slots: %w", err)
		}
	}
	configuredSlots, err = addNonnegative(configuredSlots, 1) // one bounded maintenance operation
	if err != nil {
		return nil, info, fmt.Errorf("configured maintenance slot: %w", err)
	}
	worstDocker := maximumResources(profiles[WorkloadRun], profiles[WorkloadTask], profiles[WorkloadTerminal], profiles[WorkloadPackage])
	required, err := multiplyResources(worstDocker, dockerSlots)
	if err != nil {
		return nil, info, fmt.Errorf("docker resource capacity: %w", err)
	}
	if cfg.LSPEnabled {
		lspRequired, multiplyErr := multiplyResources(profiles[WorkloadLSP], int64(max(cfg.LSPMaxSessions, 0)))
		if multiplyErr != nil {
			return nil, info, fmt.Errorf("LSP resource capacity: %w", multiplyErr)
		}
		if err := addResourcesChecked(&required, lspRequired); err != nil {
			return nil, info, fmt.Errorf("combined LSP resource capacity: %w", err)
		}
	}
	if cfg.DAPEnabled {
		dapRequired, multiplyErr := multiplyResources(profiles[WorkloadDAP], int64(max(cfg.DAPMaxSessions, 0)))
		if multiplyErr != nil {
			return nil, info, fmt.Errorf("DAP resource capacity: %w", multiplyErr)
		}
		if err := addResourcesChecked(&required, dapRequired); err != nil {
			return nil, info, fmt.Errorf("combined DAP resource capacity: %w", err)
		}
	}
	if err := addResourcesChecked(&required, profiles[WorkloadMaintenance]); err != nil {
		return nil, info, fmt.Errorf("combined maintenance resource capacity: %w", err)
	}

	memoryCapacity, err := megabytesToBytes(settings.MemoryCapacityMB)
	if err != nil {
		return nil, info, fmt.Errorf("memory capacity: %w", err)
	}
	ephemeralCapacity, err := megabytesToBytes(settings.EphemeralCapacityMB)
	if err != nil {
		return nil, info, fmt.Errorf("ephemeral capacity: %w", err)
	}

	capacity := resourcegovernor.Resources{
		Slots:            chooseCapacity(settings.SlotCapacity, configuredSlots),
		DockerContainers: dockerSlots,
		CPUMillicores:    chooseCapacity(settings.CPUCapacityMillicores, detected.CPUMillicores),
		MemoryBytes:      chooseCapacity(memoryCapacity, detected.MemoryBytes),
		PIDs:             chooseCapacity(settings.PIDCapacity, detected.PIDs),
		EphemeralBytes:   chooseCapacity(ephemeralCapacity, detected.EphemeralBytes),
		Inodes:           chooseCapacity(settings.InodeCapacity, detected.Inodes),
		Devices:          cloneDevices(settings.Devices),
	}
	capacity.CPUMillicores, err = fallbackCapacity(capacity.CPUMillicores, required.CPUMillicores, settings.CPUReservePercent)
	if err != nil {
		return nil, info, fmt.Errorf("CPU fallback capacity: %w", err)
	}
	capacity.MemoryBytes, err = fallbackCapacity(capacity.MemoryBytes, required.MemoryBytes, settings.MemoryReservePercent)
	if err != nil {
		return nil, info, fmt.Errorf("memory fallback capacity: %w", err)
	}
	capacity.PIDs, err = fallbackCapacity(capacity.PIDs, required.PIDs, settings.PIDReservePercent)
	if err != nil {
		return nil, info, fmt.Errorf("PID fallback capacity: %w", err)
	}
	capacity.EphemeralBytes, err = fallbackCapacity(capacity.EphemeralBytes, required.EphemeralBytes, settings.EphemeralReservePercent)
	if err != nil {
		return nil, info, fmt.Errorf("ephemeral fallback capacity: %w", err)
	}
	capacity.Inodes, err = fallbackCapacity(capacity.Inodes, required.Inodes, settings.InodeReservePercent)
	if err != nil {
		return nil, info, fmt.Errorf("inode fallback capacity: %w", err)
	}
	reserve := resourcegovernor.Resources{
		CPUMillicores:  percentage(capacity.CPUMillicores, settings.CPUReservePercent),
		MemoryBytes:    percentage(capacity.MemoryBytes, settings.MemoryReservePercent),
		PIDs:           percentage(capacity.PIDs, settings.PIDReservePercent),
		EphemeralBytes: percentage(capacity.EphemeralBytes, settings.EphemeralReservePercent),
		Inodes:         percentage(capacity.Inodes, settings.InodeReservePercent),
		Devices:        cloneDevices(settings.DeviceReserve),
	}
	if settings.Mode == config.ResourceGovernanceAuto {
		largestEnabled := maximumResources(worstDocker, profiles[WorkloadMaintenance])
		if cfg.LSPEnabled {
			largestEnabled = maximumResources(largestEnabled, profiles[WorkloadLSP])
		}
		if cfg.DAPEnabled {
			largestEnabled = maximumResources(largestEnabled, profiles[WorkloadDAP])
		}
		clampAutoReserve(&reserve, capacity, largestEnabled)
	}
	info.Node = resourcegovernor.NodeResources{Capacity: capacity, Reserve: reserve}
	governor, err := resourcegovernor.New(info.Node)
	if err != nil {
		return nil, info, err
	}
	queuePolicy := QueuePolicy{
		Enabled: settings.Queue.Enabled, MaxWaiting: settings.Queue.MaxWaiting,
		MaxWaitingPerOwner:   settings.Queue.MaxWaitingPerOwner,
		MaxWaitingPerProject: settings.Queue.MaxWaitingPerProject,
		AgingThreshold:       time.Duration(settings.Queue.AgingThresholdSeconds) * time.Second,
	}
	for workload := Workload(0); workload < workloadCount; workload++ {
		entry := settings.Queue.Workloads[workload.String()]
		queuePolicy.Workloads[workload] = QueueWorkloadPolicy{
			Weight: entry.Weight, MaxWaiting: entry.MaxWaiting,
			MaxWait: time.Duration(entry.TimeoutSeconds) * time.Second,
		}
	}
	controller, err := NewWithQueue(governor, profiles, registry, queuePolicy)
	if err != nil {
		return nil, info, err
	}
	return controller, info, nil
}

func chooseCapacity(configured, detected int64) int64 {
	if configured > 0 {
		return configured
	}
	return detected
}

func fallbackCapacity(current, required int64, reservePercent int) (int64, error) {
	if current > 0 {
		return current, nil
	}
	if required <= 0 {
		return 1, nil
	}
	denominator := int64(100 - reservePercent)
	whole := required / denominator
	remainder := required % denominator
	base, err := multiplyNonnegative(whole, 100)
	if err != nil {
		return 0, err
	}
	extra := (remainder*100 + denominator - 1) / denominator
	return addNonnegative(base, extra)
}

func percentage(value int64, percent int) int64 {
	if value <= 0 || percent <= 0 {
		return 0
	}
	percent64 := int64(percent)
	return (value/100)*percent64 + (value%100)*percent64/100
}

func clampAutoReserve(reserve *resourcegovernor.Resources, capacity, largestEnabled resourcegovernor.Resources) {
	reserve.DockerContainers = clampReserveDimension(capacity.DockerContainers, reserve.DockerContainers, largestEnabled.DockerContainers)
	reserve.CPUMillicores = clampReserveDimension(capacity.CPUMillicores, reserve.CPUMillicores, largestEnabled.CPUMillicores)
	reserve.MemoryBytes = clampReserveDimension(capacity.MemoryBytes, reserve.MemoryBytes, largestEnabled.MemoryBytes)
	reserve.PIDs = clampReserveDimension(capacity.PIDs, reserve.PIDs, largestEnabled.PIDs)
	reserve.EphemeralBytes = clampReserveDimension(capacity.EphemeralBytes, reserve.EphemeralBytes, largestEnabled.EphemeralBytes)
	reserve.Inodes = clampReserveDimension(capacity.Inodes, reserve.Inodes, largestEnabled.Inodes)
}

func clampReserveDimension(capacity, reserve, largestProfile int64) int64 {
	if capacity <= 0 || largestProfile <= 0 || capacity < largestProfile {
		return reserve
	}
	maximumReserve := capacity - largestProfile
	if reserve > maximumReserve {
		return maximumReserve
	}
	return reserve
}

func maximumResources(resources ...resourcegovernor.Resources) resourcegovernor.Resources {
	result := resourcegovernor.Resources{Devices: make(map[string]int64)}
	for _, value := range resources {
		result.Slots = max(result.Slots, value.Slots)
		result.DockerContainers = max(result.DockerContainers, value.DockerContainers)
		result.CPUMillicores = max(result.CPUMillicores, value.CPUMillicores)
		result.MemoryBytes = max(result.MemoryBytes, value.MemoryBytes)
		result.PIDs = max(result.PIDs, value.PIDs)
		result.EphemeralBytes = max(result.EphemeralBytes, value.EphemeralBytes)
		result.Inodes = max(result.Inodes, value.Inodes)
		for name, amount := range value.Devices {
			result.Devices[name] = max(result.Devices[name], amount)
		}
	}
	return result
}

func multiplyResources(value resourcegovernor.Resources, factor int64) (resourcegovernor.Resources, error) {
	if factor < 0 {
		return resourcegovernor.Resources{}, fmt.Errorf("negative resource multiplier")
	}
	values := []*int64{
		&value.Slots, &value.DockerContainers, &value.CPUMillicores, &value.MemoryBytes, &value.PIDs,
		&value.EphemeralBytes, &value.Inodes,
	}
	for _, item := range values {
		multiplied, err := multiplyNonnegative(*item, factor)
		if err != nil {
			return resourcegovernor.Resources{}, err
		}
		*item = multiplied
	}
	result := value
	result.Devices = make(map[string]int64, len(value.Devices))
	for name, amount := range value.Devices {
		multiplied, err := multiplyNonnegative(amount, factor)
		if err != nil {
			return resourcegovernor.Resources{}, fmt.Errorf("device %q: %w", name, err)
		}
		result.Devices[name] = multiplied
	}
	return result, nil
}

func addResourcesChecked(target *resourcegovernor.Resources, value resourcegovernor.Resources) error {
	pairs := []struct {
		target *int64
		value  int64
	}{
		{&target.Slots, value.Slots},
		{&target.DockerContainers, value.DockerContainers},
		{&target.CPUMillicores, value.CPUMillicores},
		{&target.MemoryBytes, value.MemoryBytes},
		{&target.PIDs, value.PIDs},
		{&target.EphemeralBytes, value.EphemeralBytes},
		{&target.Inodes, value.Inodes},
	}
	for _, pair := range pairs {
		combined, err := addNonnegative(*pair.target, pair.value)
		if err != nil {
			return err
		}
		*pair.target = combined
	}
	if len(value.Devices) > 0 && target.Devices == nil {
		target.Devices = make(map[string]int64, len(value.Devices))
	}
	for name, amount := range value.Devices {
		combined, err := addNonnegative(target.Devices[name], amount)
		if err != nil {
			return fmt.Errorf("device %q: %w", name, err)
		}
		target.Devices[name] = combined
	}
	return nil
}

func megabytesToBytes(value int64) (int64, error) {
	return multiplyNonnegative(value, bytesPerMegabyte)
}

func multiplyNonnegative(left, right int64) (int64, error) {
	if left < 0 || right < 0 {
		return 0, fmt.Errorf("resource value must be non-negative")
	}
	if left != 0 && right > math.MaxInt64/left {
		return 0, fmt.Errorf("resource value overflows int64")
	}
	return left * right, nil
}

func addNonnegative(left, right int64) (int64, error) {
	if left < 0 || right < 0 {
		return 0, fmt.Errorf("resource value must be non-negative")
	}
	if left > math.MaxInt64-right {
		return 0, fmt.Errorf("resource value overflows int64")
	}
	return left + right, nil
}

func cloneDevices(devices map[string]int64) map[string]int64 {
	if devices == nil {
		return nil
	}
	result := make(map[string]int64, len(devices))
	for name, amount := range devices {
		result[name] = amount
	}
	return result
}

func parseCPUMillicores(raw string) (int64, error) {
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || value <= 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, fmt.Errorf("must be a positive CPU number")
	}
	millicores := value * 1000
	if millicores >= float64(math.MaxInt64) {
		return 0, fmt.Errorf("is too large")
	}
	return int64(math.Ceil(millicores)), nil
}

func parseBytes(raw string) (int64, error) {
	return resourceunit.ParseBytes(raw)
}
