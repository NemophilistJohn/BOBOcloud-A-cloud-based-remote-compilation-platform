package docker

import (
	"context"
	"strings"
	"testing"
	"time"
)

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

func TestDetachUserContainersMaintainsPoolAccounting(t *testing.T) {
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
		userContainerLimits:   map[string]int{"removed": 2},
		deletedUsers:          make(map[string]bool),
		activeCount:           2, // hot-user + active-user
		idleCount:             2, // idle-user + idle-other
	}

	ids := pool.detachUserContainers("removed")
	if len(ids) != 3 {
		t.Fatalf("detached %d containers, want 3", len(ids))
	}
	if pool.activeCount != 0 || pool.idleCount != 1 {
		t.Fatalf("counts after detach: active=%d idle=%d", pool.activeCount, pool.idleCount)
	}
	if len(pool.idlePool["python"]) != 1 || pool.idlePool["python"][0] != "idle-other" {
		t.Fatalf("other user's idle container was not preserved: %#v", pool.idlePool)
	}
	if !pool.deletedUsers["removed"] {
		t.Fatal("deleted user was not blocked from replenishment")
	}
}

func TestReleaseUnknownContainerIsIdempotent(t *testing.T) {
	pool := &Pool{
		containerUser:        map[string]string{"known": "other"},
		userActiveContainers: map[string]int{"other": 1},
		activeCount:          1,
	}
	pool.releaseInternal("already-destroyed", "removed")
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

func TestAcquireRejectedAfterPoolShutdownBegins(t *testing.T) {
	pool := &Pool{closed: true}
	if _, err := pool.acquireForUser(context.Background(), "alice", "gcc", "", nil, nil, nil); err == nil {
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
