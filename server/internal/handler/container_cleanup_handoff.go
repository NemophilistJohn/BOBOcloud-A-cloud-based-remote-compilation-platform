package handler

import (
	"context"

	"bobocloud-server/internal/containercleanup"
)

// WithDeferredContainerCleanup is the handler-facing compatibility wrapper for
// the shared release gate used by runners and direct Docker executors.
func WithDeferredContainerCleanup(ctx context.Context) (context.Context, func(func())) {
	ctx, gate := containercleanup.WithReleaseGate(ctx)
	return ctx, func(release func()) {
		gate.Add(release)
		gate.Finalize()
	}
}

// RetainResourcesUntilContainerRemoved preserves the original synchronous
// cleanup callback API for existing direct executors and test fakes.
func RetainResourcesUntilContainerRemoved(ctx context.Context, cleanup func()) bool {
	if cleanup == nil {
		return false
	}
	return containercleanup.Retain(ctx, func(complete func()) {
		go func() {
			cleanup()
			complete()
		}()
	})
}

// RegisterResourcesUntilContainerRemoved stores completion with the pool so a
// bounded cleanup cycle never needs a goroutine that waits indefinitely.
func RegisterResourcesUntilContainerRemoved(ctx context.Context, register func(complete func())) bool {
	return containercleanup.Retain(ctx, register)
}

func runReleaseCallbacksReverse(releases []func()) {
	for index := len(releases) - 1; index >= 0; index-- {
		if releases[index] != nil {
			releases[index]()
		}
	}
}
