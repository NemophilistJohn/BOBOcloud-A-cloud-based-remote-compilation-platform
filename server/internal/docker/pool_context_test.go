package docker

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestMergeContainerOptionsPreservesDependencyAndToolchainContext(t *testing.T) {
	dependencyHost := filepath.Join("cache-v2", "dependencies", "generation-7")
	toolchainHost := filepath.Join("cache-v2", "toolchains", "pip", "generation-3")
	volumes := mergeContainerOptions(nil, map[string]string{
		dependencyHost: "/project-deps:ro",
		toolchainHost:  "/tool-cache/pip",
	})
	environment := mergeContainerOptions(nil, map[string]string{
		"PYTHONPATH":    "/project-deps/python",
		"PIP_CACHE_DIR": "/tool-cache/pip",
	})

	if volumes[dependencyHost] != "/project-deps:ro" || volumes[toolchainHost] != "/tool-cache/pip" {
		t.Fatalf("cache-v2 context volumes = %#v", volumes)
	}
	if environment["PYTHONPATH"] != "/project-deps/python" || environment["PIP_CACHE_DIR"] != "/tool-cache/pip" {
		t.Fatalf("cache-v2 context environment = %#v", environment)
	}
	if volumes == nil || environment == nil {
		t.Fatal("cache-v2 context maps must remain writable when legacy defaults are nil")
	}
}

func TestAcquireCacheV2ContextCreateFailureReleasesReservations(t *testing.T) {
	image := "python:cache-v2-test"
	nonDirectory := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(nonDirectory, []byte("occupied"), 0600); err != nil {
		t.Fatal(err)
	}
	pool := newCacheV2AcquireTestPool(image, testPoolPolicy{})

	_, err := pool.AcquireForUserWithContext(context.Background(), "alice", image, "personal/project@generation", map[string]string{
		nonDirectory: "/project-deps",
	}, map[string]string{
		"PYTHONPATH": "/project-deps/python",
	}, nil)
	if err == nil {
		t.Fatal("invalid bind source unexpectedly created a container")
	}
	assertCacheV2AcquireReservationsReleased(t, pool)
}

func TestAcquireCacheV2ContextPanicReleasesReservations(t *testing.T) {
	image := "python:cache-v2-panic-test"
	pool := newCacheV2AcquireTestPool(image, testPoolPolicy{panicOnNetwork: true})
	defer func() {
		if recovered := recover(); recovered == nil {
			t.Error("expected injected create-path panic")
		}
		assertCacheV2AcquireReservationsReleased(t, pool)
	}()

	_, _ = pool.AcquireForUserWithContext(context.Background(), "alice", image, "personal/project@generation", nil, map[string]string{
		"PYTHONPATH": "/project-deps/python",
	}, nil)
}

func TestAcquireRuntimeContextUsesRuntimeIDForNetworkPolicy(t *testing.T) {
	const (
		runtimeID = "python:3.10"
		image     = "registry.example/python-build:stable"
	)
	nonDirectory := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(nonDirectory, []byte("occupied"), 0600); err != nil {
		t.Fatal(err)
	}
	var policyKey string
	pool := newCacheV2AcquireTestPool(image, testPoolPolicy{networkPolicyKey: &policyKey})

	_, err := pool.AcquireForUserRuntimeWithContext(context.Background(), "alice", runtimeID, image, "personal/project@generation", map[string]string{
		nonDirectory: "/project-deps",
	}, nil, nil)
	if err == nil {
		t.Fatal("invalid bind source unexpectedly created a container")
	}
	if policyKey != runtimeID {
		t.Fatalf("network policy key = %q, want runtime ID %q", policyKey, runtimeID)
	}
	assertCacheV2AcquireReservationsReleased(t, pool)
}

type testPoolPolicy struct {
	panicOnNetwork   bool
	networkPolicyKey *string
}

func (policy testPoolPolicy) AllowCommand(string) bool { return true }

func (policy testPoolPolicy) AllowNetwork(runtimeID string) bool {
	if policy.networkPolicyKey != nil {
		*policy.networkPolicyKey = runtimeID
	}
	if policy.panicOnNetwork {
		panic("injected network policy panic")
	}
	return true
}

func (policy testPoolPolicy) FilterCommand(command string) string { return command }

func newCacheV2AcquireTestPool(image string, policy testPoolPolicy) *Pool {
	return &Pool{
		imageLocal:            map[string]bool{image: true},
		maxTotal:              2,
		sec:                   policy,
		userActiveContainers:  make(map[string]int),
		userPendingContainers: make(map[string]int),
	}
}

func assertCacheV2AcquireReservationsReleased(t *testing.T, pool *Pool) {
	t.Helper()
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if pool.activeCount != 0 || pool.userPendingContainers["alice"] != 0 || pool.userActiveContainers["alice"] != 0 {
		t.Fatalf("failed acquisition leaked reservations: active=%d pending=%d user_active=%d", pool.activeCount, pool.userPendingContainers["alice"], pool.userActiveContainers["alice"])
	}
}
