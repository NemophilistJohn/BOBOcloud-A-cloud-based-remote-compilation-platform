package hostresource

import (
	"math"
	"testing"
)

func TestParseCPUQuota(t *testing.T) {
	tests := map[string]int64{
		"max 100000":    0,
		"100000 100000": 1000,
		"150000 100000": 1500,
		"25000 100000":  250,
		"1 3":           334,
		"invalid":       0,
	}
	for raw, want := range tests {
		if got := parseCPUQuota(raw); got != want {
			t.Fatalf("parseCPUQuota(%q) = %d, want %d", raw, got, want)
		}
	}
}

func TestParseCPUQuotaSaturatesInsteadOfOverflowing(t *testing.T) {
	if got := parseCPUQuota("9223372036854775807 1"); got != math.MaxInt64 {
		t.Fatalf("large CPU quota = %d, want saturation", got)
	}
}

func TestParseMemTotal(t *testing.T) {
	raw := "MemFree: 10 kB\nMemTotal:       2048 kB\n"
	if got := parseMemTotal(raw); got != 2*1024*1024 {
		t.Fatalf("parseMemTotal() = %d", got)
	}
}

func TestMinPositiveIgnoresUnknownValues(t *testing.T) {
	if got := minPositive(0, -1, 900, 1200); got != 900 {
		t.Fatalf("minPositive() = %d", got)
	}
}

func TestParseCurrentCgroupsKeepsHybridMemberships(t *testing.T) {
	controllers, unified := parseCurrentCgroups("0::/unified.slice\n2:cpu,cpuacct:/legacy/cpu\n3:memory:/legacy/memory\n")
	if unified != "/unified.slice" || controllers["cpu"] != "/legacy/cpu" || controllers["memory"] != "/legacy/memory" {
		t.Fatalf("hybrid memberships = unified:%q controllers:%+v", unified, controllers)
	}
}

func TestParseMountInfoResolvesCombinedV1AndNamespacedV2(t *testing.T) {
	raw := "36 25 0:32 /docker/a /sys/fs/cgroup/cpu,cpuacct rw,nosuid,nodev - cgroup cgroup rw,cpu,cpuacct\n" +
		"42 25 0:38 /tenant/root /sys/fs/cgroup rw,nosuid,nodev - cgroup2 cgroup rw\n"
	mounts := parseCgroupMounts(raw)
	if got := cgroupRootFor(mounts, "cgroup", "cpu", "/docker/a/job"); got != "/sys/fs/cgroup/cpu,cpuacct/job" {
		t.Fatalf("v1 combined root = %q", got)
	}
	if got := cgroupRootFor(mounts, "cgroup2", "", "/job"); got != "/sys/fs/cgroup/job" {
		t.Fatalf("namespaced v2 root = %q", got)
	}
}

func TestParseMountInfoUnescapesPaths(t *testing.T) {
	mounts := parseCgroupMounts("42 25 0:38 / /sys/fs/cgroup\\040tenant rw - cgroup2 cgroup rw\n")
	if got := cgroupRootFor(mounts, "cgroup2", "", "/work"); got != "/sys/fs/cgroup tenant/work" {
		t.Fatalf("escaped mount root = %q", got)
	}
}

func TestCgroupHierarchyIncludesParentsOnlyToMountBoundary(t *testing.T) {
	got := cgroupHierarchy("/sys/fs/cgroup/tenant/job", "/sys/fs/cgroup")
	want := []string{"/sys/fs/cgroup/tenant/job", "/sys/fs/cgroup/tenant", "/sys/fs/cgroup"}
	if len(got) != len(want) {
		t.Fatalf("hierarchy = %+v", got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("hierarchy = %+v, want %+v", got, want)
		}
	}
}
