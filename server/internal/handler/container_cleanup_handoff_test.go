package handler

import (
	"context"
	"testing"
	"time"
)

func TestDeferredContainerCleanupRetainsReleaseUntilRemovalCompletes(t *testing.T) {
	ctx, finalize := WithDeferredContainerCleanup(context.Background())
	cleanup := make(chan struct{})
	released := make(chan struct{})
	if !RetainResourcesUntilContainerRemoved(ctx, func() { <-cleanup }) {
		t.Fatal("container cleanup ownership was not transferred")
	}
	finalize(func() { close(released) })
	select {
	case <-released:
		t.Fatal("storage resources were released before container removal")
	default:
	}
	close(cleanup)
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("storage resources were not released after container removal")
	}
}

func TestDeferredContainerCleanupHandlesRemovalBeforeFinalization(t *testing.T) {
	ctx, finalize := WithDeferredContainerCleanup(context.Background())
	cleanupComplete := make(chan struct{})
	if !RetainResourcesUntilContainerRemoved(ctx, func() { close(cleanupComplete) }) {
		t.Fatal("container cleanup ownership was not transferred")
	}
	select {
	case <-cleanupComplete:
	case <-time.After(time.Second):
		t.Fatal("container cleanup did not complete")
	}
	released := make(chan struct{})
	finalize(func() { close(released) })
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("completed cleanup did not release finalized resources")
	}
}

func TestDeferredContainerCleanupReleasesImmediatelyWithoutHandoff(t *testing.T) {
	_, finalize := WithDeferredContainerCleanup(context.Background())
	released := false
	finalize(func() { released = true })
	if !released {
		t.Fatal("ordinary request did not release resources synchronously")
	}
}
