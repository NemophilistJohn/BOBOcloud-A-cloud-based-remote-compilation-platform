package docker

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestShutdownContextBoundsConcurrencyAndStopsAdmission(t *testing.T) {
	const containerCount = shutdownRemovalWorkers + 7
	containers := make(map[string]string, containerCount)
	for i := range containerCount {
		containers[fmt.Sprintf("container-%02d", i)] = "alice"
	}

	started := make(chan struct{}, containerCount)
	release := make(chan struct{})
	var commandMu sync.Mutex
	active := 0
	maxActive := 0
	removed := make(map[string]int, containerCount)
	pool := &Pool{containerUser: containers}
	pool.runDockerCommand = func(ctx context.Context, args ...string) ([]byte, error) {
		if args[0] != "rm" {
			t.Fatalf("unexpected Docker command: %v", args)
		}
		containerID := args[len(args)-1]
		commandMu.Lock()
		active++
		if active > maxActive {
			maxActive = active
		}
		removed[containerID]++
		commandMu.Unlock()
		started <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		commandMu.Lock()
		active--
		commandMu.Unlock()
		return nil, nil
	}

	shutdownResult := make(chan error, 1)
	go func() { shutdownResult <- pool.ShutdownContext(context.Background()) }()
	for range shutdownRemovalWorkers {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("shutdown did not start the expected removal workers")
		}
	}
	select {
	case <-started:
		t.Fatalf("shutdown exceeded its %d-worker removal bound", shutdownRemovalWorkers)
	case <-time.After(25 * time.Millisecond):
	}

	if _, err := pool.acquireForUser(context.Background(), "alice", "python", "python", "", nil, nil, nil); err == nil {
		t.Fatal("pool accepted a new acquisition after shutdown began")
	}
	close(release)
	if err := <-shutdownResult; err != nil {
		t.Fatalf("ShutdownContext() error = %v", err)
	}

	commandMu.Lock()
	defer commandMu.Unlock()
	if maxActive != shutdownRemovalWorkers {
		t.Fatalf("maximum concurrent removals = %d, want %d", maxActive, shutdownRemovalWorkers)
	}
	if len(removed) != containerCount {
		t.Fatalf("removed %d containers, want %d: %#v", len(removed), containerCount, removed)
	}
	for containerID, attempts := range removed {
		if attempts != 1 {
			t.Fatalf("container %q removal attempts = %d, want 1", containerID, attempts)
		}
	}
}

func TestShutdownContextHonorsCancellation(t *testing.T) {
	pool := &Pool{containerUser: map[string]string{
		"container-a": "alice",
		"container-b": "bob",
		"container-c": "carol",
		"container-d": "dave",
		"container-e": "erin",
	}}
	started := make(chan struct{}, len(pool.containerUser))
	pool.runDockerCommand = func(ctx context.Context, args ...string) ([]byte, error) {
		if args[0] == "rm" {
			started <- struct{}{}
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return nil, ctx.Err()
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- pool.ShutdownContext(ctx) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not start container removal")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("ShutdownContext() error = %v, want context cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("ShutdownContext did not return after cancellation")
	}
}

func TestShutdownContextAggregatesUnconfirmedRemovalErrors(t *testing.T) {
	removeFailure := errors.New("remove failed")
	failRemovals := true
	pool := &Pool{
		containerUser: map[string]string{
			"bad-a":   "alice",
			"bad-b":   "alice",
			"gone":    "alice",
			"removed": "alice",
		},
	}
	var commandMu sync.Mutex
	commands := 0
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		commandMu.Lock()
		commands++
		commandMu.Unlock()
		containerID := args[len(args)-1]
		switch args[0] {
		case "rm":
			if !failRemovals {
				return nil, nil
			}
			switch containerID {
			case "removed":
				return nil, nil
			case "gone":
				return []byte("Error: No such container: gone"), removeFailure
			default:
				return []byte("daemon refused removal"), removeFailure
			}
		case "inspect":
			return []byte("true\n"), nil
		default:
			t.Fatalf("unexpected Docker command: %v", args)
			return nil, nil
		}
	}

	err := pool.ShutdownContext(context.Background())
	if err == nil {
		t.Fatal("ShutdownContext accepted unconfirmed removals")
	}
	for _, containerID := range []string{"bad-a", "bad-b"} {
		if !strings.Contains(err.Error(), containerID) {
			t.Fatalf("aggregate error %q does not identify %q", err, containerID)
		}
	}
	if strings.Contains(err.Error(), "gone") || strings.Contains(err.Error(), "removed") {
		t.Fatalf("confirmed absence/removal was reported as failure: %v", err)
	}
	if !errors.Is(err, removeFailure) {
		t.Fatalf("aggregate error does not preserve removal cause: %v", err)
	}

	commandMu.Lock()
	commandsAfterFirstCall := commands
	commandMu.Unlock()
	failRemovals = false
	secondErr := pool.ShutdownContext(context.Background())
	if secondErr != nil {
		t.Fatalf("retrying shutdown after Docker recovery: %v", secondErr)
	}
	commandMu.Lock()
	defer commandMu.Unlock()
	if commands <= commandsAfterFirstCall {
		t.Fatalf("second shutdown did not retry Docker cleanup: before=%d after=%d", commandsAfterFirstCall, commands)
	}
}

func TestShutdownContextRetriesAfterCreateDrainTimeout(t *testing.T) {
	const containerID = "late-after-timeout"
	pool := &Pool{
		containerUser:      make(map[string]string),
		imageByContainerID: make(map[string]string),
		containerContext:   make(map[string]string),
		pendingRemoval:     make(map[string]bool),
		taintedContainers:  make(map[string]bool),
		lruByImage:         make(map[string]time.Time),
		idlePool:           make(map[string][]string),
	}
	_, finishCreate, ok := pool.beginContainerCreate(context.Background())
	if !ok {
		t.Fatal("beginContainerCreate rejected work before shutdown")
	}

	firstCtx, cancelFirst := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancelFirst()
	if err := pool.ShutdownContext(firstCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("first ShutdownContext() error = %v, want deadline exceeded", err)
	}

	pool.mu.Lock()
	pool.containerUser[containerID] = "alice"
	pool.mu.Unlock()
	finishCreate()

	removed := make(chan string, 1)
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		if args[0] != "rm" {
			t.Fatalf("unexpected Docker command: %v", args)
		}
		removed <- args[len(args)-1]
		return nil, nil
	}
	if err := pool.ShutdownContext(context.Background()); err != nil {
		t.Fatalf("retrying ShutdownContext(): %v", err)
	}
	select {
	case got := <-removed:
		if got != containerID {
			t.Fatalf("removed container = %q, want %q", got, containerID)
		}
	default:
		t.Fatal("retry did not remove the late registered container")
	}
}

func TestDestroyUserContainersContextCancellationRetainsOwnershipForRetry(t *testing.T) {
	const containerID = "user-container"
	pool := &Pool{
		containerUser:         map[string]string{containerID: "alice"},
		containerContext:      make(map[string]string),
		taintedContainers:     make(map[string]bool),
		pendingRemoval:        make(map[string]bool),
		imageByContainerID:    make(map[string]string),
		lruByImage:            make(map[string]time.Time),
		idlePool:              make(map[string][]string),
		userActiveContainers:  map[string]int{"alice": 1},
		userPendingContainers: make(map[string]int),
		userBackgroundCreates: make(map[string]int),
		deletedUsers:          make(map[string]bool),
	}
	removeStarted := make(chan struct{})
	var removeOnce sync.Once
	pool.runDockerCommand = func(ctx context.Context, args ...string) ([]byte, error) {
		if args[0] == "rm" {
			removeOnce.Do(func() { close(removeStarted) })
			<-ctx.Done()
		}
		return nil, ctx.Err()
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- pool.DestroyUserContainersContext(ctx, "alice") }()
	select {
	case <-removeStarted:
	case <-time.After(time.Second):
		t.Fatal("user container removal did not start")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("DestroyUserContainersContext() error = %v, want cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("user container cleanup ignored cancellation")
	}

	pool.mu.Lock()
	owner, tracked := pool.containerUser[containerID]
	pool.mu.Unlock()
	if !tracked || owner != "alice" {
		t.Fatalf("cancelled cleanup lost container ownership: tracked=%v owner=%q", tracked, owner)
	}

	pool.runDockerCommand = func(context.Context, ...string) ([]byte, error) { return nil, nil }
	if err := pool.DestroyUserContainers("alice"); err != nil {
		t.Fatalf("retrying user cleanup: %v", err)
	}
	pool.mu.Lock()
	_, tracked = pool.containerUser[containerID]
	pool.mu.Unlock()
	if tracked {
		t.Fatal("successful retry retained container ownership")
	}
}

func TestShutdownContextIncludesPartiallyIndexedContainers(t *testing.T) {
	pool := &Pool{
		containerUser:      map[string]string{"owned": "alice"},
		imageByContainerID: map[string]string{"image-only": "python"},
		containerContext:   map[string]string{"context-only": "generation"},
		pendingRemoval:     map[string]bool{"pending-only": true},
		taintedContainers:  map[string]bool{"tainted-only": true},
		lruByImage:         map[string]time.Time{"lru-only": time.Now()},
		idlePool:           map[string][]string{"python": {"idle-only", "owned"}},
	}
	var commandMu sync.Mutex
	removed := make(map[string]bool)
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		commandMu.Lock()
		removed[args[len(args)-1]] = true
		commandMu.Unlock()
		return nil, nil
	}

	if err := pool.ShutdownContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, containerID := range []string{"owned", "image-only", "context-only", "pending-only", "tainted-only", "lru-only", "idle-only"} {
		if !removed[containerID] {
			t.Errorf("partially indexed container %q was not removed", containerID)
		}
	}
}

func TestShutdownWaitsForBlockedPreWarmCreateBeforeFinalSnapshot(t *testing.T) {
	const image = "python:test"
	const userID = "alice"
	const containerID = "late-prewarm-container"
	pool := &Pool{
		hotPool:               make(map[hotPoolKey]chan string),
		imageLocal:            map[string]bool{image: true},
		poolSize:              1,
		maxTotal:              4,
		userBackgroundCreates: make(map[string]int),
		deletedUsers:          make(map[string]bool),
		containerUser:         make(map[string]string),
		imageByContainerID:    make(map[string]string),
		containerContext:      make(map[string]string),
		pendingRemoval:        make(map[string]bool),
		taintedContainers:     make(map[string]bool),
		lruByImage:            make(map[string]time.Time),
		idlePool:              make(map[string][]string),
		userActiveContainers:  make(map[string]int),
		stalePersonalContext:  make(map[string]bool),
	}
	createStarted := make(chan struct{})
	releaseCreate := make(chan struct{})
	pool.createContainerHook = func(context.Context, string, map[string]string, map[string]string) (string, error) {
		close(createStarted)
		// Simulate a Docker create command which returns an ID after cancellation.
		<-releaseCreate
		return containerID, nil
	}
	var commandMu sync.Mutex
	removed := make(map[string]int)
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		if args[0] != "rm" {
			t.Fatalf("unexpected Docker command: %v", args)
		}
		commandMu.Lock()
		removed[args[len(args)-1]]++
		commandMu.Unlock()
		return nil, nil
	}

	pool.PreWarm(image, userID)
	select {
	case <-createStarted:
	case <-time.After(time.Second):
		t.Fatal("pre-warm did not reach container creation")
	}

	shutdownResult := make(chan error, 1)
	go func() { shutdownResult <- pool.ShutdownContext(context.Background()) }()
	deadline := time.Now().Add(time.Second)
	for {
		pool.mu.Lock()
		closed := pool.closed
		pool.mu.Unlock()
		if closed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("shutdown did not close admission")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case err := <-shutdownResult:
		t.Fatalf("shutdown returned before blocked create registered or rolled back: %v", err)
	case <-time.After(25 * time.Millisecond):
	}

	close(releaseCreate)
	select {
	case err := <-shutdownResult:
		if err != nil {
			t.Fatalf("ShutdownContext() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown did not finish after blocked create completed")
	}

	commandMu.Lock()
	removeAttempts := removed[containerID]
	commandMu.Unlock()
	if removeAttempts != 1 {
		t.Fatalf("late container removal attempts = %d, want 1", removeAttempts)
	}
	pool.mu.Lock()
	_, stillTracked := pool.containerUser[containerID]
	backgroundCreates := pool.userBackgroundCreates[userID]
	pool.mu.Unlock()
	if stillTracked || backgroundCreates != 0 {
		t.Fatalf("late create was not fully rolled back: tracked=%v background=%d", stillTracked, backgroundCreates)
	}
}

func TestCleanupOrphanedContainersContextCancelsRemoval(t *testing.T) {
	pool := &Pool{containerUser: make(map[string]string)}
	removeStarted := make(chan struct{})
	pool.runDockerCommand = func(ctx context.Context, args ...string) ([]byte, error) {
		switch args[0] {
		case "ps":
			return []byte("orphan\n"), nil
		case "rm":
			close(removeStarted)
			<-ctx.Done()
			return nil, ctx.Err()
		case "inspect":
			return nil, ctx.Err()
		default:
			t.Fatalf("unexpected Docker command: %v", args)
			return nil, nil
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- pool.CleanupOrphanedContainersContext(ctx) }()
	select {
	case <-removeStarted:
	case <-time.After(time.Second):
		t.Fatal("orphan cleanup did not start removal")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("CleanupOrphanedContainersContext() error = %v, want context cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("orphan cleanup did not stop after context cancellation")
	}
}

func TestDiscardRetryYieldsToFinalShutdownSnapshot(t *testing.T) {
	const containerID = "retrying-container"
	removeErr := errors.New("docker daemon unavailable")
	pool := &Pool{
		containerUser:      map[string]string{containerID: "alice"},
		containerContext:   make(map[string]string),
		taintedContainers:  make(map[string]bool),
		pendingRemoval:     make(map[string]bool),
		imageByContainerID: make(map[string]string),
		lruByImage:         make(map[string]time.Time),
		idlePool:           make(map[string][]string),
	}
	firstRemove := make(chan struct{})
	var firstRemoveOnce sync.Once
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		switch args[0] {
		case "rm":
			firstRemoveOnce.Do(func() { close(firstRemove) })
			return []byte("daemon unavailable"), removeErr
		case "inspect":
			return []byte("true\n"), nil
		default:
			t.Fatalf("unexpected Docker command: %v", args)
			return nil, nil
		}
	}

	discardDone := make(chan struct{})
	go func() {
		pool.DiscardForUser(containerID, "alice")
		close(discardDone)
	}()
	select {
	case <-firstRemove:
	case <-time.After(time.Second):
		t.Fatal("discard did not begin its first removal attempt")
	}

	err := pool.ShutdownContext(context.Background())
	if !errors.Is(err, removeErr) {
		t.Fatalf("ShutdownContext() error = %v, want final removal failure", err)
	}
	select {
	case <-discardDone:
	case <-time.After(time.Second):
		t.Fatal("discard retry did not yield to pool shutdown")
	}
	pool.mu.Lock()
	_, tracked := pool.containerUser[containerID]
	pool.mu.Unlock()
	if !tracked {
		t.Fatal("failed final removal dropped ownership state")
	}
}

func TestShutdownReleasesRetainedRemovalCallbackOnlyAfterConfirmedAbsence(t *testing.T) {
	const containerID = "retained-until-shutdown"
	failRemoval := true
	released := 0
	pool := &Pool{
		containerUser:        map[string]string{containerID: "alice"},
		containerContext:     map[string]string{containerID: "personal/cache:rw"},
		taintedContainers:    make(map[string]bool),
		pendingRemoval:       make(map[string]bool),
		imageByContainerID:   map[string]string{containerID: "python"},
		lruByImage:           make(map[string]time.Time),
		idlePool:             make(map[string][]string),
		userActiveContainers: map[string]int{"alice": 1},
		activeCount:          1,
	}
	pool.waitDockerRetry = func(time.Duration) {}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		switch args[0] {
		case "rm":
			if failRemoval {
				return []byte("daemon unavailable"), errors.New("remove failed")
			}
			return nil, nil
		case "inspect":
			return []byte("true\n"), nil
		default:
			return nil, fmt.Errorf("unexpected Docker command: %v", args)
		}
	}

	pool.DiscardForUserRetained(containerID, "alice", func() { released++ })
	pool.internalTasks.Wait()
	if released != 0 {
		t.Fatal("failed removal released callback before shutdown")
	}
	failRemoval = false
	if err := pool.ShutdownContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	if released != 1 {
		t.Fatalf("shutdown release count = %d, want 1", released)
	}
	if err := pool.ShutdownContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	if released != 1 {
		t.Fatalf("idempotent shutdown reran callback: %d", released)
	}
}

func TestContainerRunningStateContextHonorsCancellation(t *testing.T) {
	inspectStarted := make(chan struct{})
	pool := &Pool{runDockerCommand: func(ctx context.Context, args ...string) ([]byte, error) {
		if len(args) == 0 || args[0] != "inspect" {
			return nil, fmt.Errorf("unexpected Docker command: %v", args)
		}
		close(inspectStarted)
		<-ctx.Done()
		return nil, ctx.Err()
	}}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := pool.containerRunningStateContext(ctx, "health-probe-container")
		result <- err
	}()
	select {
	case <-inspectStarted:
	case <-time.After(time.Second):
		t.Fatal("health probe did not start Docker inspect")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("containerRunningStateContext() error = %v, want cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("health probe ignored context cancellation")
	}
}

func TestShutdownCancelsHealthRemovalBeforeFinalSnapshot(t *testing.T) {
	const containerID = "health-removal-container"
	pool := &Pool{
		containerUser:      map[string]string{containerID: "alice"},
		containerContext:   make(map[string]string),
		taintedContainers:  make(map[string]bool),
		pendingRemoval:     map[string]bool{containerID: false},
		imageByContainerID: map[string]string{containerID: "python"},
		lruByImage:         make(map[string]time.Time),
		idlePool:           make(map[string][]string),
	}

	firstRemovalStarted := make(chan struct{})
	finalRemoval := make(chan string, 1)
	var commandMu sync.Mutex
	removeAttempts := 0
	pool.runDockerCommand = func(ctx context.Context, args ...string) ([]byte, error) {
		switch args[0] {
		case "rm":
			commandMu.Lock()
			removeAttempts++
			attempt := removeAttempts
			commandMu.Unlock()
			if attempt == 1 {
				close(firstRemovalStarted)
				<-ctx.Done()
				return nil, ctx.Err()
			}
			finalRemoval <- args[len(args)-1]
			return nil, nil
		case "inspect":
			return nil, ctx.Err()
		default:
			return nil, fmt.Errorf("unexpected Docker command: %v", args)
		}
	}

	healthCleanup := make(chan error, 1)
	if !pool.startInternalTask(func(ctx context.Context) {
		healthCleanup <- pool.removeQuarantinedContainerContext(ctx, containerID)
	}) {
		t.Fatal("health cleanup task was rejected before shutdown")
	}
	select {
	case <-firstRemovalStarted:
	case <-time.After(time.Second):
		t.Fatal("health cleanup did not start Docker removal")
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelShutdown()
	if err := pool.ShutdownContext(shutdownCtx); err != nil {
		t.Fatalf("ShutdownContext() error = %v", err)
	}
	select {
	case err := <-healthCleanup:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("health cleanup error = %v, want lifecycle cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("health cleanup did not yield to shutdown")
	}
	select {
	case removed := <-finalRemoval:
		if removed != containerID {
			t.Fatalf("final snapshot removed %q, want %q", removed, containerID)
		}
	default:
		t.Fatal("shutdown skipped the final container snapshot")
	}
	commandMu.Lock()
	attempts := removeAttempts
	commandMu.Unlock()
	if attempts != 2 {
		t.Fatalf("container removal attempts = %d, want cancelled health removal plus final snapshot", attempts)
	}
}
