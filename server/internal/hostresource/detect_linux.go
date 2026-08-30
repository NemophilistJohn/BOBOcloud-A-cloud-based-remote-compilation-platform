//go:build linux

package hostresource

import (
	"math"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

const cgroupUnlimitedThreshold = int64(1 << 60)

func detect(storagePath string) Capacity {
	result := runtimeCPUCapacity()
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		result.MemoryBytes = parseMemTotal(string(raw))
		if result.MemoryBytes > 0 {
			result.MemoryOrigin = "proc"
		}
	}
	if raw, err := os.ReadFile("/proc/sys/kernel/pid_max"); err == nil {
		result.PIDs = parsePositiveInt(string(raw))
		if result.PIDs > 0 {
			result.PIDsOrigin = "proc"
		}
	}

	applyCgroupCapacity(&result)
	applyFilesystemCapacity(&result, storagePath)
	return result
}

func applyCgroupCapacity(result *Capacity) {
	controllers, unified := currentCgroups()
	mounts := currentCgroupMounts()
	cpuHandled, memoryHandled, pidsHandled := false, false, false
	if unified != "" {
		roots := cgroupCandidateRoots(mounts, "cgroup2", "", unified)
		for _, root := range roots {
			raw, err := os.ReadFile(filepath.Join(root, "cpu.max"))
			if err != nil {
				continue
			}
			cpuHandled = true
			if limit := parseCPUQuota(string(raw)); limit > 0 {
				applyDetectedLimit(&result.CPUMillicores, &result.CPUOrigin, limit, "cgroup-v2")
			}
		}
		for _, root := range roots {
			raw, err := os.ReadFile(filepath.Join(root, "memory.max"))
			if err != nil {
				continue
			}
			memoryHandled = true
			applyCgroupMemory(result, raw, "memory-v2")
		}
		for _, root := range roots {
			raw, err := os.ReadFile(filepath.Join(root, "pids.max"))
			if err != nil {
				continue
			}
			pidsHandled = true
			if limit := boundedCgroupValue(string(raw)); limit > 0 {
				applyDetectedLimit(&result.PIDs, &result.PIDsOrigin, limit, "cgroup-v2")
			}
		}
	}

	if membership := controllers["cpu"]; !cpuHandled && membership != "" {
		roots := cgroupCandidateRoots(mounts, "cgroup", "cpu", membership)
		for _, root := range roots {
			quotaRaw, quotaErr := os.ReadFile(filepath.Join(root, "cpu.cfs_quota_us"))
			periodRaw, periodErr := os.ReadFile(filepath.Join(root, "cpu.cfs_period_us"))
			if quotaErr != nil || periodErr != nil {
				continue
			}
			quota, period := parsePositiveInt(string(quotaRaw)), parsePositiveInt(string(periodRaw))
			if quota > 0 && period > 0 {
				applyDetectedLimit(&result.CPUMillicores, &result.CPUOrigin, ceilMulDivPositive(quota, 1000, period), "cgroup-v1")
			}
		}
	}
	if membership := controllers["memory"]; !memoryHandled && membership != "" {
		roots := cgroupCandidateRoots(mounts, "cgroup", "memory", membership)
		for _, root := range roots {
			raw, err := os.ReadFile(filepath.Join(root, "memory.limit_in_bytes"))
			if err != nil {
				continue
			}
			applyCgroupMemory(result, raw, "memory-v1")
		}
	}
	if membership := controllers["pids"]; !pidsHandled && membership != "" {
		roots := cgroupCandidateRoots(mounts, "cgroup", "pids", membership)
		for _, root := range roots {
			raw, err := os.ReadFile(filepath.Join(root, "pids.max"))
			if err != nil {
				continue
			}
			if limit := boundedCgroupValue(string(raw)); limit > 0 {
				applyDetectedLimit(&result.PIDs, &result.PIDsOrigin, limit, "cgroup-v1")
			}
		}
	}
}

func applyCgroupMemory(result *Capacity, raw []byte, origin string) {
	limit := boundedCgroupValue(string(raw))
	if limit == 0 {
		return
	}
	applyDetectedLimit(&result.MemoryBytes, &result.MemoryOrigin, limit, origin)
}

func applyDetectedLimit(current *int64, currentOrigin *string, limit int64, origin string) {
	if limit <= 0 {
		return
	}
	if *current <= 0 || limit < *current {
		*current = limit
		*currentOrigin = origin
	}
}

func boundedCgroupValue(raw string) int64 {
	value := parsePositiveInt(raw)
	if value >= cgroupUnlimitedThreshold {
		return 0
	}
	return value
}

func currentCgroups() (map[string]string, string) {
	raw, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return make(map[string]string), ""
	}
	return parseCurrentCgroups(string(raw))
}

func currentCgroupMounts() []cgroupMount {
	raw, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return nil
	}
	return parseCgroupMounts(string(raw))
}

func cgroupCandidateRoots(mounts []cgroupMount, filesystem, controller, membership string) []string {
	result := make([]string, 0, 8)
	seen := make(map[string]struct{})
	appendHierarchy := func(root, boundary string) {
		for _, candidate := range cgroupHierarchy(filepath.ToSlash(root), filepath.ToSlash(boundary)) {
			candidate = filepath.FromSlash(candidate)
			if _, exists := seen[candidate]; exists {
				continue
			}
			seen[candidate] = struct{}{}
			result = append(result, candidate)
		}
	}
	if mount, exists := cgroupMountFor(mounts, filesystem, controller); exists {
		appendHierarchy(resolveCgroupMount(mount, membership), mount.mountPoint)
	}
	var conventional, boundary string
	if filesystem == "cgroup2" {
		conventional = filepath.Join("/sys/fs/cgroup", filepath.FromSlash(strings.TrimPrefix(membership, "/")))
		boundary = "/sys/fs/cgroup"
	} else {
		conventional = filepath.Join("/sys/fs/cgroup", controller, filepath.FromSlash(strings.TrimPrefix(membership, "/")))
		boundary = filepath.Join("/sys/fs/cgroup", controller)
	}
	appendHierarchy(conventional, boundary)
	return result
}

func applyFilesystemCapacity(result *Capacity, storagePath string) {
	path := strings.TrimSpace(storagePath)
	if path == "" {
		path = os.TempDir()
	}
	if absolute, err := filepath.Abs(path); err == nil {
		path = absolute
	}
	for {
		var stats unix.Statfs_t
		if err := unix.Statfs(path, &stats); err == nil {
			blockSize := int64(stats.Bsize)
			if blockSize > 0 {
				availableBlocks := uint64(stats.Bavail)
				if availableBlocks > uint64(math.MaxInt64/blockSize) {
					result.EphemeralBytes = math.MaxInt64
				} else {
					result.EphemeralBytes = int64(availableBlocks) * blockSize
				}
			}
			freeInodes := uint64(stats.Ffree)
			if freeInodes > math.MaxInt64 {
				result.Inodes = math.MaxInt64
			} else {
				result.Inodes = int64(freeInodes)
			}
			result.StorageOrigin = "statfs"
			return
		}
		parent := filepath.Dir(path)
		if parent == path {
			return
		}
		path = parent
	}
}
