package resourcecontrol

import (
	"math"
	"testing"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/hostresource"
)

func TestBuildAutoUsesDetectedCapacityAndReserve(t *testing.T) {
	cfg := config.Default()
	detected := hostresource.Capacity{CPUMillicores: 8_000, MemoryBytes: 16_000_000_000, PIDs: 32_000, EphemeralBytes: 100_000_000_000, Inodes: 1_000_000}
	controller, info, err := Build(cfg, detected, nil)
	if err != nil {
		t.Fatal(err)
	}
	if controller == nil || info.Node.Capacity.CPUMillicores != 8_000 || info.Node.Reserve.CPUMillicores != 800 {
		t.Fatalf("unexpected auto node: %+v", info.Node)
	}
	if info.Node.Capacity.MemoryBytes != detected.MemoryBytes || info.Node.Reserve.MemoryBytes != 2_400_000_000 {
		t.Fatalf("unexpected memory node: %+v", info.Node)
	}
}

func TestBuildExplicitCapacityOverridesOneDetectedDimension(t *testing.T) {
	cfg := config.Default()
	cfg.ResourceGovernance.CPUCapacityMillicores = 4_000
	_, info, err := Build(cfg, hostresource.Capacity{CPUMillicores: 8_000, MemoryBytes: 8_000_000_000, PIDs: 10_000, EphemeralBytes: 10_000_000_000, Inodes: 100_000}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if info.Node.Capacity.CPUMillicores != 4_000 {
		t.Fatalf("CPU capacity = %d", info.Node.Capacity.CPUMillicores)
	}
}

func TestBuildFallsBackWhenHostDimensionIsUnavailable(t *testing.T) {
	cfg := config.Default()
	_, info, err := Build(cfg, hostresource.Capacity{CPUMillicores: 4_000}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if info.Node.Capacity.MemoryBytes <= 0 || info.Node.Capacity.PIDs <= 0 || info.Node.Capacity.EphemeralBytes <= 0 || info.Node.Capacity.Inodes <= 0 {
		t.Fatalf("fallback capacities are incomplete: %+v", info.Node.Capacity)
	}
}

func TestBuildAutoReserveKeepsOneLargestEnabledProfileAdmissible(t *testing.T) {
	cfg := config.Default()
	detected := hostresource.Capacity{
		CPUMillicores: 1_000, MemoryBytes: 512_000_000,
		PIDs: 256, EphemeralBytes: 256_000_000, Inodes: 16_384,
	}
	controller, info, err := Build(cfg, detected, nil)
	if err != nil {
		t.Fatal(err)
	}
	if info.Node.Reserve.CPUMillicores != 0 || info.Node.Reserve.MemoryBytes != 0 {
		t.Fatalf("auto reserve prevents one workload: capacity=%+v reserve=%+v", info.Node.Capacity, info.Node.Reserve)
	}
	lease, err := controller.TryAcquire(WorkloadRun, "user", "one-core-run")
	if err != nil {
		t.Fatalf("one workload should fit after auto reserve clamp: %v", err)
	}
	lease.Release()
}

func TestBuildFixedReserveRemainsExplicit(t *testing.T) {
	cfg := config.Default()
	cfg.ResourceGovernance.Mode = config.ResourceGovernanceFixed
	cfg.ResourceGovernance.SlotCapacity = 8
	cfg.ResourceGovernance.CPUCapacityMillicores = 1_000
	cfg.ResourceGovernance.MemoryCapacityMB = 1_000
	cfg.ResourceGovernance.PIDCapacity = 256
	cfg.ResourceGovernance.EphemeralCapacityMB = 256
	cfg.ResourceGovernance.InodeCapacity = 16_384
	_, info, err := Build(cfg, hostresource.Capacity{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if info.Node.Reserve.CPUMillicores != 100 || info.Node.Reserve.MemoryBytes != 150_000_000 {
		t.Fatalf("fixed reserve was unexpectedly clamped: %+v", info.Node.Reserve)
	}
}

func TestBuildProfilesKeepDefaultDockerLimitsAndPIDHardLimits(t *testing.T) {
	cfg := config.Default()
	profile := cfg.ResourceGovernance.Workloads["run"]
	profile.CPUMillicores = 100
	profile.MemoryMB = 128
	profile.PIDs = 32
	cfg.ResourceGovernance.Workloads["run"] = profile
	_, info, err := Build(cfg, hostresource.Capacity{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if info.Profiles[WorkloadRun].MemoryBytes != 512_000_000 {
		t.Fatalf("run memory = %d, want default Docker limit", info.Profiles[WorkloadRun].MemoryBytes)
	}
	if info.Profiles[WorkloadRun].CPUMillicores != 1_000 {
		t.Fatalf("run CPU = %d, want Docker hard limit", info.Profiles[WorkloadRun].CPUMillicores)
	}
	if info.Profiles[WorkloadRun].PIDs != containerProcessHardLimit || info.Profiles[WorkloadLSP].PIDs != containerProcessHardLimit || info.Profiles[WorkloadDAP].PIDs != containerProcessHardLimit {
		t.Fatalf("container PID profiles do not match hard limits: %+v", info.Profiles)
	}
}

func TestBuildRejectsResourceArithmeticOverflow(t *testing.T) {
	cfg := config.Default()
	profile := cfg.ResourceGovernance.Workloads["run"]
	profile.CPUMillicores = math.MaxInt64
	cfg.ResourceGovernance.Workloads["run"] = profile
	if _, _, err := Build(cfg, hostresource.Capacity{}, nil); err == nil {
		t.Fatal("overflowing aggregate resource profile was accepted")
	}
}

func TestBuildOffReturnsNoController(t *testing.T) {
	cfg := config.Default()
	cfg.ResourceGovernance.Mode = config.ResourceGovernanceOff
	controller, _, err := Build(cfg, hostresource.Capacity{}, nil)
	if err != nil || controller != nil {
		t.Fatalf("off build = controller:%v error:%v", controller, err)
	}
}

func TestLimitParsers(t *testing.T) {
	if cpu, err := parseCPUMillicores("0.75"); err != nil || cpu != 750 {
		t.Fatalf("cpu = %d error=%v", cpu, err)
	}
	if memory, err := parseBytes("512MiB"); err != nil || memory != 512<<20 {
		t.Fatalf("memory = %d error=%v", memory, err)
	}
	if _, err := parseCPUMillicores("1e30"); err == nil {
		t.Fatal("overflowing CPU limit was accepted")
	}
	if _, err := parseBytes("999999999999999999999g"); err == nil {
		t.Fatal("overflowing memory limit was accepted")
	}
}
