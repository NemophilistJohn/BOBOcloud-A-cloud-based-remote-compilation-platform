package config

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadLegacyConfigWithoutGovernanceUsesSafeDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"http_port":4310}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ResourceGovernance.Mode != ResourceGovernanceAuto || cfg.ResourceGovernance.Workloads["run"].PIDs != 256 || !cfg.ResourceGovernance.Queue.Enabled {
		t.Fatalf("legacy config governance defaults = %+v", cfg.ResourceGovernance)
	}
	if cfg.ResourceGovernance.Queue.MaxWaiting != 128 || cfg.ResourceGovernance.Queue.Workloads["terminal"].Weight != 8 {
		t.Fatalf("legacy config queue defaults = %+v", cfg.ResourceGovernance.Queue)
	}
}

func TestResourceQueuePartialJSONKeepsDefaultsAndAllowsDisable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"resource_governance":{"queue":{"max_waiting":64,"workloads":{"run":{"weight":6}}}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	queue := cfg.ResourceGovernance.Queue
	if !queue.Enabled || queue.MaxWaiting != 64 || queue.MaxWaitingPerOwner != 8 || queue.Workloads["run"].Weight != 6 || queue.Workloads["run"].MaxWaiting != 48 {
		t.Fatalf("partial queue JSON lost defaults: %+v", queue)
	}

	if err := os.WriteFile(path, []byte(`{"resource_governance":{"queue":{"enabled":false}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err = Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ResourceGovernance.Queue.Enabled {
		t.Fatal("explicitly disabled resource queue was re-enabled")
	}

	if err := os.WriteFile(path, []byte(`{"resource_governance":{"queue":{"aging_threshold_seconds":0}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err = Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ResourceGovernance.Queue.AgingThresholdSeconds != 0 {
		t.Fatalf("explicitly disabled queue aging was reset to %d", cfg.ResourceGovernance.Queue.AgingThresholdSeconds)
	}
}

func TestResourceQueueRejectsUnknownAndUnsafeLimits(t *testing.T) {
	tests := []string{
		`{"resource_governance":{"queue":{"max_waitng":12}}}`,
		`{"resource_governance":{"queue":{"max_waiting":4,"max_waiting_per_owner":5}}}`,
		`{"resource_governance":{"queue":{"max_waiting":8,"max_waiting_per_owner":4,"max_waiting_per_project":5}}}`,
		`{"resource_governance":{"queue":{"aging_threshold_seconds":601}}}`,
		`{"resource_governance":{"queue":{"workloads":{"run":{"weight":33}}}}}`,
		`{"resource_governance":{"queue":{"workloads":{"unknown":{"weight":1}}}}}`,
	}
	for _, document := range tests {
		path := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, []byte(document), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Fatalf("unsafe queue config was accepted: %s", document)
		}
	}
}

func TestNormalizeResourceGovernanceFillsMissingWorkloadProfiles(t *testing.T) {
	value := DefaultResourceGovernance()
	value.Workloads = map[string]ResourceProfileConfig{"run": {CPUMillicores: 750}}
	if err := normalizeResourceGovernance(&value); err != nil {
		t.Fatal(err)
	}
	if value.Workloads["run"].PIDs != 256 || value.Workloads["lsp"].PIDs != 256 {
		t.Fatalf("workload defaults were not restored: %+v", value.Workloads)
	}
}

func TestNormalizeResourceGovernanceRejectsIncompleteFixedCapacity(t *testing.T) {
	value := DefaultResourceGovernance()
	value.Mode = ResourceGovernanceFixed
	if err := normalizeResourceGovernance(&value); err == nil {
		t.Fatal("incomplete fixed capacity was accepted")
	}
}

func TestNormalizeResourceGovernanceRejectsUnknownWorkload(t *testing.T) {
	value := DefaultResourceGovernance()
	value.Workloads["interactive-secret"] = ResourceProfileConfig{PIDs: 1}
	if err := normalizeResourceGovernance(&value); err == nil {
		t.Fatal("unknown workload was accepted")
	}
}

func TestNormalizeResourceGovernanceRejectsNegativeAndOverflowingCapacity(t *testing.T) {
	for _, mutate := range []func(*ResourceGovernanceConfig){
		func(value *ResourceGovernanceConfig) { value.CPUCapacityMillicores = -1 },
		func(value *ResourceGovernanceConfig) { value.MemoryCapacityMB = math.MaxInt64 },
		func(value *ResourceGovernanceConfig) {
			value.Workloads["run"] = ResourceProfileConfig{PIDs: 1, MemoryMB: math.MaxInt64}
		},
	} {
		value := DefaultResourceGovernance()
		mutate(&value)
		if err := normalizeResourceGovernance(&value); err == nil {
			t.Fatalf("invalid resource capacity was accepted: %+v", value)
		}
	}
}

func TestNormalizeResourceGovernanceRejectsUnavailableProfileDevice(t *testing.T) {
	value := DefaultResourceGovernance()
	profile := value.Workloads["run"]
	profile.Devices = map[string]int64{"gpu": 1}
	value.Workloads["run"] = profile
	if err := normalizeResourceGovernance(&value); err == nil {
		t.Fatal("profile device without node capacity was accepted")
	}

	value.Devices["gpu"] = 1
	value.DeviceReserve["gpu"] = 1
	if err := normalizeResourceGovernance(&value); err == nil {
		t.Fatal("profile device fully reserved from workloads was accepted")
	}
}

func TestResourceGovernanceJSONRejectsUnknownFieldsAndKeepsDefaults(t *testing.T) {
	value := DefaultResourceGovernance()
	if err := json.Unmarshal([]byte(`{"mode":"auto","cpu_capacity_millicores":2000}`), &value); err != nil {
		t.Fatal(err)
	}
	if value.CPUCapacityMillicores != 2000 || value.MemoryReservePercent != 15 || value.Workloads["run"].PIDs != 256 {
		t.Fatalf("partial JSON lost defaults: %+v", value)
	}
	if err := json.Unmarshal([]byte(`{"cpu_capacity_milicores":2000}`), &value); err == nil {
		t.Fatal("misspelled governance key was silently accepted")
	}
	if err := json.Unmarshal([]byte(`{"workloads":{"run":{"pids":256,"memory_mib":512}}}`), &value); err == nil {
		t.Fatal("misspelled workload key was silently accepted")
	}
	if err := json.Unmarshal([]byte(`{"queue":{"workloads":{"run":{"timeout_second":10}}}}`), &value); err == nil {
		t.Fatal("misspelled queue workload key was silently accepted")
	}
}
