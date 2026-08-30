package resourcegovernor

import (
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
)

func testNode() NodeResources {
	return NodeResources{
		Capacity: Resources{
			Slots: 4, CPUMillicores: 8000, MemoryBytes: 16 << 30,
			PIDs: 4096, EphemeralBytes: 100 << 30, Inodes: 1_000_000,
			Devices: map[string]int64{"gpu": 2, "fpga": 1},
		},
		Reserve: Resources{
			Slots: 1, CPUMillicores: 1000, MemoryBytes: 2 << 30,
			PIDs: 96, EphemeralBytes: 10 << 30, Inodes: 100_000,
			Devices: map[string]int64{"gpu": 1},
		},
	}
}

func TestNewRejectsInvalidNodeVectors(t *testing.T) {
	tests := []struct {
		name string
		node NodeResources
		code ConfigurationIssueCode
	}{
		{
			name: "negative capacity",
			node: NodeResources{Capacity: Resources{Slots: -1}},
			code: ConfigurationNegativeCapacity,
		},
		{
			name: "negative reserve",
			node: NodeResources{Capacity: Resources{Slots: 1}, Reserve: Resources{Slots: -1}},
			code: ConfigurationNegativeReserve,
		},
		{
			name: "reserve exceeds capacity",
			node: NodeResources{Capacity: Resources{MemoryBytes: 1}, Reserve: Resources{MemoryBytes: 2}},
			code: ConfigurationReserveExceedsCapacity,
		},
		{
			name: "invalid device name",
			node: NodeResources{Capacity: Resources{Devices: map[string]int64{" gpu": 1}}},
			code: ConfigurationInvalidDevice,
		},
		{
			name: "device reserve without capacity",
			node: NodeResources{Reserve: Resources{Devices: map[string]int64{"gpu": 1}}},
			code: ConfigurationReserveExceedsCapacity,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := New(test.node)
			var configurationError *ConfigurationError
			if !errors.As(err, &configurationError) {
				t.Fatalf("New error = %v, want *ConfigurationError", err)
			}
			if len(configurationError.Issues) == 0 || configurationError.Issues[0].Code != test.code {
				t.Fatalf("configuration issues = %+v, want first code %s", configurationError.Issues, test.code)
			}
		})
	}
}

func TestAcquireUsesCapacityMinusReserveAcrossResourceVector(t *testing.T) {
	governor, err := New(testNode())
	if err != nil {
		t.Fatal(err)
	}
	request := Request{
		Resources: Resources{
			Slots: 3, CPUMillicores: 7000, MemoryBytes: 14 << 30,
			PIDs: 4000, EphemeralBytes: 90 << 30, Inodes: 900_000,
			Devices: map[string]int64{"gpu": 1, "fpga": 1},
		},
		Metadata: Metadata{WorkloadID: "run-1", OwnerID: "alice"},
	}
	lease, err := governor.Acquire(request)
	if err != nil {
		t.Fatal(err)
	}
	if lease.ID() == 0 || lease.Metadata() != request.Metadata {
		t.Fatalf("lease = id:%d metadata:%+v", lease.ID(), lease.Metadata())
	}

	snapshot := governor.Snapshot()
	if !reflect.DeepEqual(snapshot.Usable, request.Resources) ||
		!reflect.DeepEqual(snapshot.Used, request.Resources) {
		t.Fatalf("snapshot usable=%+v used=%+v, want %+v", snapshot.Usable, snapshot.Used, request.Resources)
	}
	if !resourcesZero(snapshot.Available) {
		t.Fatalf("available after exact admission = %+v, want zero", snapshot.Available)
	}

	_, err = governor.Acquire(Request{Resources: Resources{Slots: 1}, Metadata: Metadata{WorkloadID: "run-2"}})
	var rejection *Rejection
	if !errors.As(err, &rejection) || rejection.Code != RejectionInsufficientResources {
		t.Fatalf("second Acquire error = %#v, want insufficient rejection", err)
	}
	if len(rejection.Reasons) != 1 || rejection.Reasons[0].Resource != ResourceSlots ||
		rejection.Reasons[0].Available != 0 || rejection.Reasons[0].Capacity != 4 ||
		rejection.Reasons[0].Reserve != 1 || rejection.Reasons[0].Used != 3 {
		t.Fatalf("slot rejection reason = %+v", rejection.Reasons)
	}
}

func TestAcquireReturnsAllStructuredDeficits(t *testing.T) {
	governor, err := New(NodeResources{
		Capacity: Resources{Slots: 2, MemoryBytes: 1024, Devices: map[string]int64{"gpu": 1}},
		Reserve:  Resources{Slots: 1, MemoryBytes: 256},
	})
	if err != nil {
		t.Fatal(err)
	}
	metadata := Metadata{WorkloadID: "heavy-run", OwnerID: "bob"}
	_, err = governor.Acquire(Request{
		Resources: Resources{Slots: 2, MemoryBytes: 900, Devices: map[string]int64{"gpu": 2, "tpu": 1}},
		Metadata:  metadata,
	})
	var rejection *Rejection
	if !errors.As(err, &rejection) {
		t.Fatalf("Acquire error = %v, want *Rejection", err)
	}
	if rejection.Code != RejectionInsufficientResources || rejection.Metadata != metadata {
		t.Fatalf("rejection = %+v", rejection)
	}
	want := map[string]RejectionReasonCode{
		"slots":      ReasonInsufficientAmount,
		"memory":     ReasonInsufficientAmount,
		"device:gpu": ReasonInsufficientAmount,
		"device:tpu": ReasonUnavailableDevice,
	}
	for _, reason := range rejection.Reasons {
		key := string(reason.Resource)
		if reason.Resource == ResourceMemoryBytes {
			key = "memory"
		}
		if reason.Resource == ResourceDevice {
			key += ":" + reason.Device
		}
		if code, exists := want[key]; !exists || code != reason.Code {
			t.Fatalf("unexpected reason %+v", reason)
		}
		delete(want, key)
	}
	if len(want) != 0 {
		t.Fatalf("missing rejection reasons: %+v", want)
	}
}

func TestAcquireRejectsInvalidAndEmptyRequests(t *testing.T) {
	governor, err := New(testNode())
	if err != nil {
		t.Fatal(err)
	}
	tests := []Request{
		{},
		{Resources: Resources{PIDs: -1}},
		{Resources: Resources{Devices: map[string]int64{"": 1}}},
		{Resources: Resources{Devices: map[string]int64{"gpu": -1}}},
	}
	for _, request := range tests {
		_, err := governor.Acquire(request)
		var rejection *Rejection
		if !errors.As(err, &rejection) || rejection.Code != RejectionInvalidRequest || len(rejection.Reasons) == 0 {
			t.Fatalf("Acquire(%+v) error = %#v, want invalid request rejection", request, err)
		}
	}
	if snapshot := governor.Snapshot(); len(snapshot.Leases) != 0 || !resourcesZero(snapshot.Used) {
		t.Fatalf("invalid requests changed snapshot: %+v", snapshot)
	}
}

func TestLeaseReleaseIsIdempotentAndDefensive(t *testing.T) {
	governor, err := New(NodeResources{Capacity: Resources{Slots: 1, Devices: map[string]int64{"gpu": 1}}})
	if err != nil {
		t.Fatal(err)
	}
	requestDevices := map[string]int64{"gpu": 1}
	lease, err := governor.Acquire(Request{Resources: Resources{Slots: 1, Devices: requestDevices}})
	if err != nil {
		t.Fatal(err)
	}
	requestDevices["gpu"] = 100
	resources := lease.Resources()
	resources.Devices["gpu"] = 50
	if !lease.Release() {
		t.Fatal("first Release returned false")
	}
	if lease.Release() {
		t.Fatal("second Release returned true")
	}
	if snapshot := governor.Snapshot(); snapshot.Used.Slots != 0 || snapshot.Used.Devices["gpu"] != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("released snapshot = %+v", snapshot)
	}
	if _, err := governor.Acquire(Request{Resources: Resources{Slots: 1, Devices: map[string]int64{"gpu": 1}}}); err != nil {
		t.Fatalf("released resources were not reusable: %v", err)
	}
}

func TestSnapshotIsConsistentOrderedAndIndependent(t *testing.T) {
	node := NodeResources{Capacity: Resources{Slots: 3, Devices: map[string]int64{"gpu": 3}}}
	governor, err := New(node)
	if err != nil {
		t.Fatal(err)
	}
	node.Capacity.Devices["gpu"] = 99
	first, err := governor.Acquire(Request{
		Resources: Resources{Slots: 1, Devices: map[string]int64{"gpu": 1}},
		Metadata:  Metadata{WorkloadID: "first", OwnerID: "alice"},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := governor.Acquire(Request{
		Resources: Resources{Slots: 1, Devices: map[string]int64{"gpu": 1}},
		Metadata:  Metadata{WorkloadID: "second", OwnerID: "bob"},
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := governor.Snapshot()
	if snapshot.Capacity.Devices["gpu"] != 3 || len(snapshot.Leases) != 2 ||
		snapshot.Leases[0].ID != first.ID() || snapshot.Leases[1].ID != second.ID() {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	snapshot.Capacity.Devices["gpu"] = 100
	snapshot.Used.Devices["gpu"] = 100
	snapshot.Leases[0].Resources.Devices["gpu"] = 100
	fresh := governor.Snapshot()
	if fresh.Capacity.Devices["gpu"] != 3 || fresh.Used.Devices["gpu"] != 2 ||
		fresh.Leases[0].Resources.Devices["gpu"] != 1 {
		t.Fatalf("mutating snapshot changed governor: %+v", fresh)
	}
}

func TestConcurrentAcquireNeverOvercommits(t *testing.T) {
	const (
		capacity = 8
		workers  = 128
	)
	governor, err := New(NodeResources{Capacity: Resources{Slots: capacity, MemoryBytes: capacity * 1024}})
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		lease *Lease
		err   error
	}
	start := make(chan struct{})
	release := make(chan struct{})
	results := make(chan result, workers)
	var wait sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wait.Add(1)
		go func(worker int) {
			defer wait.Done()
			<-start
			lease, acquireErr := governor.Acquire(Request{
				Resources: Resources{Slots: 1, MemoryBytes: 1024},
				Metadata:  Metadata{WorkloadID: "concurrent", OwnerID: "owner"},
			})
			results <- result{lease: lease, err: acquireErr}
			if lease != nil {
				<-release
				lease.Release()
			}
		}(worker)
	}
	close(start)
	winners := 0
	for worker := 0; worker < workers; worker++ {
		result := <-results
		if result.lease != nil {
			winners++
			continue
		}
		var rejection *Rejection
		if !errors.As(result.err, &rejection) || rejection.Code != RejectionInsufficientResources {
			t.Fatalf("losing acquire error = %#v", result.err)
		}
	}
	if winners != capacity {
		t.Fatalf("concurrent winners = %d, want %d", winners, capacity)
	}
	snapshot := governor.Snapshot()
	if snapshot.Used.Slots != capacity || snapshot.Used.MemoryBytes != capacity*1024 || len(snapshot.Leases) != capacity {
		t.Fatalf("peak snapshot = %+v", snapshot)
	}
	close(release)
	wait.Wait()
	if snapshot := governor.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("final snapshot = %+v", snapshot)
	}
}

func TestConcurrentReleaseOnlyAccountsOnce(t *testing.T) {
	governor, err := New(NodeResources{Capacity: Resources{Slots: 1}})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := governor.Acquire(Request{Resources: Resources{Slots: 1}})
	if err != nil {
		t.Fatal(err)
	}
	const releasers = 128
	var successful atomic.Int64
	var wait sync.WaitGroup
	for index := 0; index < releasers; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if lease.Release() {
				successful.Add(1)
			}
		}()
	}
	wait.Wait()
	if successful.Load() != 1 {
		t.Fatalf("successful releases = %d, want 1", successful.Load())
	}
	if snapshot := governor.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("snapshot after concurrent release = %+v", snapshot)
	}
}

func TestConcurrentAcquireReleaseAndSnapshot(t *testing.T) {
	governor, err := New(NodeResources{
		Capacity: Resources{Slots: 32, CPUMillicores: 32_000, Devices: map[string]int64{"gpu": 4}},
	})
	if err != nil {
		t.Fatal(err)
	}
	const (
		workers    = 32
		iterations = 250
	)
	start := make(chan struct{})
	var wait sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wait.Add(1)
		go func(worker int) {
			defer wait.Done()
			<-start
			for iteration := 0; iteration < iterations; iteration++ {
				resources := Resources{Slots: 1, CPUMillicores: 1000}
				if worker%8 == 0 {
					resources.Devices = map[string]int64{"gpu": 1}
				}
				lease, acquireErr := governor.Acquire(Request{Resources: resources})
				if acquireErr == nil {
					_ = lease.Resources()
					_ = governor.Snapshot()
					lease.Release()
					continue
				}
				var rejection *Rejection
				if !errors.As(acquireErr, &rejection) || rejection.Code != RejectionInsufficientResources {
					t.Errorf("Acquire error = %#v", acquireErr)
					return
				}
			}
		}(worker)
	}
	close(start)
	wait.Wait()
	if snapshot := governor.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("final snapshot = %+v", snapshot)
	}
}
