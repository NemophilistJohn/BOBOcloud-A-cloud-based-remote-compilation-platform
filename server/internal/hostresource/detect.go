package hostresource

import (
	"math"
	"math/bits"
	pathpkg "path"
	"runtime"
	"strings"
)

// Capacity is the host budget visible to this process. Zero means that a
// dimension could not be discovered and must be supplied by configuration.
type Capacity struct {
	CPUMillicores  int64  `json:"cpu_millicores"`
	MemoryBytes    int64  `json:"memory_bytes"`
	PIDs           int64  `json:"pids"`
	EphemeralBytes int64  `json:"ephemeral_bytes"`
	Inodes         int64  `json:"inodes"`
	CPUOrigin      string `json:"cpu_origin"`
	MemoryOrigin   string `json:"memory_origin"`
	PIDsOrigin     string `json:"pids_origin"`
	StorageOrigin  string `json:"storage_origin"`
}

// Detect returns the best available host/cgroup capacity without requiring a
// distribution-specific service or command. Platform implementations may
// leave unsupported dimensions at zero.
func Detect(storagePath string) Capacity {
	return detect(storagePath)
}

func runtimeCPUCapacity() Capacity {
	count := runtime.NumCPU()
	if count < 1 {
		count = 1
	}
	return Capacity{CPUMillicores: int64(count) * 1000, CPUOrigin: "runtime"}
}

func minPositive(values ...int64) int64 {
	var result int64
	for _, value := range values {
		if value <= 0 {
			continue
		}
		if result == 0 || value < result {
			result = value
		}
	}
	return result
}

func parsePositiveInt(raw string) int64 {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "max" || raw == "-1" {
		return 0
	}
	var value int64
	for _, char := range raw {
		if char < '0' || char > '9' {
			return 0
		}
		if value > (1<<63-1-int64(char-'0'))/10 {
			return 0
		}
		value = value*10 + int64(char-'0')
	}
	if value <= 0 {
		return 0
	}
	return value
}

func parseCPUQuota(raw string) int64 {
	fields := strings.Fields(raw)
	if len(fields) != 2 || fields[0] == "max" {
		return 0
	}
	quota := parsePositiveInt(fields[0])
	period := parsePositiveInt(fields[1])
	if quota == 0 || period == 0 {
		return 0
	}
	return ceilMulDivPositive(quota, 1000, period)
}

func parseMemTotal(raw string) int64 {
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != "MemTotal:" {
			continue
		}
		kilobytes := parsePositiveInt(fields[1])
		if kilobytes > 0 {
			return saturatingPositiveProduct(kilobytes, 1024)
		}
	}
	return 0
}

func ceilMulDivPositive(value, multiplier, divisor int64) int64 {
	if value <= 0 || multiplier <= 0 || divisor <= 0 {
		return 0
	}
	high, low := bits.Mul64(uint64(value), uint64(multiplier))
	if high >= uint64(divisor) {
		return math.MaxInt64
	}
	quotient, remainder := bits.Div64(high, low, uint64(divisor))
	if remainder != 0 {
		quotient++
	}
	if quotient > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(quotient)
}

func saturatingPositiveProduct(left, right int64) int64 {
	if left <= 0 || right <= 0 {
		return 0
	}
	if left > math.MaxInt64/right {
		return math.MaxInt64
	}
	return left * right
}

type cgroupMount struct {
	root        string
	mountPoint  string
	filesystem  string
	controllers map[string]struct{}
}

func parseCurrentCgroups(raw string) (map[string]string, string) {
	controllers := make(map[string]string)
	var unified string
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), ":", 3)
		if len(parts) != 3 {
			continue
		}
		if parts[0] == "0" && parts[1] == "" {
			unified = parts[2]
			continue
		}
		for _, controller := range strings.Split(parts[1], ",") {
			if controller != "" {
				controllers[controller] = parts[2]
			}
		}
	}
	return controllers, unified
}

func parseCgroupMounts(raw string) []cgroupMount {
	mounts := make([]cgroupMount, 0)
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		separator := -1
		for index, field := range fields {
			if field == "-" {
				separator = index
				break
			}
		}
		if separator < 6 || len(fields) <= separator+3 {
			continue
		}
		filesystem := fields[separator+1]
		if filesystem != "cgroup" && filesystem != "cgroup2" {
			continue
		}
		mount := cgroupMount{
			root:        unescapeMountInfoPath(fields[3]),
			mountPoint:  unescapeMountInfoPath(fields[4]),
			filesystem:  filesystem,
			controllers: make(map[string]struct{}),
		}
		if filesystem == "cgroup" {
			options := fields[5] + "," + fields[separator+3]
			for _, option := range strings.Split(options, ",") {
				if option != "" {
					mount.controllers[option] = struct{}{}
				}
			}
		}
		mounts = append(mounts, mount)
	}
	return mounts
}

func cgroupRootFor(mounts []cgroupMount, filesystem, controller, membership string) string {
	mount, exists := cgroupMountFor(mounts, filesystem, controller)
	if !exists {
		return ""
	}
	return resolveCgroupMount(mount, membership)
}

func cgroupMountFor(mounts []cgroupMount, filesystem, controller string) (cgroupMount, bool) {
	for _, mount := range mounts {
		if mount.filesystem != filesystem {
			continue
		}
		if filesystem == "cgroup" {
			if _, exists := mount.controllers[controller]; !exists {
				continue
			}
		}
		return mount, true
	}
	return cgroupMount{}, false
}

func resolveCgroupMount(mount cgroupMount, membership string) string {
	mountPoint := pathpkg.Clean(mount.mountPoint)
	mountRoot := cleanLinuxPath(mount.root)
	membership = cleanLinuxPath(membership)
	if mountRoot == "/" {
		return pathpkg.Join(mountPoint, strings.TrimPrefix(membership, "/"))
	}
	if membership == mountRoot {
		return mountPoint
	}
	if strings.HasPrefix(membership, mountRoot+"/") {
		return pathpkg.Join(mountPoint, strings.TrimPrefix(membership[len(mountRoot):], "/"))
	}
	// A cgroup namespace may expose membership relative to the mounted subtree
	// while mountinfo retains the host-side root. In that case the mount point is
	// already the namespace root.
	return pathpkg.Join(mountPoint, strings.TrimPrefix(membership, "/"))
}

func cleanLinuxPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "/"
	}
	return pathpkg.Clean("/" + strings.TrimPrefix(value, "/"))
}

func cgroupHierarchy(root, boundary string) []string {
	root = cleanLinuxPath(root)
	boundary = cleanLinuxPath(boundary)
	if root != boundary && !strings.HasPrefix(root, boundary+"/") {
		return []string{root}
	}
	result := make([]string, 0, 8)
	for current := root; ; current = pathpkg.Dir(current) {
		result = append(result, current)
		if current == boundary {
			return result
		}
		parent := pathpkg.Dir(current)
		if parent == current {
			return result
		}
	}
}

func unescapeMountInfoPath(value string) string {
	return strings.NewReplacer(
		`\040`, " ",
		`\011`, "\t",
		`\012`, "\n",
		`\134`, `\`,
	).Replace(value)
}
