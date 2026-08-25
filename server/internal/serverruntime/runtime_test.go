package serverruntime

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type listenerFunc func(context.Context) error

func (function listenerFunc) Shutdown(ctx context.Context) error {
	return function(ctx)
}

func TestBeginDrainIsConcurrentAndCancelsRootContext(t *testing.T) {
	runtime := New(context.Background())
	const callers = 64
	cause := errors.New("test drain")
	var transitioned atomic.Int32
	var wait sync.WaitGroup
	wait.Add(callers)
	for index := 0; index < callers; index++ {
		go func() {
			defer wait.Done()
			if runtime.BeginDrain(cause) {
				transitioned.Add(1)
			}
		}()
	}
	wait.Wait()

	if transitioned.Load() != 1 {
		t.Fatalf("successful transitions = %d, want 1", transitioned.Load())
	}
	if runtime.State() != Draining {
		t.Fatalf("state = %s, want draining", runtime.State())
	}
	select {
	case <-runtime.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("root context was not cancelled")
	}
	if !errors.Is(context.Cause(runtime.Context()), cause) {
		t.Fatalf("root cause = %v, want %v", context.Cause(runtime.Context()), cause)
	}
	if err := runtime.Go("late-worker", func(context.Context) {}); !errors.Is(err, ErrNotAccepting) {
		t.Fatalf("late Go error = %v, want ErrNotAccepting", err)
	}
}

func TestShutdownCancelsAndWaitsForManagedWorkers(t *testing.T) {
	runtime := New(context.Background())
	started := make(chan struct{})
	exited := make(chan struct{})
	if err := runtime.Go("cleanup-loop", func(ctx context.Context) {
		close(started)
		<-ctx.Done()
		close(exited)
	}); err != nil {
		t.Fatal(err)
	}
	<-started

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := runtime.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
	select {
	case <-exited:
	default:
		t.Fatal("managed worker was not awaited")
	}
	if runtime.State() != Stopped {
		t.Fatalf("state = %s, want stopped", runtime.State())
	}
}

func TestAcquireTracksCallerOwnedWorkAcrossDrain(t *testing.T) {
	runtime := New(context.Background())
	release, err := runtime.Acquire("websocket-run")
	if err != nil {
		t.Fatal(err)
	}
	runtime.BeginDrain(errors.New("shutdown"))

	short, cancelShort := context.WithTimeout(context.Background(), 20*time.Millisecond)
	if err := runtime.Wait(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Wait() error = %v, want deadline exceeded", err)
	}
	cancelShort()
	if _, err := runtime.Acquire("late-websocket"); !errors.Is(err, ErrNotAccepting) {
		t.Fatalf("late Acquire() error = %v, want ErrNotAccepting", err)
	}

	release()
	release()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := runtime.Wait(ctx); err != nil {
		t.Fatalf("Wait() after release error = %v", err)
	}
}

func TestShutdownTimeoutRemainsDrainingAndCanRetry(t *testing.T) {
	runtime := New(context.Background())
	release := make(chan struct{})
	if err := runtime.Go("slow-worker", func(context.Context) {
		<-release
	}); err != nil {
		t.Fatal(err)
	}

	short, cancelShort := context.WithTimeout(context.Background(), 20*time.Millisecond)
	err := runtime.Shutdown(short)
	cancelShort()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("first Shutdown() error = %v, want deadline exceeded", err)
	}
	if runtime.State() != Draining {
		t.Fatalf("state after timeout = %s, want draining", runtime.State())
	}
	select {
	case <-runtime.Done():
		t.Fatal("Done closed before shutdown completed")
	default:
	}

	close(release)
	retry, cancelRetry := context.WithTimeout(context.Background(), time.Second)
	defer cancelRetry()
	if err := runtime.Shutdown(retry); err != nil {
		t.Fatalf("retry Shutdown() error = %v", err)
	}
	if runtime.State() != Stopped {
		t.Fatalf("state after retry = %s, want stopped", runtime.State())
	}
}

func TestShutdownWorkerTimeoutStillRunsResourceAndStorageHooks(t *testing.T) {
	runtime := New(context.Background())
	releaseWorker := make(chan struct{})
	defer close(releaseWorker)
	if err := runtime.Go("stuck-worker", func(context.Context) {
		<-releaseWorker
	}); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	order := make([]string, 0, 3)
	record := func(name string) StopHook {
		return func(ctx context.Context) error {
			if err := ctx.Err(); err != nil {
				t.Errorf("%s hook received an expired context: %v", name, err)
			}
			mu.Lock()
			order = append(order, name)
			mu.Unlock()
			return nil
		}
	}
	if err := runtime.RegisterStopHook(PhaseServices, "service", record("service")); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RegisterStopHook(PhaseResources, "resource", record("resource")); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RegisterStopHook(PhaseStorage, "storage", record("storage")); err != nil {
		t.Fatal(err)
	}

	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	err := runtime.Shutdown(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Shutdown() error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed >= 200*time.Millisecond {
		t.Fatalf("Shutdown() consumed the full budget before finishing hooks: %s", elapsed)
	}
	mu.Lock()
	gotOrder := append([]string(nil), order...)
	mu.Unlock()
	wantOrder := []string{"service", "resource", "storage"}
	if len(gotOrder) != len(wantOrder) {
		t.Fatalf("hook order = %v, want %v", gotOrder, wantOrder)
	}
	for index := range wantOrder {
		if gotOrder[index] != wantOrder[index] {
			t.Fatalf("hook order = %v, want %v", gotOrder, wantOrder)
		}
	}
	if runtime.State() != Draining {
		t.Fatalf("state = %s, want draining after worker timeout", runtime.State())
	}
}

func TestShutdownRetriesInterruptedListenerWithoutDuplicateConcurrency(t *testing.T) {
	runtime := New(context.Background())
	var calls atomic.Int32
	var active atomic.Int32
	var maximumActive atomic.Int32
	releaseFirst := make(chan struct{})
	listener := listenerFunc(func(ctx context.Context) error {
		call := calls.Add(1)
		current := active.Add(1)
		defer active.Add(-1)
		for {
			maximum := maximumActive.Load()
			if current <= maximum || maximumActive.CompareAndSwap(maximum, current) {
				break
			}
		}
		if call == 1 {
			<-releaseFirst
			return ctx.Err()
		}
		return nil
	})
	if err := runtime.RegisterListener("http", listener); err != nil {
		t.Fatal(err)
	}

	first, cancelFirst := context.WithTimeout(context.Background(), 20*time.Millisecond)
	err := runtime.Shutdown(first)
	cancelFirst()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("first Shutdown() error = %v, want deadline exceeded", err)
	}
	if runtime.State() != Draining {
		t.Fatalf("state = %s, want draining", runtime.State())
	}

	retryResult := make(chan error, 1)
	go func() {
		retry, cancelRetry := context.WithTimeout(context.Background(), time.Second)
		defer cancelRetry()
		retryResult <- runtime.Shutdown(retry)
	}()
	time.Sleep(20 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("listener was called while its first shutdown was still active: calls = %d", calls.Load())
	}
	close(releaseFirst)
	if err := <-retryResult; err != nil {
		t.Fatalf("retry Shutdown() error = %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("listener calls = %d, want 2", calls.Load())
	}
	if maximumActive.Load() != 1 {
		t.Fatalf("maximum concurrent listener calls = %d, want 1", maximumActive.Load())
	}
}

func TestShutdownRetryCanReuseOverallCallerDeadline(t *testing.T) {
	runtime := New(context.Background())
	var listenerCalls atomic.Int32
	var hookCalls atomic.Int32
	if err := runtime.RegisterListener("http", listenerFunc(func(ctx context.Context) error {
		if listenerCalls.Add(1) == 1 {
			<-ctx.Done()
			return ctx.Err()
		}
		return nil
	})); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RegisterStopHook(PhaseResources, "docker", func(context.Context) error {
		hookCalls.Add(1)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	overall, cancelOverall := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancelOverall()
	if err := runtime.Shutdown(overall); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("first Shutdown() error = %v, want phase deadline", err)
	}
	if err := overall.Err(); err != nil {
		t.Fatalf("phase checkpoint consumed the overall deadline: %v", err)
	}
	if hookCalls.Load() != 0 {
		t.Fatal("dependent hook ran before the listener retry completed")
	}
	if err := runtime.Shutdown(overall); err != nil {
		t.Fatalf("retry Shutdown() with the same context error = %v", err)
	}
	if listenerCalls.Load() != 2 || hookCalls.Load() != 1 {
		t.Fatalf("shutdown calls = listener %d, hook %d; want 2, 1", listenerCalls.Load(), hookCalls.Load())
	}
}

func TestShutdownDefersDependentPhasesWhileServiceHookIsStillRunning(t *testing.T) {
	runtime := New(context.Background())
	var serviceCalls atomic.Int32
	var resourceCalls atomic.Int32
	var storageCalls atomic.Int32
	releaseFirst := make(chan struct{})
	if err := runtime.RegisterStopHook(PhaseServices, "service", func(ctx context.Context) error {
		if serviceCalls.Add(1) == 1 {
			<-releaseFirst
			return ctx.Err()
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RegisterStopHook(PhaseResources, "docker", func(context.Context) error {
		resourceCalls.Add(1)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RegisterStopHook(PhaseStorage, "database", func(context.Context) error {
		storageCalls.Add(1)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	first, cancelFirst := context.WithTimeout(context.Background(), 80*time.Millisecond)
	err := runtime.Shutdown(first)
	cancelFirst()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("first Shutdown() error = %v, want deadline exceeded", err)
	}
	if resourceCalls.Load() != 0 || storageCalls.Load() != 0 {
		t.Fatalf("dependent hooks ran during active service cleanup: resource=%d storage=%d", resourceCalls.Load(), storageCalls.Load())
	}

	retryResult := make(chan error, 1)
	go func() {
		retry, cancelRetry := context.WithTimeout(context.Background(), time.Second)
		defer cancelRetry()
		retryResult <- runtime.Shutdown(retry)
	}()
	time.Sleep(20 * time.Millisecond)
	if serviceCalls.Load() != 1 {
		t.Fatalf("service hook was invoked concurrently: calls=%d", serviceCalls.Load())
	}
	if resourceCalls.Load() != 0 || storageCalls.Load() != 0 {
		t.Fatalf("retry crossed the active service hook: resource=%d storage=%d", resourceCalls.Load(), storageCalls.Load())
	}
	close(releaseFirst)
	if err := <-retryResult; err != nil {
		t.Fatalf("retry Shutdown() error = %v", err)
	}
	if serviceCalls.Load() != 2 || resourceCalls.Load() != 1 || storageCalls.Load() != 1 {
		t.Fatalf("shutdown calls = service %d, resource %d, storage %d; want 2, 1, 1", serviceCalls.Load(), resourceCalls.Load(), storageCalls.Load())
	}
}

func TestShutdownAggregatesListenerErrors(t *testing.T) {
	runtime := New(context.Background())
	errHTTP := errors.New("http failed")
	errWebSocket := errors.New("websocket failed")
	if err := runtime.RegisterListener("http", listenerFunc(func(context.Context) error { return errHTTP })); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RegisterListener("websocket", listenerFunc(func(context.Context) error { return errWebSocket })); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := runtime.Shutdown(ctx)
	if !errors.Is(err, errHTTP) || !errors.Is(err, errWebSocket) {
		t.Fatalf("Shutdown() error = %v, want both listener errors", err)
	}
	if runtime.State() != Draining {
		t.Fatalf("state = %s, want draining", runtime.State())
	}
}

func TestShutdownRunsAllPhasesInOrderAndAggregatesHookErrors(t *testing.T) {
	runtime := New(context.Background())
	var phaseOneA atomic.Int32
	var phaseOneB atomic.Int32
	var phaseTwo atomic.Int32
	errA := errors.New("hook a failed")
	errB := errors.New("hook b failed")

	if err := runtime.RegisterStopHook(PhaseServices, "service-a", func(context.Context) error {
		if phaseOneA.Add(1) == 1 {
			return errA
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RegisterStopHook(PhaseServices, "service-b", func(context.Context) error {
		if phaseOneB.Add(1) == 1 {
			return errB
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RegisterStopHook(PhaseResources, "resource", func(context.Context) error {
		phaseTwo.Add(1)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	err := runtime.Shutdown(ctx)
	cancel()
	if !errors.Is(err, errA) || !errors.Is(err, errB) {
		t.Fatalf("Shutdown() error = %v, want both hook errors", err)
	}
	if phaseTwo.Load() != 1 {
		t.Fatalf("later phase calls = %d, want 1 despite an earlier error", phaseTwo.Load())
	}
	if runtime.State() != Draining {
		t.Fatalf("state = %s, want draining", runtime.State())
	}

	retry, cancelRetry := context.WithTimeout(context.Background(), time.Second)
	defer cancelRetry()
	if err := runtime.Shutdown(retry); err != nil {
		t.Fatalf("retry Shutdown() error = %v", err)
	}
	if phaseOneA.Load() != 2 || phaseOneB.Load() != 2 || phaseTwo.Load() != 1 {
		t.Fatalf("hook calls = (%d, %d, %d), want (2, 2, 1)", phaseOneA.Load(), phaseOneB.Load(), phaseTwo.Load())
	}
}

func TestConcurrentShutdownIsIdempotent(t *testing.T) {
	runtime := New(context.Background())
	var listenerCalls atomic.Int32
	var hookCalls atomic.Int32
	if err := runtime.RegisterListener("http", listenerFunc(func(context.Context) error {
		listenerCalls.Add(1)
		return nil
	})); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RegisterStopHook(PhaseResources, "pool", func(context.Context) error {
		hookCalls.Add(1)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	const callers = 32
	errorsFound := make(chan error, callers)
	var wait sync.WaitGroup
	wait.Add(callers)
	for index := 0; index < callers; index++ {
		go func() {
			defer wait.Done()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			errorsFound <- runtime.Shutdown(ctx)
		}()
	}
	wait.Wait()
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatalf("concurrent Shutdown() error = %v", err)
		}
	}
	if listenerCalls.Load() != 1 || hookCalls.Load() != 1 {
		t.Fatalf("shutdown calls = listener %d, hook %d; want 1 each", listenerCalls.Load(), hookCalls.Load())
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runtime.Shutdown(ctx); err != nil {
		t.Fatalf("idempotent Shutdown() after stop error = %v", err)
	}
	select {
	case <-runtime.Done():
	default:
		t.Fatal("Done is not closed")
	}
}

func TestRegistrationValidationAndWaitContract(t *testing.T) {
	runtime := New(context.Background())
	if err := runtime.Wait(context.Background()); !errors.Is(err, ErrNotDraining) {
		t.Fatalf("Wait() error = %v, want ErrNotDraining", err)
	}
	listener := listenerFunc(func(context.Context) error { return nil })
	if err := runtime.RegisterListener("http", listener); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RegisterListener("http", listener); !errors.Is(err, ErrDuplicateName) {
		t.Fatalf("duplicate registration error = %v, want ErrDuplicateName", err)
	}
	runtime.BeginDrain(nil)
	if err := runtime.RegisterStopHook(PhaseStorage, "db", func(context.Context) error { return nil }); !errors.Is(err, ErrNotAccepting) {
		t.Fatalf("late registration error = %v, want ErrNotAccepting", err)
	}
}

func TestParentCancellationBeginsDrain(t *testing.T) {
	parent, cancelParent := context.WithCancelCause(context.Background())
	runtime := New(parent)
	cause := errors.New("signal")
	cancelParent(cause)

	deadline := time.After(time.Second)
	for runtime.State() == Accepting {
		select {
		case <-deadline:
			t.Fatal("parent cancellation did not begin drain")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if !errors.Is(context.Cause(runtime.Context()), cause) {
		t.Fatalf("root cause = %v, want %v", context.Cause(runtime.Context()), cause)
	}
}
