package handler

import (
	"context"
	"sync"
)

type containerCleanupHandoffKey struct{}

// containerCleanupHandoff keeps request-owned storage resources alive when a
// Docker container cannot be synchronously confirmed absent. The executor
// starts the removal retry first; the HTTP layer then supplies the release
// callback after it has marked a failed dependency transaction aborted.
type containerCleanupHandoff struct {
	mu              sync.Mutex
	retained        bool
	cleanupComplete bool
	finalized       bool
	release         func()
	releaseOnce     sync.Once
}

// WithDeferredContainerCleanup installs a one-shot cleanup ownership handoff.
// finalize must be called after the executor returns. It releases immediately
// unless the executor retained ownership for a pending container removal.
func WithDeferredContainerCleanup(ctx context.Context) (context.Context, func(func())) {
	if ctx == nil {
		ctx = context.Background()
	}
	handoff := &containerCleanupHandoff{}
	return context.WithValue(ctx, containerCleanupHandoffKey{}, handoff), handoff.finalize
}

// RetainResourcesUntilContainerRemoved transfers storage-resource ownership
// to cleanup. It returns false when the context has no handoff or the request
// has already finalized; callers must then run cleanup synchronously.
func RetainResourcesUntilContainerRemoved(ctx context.Context, cleanup func()) bool {
	if ctx == nil || cleanup == nil {
		return false
	}
	handoff, _ := ctx.Value(containerCleanupHandoffKey{}).(*containerCleanupHandoff)
	if handoff == nil || !handoff.retain() {
		return false
	}
	go func() {
		cleanup()
		handoff.completeCleanup()
	}()
	return true
}

func (handoff *containerCleanupHandoff) retain() bool {
	handoff.mu.Lock()
	defer handoff.mu.Unlock()
	if handoff.retained || handoff.finalized {
		return false
	}
	handoff.retained = true
	return true
}

func (handoff *containerCleanupHandoff) finalize(release func()) {
	if handoff == nil {
		if release != nil {
			release()
		}
		return
	}
	handoff.mu.Lock()
	if handoff.finalized {
		handoff.mu.Unlock()
		return
	}
	handoff.finalized = true
	handoff.release = release
	ready := !handoff.retained || handoff.cleanupComplete
	handoff.mu.Unlock()
	if ready {
		handoff.runRelease()
	}
}

func (handoff *containerCleanupHandoff) completeCleanup() {
	handoff.mu.Lock()
	handoff.cleanupComplete = true
	ready := handoff.finalized
	handoff.mu.Unlock()
	if ready {
		handoff.runRelease()
	}
}

func (handoff *containerCleanupHandoff) runRelease() {
	handoff.releaseOnce.Do(func() {
		handoff.mu.Lock()
		release := handoff.release
		handoff.release = nil
		handoff.mu.Unlock()
		if release != nil {
			release()
		}
	})
}
