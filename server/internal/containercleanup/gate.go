package containercleanup

import (
	"context"
	"sync"
)

type gateContextKey struct{}

// ReleaseGate delays request-owned release callbacks only when container
// cleanup explicitly transfers ownership through Retain.
type ReleaseGate struct {
	mu        sync.Mutex
	retained  bool
	completed bool
	finalized bool
	releases  []func()
}

func WithReleaseGate(ctx context.Context) (context.Context, *ReleaseGate) {
	if ctx == nil {
		ctx = context.Background()
	}
	gate := &ReleaseGate{}
	return context.WithValue(ctx, gateContextKey{}, gate), gate
}

// Add registers one idempotent owner release. Finalize runs registrations in
// reverse order to preserve ordinary defer cleanup ordering.
func (gate *ReleaseGate) Add(release func()) {
	if gate == nil || release == nil {
		return
	}
	gate.mu.Lock()
	if gate.finalized && (!gate.retained || gate.completed) {
		gate.mu.Unlock()
		release()
		return
	}
	gate.releases = append(gate.releases, release)
	gate.mu.Unlock()
}

func (gate *ReleaseGate) Finalize() {
	if gate == nil {
		return
	}
	gate.mu.Lock()
	if gate.finalized {
		gate.mu.Unlock()
		return
	}
	gate.finalized = true
	ready := !gate.retained || gate.completed
	releases := gate.takeReleasesLocked(ready)
	gate.mu.Unlock()
	runReleases(releases)
}

func (gate *ReleaseGate) complete() {
	gate.mu.Lock()
	if gate.completed {
		gate.mu.Unlock()
		return
	}
	gate.completed = true
	releases := gate.takeReleasesLocked(gate.finalized)
	gate.mu.Unlock()
	runReleases(releases)
}

func (gate *ReleaseGate) takeReleasesLocked(ready bool) []func() {
	if !ready || len(gate.releases) == 0 {
		return nil
	}
	releases := gate.releases
	gate.releases = nil
	return releases
}

// Retain transfers cleanup completion to register. register must arrange for
// done to run only after the container is confirmed absent.
func Retain(ctx context.Context, register func(done func())) bool {
	if ctx == nil || register == nil {
		return false
	}
	gate, _ := ctx.Value(gateContextKey{}).(*ReleaseGate)
	if gate == nil {
		return false
	}
	gate.mu.Lock()
	if gate.retained || gate.finalized {
		gate.mu.Unlock()
		return false
	}
	gate.retained = true
	gate.mu.Unlock()
	register(gate.complete)
	return true
}

func runReleases(releases []func()) {
	for index := len(releases) - 1; index >= 0; index-- {
		if releases[index] != nil {
			releases[index]()
		}
	}
}
