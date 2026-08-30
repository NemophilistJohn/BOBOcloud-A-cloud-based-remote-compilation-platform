package docker

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/containercleanup"
	"bobocloud-server/internal/metrics"
)

func TestPoolPublishesBoundedDockerQueueDepthInsteadOfPerRequestLogs(t *testing.T) {
	registry := metrics.New(true, 4)
	pool := &Pool{queue: NewRequestQueue(2, time.Second)}
	pool.SetMetrics(registry)
	req := queuedRequest("alice", "python")
	if err := pool.queue.Enqueue(req); err != nil {
		t.Fatal(err)
	}
	pool.observeQueueDepth()

	assertDepth := func(want int64) {
		t.Helper()
		for _, queue := range registry.Snapshot().Governance.Queues {
			if queue.Workload == "docker" {
				if queue.Current != want {
					t.Fatalf("Docker queue depth = %d, want %d", queue.Current, want)
				}
				return
			}
		}
		t.Fatal("Docker queue metric was not published")
	}
	assertDepth(1)
	pool.wakeNextQueued()
	assertDepth(0)
}

type queueStatusOutput struct {
	mu       sync.Mutex
	statuses []string
}

func (output *queueStatusOutput) WriteStatus(_ string, message string) {
	output.mu.Lock()
	output.statuses = append(output.statuses, message)
	output.mu.Unlock()
}
func (*queueStatusOutput) WriteStdout(string, string)           {}
func (*queueStatusOutput) WriteStderr(string, string)           {}
func (*queueStatusOutput) WriteArtifactBegin()                  {}
func (*queueStatusOutput) WriteArtifact(string, []byte, string) {}
func (*queueStatusOutput) WriteArtifactEnd()                    {}
func (*queueStatusOutput) WriteResult(bool, int)                {}
func (*queueStatusOutput) WriteError(string)                    {}

func queuedRequest(user, image string) *QueueRequest {
	return &QueueRequest{
		UserID: user, Image: image,
		ResultCh: make(chan QueueResult, 1),
		Ctx:      context.Background(), CreatedAt: time.Now(),
	}
}

func TestRequestQueueFIFO(t *testing.T) {
	rq := NewRequestQueue(3, time.Second)
	first := queuedRequest("a", "python")
	second := queuedRequest("b", "rust")
	if err := rq.Enqueue(first); err != nil {
		t.Fatal(err)
	}
	if err := rq.Enqueue(second); err != nil {
		t.Fatal(err)
	}
	if got := rq.DequeueNext(); got != first {
		t.Fatalf("first dequeue = %p, want %p", got, first)
	}
	if got := rq.DequeueNext(); got != second {
		t.Fatalf("second dequeue = %p, want %p", got, second)
	}
}

func TestRequestQueueRejectsFullAndSkipsCancelled(t *testing.T) {
	rq := NewRequestQueue(1, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cancelled := queuedRequest("a", "python")
	cancelled.Ctx = ctx
	if err := rq.Enqueue(cancelled); err == nil {
		t.Fatal("expected cancelled request to be rejected")
	}

	first := queuedRequest("a", "python")
	if err := rq.Enqueue(first); err != nil {
		t.Fatal(err)
	}
	if err := rq.Enqueue(queuedRequest("b", "rust")); err == nil {
		t.Fatal("expected full queue error")
	}
}

func TestWakeNextQueuedNeverTransfersContainer(t *testing.T) {
	rq := NewRequestQueue(1, time.Second)
	req := queuedRequest("new-user", "rust")
	if err := rq.Enqueue(req); err != nil {
		t.Fatal(err)
	}
	pool := &Pool{queue: rq}
	pool.wakeNextQueued()

	select {
	case result := <-req.ResultCh:
		if result.ContainerID != "" {
			t.Fatalf("wake transferred container %q", result.ContainerID)
		}
	case <-time.After(time.Second):
		t.Fatal("queued request was not woken")
	}
}

func TestRequestQueueTimeoutStats(t *testing.T) {
	rq := NewRequestQueue(1, 25*time.Millisecond)
	if got := rq.Timeout(); got != 25*time.Millisecond {
		t.Fatalf("timeout = %v", got)
	}
	rq.RecordTimeout()
	_, timedOut, _ := rq.Stats()
	if timedOut != 1 {
		t.Fatalf("timeout count = %d, want 1", timedOut)
	}
}

func TestAcquireViaQueueSnapshotsCapacityUnderLock(t *testing.T) {
	pool := &Pool{queue: NewRequestQueue(1, time.Second), maxTotal: 8}
	output := &queueStatusOutput{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	started := make(chan struct{})
	stop := make(chan struct{})
	var writer sync.WaitGroup
	writer.Add(1)
	go func() {
		defer writer.Done()
		close(started)
		for active := 0; ; active = (active + 1) % 9 {
			select {
			case <-stop:
				return
			default:
			}
			pool.mu.Lock()
			pool.activeCount = active
			pool.mu.Unlock()
		}
	}()
	<-started

	for i := 0; i < 500; i++ {
		if _, err := pool.acquireViaQueue(ctx, "alice", "python:3.10", "python:3.10-slim", "", nil, nil, output); err == nil {
			close(stop)
			writer.Wait()
			t.Fatal("cancelled queue request unexpectedly succeeded")
		}
	}
	close(stop)
	writer.Wait()

	output.mu.Lock()
	defer output.mu.Unlock()
	if len(output.statuses) != 500 {
		t.Fatalf("queue status count = %d, want 500", len(output.statuses))
	}
	for _, status := range output.statuses {
		if !strings.Contains(status, "/8)") {
			t.Fatalf("queue status did not use the configured capacity snapshot: %q", status)
		}
	}
}

func TestRequestQueueRemoveByUser(t *testing.T) {
	rq := NewRequestQueue(3, time.Second)
	removed := queuedRequest("removed", "python")
	kept := queuedRequest("kept", "rust")
	_ = rq.Enqueue(removed)
	_ = rq.Enqueue(kept)
	if count := rq.RemoveByUser("removed", nil); count != 1 {
		t.Fatalf("removed count = %d, want 1", count)
	}
	if result := <-removed.ResultCh; result.Error == nil {
		t.Fatal("removed request did not receive cancellation")
	}
	if got := rq.DequeueNext(); got != kept {
		t.Fatal("unrelated queued request was removed")
	}
}

func TestDestroyUserContainersWaitsForPendingAcquireBeforeDetaching(t *testing.T) {
	hot := make(chan string, 1)
	hot <- "hot-user"
	pool := &Pool{
		hotPool: map[hotPoolKey]chan string{
			{image: "python", userID: "removed"}: hot,
		},
		idlePool: map[string][]string{
			"python": {"idle-user", "idle-other"},
		},
		containerUser: map[string]string{
			"hot-user": "removed", "idle-user": "removed",
			"active-user": "removed", "idle-other": "other",
		},
		lruByImage: map[string]time.Time{
			"hot-user": time.Now(), "idle-user": time.Now(), "idle-other": time.Now(),
		},
		imageByContainerID: map[string]string{
			"hot-user": "python", "idle-user": "python", "active-user": "rust", "idle-other": "python",
		},
		userActiveContainers:  map[string]int{"removed": 1},
		userPendingContainers: map[string]int{"removed": 1},
		userBackgroundCreates: map[string]int{"removed": 1},
		userContainerLimits:   map[string]int{"removed": 2},
		deletedUsers:          make(map[string]bool),
		pendingRemoval:        make(map[string]bool),
		activeCount:           2, // hot-user + active-user
		idleCount:             2, // idle-user + idle-other
	}

	if err := pool.DestroyUserContainers("removed"); err == nil {
		t.Fatal("account deletion ignored an in-flight acquisition")
	}
	if pool.activeCount != 2 || pool.idleCount != 2 || len(pool.containerUser) != 4 {
		t.Fatalf("pending acquisition lost ownership: active=%d idle=%d owners=%#v", pool.activeCount, pool.idleCount, pool.containerUser)
	}
	if pool.userActiveContainers["removed"] != 1 || pool.userContainerLimits["removed"] != 2 {
		t.Fatalf("pending acquisition lost quota accounting: active=%d limit=%d", pool.userActiveContainers["removed"], pool.userContainerLimits["removed"])
	}
	if !pool.deletedUsers["removed"] {
		t.Fatal("deleted user was not blocked from replenishment")
	}

	pool.userPendingContainers["removed"] = 0
	pool.userBackgroundCreates["removed"] = 0
	pool.runDockerCommand = func(context.Context, ...string) ([]byte, error) { return nil, nil }
	if err := pool.DestroyUserContainers("removed"); err != nil {
		t.Fatal(err)
	}
	if pool.activeCount != 0 || pool.idleCount != 1 {
		t.Fatalf("counts after confirmed deletion: active=%d idle=%d", pool.activeCount, pool.idleCount)
	}
	if len(pool.idlePool["python"]) != 1 || pool.idlePool["python"][0] != "idle-other" {
		t.Fatalf("other user's idle container was not preserved: %#v", pool.idlePool)
	}
}

func TestSetUserLimitDoesNotReactivateDeletedUser(t *testing.T) {
	pool := &Pool{
		userActiveContainers:  make(map[string]int),
		userPendingContainers: make(map[string]int),
		userBackgroundCreates: make(map[string]int),
		userContainerLimits:   map[string]int{"alice": 1},
		deletedUsers:          make(map[string]bool),
		containerUser:         make(map[string]string),
	}

	if err := pool.DestroyUserContainersContext(context.Background(), "alice"); err != nil {
		t.Fatal(err)
	}
	pool.SetUserLimit("alice", 7)

	pool.mu.Lock()
	deleted := pool.deletedUsers["alice"]
	_, hasLimit := pool.userContainerLimits["alice"]
	pool.mu.Unlock()
	if !deleted {
		t.Fatal("quota update removed the account deletion tombstone")
	}
	if hasLimit {
		t.Fatal("quota update retained stale state for a deleted user")
	}
	if _, err := pool.AcquireForUser(context.Background(), "alice", "python", nil); err == nil || !strings.Contains(err.Error(), "no longer available") {
		t.Fatalf("deleted user acquisition error = %v, want no longer available", err)
	}
}

func TestSetUserLimitCannotReactivateUserDuringContainerDeletion(t *testing.T) {
	const containerID = "deleting-account-container-123456"
	removalStarted := make(chan struct{})
	releaseRemoval := make(chan struct{})
	defer func() {
		select {
		case <-releaseRemoval:
		default:
			close(releaseRemoval)
		}
	}()

	pool := &Pool{
		userActiveContainers:  map[string]int{"alice": 1},
		userPendingContainers: make(map[string]int),
		userBackgroundCreates: make(map[string]int),
		userContainerLimits:   map[string]int{"alice": 1},
		deletedUsers:          make(map[string]bool),
		containerUser:         map[string]string{containerID: "alice"},
		imageByContainerID:    map[string]string{containerID: "python"},
		activeCount:           1,
	}
	pool.runDockerCommand = func(ctx context.Context, args ...string) ([]byte, error) {
		if len(args) == 0 || args[0] != "rm" {
			return nil, fmt.Errorf("unexpected docker command: %v", args)
		}
		close(removalStarted)
		select {
		case <-releaseRemoval:
			return nil, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	destroyCtx, cancelDestroy := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelDestroy()
	destroyed := make(chan error, 1)
	go func() {
		destroyed <- pool.DestroyUserContainersContext(destroyCtx, "alice")
	}()

	select {
	case <-removalStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("container deletion did not reach Docker removal")
	}

	// Docker removal starts only after DestroyUserContainersContext publishes the
	// tombstone. This quota update therefore exercises the deletion race without
	// relying on scheduler ordering.
	pool.SetUserLimit("alice", 9)
	pool.mu.Lock()
	deletedDuringCleanup := pool.deletedUsers["alice"]
	limitDuringCleanup := pool.userContainerLimits["alice"]
	pool.mu.Unlock()
	if !deletedDuringCleanup || limitDuringCleanup != 1 {
		t.Fatalf("quota update changed deleting user state: deleted=%t limit=%d", deletedDuringCleanup, limitDuringCleanup)
	}
	if _, err := pool.AcquireForUser(context.Background(), "alice", "python", nil); err == nil || !strings.Contains(err.Error(), "no longer available") {
		t.Fatalf("deleting user acquisition error = %v, want no longer available", err)
	}

	close(releaseRemoval)
	select {
	case err := <-destroyed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("container deletion did not finish")
	}

	pool.SetUserLimit("alice", 11)
	pool.mu.Lock()
	deletedAfterCleanup := pool.deletedUsers["alice"]
	_, hasLimitAfterCleanup := pool.userContainerLimits["alice"]
	pool.mu.Unlock()
	if !deletedAfterCleanup || hasLimitAfterCleanup {
		t.Fatalf("completed deletion was reactivated: deleted=%t has_limit=%t", deletedAfterCleanup, hasLimitAfterCleanup)
	}
	if _, err := pool.AcquireForUser(context.Background(), "alice", "python", nil); err == nil || !strings.Contains(err.Error(), "no longer available") {
		t.Fatalf("deleted user acquisition error = %v, want no longer available", err)
	}
}

func TestReleaseUnknownContainerIsIdempotent(t *testing.T) {
	pool := &Pool{
		containerUser:        map[string]string{"known": "other"},
		userActiveContainers: map[string]int{"other": 1},
		activeCount:          1,
	}
	pool.releaseInternal("already-destroyed", "removed", nil)
	if pool.activeCount != 1 || pool.userActiveContainers["other"] != 1 {
		t.Fatal("unknown release changed pool accounting")
	}
}

func TestDiscardActiveLeaseQuarantinesContainerWithoutTouchingIdlePool(t *testing.T) {
	pool := &Pool{
		idlePool: map[string][]string{
			"python": {"idle"},
		},
		containerUser: map[string]string{
			"active": "alice",
			"idle":   "alice",
		},
		containerContext: map[string]string{"active": "team-context"},
		imageByContainerID: map[string]string{
			"active": "python",
			"idle":   "python",
		},
		lruByImage: map[string]time.Time{"idle": time.Now()},
		userActiveContainers: map[string]int{
			"alice": 1,
		},
		activeCount: 1,
		idleCount:   1,
	}
	if !pool.discardActiveLease("active", "wrong-owner") {
		t.Fatal("active lease was not discarded")
	}
	if pool.activeCount != 0 || pool.idleCount != 1 || pool.userActiveContainers["alice"] != 0 {
		t.Fatalf("discard accounting active=%d idle=%d users=%#v", pool.activeCount, pool.idleCount, pool.userActiveContainers)
	}
	if _, exists := pool.containerUser["active"]; exists {
		t.Fatal("discarded container remained addressable")
	}
	if _, exists := pool.containerContext["active"]; exists {
		t.Fatal("discarded container context remained addressable")
	}
	if len(pool.idlePool["python"]) != 1 || pool.idlePool["python"][0] != "idle" || pool.containerUser["idle"] != "alice" {
		t.Fatalf("idle container was changed by active discard: %#v", pool)
	}
}

func TestConfirmedDiscardKeepsActiveOwnershipWhileContainerCanStillWrite(t *testing.T) {
	containerID := "container-active-123456"
	var commands [][]string
	pool := &Pool{
		containerUser:        map[string]string{containerID: "alice"},
		containerContext:     map[string]string{containerID: "project-cache"},
		imageByContainerID:   map[string]string{containerID: "python"},
		userActiveContainers: map[string]int{"alice": 1},
		activeCount:          1,
		runDockerCommand: func(_ context.Context, args ...string) ([]byte, error) {
			commands = append(commands, append([]string(nil), args...))
			if len(args) > 0 && args[0] == "inspect" {
				return []byte("true\n"), nil
			}
			return []byte("daemon refused removal"), errors.New("docker rm failed")
		},
	}

	err := pool.DiscardForUserAndWait(containerID, "alice")
	if err == nil {
		t.Fatal("running container removal failure was reported as confirmed")
	}
	if pool.containerUser[containerID] != "alice" || pool.userActiveContainers["alice"] != 1 || pool.activeCount != 1 {
		t.Fatalf("failed confirmed discard released ownership: %#v", pool)
	}
	if len(commands) != 2 || strings.Join(commands[0], " ") != "rm -f "+containerID || commands[1][0] != "inspect" {
		t.Fatalf("destroy commands = %#v", commands)
	}
}

func TestConfirmedDiscardKeepsOwnershipWhenStoppedContainerRemovalIsUnconfirmed(t *testing.T) {
	containerID := "container-stopped-123456"
	pool := &Pool{
		containerUser:        map[string]string{containerID: "alice"},
		containerContext:     map[string]string{containerID: "project-cache"},
		imageByContainerID:   map[string]string{containerID: "python"},
		userActiveContainers: map[string]int{"alice": 1},
		activeCount:          1,
		runDockerCommand: func(_ context.Context, args ...string) ([]byte, error) {
			if len(args) > 0 && args[0] == "inspect" {
				return []byte("false\n"), nil
			}
			return []byte("remove conflict"), errors.New("docker rm failed")
		},
	}

	if err := pool.DiscardForUserAndWait(containerID, "alice"); err == nil {
		t.Fatal("stopped but still existing container was reported as removed")
	}
	if pool.containerUser[containerID] != "alice" || pool.userActiveContainers["alice"] != 1 || pool.activeCount != 1 {
		t.Fatalf("unconfirmed stopped-container removal released ownership: %#v", pool)
	}
}

func TestConfirmedDiscardReleasesOwnershipWhenInspectConfirmsContainerAbsent(t *testing.T) {
	containerID := "container-absent-123456"
	pool := &Pool{
		containerUser:        map[string]string{containerID: "alice"},
		containerContext:     map[string]string{containerID: "project-cache"},
		imageByContainerID:   map[string]string{containerID: "python"},
		userActiveContainers: map[string]int{"alice": 1},
		activeCount:          1,
		runDockerCommand: func(_ context.Context, args ...string) ([]byte, error) {
			if len(args) > 0 && args[0] == "inspect" {
				return []byte("Error: No such container: " + containerID), errors.New("inspect failed")
			}
			return []byte("remove response was lost"), errors.New("docker rm failed")
		},
	}

	if err := pool.DiscardForUserAndWait(containerID, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, exists := pool.containerUser[containerID]; exists || pool.userActiveContainers["alice"] != 0 || pool.activeCount != 0 {
		t.Fatalf("confirmed absent container retained ownership: %#v", pool)
	}
}

func TestDiscardForUserRetriesWithoutDroppingWritableContainerOwnership(t *testing.T) {
	containerID := "container-retry-123456"
	removeAttempts := 0
	waits := 0
	pool := &Pool{
		containerUser:        map[string]string{containerID: "alice"},
		containerContext:     map[string]string{containerID: "project-cache"},
		imageByContainerID:   map[string]string{containerID: "python"},
		userActiveContainers: map[string]int{"alice": 1},
		activeCount:          1,
		runDockerCommand: func(_ context.Context, args ...string) ([]byte, error) {
			if len(args) > 0 && args[0] == "rm" {
				removeAttempts++
				if removeAttempts > 1 {
					return []byte(containerID), nil
				}
				return []byte("daemon refused removal"), errors.New("docker rm failed")
			}
			return []byte("true\n"), nil
		},
	}
	pool.waitDockerRetry = func(time.Duration) {
		waits++
		if pool.containerUser[containerID] != "alice" || pool.activeCount != 1 {
			t.Fatal("writable container ownership was dropped before retry")
		}
	}

	pool.DiscardForUser(containerID, "alice")
	pool.internalTasks.Wait()
	if removeAttempts != 2 || waits != 1 {
		t.Fatalf("discard attempts=%d waits=%d", removeAttempts, waits)
	}
	if _, exists := pool.containerUser[containerID]; exists || pool.activeCount != 0 {
		t.Fatalf("confirmed discard retained ownership: %#v", pool)
	}
}

func TestDiscardForUserExhaustsBoundedCycleThenPeriodicRetryReleasesCallback(t *testing.T) {
	containerID := "container-bounded-retry-123456"
	failRemoval := true
	removeAttempts := 0
	waits := 0
	released := 0
	pool := &Pool{
		containerUser:        map[string]string{containerID: "alice"},
		containerContext:     map[string]string{containerID: "project-cache"},
		imageByContainerID:   map[string]string{containerID: "python"},
		userActiveContainers: map[string]int{"alice": 1},
		activeCount:          1,
	}
	pool.waitDockerRetry = func(time.Duration) { waits++ }
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		switch args[0] {
		case "rm":
			removeAttempts++
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
	if removeAttempts != 1+containerRemovalBackgroundAttempts || waits != containerRemovalBackgroundAttempts {
		t.Fatalf("bounded cleanup attempts=%d waits=%d", removeAttempts, waits)
	}
	pool.mu.Lock()
	owner := pool.containerUser[containerID]
	retrying, pending := pool.discardRetrying[containerID]
	pendingCount := pool.pendingContainerRemovalCountLocked()
	pool.mu.Unlock()
	if owner != "alice" || !pending || retrying || pendingCount != 1 || released != 0 {
		t.Fatalf("exhausted cleanup owner=%q pending=%t retrying=%t pending_count=%d released=%d", owner, pending, retrying, pendingCount, released)
	}

	failRemoval = false
	pool.retryExhaustedContainerRemovals()
	pool.internalTasks.Wait()
	if released != 1 {
		t.Fatalf("later successful cleanup released callback %d times", released)
	}
	pool.retryExhaustedContainerRemovals()
	pool.internalTasks.Wait()
	if released != 1 {
		t.Fatalf("completed cleanup callback ran again: %d", released)
	}
	pool.mu.Lock()
	_, owned := pool.containerUser[containerID]
	pendingCount = pool.pendingContainerRemovalCountLocked()
	pool.mu.Unlock()
	if owned || pendingCount != 0 {
		t.Fatalf("successful reconciliation retained ownership=%t pending=%d", owned, pendingCount)
	}
}

func TestRetainedReleaseKeepsGateClosedWhenResetFallsBackToAsyncRemoval(t *testing.T) {
	containerID := "container-reset-retry-123456"
	retryStarted := make(chan struct{})
	allowRetry := make(chan struct{})
	var retryOnce sync.Once
	removeAttempts := 0
	pool := &Pool{
		containerUser:        map[string]string{containerID: "alice"},
		containerContext:     map[string]string{containerID: "personal/cache:rw"},
		imageByContainerID:   map[string]string{containerID: "python"},
		userActiveContainers: map[string]int{"alice": 1},
		activeCount:          1,
	}
	pool.waitDockerRetry = func(time.Duration) {
		retryOnce.Do(func() { close(retryStarted) })
		<-allowRetry
	}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		switch args[0] {
		case "top":
			return []byte("daemon unavailable"), errors.New("top failed")
		case "restart":
			return []byte("restart failed"), errors.New("restart failed")
		case "rm":
			removeAttempts++
			if removeAttempts == 1 {
				return []byte("daemon unavailable"), errors.New("remove failed")
			}
			return nil, nil
		case "inspect":
			return []byte("true\n"), nil
		default:
			return nil, fmt.Errorf("unexpected Docker command: %v", args)
		}
	}

	ctx, gate := containercleanup.WithReleaseGate(context.Background())
	released := 0
	gate.Add(func() { released++ })
	if !containercleanup.Retain(ctx, func(done func()) {
		pool.ReleaseForUserRetained(containerID, "alice", done)
	}) {
		t.Fatal("release gate was not retained")
	}
	gate.Finalize()
	select {
	case <-retryStarted:
	case <-time.After(time.Second):
		t.Fatal("reset failure did not start bounded removal")
	}
	if released != 0 || pool.containerUser[containerID] != "alice" {
		t.Fatalf("reset failure released gate=%d owner=%q", released, pool.containerUser[containerID])
	}
	close(allowRetry)
	pool.internalTasks.Wait()
	if released != 1 {
		t.Fatalf("confirmed async removal release count = %d", released)
	}
}

func TestContainerRunningStateDoesNotTreatInspectFailureAsDead(t *testing.T) {
	pool := &Pool{runDockerCommand: func(_ context.Context, _ ...string) ([]byte, error) {
		return []byte("docker daemon unavailable"), errors.New("inspect failed")
	}}
	running, err := pool.containerRunningState("container-unknown-123456")
	if err == nil || running {
		t.Fatalf("unknown inspect state reported running=%v error=%v", running, err)
	}
}

func TestHotPoolUnknownContainerIsSafelyDiscardedWhenQuarantineRefills(t *testing.T) {
	const (
		unknownID     = "container-unknown-123456"
		replacementID = "container-replace-123456"
	)
	hot := make(chan string, 1)
	hot <- unknownID
	pool := &Pool{
		hotPool: map[hotPoolKey]chan string{
			{image: "python", userID: "alice"}: hot,
		},
		containerUser: map[string]string{
			unknownID: "alice", replacementID: "alice",
		},
		imageByContainerID: map[string]string{
			unknownID: "python", replacementID: "python",
		},
		activeCount: 2,
	}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "inspect" {
			hot <- replacementID
			return []byte("docker daemon unavailable"), errors.New("inspect failed")
		}
		return nil, nil
	}

	if got := pool.tryHotPool("python", "alice"); got != "" {
		t.Fatalf("unknown hot-pool container was reused: %q", got)
	}
	if _, exists := pool.containerUser[unknownID]; exists {
		t.Fatal("unreachable unknown container retained pool ownership after confirmed removal")
	}
	if pool.activeCount != 1 {
		t.Fatalf("activeCount = %d, want 1 replacement container", pool.activeCount)
	}
	select {
	case got := <-hot:
		if got != replacementID {
			t.Fatalf("hot pool contains %q, want replacement", got)
		}
	default:
		t.Fatal("replacement container disappeared from hot pool")
	}
}

func TestIdlePoolRequiresExactCacheContext(t *testing.T) {
	pool := &Pool{
		idlePool: map[string][]string{
			"gcc": {"personal", "team-main", "team-feature", "other-user"},
		},
		containerUser: map[string]string{
			"personal": "alice", "team-main": "alice", "team-feature": "alice", "other-user": "bob",
		},
		containerContext: map[string]string{
			"team-main": "main@generation-1", "team-feature": "feature@generation-1", "other-user": "main@generation-1",
		},
		lruByImage: map[string]time.Time{
			"personal": time.Now(), "team-main": time.Now(), "team-feature": time.Now(), "other-user": time.Now(),
		},
	}

	if got := pool.takeIdleMatchLocked("gcc", "alice", "main@generation-1"); got != "team-main" {
		t.Fatalf("context match = %q, want team-main", got)
	}
	if got := pool.takeIdleMatchLocked("gcc", "alice", "main@generation-2"); got != "" {
		t.Fatalf("stale mount generation was reused: %q", got)
	}
	if got := pool.takeIdleMatchLocked("gcc", "alice", ""); got != "personal" {
		t.Fatalf("personal build match = %q, want personal", got)
	}
	if got := pool.takeIdleMatchLocked("gcc", "alice", "main@generation-1"); got != "" {
		t.Fatalf("another user's context leaked: %q", got)
	}
}

func TestContainerLimitIncludesIdlePool(t *testing.T) {
	pool := &Pool{activeCount: 7, idleCount: 3}
	if got := pool.totalContainersLocked(); got != 10 {
		t.Fatalf("total containers = %d, want 10", got)
	}
}

func TestDetachIdleBuildCacheContainersKeepsPersonalAndActive(t *testing.T) {
	pool := &Pool{
		idlePool: map[string][]string{"gcc": {"personal", "team-idle"}},
		containerUser: map[string]string{
			"personal": "alice", "team-idle": "alice", "team-active": "alice",
		},
		containerContext: map[string]string{
			"team-idle": "team/main@generation", "team-active": "team/main@generation",
		},
		imageByContainerID: map[string]string{"personal": "gcc", "team-idle": "gcc", "team-active": "gcc"},
		lruByImage:         map[string]time.Time{"personal": time.Now(), "team-idle": time.Now()},
		idleCount:          2, activeCount: 1,
	}
	removed := pool.detachIdleBuildCacheContainers()
	if len(removed) != 1 || removed[0] != "team-idle" {
		t.Fatalf("removed contexts = %#v", removed)
	}
	if pool.idleCount != 1 || pool.activeCount != 1 {
		t.Fatalf("accounting changed incorrectly: active=%d idle=%d", pool.activeCount, pool.idleCount)
	}
	if len(pool.idlePool["gcc"]) != 1 || pool.idlePool["gcc"][0] != "personal" {
		t.Fatalf("personal idle container was removed: %#v", pool.idlePool)
	}
	if pool.containerContext["team-active"] == "" {
		t.Fatal("active context container was invalidated")
	}
}

func TestDetachIdleContextContainersTargetsOnePersonalNamespace(t *testing.T) {
	pool := &Pool{
		idlePool:      map[string][]string{"python": {"old", "current", "other"}},
		containerUser: map[string]string{"old": "alice", "current": "alice", "other": "bob"},
		containerContext: map[string]string{
			"old":     "personal/alice/project/python/digest@old:ro",
			"current": "personal/alice/project/python/digest@current:ro",
			"other":   "personal/bob/project/python/digest@old:ro",
		},
		imageByContainerID: map[string]string{"old": "python", "current": "python", "other": "python"},
		lruByImage:         map[string]time.Time{"old": time.Now(), "current": time.Now(), "other": time.Now()},
		idleCount:          3,
	}
	removed := pool.detachIdleContextContainers(func(key string) bool {
		return strings.HasPrefix(key, "personal/alice/project/python/digest@")
	})
	if len(removed) != 2 {
		t.Fatalf("removed = %#v", removed)
	}
	if got := pool.idlePool["python"]; len(got) != 1 || got[0] != "other" {
		t.Fatalf("idle pool = %#v", pool.idlePool)
	}
}

func TestIdleInvalidationRetainsOwnershipUntilTransientRemovalRetrySucceeds(t *testing.T) {
	containerID := "quarantined-idle-container-123456"
	retryStarted := make(chan struct{})
	allowRetry := make(chan struct{})
	removed := make(chan struct{})
	var retryOnce sync.Once
	var removedOnce sync.Once
	var commandMu sync.Mutex
	removalAttempts := 0
	pool := &Pool{
		idlePool:           map[string][]string{"python": {containerID}},
		containerUser:      map[string]string{containerID: "alice"},
		containerContext:   map[string]string{containerID: "team/cache-generation"},
		imageByContainerID: map[string]string{containerID: "python"},
		lruByImage:         map[string]time.Time{containerID: time.Now()},
		idleCount:          1,
		maxTotal:           1,
	}
	pool.waitDockerRetry = func(time.Duration) {
		retryOnce.Do(func() { close(retryStarted) })
		<-allowRetry
	}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		commandMu.Lock()
		defer commandMu.Unlock()
		switch args[0] {
		case "rm":
			removalAttempts++
			if removalAttempts == 1 {
				return []byte("daemon busy"), errors.New("transient remove failure")
			}
			removedOnce.Do(func() { close(removed) })
			return nil, nil
		case "inspect":
			return []byte("true\n"), nil
		default:
			return nil, nil
		}
	}

	pool.InvalidateIdleBuildCacheContainers()
	select {
	case <-retryStarted:
	case <-time.After(time.Second):
		t.Fatal("transient removal failure did not start a retry")
	}
	pool.mu.Lock()
	_, pending := pool.pendingRemoval[containerID]
	owner := pool.containerUser[containerID]
	contextKey := pool.containerContext[containerID]
	total := pool.totalContainersLocked()
	idle := append([]string(nil), pool.idlePool["python"]...)
	pool.mu.Unlock()
	if !pending || owner != "alice" || contextKey != "team/cache-generation" {
		t.Fatalf("quarantined ownership pending=%t owner=%q context=%q", pending, owner, contextKey)
	}
	if total != 1 || len(idle) != 0 {
		t.Fatalf("quarantined accounting total=%d idle=%#v", total, idle)
	}

	close(allowRetry)
	select {
	case <-removed:
	case <-time.After(time.Second):
		t.Fatal("Docker removal retry did not run")
	}
	deadline := time.Now().Add(time.Second)
	for {
		pool.mu.Lock()
		_, pending = pool.pendingRemoval[containerID]
		_, owned := pool.containerUser[containerID]
		total = pool.totalContainersLocked()
		pool.mu.Unlock()
		if !pending && !owned {
			if total != 0 {
				t.Fatalf("confirmed removal left total containers = %d", total)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("confirmed removal remained tracked pending=%t owned=%t", pending, owned)
		}
		time.Sleep(time.Millisecond)
	}
	commandMu.Lock()
	attempts := removalAttempts
	commandMu.Unlock()
	if attempts != 2 {
		t.Fatalf("removal attempts = %d, want 2", attempts)
	}
}

func TestQuarantinedRemovalExhaustionIsRetriedByMaintenanceBatch(t *testing.T) {
	containerID := "quarantined-maintenance-container-123456"
	failRemoval := true
	pool := &Pool{
		containerUser:      map[string]string{containerID: "alice"},
		containerContext:   map[string]string{containerID: "team/cache-generation"},
		imageByContainerID: map[string]string{containerID: "python"},
		pendingRemoval:     map[string]bool{containerID: false},
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

	if err := pool.removeQuarantinedContainer(containerID); err == nil {
		t.Fatal("persistent removal failure was hidden")
	}
	pool.internalTasks.Wait()
	pool.mu.Lock()
	retrying, tracked := pool.pendingRemoval[containerID]
	pool.mu.Unlock()
	if !tracked || retrying || pool.containerUser[containerID] != "alice" {
		t.Fatalf("exhausted quarantine tracked=%t retrying=%t owner=%q", tracked, retrying, pool.containerUser[containerID])
	}

	failRemoval = false
	pool.retryExhaustedContainerRemovals()
	pool.internalTasks.Wait()
	pool.mu.Lock()
	_, tracked = pool.pendingRemoval[containerID]
	_, owned := pool.containerUser[containerID]
	pool.mu.Unlock()
	if tracked || owned {
		t.Fatalf("maintenance success retained quarantine=%t ownership=%t", tracked, owned)
	}
}

func TestCleanupOrphanedContainersReportsUnconfirmedRemoval(t *testing.T) {
	containerID := "orphan-container-1234567890"
	pool := &Pool{containerUser: map[string]string{}}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		switch args[0] {
		case "ps":
			return []byte(containerID + "\n"), nil
		case "rm":
			return []byte("daemon busy"), errors.New("remove failed")
		case "inspect":
			return []byte("true\n"), nil
		default:
			return nil, nil
		}
	}
	if err := pool.CleanupOrphanedContainers(); err == nil {
		t.Fatal("startup cleanup accepted a container that may still hold writable mounts")
	}
}

func TestCleanupOrphanedContainersIncludesStoppedContainers(t *testing.T) {
	containerID := "stopped-orphan-container-123456"
	var commands [][]string
	pool := &Pool{containerUser: map[string]string{}}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		commands = append(commands, append([]string(nil), args...))
		if args[0] == "ps" {
			return []byte(containerID + "\n"), nil
		}
		return nil, nil
	}
	if err := pool.CleanupOrphanedContainers(); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 2 || strings.Join(commands[0], " ") != "ps -aq --filter label=bobocloud.managed=true" || strings.Join(commands[1], " ") != "rm -f "+containerID {
		t.Fatalf("cleanup commands = %#v", commands)
	}
}

func TestActiveOldPersonalDependencyGenerationIsDiscardedAfterInvalidation(t *testing.T) {
	cacheKey := "alice/project/python/digest"
	oldID := "old-active-container-123456"
	currentID := "current-active-container-123456"
	oldContext := "personal/" + cacheKey + "@old-generation:ro"
	currentContext := "personal/" + cacheKey + "@current-generation:ro"
	topStarted := make(chan struct{})
	continueReset := make(chan struct{})
	var topOnce sync.Once
	var commandsMu sync.Mutex
	var commands [][]string
	pool := &Pool{
		idlePool:             make(map[string][]string),
		containerUser:        map[string]string{oldID: "alice", currentID: "alice"},
		containerContext:     map[string]string{oldID: oldContext, currentID: currentContext},
		taintedContainers:    make(map[string]bool),
		stalePersonalContext: make(map[string]bool),
		imageByContainerID:   map[string]string{oldID: "python", currentID: "python"},
		lruByImage:           make(map[string]time.Time),
		userActiveContainers: map[string]int{"alice": 2},
		activeCount:          2,
		maxIdle:              4,
		resetStrategy:        ResetStrategyVerified,
	}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		commandsMu.Lock()
		commands = append(commands, append([]string(nil), args...))
		commandsMu.Unlock()
		switch args[0] {
		case "top":
			if args[1] == oldID {
				topOnce.Do(func() { close(topStarted) })
				<-continueReset
			}
			return []byte(managedTopWithoutInit), nil
		case "inspect":
			return []byte("true\n"), nil
		default:
			return nil, nil
		}
	}

	released := make(chan struct{})
	go func() {
		pool.ReleaseForUser(oldID, "alice")
		close(released)
	}()
	select {
	case <-topStarted:
	case <-time.After(time.Second):
		t.Fatal("old generation did not enter container reset")
	}
	pool.InvalidateIdlePersonalDependencyContainers(cacheKey, "current-generation", 2)
	pool.mu.Lock()
	oldMarked := pool.stalePersonalContext[oldContext]
	currentMarked := pool.stalePersonalContext[currentContext]
	pool.mu.Unlock()
	if !oldMarked || currentMarked {
		t.Fatalf("stale contexts old=%t current=%t", oldMarked, currentMarked)
	}
	close(continueReset)
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("old generation release did not complete")
	}
	if _, exists := pool.containerUser[oldID]; exists || pool.activeCount != 1 || pool.userActiveContainers["alice"] != 1 {
		t.Fatalf("old generation remained pooled: %#v", pool)
	}
	if pool.stalePersonalContext[oldContext] {
		t.Fatal("unused stale generation marker was not released")
	}

	pool.ReleaseForUser(currentID, "alice")
	if got := pool.idlePool["python"]; len(got) != 1 || got[0] != currentID {
		t.Fatalf("current generation was not reusable: %#v", got)
	}
	if pool.activeCount != 0 || pool.idleCount != 1 || pool.userActiveContainers["alice"] != 0 {
		t.Fatalf("current generation accounting active=%d idle=%d users=%#v", pool.activeCount, pool.idleCount, pool.userActiveContainers)
	}

	commandsMu.Lock()
	defer commandsMu.Unlock()
	removedOld := false
	for _, command := range commands {
		if strings.Join(command, " ") == "rm -f "+oldID {
			removedOld = true
		}
		if strings.Join(command, " ") == "rm -f "+currentID {
			t.Fatal("current generation container was destroyed")
		}
	}
	if !removedOld {
		t.Fatal("old generation container was not destroyed")
	}
}

func TestPersonalDependencyInvalidationKeepsCurrentIdleGeneration(t *testing.T) {
	cacheKey := "alice/project/python/digest"
	oldID := "old-idle-container-123456"
	currentID := "current-idle-container-123456"
	otherID := "unrelated-idle-container-123456"
	removed := make([]string, 0, 1)
	pool := &Pool{
		idlePool: map[string][]string{"python": {oldID, currentID, otherID}},
		containerUser: map[string]string{
			oldID: "alice", currentID: "alice", otherID: "bob",
		},
		containerContext: map[string]string{
			oldID:     "personal/" + cacheKey + "@old-generation:ro",
			currentID: "personal/" + cacheKey + "@current-generation:ro",
			otherID:   "personal/bob/project/python/digest@old-generation:ro",
		},
		taintedContainers:    make(map[string]bool),
		stalePersonalContext: make(map[string]bool),
		imageByContainerID: map[string]string{
			oldID: "python", currentID: "python", otherID: "python",
		},
		lruByImage: map[string]time.Time{
			oldID: time.Now(), currentID: time.Now(), otherID: time.Now(),
		},
		idleCount: 3,
		runDockerCommand: func(_ context.Context, args ...string) ([]byte, error) {
			if args[0] == "rm" {
				removed = append(removed, args[len(args)-1])
			}
			return nil, nil
		},
	}

	pool.InvalidateIdlePersonalDependencyContainers(cacheKey, "current-generation", 2)
	if len(removed) != 1 || removed[0] != oldID {
		t.Fatalf("removed containers = %#v", removed)
	}
	if got := pool.idlePool["python"]; len(got) != 2 || got[0] != currentID || got[1] != otherID {
		t.Fatalf("remaining idle containers = %#v", got)
	}
	if pool.idleCount != 2 || pool.containerContext[currentID] == "" || pool.containerContext[otherID] == "" {
		t.Fatalf("current or unrelated generation was invalidated: %#v", pool)
	}
}

func TestDelayedOldReadLeaseAcquireAfterPublicationIsDiscarded(t *testing.T) {
	cacheKey := "alice/project/python/digest"
	oldContext := "personal/" + cacheKey + "@old-generation:ro"
	containerID := "delayed-old-container-123456"
	var commands [][]string
	pool := &Pool{
		idlePool:                  make(map[string][]string),
		containerUser:             make(map[string]string),
		containerContext:          make(map[string]string),
		taintedContainers:         make(map[string]bool),
		stalePersonalContext:      make(map[string]bool),
		currentPersonalGeneration: make(map[string]personalGenerationState),
		imageByContainerID:        make(map[string]string),
		lruByImage:                make(map[string]time.Time),
		userActiveContainers:      map[string]int{"alice": 1},
		activeCount:               1,
		runDockerCommand: func(_ context.Context, args ...string) ([]byte, error) {
			commands = append(commands, append([]string(nil), args...))
			return nil, nil
		},
	}

	// The read lease captured old-generation before this publication, but it
	// does not ask Docker for a container until after the callback returns.
	pool.InvalidateIdlePersonalDependencyContainers(cacheKey, "current-generation", 2)
	pool.mu.Lock()
	pool.containerUser[containerID] = "alice"
	pool.imageByContainerID[containerID] = "python"
	pool.recordContainerContextLocked(containerID, oldContext)
	pool.mu.Unlock()
	pool.ReleaseForUser(containerID, "alice")

	if len(commands) != 1 || strings.Join(commands[0], " ") != "rm -f "+containerID {
		t.Fatalf("old delayed-acquire commands = %#v", commands)
	}
	if _, exists := pool.containerUser[containerID]; exists || len(pool.idlePool["python"]) != 0 || pool.activeCount != 0 {
		t.Fatalf("old delayed-acquire container remained reusable: %#v", pool)
	}
}

func TestPersonalGenerationPublicationAcquireRaceNeverPoolsOldContext(t *testing.T) {
	const iterations = 500
	for iteration := 0; iteration < iterations; iteration++ {
		cacheKey := "alice/project/python/digest"
		oldContext := "personal/" + cacheKey + "@old-generation:ro"
		containerID := fmt.Sprintf("old-race-container-%06d", iteration)
		pool := &Pool{
			idlePool:                  make(map[string][]string),
			containerUser:             make(map[string]string),
			containerContext:          make(map[string]string),
			taintedContainers:         make(map[string]bool),
			stalePersonalContext:      make(map[string]bool),
			currentPersonalGeneration: make(map[string]personalGenerationState),
			imageByContainerID:        make(map[string]string),
			lruByImage:                make(map[string]time.Time),
			userActiveContainers:      map[string]int{"alice": 1},
			activeCount:               1,
		}
		start := make(chan struct{})
		var workers sync.WaitGroup
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-start
			pool.InvalidateIdlePersonalDependencyContainers(cacheKey, "current-generation", 2)
		}()
		go func() {
			defer workers.Done()
			<-start
			pool.mu.Lock()
			pool.containerUser[containerID] = "alice"
			pool.imageByContainerID[containerID] = "python"
			pool.recordContainerContextLocked(containerID, oldContext)
			pool.mu.Unlock()
		}()
		close(start)
		workers.Wait()

		returned, stale, _, _, _ := pool.returnActiveContainerToIdle(containerID, "alice")
		if returned || !stale {
			t.Fatalf("iteration %d returned=%t stale=%t state=%#v", iteration, returned, stale, pool)
		}
	}
}

func TestOutOfOrderPersonalGenerationCallbackCannotRollBackCurrent(t *testing.T) {
	cacheKey := "alice/project/python/digest"
	pool := &Pool{
		idlePool:                  make(map[string][]string),
		containerUser:             make(map[string]string),
		containerContext:          make(map[string]string),
		stalePersonalContext:      make(map[string]bool),
		currentPersonalGeneration: make(map[string]personalGenerationState),
	}
	pool.InvalidateIdlePersonalDependencyContainers(cacheKey, "generation-three", 3)
	pool.InvalidateIdlePersonalDependencyContainers(cacheKey, "generation-two", 2)

	pool.mu.Lock()
	state := pool.currentPersonalGeneration[cacheKey]
	currentContext := "personal/" + cacheKey + "@generation-three:ro"
	oldContext := "personal/" + cacheKey + "@generation-two:ro"
	currentStale := pool.personalContextSupersededLocked(currentContext)
	oldStale := pool.personalContextSupersededLocked(oldContext)
	pool.mu.Unlock()
	if state.generation != "generation-three" || state.publication != 3 || currentStale || !oldStale {
		t.Fatalf("current state=%+v current_stale=%t old_stale=%t", state, currentStale, oldStale)
	}
}

func TestIdleAcquireRevalidatesSupersededPersonalGeneration(t *testing.T) {
	cacheKey := "alice/project/python/digest"
	contextKey := "personal/" + cacheKey + "@old-generation:ro"
	containerID := "unexpected-old-idle-123456"
	pool := &Pool{
		idlePool:                  map[string][]string{"python": {containerID}},
		containerUser:             map[string]string{containerID: "alice"},
		containerContext:          map[string]string{containerID: contextKey},
		stalePersonalContext:      make(map[string]bool),
		currentPersonalGeneration: map[string]personalGenerationState{cacheKey: {generation: "current-generation", publication: 2}},
		lruByImage:                map[string]time.Time{containerID: time.Now()},
	}
	pool.mu.Lock()
	acquired := pool.takeIdleMatchLocked("python", "alice", contextKey)
	stale := pool.stalePersonalContext[contextKey]
	pool.mu.Unlock()
	if acquired != containerID || !stale {
		t.Fatalf("idle acquire=%q stale=%t pool=%#v", acquired, stale, pool)
	}
}

func TestAcquireRejectedAfterPoolShutdownBegins(t *testing.T) {
	pool := &Pool{closed: true}
	if _, err := pool.acquireForUser(context.Background(), "alice", "gcc", "gcc", "", nil, nil, nil); err == nil {
		t.Fatal("closed pool accepted a new acquisition")
	}
}

func TestContainerWorkspaceBootstrapUsesStableRootWorkingDirectory(t *testing.T) {
	got := containerWorkspaceBootstrapArguments("container-id")
	want := []string{"exec", "-w", "/", "container-id", "mkdir", "-p", "/workspace"}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("workspace bootstrap arguments = %#v, want %#v", got, want)
	}
}

func TestDestroyUserContainersRetriesBeforeReleasingOwnershipAndQuota(t *testing.T) {
	const (
		activeID = "account-active-container-123456"
		idleID   = "account-idle-container-12345678"
		hotID    = "account-hot-container-123456789"
	)
	hot := make(chan string, 1)
	hot <- hotID
	removalAttempts := make(map[string]int)
	pool := &Pool{
		hotPool:               map[hotPoolKey]chan string{{image: "node", userID: "alice"}: hot},
		idlePool:              map[string][]string{"python": {idleID}},
		containerUser:         map[string]string{activeID: "alice", idleID: "alice", hotID: "alice"},
		containerContext:      map[string]string{activeID: "personal/alice/python@generation:rw"},
		imageByContainerID:    map[string]string{activeID: "python", idleID: "python", hotID: "node"},
		lruByImage:            map[string]time.Time{idleID: time.Now(), hotID: time.Now()},
		pendingRemoval:        make(map[string]bool),
		userActiveContainers:  map[string]int{"alice": 1},
		userPendingContainers: make(map[string]int),
		userBackgroundCreates: make(map[string]int),
		userContainerLimits:   map[string]int{"alice": 3},
		deletedUsers:          make(map[string]bool),
		activeCount:           2,
		idleCount:             1,
	}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		containerID := args[len(args)-1]
		switch args[0] {
		case "rm":
			removalAttempts[containerID]++
			if containerID == activeID && removalAttempts[containerID] == 1 {
				return []byte("daemon busy"), errors.New("transient remove failure")
			}
			return nil, nil
		case "inspect":
			return []byte("true\n"), nil
		default:
			return nil, nil
		}
	}
	pool.waitDockerRetry = func(time.Duration) {
		pool.mu.Lock()
		defer pool.mu.Unlock()
		if pool.containerUser[activeID] != "alice" || pool.containerContext[activeID] == "" {
			t.Fatal("transient failure released active container ownership")
		}
		if pool.userActiveContainers["alice"] != 1 || pool.userContainerLimits["alice"] != 3 {
			t.Fatalf("transient failure released user accounting active=%d limit=%d", pool.userActiveContainers["alice"], pool.userContainerLimits["alice"])
		}
	}

	if err := pool.DestroyUserContainers("alice"); err != nil {
		t.Fatal(err)
	}
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if removalAttempts[activeID] != 2 {
		t.Fatalf("active removal attempts = %d, want 2", removalAttempts[activeID])
	}
	if len(pool.containerUser) != 0 || pool.activeCount != 0 || pool.idleCount != 0 || len(pool.pendingRemoval) != 0 {
		t.Fatalf("confirmed deletion retained pool ownership: %#v", pool)
	}
	if _, exists := pool.userContainerLimits["alice"]; exists || pool.userActiveContainers["alice"] != 0 {
		t.Fatalf("confirmed deletion retained user quota accounting: %#v", pool.userContainerLimits)
	}
	if !pool.deletedUsers["alice"] {
		t.Fatal("deleted user was allowed to acquire again")
	}
}

func TestDestroyUserContainersPersistentFailureRetainsOwnershipUntilLaterRetry(t *testing.T) {
	const containerID = "persistent-account-container-123456"
	failRemoval := true
	removalAttempts := 0
	pool := &Pool{
		containerUser:         map[string]string{containerID: "alice"},
		containerContext:      map[string]string{containerID: "personal/alice/python@generation:rw"},
		imageByContainerID:    map[string]string{containerID: "python"},
		lruByImage:            make(map[string]time.Time),
		pendingRemoval:        make(map[string]bool),
		userActiveContainers:  map[string]int{"alice": 1},
		userPendingContainers: make(map[string]int),
		userBackgroundCreates: make(map[string]int),
		userContainerLimits:   map[string]int{"alice": 1},
		deletedUsers:          make(map[string]bool),
		activeCount:           1,
	}
	pool.waitDockerRetry = func(time.Duration) {}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		switch args[0] {
		case "rm":
			removalAttempts++
			if failRemoval {
				return []byte("daemon unavailable"), errors.New("persistent remove failure")
			}
			return nil, nil
		case "inspect":
			return []byte("true\n"), nil
		default:
			return nil, nil
		}
	}

	if err := pool.DestroyUserContainers("alice"); err == nil {
		t.Fatal("persistent removal failure was hidden")
	}
	pool.mu.Lock()
	owner := pool.containerUser[containerID]
	contextKey := pool.containerContext[containerID]
	active := pool.activeCount
	userActive := pool.userActiveContainers["alice"]
	limit := pool.userContainerLimits["alice"]
	pool.mu.Unlock()
	if owner != "alice" || contextKey == "" || active != 1 || userActive != 1 || limit != 1 {
		t.Fatalf("persistent failure lost ownership/accounting owner=%q context=%q active=%d user_active=%d limit=%d", owner, contextKey, active, userActive, limit)
	}
	if removalAttempts != userContainerRemovalAttempts {
		t.Fatalf("persistent removal attempts = %d, want %d", removalAttempts, userContainerRemovalAttempts)
	}

	failRemoval = false
	if err := pool.DestroyUserContainers("alice"); err != nil {
		t.Fatalf("later cleanup retry failed: %v", err)
	}
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if _, exists := pool.containerUser[containerID]; exists || pool.activeCount != 0 || pool.userActiveContainers["alice"] != 0 {
		t.Fatalf("successful retry retained ownership/accounting: %#v", pool)
	}
}
