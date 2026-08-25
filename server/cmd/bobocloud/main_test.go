package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/serverruntime"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"

	bolt "go.etcd.io/bbolt"
)

type testUserContainerDestroyer struct {
	err   error
	calls int
}

type testRuntimeShutdownFunc func(context.Context) error

func (function testRuntimeShutdownFunc) Shutdown(ctx context.Context) error {
	return function(ctx)
}

type testRuntimeListenerFunc func(context.Context) error

func (function testRuntimeListenerFunc) Shutdown(ctx context.Context) error {
	return function(ctx)
}

func (d *testUserContainerDestroyer) DestroyUserContainers(string) error {
	d.calls++
	return d.err
}

func TestFinishRuntimeShutdownAdvancesPastPhaseCheckpointWithinGracePeriod(t *testing.T) {
	runtime := serverruntime.New(context.Background())
	var listenerCalls atomic.Int32
	var hookCalls atomic.Int32
	if err := runtime.RegisterListener("http", testRuntimeListenerFunc(func(ctx context.Context) error {
		if listenerCalls.Add(1) == 1 {
			<-ctx.Done()
			return ctx.Err()
		}
		return nil
	})); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RegisterStopHook(serverruntime.PhaseResources, "docker", func(context.Context) error {
		hookCalls.Add(1)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	grace, cancelGrace := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancelGrace()
	if err := finishRuntimeShutdown(grace, runtime, time.Millisecond); err != nil {
		t.Fatalf("finishRuntimeShutdown() error = %v", err)
	}
	if err := grace.Err(); err != nil {
		t.Fatalf("overall grace period expired: %v", err)
	}
	if listenerCalls.Load() != 2 || hookCalls.Load() != 1 {
		t.Fatalf("shutdown calls = listener %d, hook %d; want 2, 1", listenerCalls.Load(), hookCalls.Load())
	}
	if runtime.State() != serverruntime.Stopped {
		t.Fatalf("runtime state = %s, want stopped", runtime.State())
	}
}

func TestFinishRuntimeShutdownBoundsPermanentErrorsWithoutBusyLoop(t *testing.T) {
	permanentErr := errors.New("permanent shutdown failure")
	var calls atomic.Int32
	runtime := testRuntimeShutdownFunc(func(context.Context) error {
		calls.Add(1)
		return permanentErr
	})
	grace, cancelGrace := context.WithTimeout(context.Background(), 55*time.Millisecond)
	defer cancelGrace()
	err := finishRuntimeShutdown(grace, runtime, 20*time.Millisecond)
	if !errors.Is(err, permanentErr) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("finishRuntimeShutdown() error = %v, want permanent error and deadline", err)
	}
	if got := calls.Load(); got < 2 || got > 3 {
		t.Fatalf("shutdown attempts = %d, want bounded retries with backoff", got)
	}

	backgroundCalls := atomic.Int32{}
	err = finishRuntimeShutdown(context.Background(), testRuntimeShutdownFunc(func(context.Context) error {
		backgroundCalls.Add(1)
		return permanentErr
	}), time.Millisecond)
	if !errors.Is(err, permanentErr) || backgroundCalls.Load() != 1 {
		t.Fatalf("non-cancellable shutdown = (%v, %d calls), want one attempt", err, backgroundCalls.Load())
	}
}

func TestTeamCacheV2RootDoesNotReadLegacyStore(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "data")
	got := teamCacheV2Root(dataDir)
	want := filepath.Join(dataDir, "cache-v2", "teams")
	if got != want {
		t.Fatalf("team cache root = %q, want %q", got, want)
	}
	if got == filepath.Join(dataDir, "team-cache") {
		t.Fatal("cache-v2 team manager still targets the retired team-cache root")
	}
}

func TestSynchronizeUserContainerLimitsIncludesPersistedUsersAfterRestart(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "users.db")
	db, err := bolt.Open(databasePath, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	store := auth.NewBoltUserStore(db)
	for _, user := range []*auth.User{
		{ID: "persisted-root", Username: "root", Role: auth.RoleRoot, ContainerLimit: 3},
		{ID: "persisted-member", Username: "member", Role: auth.RoleMember, ContainerLimit: 7},
	} {
		if err := store.Create(user); err != nil {
			_ = db.Close()
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = bolt.Open(databasePath, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	restarted := auth.NewBoltUserStore(db)
	limits := make(map[string]int)
	users, err := synchronizeUserContainerLimits(restarted, func(userID string, limit int) {
		limits[userID] = limit
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 2 || limits["persisted-root"] != 3 || limits["persisted-member"] != 7 {
		t.Fatalf("restart limits = %v for %d users", limits, len(users))
	}
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
	step := func(name string) func(context.Context) error {
		return func(context.Context) error {
			calls = append(calls, name)
			return nil
		}
	}
	mountStep := func(name string) func(context.Context, string) error {
		return func(context.Context, string) error {
			calls = append(calls, name)
			return nil
		}
	}
	err := recoverDependencyRuntimeState(context.Background(), t.TempDir(), dependencyRecoverySteps{
		cleanupManagedContainers: step("managed-containers"),
		cleanupLSPContainers:     step("lsp-containers"),
		cleanupLSPMounts:         mountStep("lsp-mounts"),
		cleanupDAPContainers:     step("dap-containers"),
		cleanupDAPMounts:         mountStep("dap-mounts"),
		recoverTransactions:      func(context.Context) error { calls = append(calls, "transactions"); return nil },
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
	err := recoverDependencyRuntimeState(context.Background(), t.TempDir(), dependencyRecoverySteps{
		cleanupManagedContainers: func(context.Context) error { calls = append(calls, "managed"); return nil },
		cleanupLSPContainers:     func(context.Context) error { calls = append(calls, "lsp-containers"); return nil },
		cleanupLSPMounts:         func(context.Context, string) error { calls = append(calls, "lsp-mounts"); return mountErr },
		cleanupDAPContainers:     func(context.Context) error { calls = append(calls, "dap-containers"); return nil },
		cleanupDAPMounts:         func(context.Context, string) error { calls = append(calls, "dap-mounts"); return nil },
		recoverTransactions:      func(context.Context) error { calls = append(calls, "transactions"); return nil },
	})
	if !errors.Is(err, mountErr) {
		t.Fatalf("mount cleanup failure was hidden: %v", err)
	}
	want := []string{"managed", "lsp-containers", "dap-containers", "lsp-mounts"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("fail-closed recovery calls = %v, want %v", calls, want)
	}
}

func TestDependencyRecoveryStopsBetweenStagesWhenStartupIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var calls []string
	err := recoverDependencyRuntimeState(ctx, t.TempDir(), dependencyRecoverySteps{
		cleanupManagedContainers: func(context.Context) error {
			calls = append(calls, "managed")
			cancel()
			return context.Canceled
		},
		cleanupLSPContainers: func(context.Context) error {
			calls = append(calls, "lsp")
			return nil
		},
		cleanupLSPMounts: func(context.Context, string) error {
			calls = append(calls, "lsp-mount")
			return nil
		},
		cleanupDAPContainers: func(context.Context) error {
			calls = append(calls, "dap")
			return nil
		},
		cleanupDAPMounts: func(context.Context, string) error {
			calls = append(calls, "dap-mount")
			return nil
		},
		recoverTransactions: func(context.Context) error { calls = append(calls, "transactions"); return nil },
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("recovery error = %v, want context cancellation", err)
	}
	if want := []string{"managed"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("cancelled recovery calls = %v, want %v", calls, want)
	}
}

func TestCleanupLoopRemovesPendingSessionAndChannelTogether(t *testing.T) {
	store := storage.NewMemorySessionStore()
	channels := session.NewChannelManager()
	if _, err := store.Create(&model.RunSession{RunID: "loop-pending", UserID: "default"}); err != nil {
		t.Fatal(err)
	}
	channels.GetOrCreate("loop-pending", true)
	if _, err := store.Create(&model.RunSession{RunID: "loop-started", UserID: "default"}); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkStarted("loop-started"); err != nil {
		t.Fatalf("failed to mark fixture session started: %v", err)
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

func TestBOBOHTTPServerBoundsHeadersWithoutTimingOutStreams(t *testing.T) {
	cfg := config.Default()
	cfg.HTTPReadHeaderTimeoutSeconds = 7
	cfg.HTTPIdleTimeoutSeconds = 75
	cfg.HTTPMaxHeaderBytes = 512 << 10
	type contextKey string
	base := context.WithValue(context.Background(), contextKey("server"), "root")
	server := newBOBOHTTPServer(":0", http.NotFoundHandler(), cfg, base)

	if server.ReadHeaderTimeout != 7*time.Second || server.IdleTimeout != 75*time.Second {
		t.Fatalf("listener timeouts = read-header %s idle %s", server.ReadHeaderTimeout, server.IdleTimeout)
	}
	if server.MaxHeaderBytes != 512<<10 {
		t.Fatalf("max header bytes = %d", server.MaxHeaderBytes)
	}
	if server.ReadTimeout != 0 || server.WriteTimeout != 0 {
		t.Fatalf("streaming deadlines must remain unset: read=%s write=%s", server.ReadTimeout, server.WriteTimeout)
	}
	if got := server.BaseContext(nil).Value(contextKey("server")); got != "root" {
		t.Fatalf("base context value = %v", got)
	}
}

func TestPeriodicLoopStopsWithServerContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	called := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		periodicLoop(ctx, time.Millisecond, func() {
			select {
			case called <- struct{}{}:
			default:
			}
		})
		close(done)
	}()
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("periodic loop did not run")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("periodic loop did not stop after cancellation")
	}
}
