package main

import (
	"context"
	"testing"
	"time"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
)

func TestCleanupLoopRemovesPendingSessionAndChannelTogether(t *testing.T) {
	store := storage.NewMemorySessionStore()
	channels := session.NewChannelManager()
	store.Create(&model.RunSession{RunID: "loop-pending", UserID: "default"})
	channels.GetOrCreate("loop-pending", true)
	store.Create(&model.RunSession{RunID: "loop-started", UserID: "default"})
	if !store.MarkStarted("loop-started") {
		t.Fatal("failed to mark fixture session started")
	}
	startedChannel := channels.GetOrCreate("loop-started", true)
	time.Sleep(time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		cleanupLoop(ctx, store, channels, time.Millisecond, 0)
		close(done)
	}()

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		_, pendingExists := store.Get("loop-pending")
		if !pendingExists && channels.GetOrCreate("loop-pending", false) == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if _, exists := store.Get("loop-pending"); exists {
		cancel()
		t.Fatal("cleanup loop retained expired pending session")
	}
	if channel := channels.GetOrCreate("loop-pending", false); channel != nil {
		cancel()
		t.Fatal("cleanup loop retained expired pending channel")
	}
	if _, exists := store.Get("loop-started"); !exists {
		cancel()
		t.Fatal("cleanup loop removed started session")
	}
	if channel := channels.GetOrCreate("loop-started", false); channel != startedChannel {
		cancel()
		t.Fatal("cleanup loop removed or replaced started channel")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cleanup loop did not stop after cancellation")
	}
}
