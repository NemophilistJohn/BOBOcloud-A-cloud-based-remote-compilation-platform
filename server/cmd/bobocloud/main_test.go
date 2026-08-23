package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
)

type testUserContainerDestroyer struct {
	err   error
	calls int
}

func (d *testUserContainerDestroyer) DestroyUserContainers(string) error {
	d.calls++
	return d.err
}

func TestRemoveUserDataWaitsForConfirmedContainerRemoval(t *testing.T) {
	userDir := filepath.Join(t.TempDir(), "users", "alice")
	if err := os.MkdirAll(userDir, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(userDir, "persist-marker")
	if err := os.WriteFile(marker, []byte("still mounted"), 0600); err != nil {
		t.Fatal(err)
	}

	destroyer := &testUserContainerDestroyer{err: errors.New("container may still be live")}
	if err := removeUserDataAfterContainerCleanup(destroyer, "alice", userDir); err == nil {
		t.Fatal("unconfirmed container removal was accepted")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("user data was removed before container absence was confirmed: %v", err)
	}

	destroyer.err = nil
	if err := removeUserDataAfterContainerCleanup(destroyer, "alice", userDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(userDir); !os.IsNotExist(err) {
		t.Fatalf("confirmed cleanup retained user directory: %v", err)
	}
	if destroyer.calls != 2 {
		t.Fatalf("container cleanup calls = %d, want 2", destroyer.calls)
	}
}

func TestDependencyRecoveryCleansAllRuntimesBeforeTransactions(t *testing.T) {
	var calls []string
	step := func(name string) func() error {
		return func() error {
			calls = append(calls, name)
			return nil
		}
	}
	mountStep := func(name string) func(string) error {
		return func(string) error {
			calls = append(calls, name)
			return nil
		}
	}
	err := recoverDependencyRuntimeState(t.TempDir(), dependencyRecoverySteps{
		cleanupManagedContainers: step("managed-containers"),
		cleanupLSPContainers:     step("lsp-containers"),
		cleanupLSPMounts:         mountStep("lsp-mounts"),
		cleanupDAPContainers:     step("dap-containers"),
		cleanupDAPMounts:         mountStep("dap-mounts"),
		recoverTransactions:      func() { calls = append(calls, "transactions") },
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"managed-containers", "lsp-containers", "dap-containers", "lsp-mounts", "dap-mounts", "transactions"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("recovery order = %v, want %v", calls, want)
	}
}

func TestDependencyRecoveryFailsClosedBeforeTransactions(t *testing.T) {
	mountErr := errors.New("unmount still pending")
	var calls []string
	err := recoverDependencyRuntimeState(t.TempDir(), dependencyRecoverySteps{
		cleanupManagedContainers: func() error { calls = append(calls, "managed"); return nil },
		cleanupLSPContainers:     func() error { calls = append(calls, "lsp-containers"); return nil },
		cleanupLSPMounts:         func(string) error { calls = append(calls, "lsp-mounts"); return mountErr },
		cleanupDAPContainers:     func() error { calls = append(calls, "dap-containers"); return nil },
		cleanupDAPMounts:         func(string) error { calls = append(calls, "dap-mounts"); return nil },
		recoverTransactions:      func() { calls = append(calls, "transactions") },
	})
	if !errors.Is(err, mountErr) {
		t.Fatalf("mount cleanup failure was hidden: %v", err)
	}
	want := []string{"managed", "lsp-containers", "dap-containers", "lsp-mounts"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("fail-closed recovery calls = %v, want %v", calls, want)
	}
}

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
