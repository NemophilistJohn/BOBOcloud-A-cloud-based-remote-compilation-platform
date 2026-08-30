package resourcecontrol

import (
	"errors"
	"sync"
	"testing"

	"bobocloud-server/internal/metrics"
	"bobocloud-server/internal/resourcegovernor"
)

func testProfiles() Profiles {
	profiles := make(Profiles)
	for workload := Workload(0); workload < workloadCount; workload++ {
		profiles[workload] = resourcegovernor.Resources{Slots: 1, CPUMillicores: 1000, MemoryBytes: 1024, PIDs: 16}
	}
	return profiles
}

func TestControllerRequiresEveryClosedWorkloadProfile(t *testing.T) {
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{Capacity: resourcegovernor.Resources{Slots: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(governor, Profiles{}, nil); err == nil {
		t.Fatal("controller accepted incomplete profiles")
	}
	profiles := testProfiles()
	profiles[WorkloadRun] = resourcegovernor.Resources{Slots: 1, MemoryBytes: -1}
	if _, err := New(governor, profiles, nil); err == nil {
		t.Fatal("controller accepted an invalid profile")
	}
}

func TestControllerAdmissionAndReleaseUpdateBoundedMetrics(t *testing.T) {
	registry := metrics.New(true, 8)
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{Capacity: resourcegovernor.Resources{Slots: 1, CPUMillicores: 1000, MemoryBytes: 1024, PIDs: 16}})
	if err != nil {
		t.Fatal(err)
	}
	controller, err := New(governor, testProfiles(), registry)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := controller.TryAcquire(WorkloadRun, "alice", "run-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := controller.TryAcquire(WorkloadTerminal, "bob", "terminal-1"); err == nil {
		t.Fatal("over-capacity request was admitted")
	} else {
		var rejection *resourcegovernor.Rejection
		if !errors.As(err, &rejection) {
			t.Fatalf("error = %T, want resource rejection", err)
		}
	}
	if !lease.Release() || lease.Release() {
		t.Fatal("lease release was not idempotent")
	}
	snapshot := registry.Snapshot().Governance
	if len(snapshot.Admissions) != 2 || len(snapshot.Rejections) != 1 {
		t.Fatalf("governance metrics = %+v", snapshot)
	}
	for _, resource := range snapshot.Resources {
		if resource.InUse != 0 {
			t.Fatalf("resource remained in use: %+v", resource)
		}
	}
}

func TestControllerLeaseSnapshotKeepsClosedWorkloadClass(t *testing.T) {
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{Capacity: resourcegovernor.Resources{Slots: 1, CPUMillicores: 1000, MemoryBytes: 1024, PIDs: 16}})
	if err != nil {
		t.Fatal(err)
	}
	controller, err := New(governor, testProfiles(), nil)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := controller.TryAcquire(WorkloadPackage, "alice", "package-1")
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	snapshot := controller.Snapshot()
	if len(snapshot.Leases) != 1 || snapshot.Leases[0].Metadata.Workload != WorkloadPackage.String() {
		t.Fatalf("lease metadata = %+v", snapshot.Leases)
	}
}

func TestControllerConcurrentReleaseDoesNotUnderflow(t *testing.T) {
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{Capacity: resourcegovernor.Resources{Slots: 1, CPUMillicores: 1000, MemoryBytes: 1024, PIDs: 16}})
	if err != nil {
		t.Fatal(err)
	}
	controller, err := New(governor, testProfiles(), nil)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := controller.TryAcquire(WorkloadLSP, "alice", "lsp-1")
	if err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	for index := 0; index < 64; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			lease.Release()
		}()
	}
	wait.Wait()
	if snapshot := controller.Snapshot(); snapshot.Used.Slots != 0 || snapshot.Used.CPUMillicores != 0 {
		t.Fatalf("resources leaked or underflowed: %+v", snapshot.Used)
	}
}

func TestControllerRequestDemandCanOnlyRaiseConfiguredProfile(t *testing.T) {
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{Capacity: resourcegovernor.Resources{
		Slots: 2, CPUMillicores: 4000, MemoryBytes: 4096, PIDs: 64,
	}})
	if err != nil {
		t.Fatal(err)
	}
	controller, err := New(governor, testProfiles(), nil)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := controller.TryAcquireWithDemand(WorkloadRun, "alice", "compiler", resourcegovernor.Resources{
		CPUMillicores: 100, MemoryBytes: 2048,
	})
	if err != nil {
		t.Fatal(err)
	}
	if used := controller.Snapshot().Used; used.CPUMillicores != 1000 || used.MemoryBytes != 2048 {
		t.Fatalf("request demand lowered or failed to raise profile: %+v", used)
	}
	lease.Release()

	defaultLease, err := controller.TryAcquire(WorkloadRun, "alice", "default")
	if err != nil {
		t.Fatal(err)
	}
	if used := controller.Snapshot().Used; used.MemoryBytes != 1024 {
		t.Fatalf("request demand mutated the shared profile: %+v", used)
	}
	defaultLease.Release()
}

func TestControllerRejectsInvalidRequestDemand(t *testing.T) {
	registry := metrics.New(true, 4)
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{Capacity: resourcegovernor.Resources{Slots: 1, CPUMillicores: 1000, MemoryBytes: 1024, PIDs: 16}})
	if err != nil {
		t.Fatal(err)
	}
	controller, err := New(governor, testProfiles(), registry)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := controller.TryAcquireWithDemand(WorkloadRun, "alice", "invalid", resourcegovernor.Resources{MemoryBytes: -1}); err == nil {
		t.Fatal("negative request demand was accepted")
	}
	snapshot := registry.Snapshot().Governance
	if len(snapshot.Rejections) != 1 || snapshot.Rejections[0].Reason != "internal" {
		t.Fatalf("invalid demand metrics = %+v", snapshot.Rejections)
	}
}
