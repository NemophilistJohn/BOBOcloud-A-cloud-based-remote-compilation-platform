package docker

import (
	"context"
	"log/slog"
	"sort"
	"time"
)

const (
	containerRemovalBackgroundAttempts = 3
	containerRemovalRetryBudget        = 45 * time.Second
	containerRemovalInitialRetry       = 250 * time.Millisecond
	containerRemovalMaxRetry           = 2 * time.Second
	containerRemovalMaintenanceBatch   = 4
)

// DiscardForUser makes the common removal path synchronous. An unconfirmed
// removal is transferred to one bounded pool-owned task while all container
// accounting remains live and non-reusable.
func (dp *Pool) DiscardForUser(containerID, userID string) {
	dp.discardForUser(containerID, userID, nil)
}

// DiscardForUserRetained additionally transfers request-owned resource release
// to the pool. onRemoved runs exactly once, and only after confirmed absence.
func (dp *Pool) DiscardForUserRetained(containerID, userID string, onRemoved func()) {
	dp.discardForUser(containerID, userID, onRemoved)
}

func (dp *Pool) discardForUser(containerID, userID string, onRemoved func()) {
	if containerID == "" {
		if onRemoved != nil {
			onRemoved()
		}
		return
	}
	if onRemoved != nil && !dp.registerContainerRemovalCallback(containerID, onRemoved) {
		return
	}

	dp.mu.Lock()
	if dp.closed {
		dp.mu.Unlock()
		return
	}
	lifecycleCtx, _ := dp.ensureLifecycleLocked()
	dp.mu.Unlock()
	if err := dp.discardForUserAndWaitContext(lifecycleCtx, containerID, userID); err == nil {
		return
	} else {
		slog.Warn("Container removal was not immediately confirmed; ownership transferred to bounded cleanup",
			"container_id", shortContainerID(containerID), "error", err)
	}
	dp.startDiscardRetry(containerID, userID)
}

func (dp *Pool) startDiscardRetry(containerID, userID string) {
	dp.mu.Lock()
	if dp.closed {
		dp.mu.Unlock()
		return
	}
	if dp.discardRetrying == nil {
		dp.discardRetrying = make(map[string]bool)
	}
	if dp.discardRetrying[containerID] {
		dp.mu.Unlock()
		return
	}
	dp.discardRetrying[containerID] = true
	dp.mu.Unlock()

	if dp.startInternalTask(func(ctx context.Context) {
		dp.retryDiscardedContainerRemoval(ctx, containerID, userID)
	}) {
		return
	}
	dp.mu.Lock()
	if _, tracked := dp.containerUser[containerID]; tracked {
		dp.discardRetrying[containerID] = false
	} else {
		delete(dp.discardRetrying, containerID)
	}
	dp.mu.Unlock()
}

func (dp *Pool) retryDiscardedContainerRemoval(ctx context.Context, containerID, userID string) {
	retryCtx, cancel := context.WithTimeout(ctx, containerRemovalRetryBudget)
	defer cancel()
	delay := containerRemovalInitialRetry
	var lastErr error
	for retry := 1; retry <= containerRemovalBackgroundAttempts; retry++ {
		if !dp.waitForDockerRetry(retryCtx, delay) {
			lastErr = retryCtx.Err()
			break
		}
		if err := dp.discardForUserAndWaitContext(retryCtx, containerID, userID); err == nil {
			slog.Info("Deferred container removal confirmed", "container_id", shortContainerID(containerID), "attempt", retry+1)
			return
		} else {
			lastErr = err
			slog.Warn("Deferred container removal remains unconfirmed", "container_id", shortContainerID(containerID), "attempt", retry+1, "error", err)
		}
		delay = nextContainerRemovalRetry(delay)
	}

	dp.mu.Lock()
	_, tracked := dp.containerUser[containerID]
	callbackCount := len(dp.removalCallbacks[containerID])
	cycle := 0
	if tracked {
		dp.discardRetrying[containerID] = false
		if dp.discardRetryCycles == nil {
			dp.discardRetryCycles = make(map[string]int)
		}
		dp.discardRetryCycles[containerID]++
		cycle = dp.discardRetryCycles[containerID]
	} else {
		delete(dp.discardRetrying, containerID)
		delete(dp.discardRetryCycles, containerID)
	}
	dp.mu.Unlock()
	if retryCtx.Err() == context.Canceled && ctx.Err() != nil {
		return
	}
	if tracked {
		attributes := []any{
			"container_id", shortContainerID(containerID),
			"attempts", containerRemovalBackgroundAttempts + 1,
			"retry_budget", containerRemovalRetryBudget,
			"retry_cycle", cycle,
			"pending_release_callbacks", callbackCount,
			"error", lastErr,
		}
		if cycle == 1 {
			slog.Error("Container removal retry budget exhausted; ownership and resource releases remain retained", attributes...)
		} else if cycle%10 == 0 {
			slog.Warn("Container removal remains pending after bounded maintenance retries", attributes...)
		}
	}
}

// DiscardForUserAndWait performs one bounded Docker removal operation. Callers
// that own cache/resource leases must retain them themselves when it fails.
func (dp *Pool) DiscardForUserAndWait(containerID, userID string) error {
	return dp.discardForUserAndWaitContext(context.Background(), containerID, userID)
}

func (dp *Pool) discardForUserAndWaitContext(ctx context.Context, containerID, userID string) error {
	if containerID == "" {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := dp.destroyContainerContext(ctx, containerID); err != nil {
		return err
	}
	if dp.discardActiveLease(containerID, userID) {
		dp.wakeNextQueued()
	}
	return nil
}

// discardActiveLease drops pool accounting only after Docker has confirmed the
// container cannot keep writing through its mounts.
func (dp *Pool) discardActiveLease(containerID, userID string) bool {
	dp.mu.Lock()
	owner, known := dp.containerUser[containerID]
	if !known {
		dp.mu.Unlock()
		return false
	}
	if userID == "" || userID != owner {
		userID = owner
	}
	contextKey := dp.containerContext[containerID]
	delete(dp.containerUser, containerID)
	delete(dp.containerContext, containerID)
	delete(dp.taintedContainers, containerID)
	delete(dp.imageByContainerID, containerID)
	delete(dp.lruByImage, containerID)
	delete(dp.discardRetrying, containerID)
	delete(dp.discardRetryCycles, containerID)
	if dp.activeCount > 0 {
		dp.activeCount--
	}
	if dp.userActiveContainers[userID] > 1 {
		dp.userActiveContainers[userID]--
	} else {
		delete(dp.userActiveContainers, userID)
	}
	dp.pruneStalePersonalContextLocked(contextKey)
	callbacks := dp.takeContainerRemovalCallbacksLocked(containerID)
	dp.mu.Unlock()
	runContainerRemovalCallbacks(callbacks)
	return true
}

// removeQuarantinedContainer makes one immediate attempt for a detached pooled
// container, then starts one bounded retry task on transient failure.
func (dp *Pool) removeQuarantinedContainer(containerID string) error {
	return dp.removeQuarantinedContainerContext(context.Background(), containerID)
}

func (dp *Pool) removeQuarantinedContainerContext(ctx context.Context, containerID string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := dp.destroyContainerContext(ctx, containerID); err != nil {
		dp.startQuarantinedRemovalRetry(containerID)
		return err
	}
	dp.finishQuarantinedContainerRemoval(containerID)
	return nil
}

func (dp *Pool) startQuarantinedRemovalRetry(containerID string) {
	dp.mu.Lock()
	retrying, tracked := dp.pendingRemoval[containerID]
	if !tracked || retrying || dp.closed {
		dp.mu.Unlock()
		return
	}
	dp.pendingRemoval[containerID] = true
	dp.mu.Unlock()
	if dp.startInternalTask(func(ctx context.Context) {
		dp.retryQuarantinedContainerRemoval(ctx, containerID)
	}) {
		return
	}
	dp.mu.Lock()
	if _, stillTracked := dp.pendingRemoval[containerID]; stillTracked {
		dp.pendingRemoval[containerID] = false
	}
	dp.mu.Unlock()
}

func (dp *Pool) retryQuarantinedContainerRemoval(ctx context.Context, containerID string) {
	retryCtx, cancel := context.WithTimeout(ctx, containerRemovalRetryBudget)
	defer cancel()
	delay := containerRemovalInitialRetry
	var lastErr error
	for retry := 1; retry <= containerRemovalBackgroundAttempts; retry++ {
		if !dp.waitForDockerRetry(retryCtx, delay) {
			lastErr = retryCtx.Err()
			break
		}
		dp.mu.Lock()
		_, tracked := dp.pendingRemoval[containerID]
		dp.mu.Unlock()
		if !tracked {
			return
		}
		if err := dp.destroyContainerContext(retryCtx, containerID); err == nil {
			dp.finishQuarantinedContainerRemoval(containerID)
			slog.Info("Quarantined container removal confirmed", "container_id", shortContainerID(containerID), "attempt", retry+1)
			return
		} else {
			lastErr = err
			slog.Warn("Quarantined container still holds pool ownership", "container_id", shortContainerID(containerID), "attempt", retry+1, "error", err)
		}
		delay = nextContainerRemovalRetry(delay)
	}

	dp.mu.Lock()
	_, tracked := dp.pendingRemoval[containerID]
	cycle := 0
	if tracked {
		dp.pendingRemoval[containerID] = false
		if dp.discardRetryCycles == nil {
			dp.discardRetryCycles = make(map[string]int)
		}
		dp.discardRetryCycles[containerID]++
		cycle = dp.discardRetryCycles[containerID]
	}
	dp.mu.Unlock()
	if retryCtx.Err() == context.Canceled && ctx.Err() != nil {
		return
	}
	if tracked {
		attributes := []any{
			"container_id", shortContainerID(containerID),
			"attempts", containerRemovalBackgroundAttempts + 1,
			"retry_budget", containerRemovalRetryBudget,
			"retry_cycle", cycle,
			"error", lastErr,
		}
		if cycle == 1 {
			slog.Error("Quarantined container removal retry budget exhausted; pool ownership retained", attributes...)
		} else if cycle%10 == 0 {
			slog.Warn("Quarantined container removal remains pending after bounded maintenance retries", attributes...)
		}
	}
}

func (dp *Pool) waitForDockerRetry(ctx context.Context, delay time.Duration) bool {
	if dp.waitDockerRetry != nil {
		dp.waitDockerRetry(delay)
		return ctx.Err() == nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func nextContainerRemovalRetry(delay time.Duration) time.Duration {
	delay *= 2
	if delay > containerRemovalMaxRetry {
		return containerRemovalMaxRetry
	}
	return delay
}

func (dp *Pool) finishQuarantinedContainerRemoval(containerID string) {
	dp.mu.Lock()
	if _, tracked := dp.pendingRemoval[containerID]; !tracked {
		dp.mu.Unlock()
		return
	}
	contextKey := dp.containerContext[containerID]
	delete(dp.pendingRemoval, containerID)
	delete(dp.discardRetrying, containerID)
	delete(dp.discardRetryCycles, containerID)
	delete(dp.containerUser, containerID)
	delete(dp.containerContext, containerID)
	delete(dp.taintedContainers, containerID)
	delete(dp.lruByImage, containerID)
	delete(dp.imageByContainerID, containerID)
	dp.pruneStalePersonalContextLocked(contextKey)
	callbacks := dp.takeContainerRemovalCallbacksLocked(containerID)
	dp.mu.Unlock()
	runContainerRemovalCallbacks(callbacks)
	dp.wakeNextQueued()
}

func (dp *Pool) registerContainerRemovalCallback(containerID string, callback func()) bool {
	if callback == nil {
		return true
	}
	dp.mu.Lock()
	_, active := dp.containerUser[containerID]
	_, quarantined := dp.pendingRemoval[containerID]
	if !active && !quarantined {
		dp.mu.Unlock()
		callback()
		return false
	}
	if dp.removalCallbacks == nil {
		dp.removalCallbacks = make(map[string][]func())
	}
	dp.removalCallbacks[containerID] = append(dp.removalCallbacks[containerID], callback)
	dp.mu.Unlock()
	return true
}

func (dp *Pool) takeContainerRemovalCallbacksLocked(containerID string) []func() {
	callbacks := dp.removalCallbacks[containerID]
	delete(dp.removalCallbacks, containerID)
	return callbacks
}

func (dp *Pool) takeAllRemovalCallbacksLocked() []func() {
	var callbacks []func()
	for containerID := range dp.removalCallbacks {
		callbacks = append(callbacks, dp.takeContainerRemovalCallbacksLocked(containerID)...)
	}
	return callbacks
}

func runContainerRemovalCallbacks(callbacks []func()) {
	for _, callback := range callbacks {
		if callback != nil {
			callback()
		}
	}
}

func (dp *Pool) pendingContainerRemovalCountLocked() int {
	containers := make(map[string]struct{}, len(dp.pendingRemoval)+len(dp.discardRetrying))
	for containerID := range dp.pendingRemoval {
		containers[containerID] = struct{}{}
	}
	for containerID := range dp.discardRetrying {
		containers[containerID] = struct{}{}
	}
	return len(containers)
}

// retryExhaustedContainerRemovals starts at most one bounded cycle for a small
// batch. The health loop provides reconciliation without a resident goroutine
// per failed container or an unbounded retry loop.
func (dp *Pool) retryExhaustedContainerRemovals() {
	type retryCandidate struct {
		containerID string
		userID      string
		quarantined bool
	}
	dp.mu.Lock()
	if dp.closed {
		dp.mu.Unlock()
		return
	}
	candidates := make([]retryCandidate, 0, len(dp.discardRetrying)+len(dp.pendingRemoval))
	activeIDs := make(map[string]struct{}, len(dp.discardRetrying))
	for containerID, running := range dp.discardRetrying {
		activeIDs[containerID] = struct{}{}
		if running {
			continue
		}
		userID, tracked := dp.containerUser[containerID]
		if !tracked {
			delete(dp.discardRetrying, containerID)
			delete(dp.discardRetryCycles, containerID)
			continue
		}
		candidates = append(candidates, retryCandidate{containerID: containerID, userID: userID})
	}
	for containerID, running := range dp.pendingRemoval {
		if running {
			continue
		}
		if _, active := activeIDs[containerID]; active {
			continue
		}
		candidates = append(candidates, retryCandidate{containerID: containerID, quarantined: true})
	}
	sort.Slice(candidates, func(left, right int) bool { return candidates[left].containerID < candidates[right].containerID })
	selected := make([]retryCandidate, 0, min(containerRemovalMaintenanceBatch, len(candidates)))
	if len(candidates) > 0 {
		start := sort.Search(len(candidates), func(index int) bool {
			return candidates[index].containerID > dp.removalRetryCursor
		})
		if start == len(candidates) {
			start = 0
		}
		for offset := 0; offset < len(candidates) && len(selected) < containerRemovalMaintenanceBatch; offset++ {
			selected = append(selected, candidates[(start+offset)%len(candidates)])
		}
		dp.removalRetryCursor = selected[len(selected)-1].containerID
	}
	dp.mu.Unlock()
	for _, pending := range selected {
		if pending.quarantined {
			dp.startQuarantinedRemovalRetry(pending.containerID)
		} else {
			dp.startDiscardRetry(pending.containerID, pending.userID)
		}
	}
}
