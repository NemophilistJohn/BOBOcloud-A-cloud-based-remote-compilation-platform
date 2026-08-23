package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/metrics"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/ringbuffer"
	"bobocloud-server/internal/security"
	"bobocloud-server/internal/session"
)

// ============================================================
// pool.go — Docker 容器池管理（Phase 2: 用户配额 + 排队）
// ============================================================

// hotPoolKey 以「镜像 + 用户」为键，使热池按用户隔离。
// 每个用户的热池容器在创建时即挂载各自的 /persist 持久化卷，
// 保证 L1 命中时与 L3/L4 新建容器具备一致的持久化能力。
type hotPoolKey struct {
	image  string
	userID string
}

type personalGenerationState struct {
	generation  string
	publication uint64
}

// Pool 管理 Docker 容器生命周期。
// 三层命中策略：
//
//	L1: 热池中取已有空闲容器
//	L2: 本地已有镜像 → 创建新容器
//	L3: 从 Docker Hub 拉取镜像 → 创建容器
type Pool struct {
	hotPool     map[hotPoolKey]chan string
	imageLocal  map[string]bool
	poolSize    int
	maxTotal    int
	maxIdle     int
	activeCount int
	idleCount   int
	closed      bool
	mu          sync.Mutex
	sec         security.Policy

	// LRU 追踪
	lruByImage         map[string]time.Time
	imageByContainerID map[string]string
	memLimit           string
	cpuLimit           string
	replenishInterval  time.Duration

	// Phase 2: 用户配额
	userActiveContainers  map[string]int
	userPendingContainers map[string]int
	userBackgroundCreates map[string]int
	userContainerLimits   map[string]int
	deletedUsers          map[string]bool

	// Phase 2: 请求队列
	queue *RequestQueue

	// Phase 3: 容器复用（按用户隔离）
	idlePool                  map[string][]string // image → containerIDs (LRU, most recent first)
	containerUser             map[string]string   // containerID → userID
	containerContext          map[string]string   // containerID → exact cache mount generation
	taintedContainers         map[string]bool     // cancelled docker exec may still have a live process and must not be reused
	pendingRemoval            map[string]bool     // detached from reuse but owned until Docker confirms absence; value marks retry started
	stalePersonalContext      map[string]bool     // published personal dependency generations that active containers still mount
	currentPersonalGeneration map[string]personalGenerationState

	// Phase 3: 镜像加速
	registryMirrors []string
	pullTimeout     time.Duration
	userDataDir     string // {DataDir}/users/{userID} 根路径

	// 安全加固（G1）
	hardening               bool // 丢弃 capabilities / 禁提权 / 限制进程数 / init
	readOnlyRootfs          bool // 只读根文件系统（配合 tmpfs）
	metrics                 *metrics.Registry
	outputRetainedBytes     int
	personalDependencyScope string
	resetStrategy           string
	runDockerCommand        func(context.Context, ...string) ([]byte, error)
	waitDockerRetry         func(time.Duration)
}

// UserQuotaProvider 用于查询用户容器配额
type UserQuotaProvider interface {
	GetContainerLimit(userID string) int
}

// NewPool 创建 Docker 容器池
func NewPool(
	hotPoolSize, maxTotal, maxIdle int,
	memLimit, cpuLimit string,
	replenishInterval time.Duration,
	sec security.Policy,
	queueSize, queueTimeoutSec int,
	registryMirrors []string,
	pullTimeout time.Duration,
	userDataDir string,
) *Pool {
	var rq *RequestQueue
	if queueSize > 0 {
		rq = NewRequestQueue(queueSize, time.Duration(queueTimeoutSec)*time.Second)
	}

	dp := &Pool{
		hotPool:                   make(map[hotPoolKey]chan string),
		imageLocal:                make(map[string]bool),
		poolSize:                  hotPoolSize,
		maxTotal:                  maxTotal,
		maxIdle:                   maxIdle,
		sec:                       sec,
		lruByImage:                make(map[string]time.Time),
		imageByContainerID:        make(map[string]string),
		memLimit:                  memLimit,
		cpuLimit:                  cpuLimit,
		replenishInterval:         replenishInterval,
		userActiveContainers:      make(map[string]int),
		userPendingContainers:     make(map[string]int),
		userBackgroundCreates:     make(map[string]int),
		userContainerLimits:       make(map[string]int),
		deletedUsers:              make(map[string]bool),
		queue:                     rq,
		idlePool:                  make(map[string][]string),
		containerUser:             make(map[string]string),
		containerContext:          make(map[string]string),
		taintedContainers:         make(map[string]bool),
		pendingRemoval:            make(map[string]bool),
		stalePersonalContext:      make(map[string]bool),
		currentPersonalGeneration: make(map[string]personalGenerationState),
		registryMirrors:           registryMirrors,
		pullTimeout:               pullTimeout,
		userDataDir:               userDataDir,
		outputRetainedBytes:       256 << 10,
	}

	go dp.replenishLoop()
	go dp.healthCheckLoop()

	return dp
}

func (dp *Pool) SetMetrics(registry *metrics.Registry) { dp.metrics = registry }

func (dp *Pool) SetOutputRetentionLimit(limit int) {
	if limit > 0 {
		dp.outputRetainedBytes = limit
	}
}

func (dp *Pool) SetPersonalDependencyScope(scope string) {
	dp.personalDependencyScope = scope
}

const (
	ResetStrategyVerified = "verified"
	ResetStrategyRestart  = "restart"
)

// SetResetStrategy selects how a successfully used container is sanitized
// before returning to the idle pool. Invalid values fail closed to restart;
// config validation normally prevents them from reaching this boundary.
func (dp *Pool) SetResetStrategy(strategy string) {
	strategy = strings.ToLower(strings.TrimSpace(strategy))
	if strategy != ResetStrategyVerified && strategy != ResetStrategyRestart {
		strategy = ResetStrategyRestart
	}
	dp.mu.Lock()
	dp.resetStrategy = strategy
	dp.mu.Unlock()
}

// SetHardening 配置容器安全加固开关。
//
//	hardening      : 丢弃所有 capabilities、禁止提权、限制进程数、启用 init
//	readOnlyRootfs: 只读根文件系统（配合 /tmp /workspace /home 的 tmpfs）
//
// 两者均默认由配置文件驱动；readOnlyRootfs 为实验性，默认关闭以兼顾兼容性。
func (dp *Pool) SetHardening(hardening, readOnlyRootfs bool) {
	dp.hardening = hardening
	dp.readOnlyRootfs = readOnlyRootfs
}

// Shutdown 优雅关闭：销毁池中所有已知容器（热池+空闲池+活跃），避免进程退出后孤儿容器泄漏。
// 在 SIGTERM/SIGINT 时由 main 调用。containerUser 记录了所有创建过的容器 ID；
// destroyContainer 对已销毁容器幂等（docker stop/rm 忽略错误）。
func (dp *Pool) Shutdown() {
	slog.Info("Docker pool shutting down, destroying all known containers...")
	dp.mu.Lock()
	if dp.closed {
		dp.mu.Unlock()
		return
	}
	dp.closed = true
	ids := make([]string, 0, len(dp.containerUser))
	for id := range dp.containerUser {
		ids = append(ids, id)
	}
	dp.mu.Unlock()

	for _, id := range ids {
		dp.destroyContainer(id)
	}
	slog.Info("Docker pool shutdown complete", "containers_processed", len(ids))
}

// CleanupOrphanedContainers 清理上次进程异常退出后遗留的孤儿容器。
// 通过 docker label 筛选本服务创建的容器，销毁所有不在当前 containerUser 映射中的。
// 在服务启动时调用，确保干净的起始状态。
func (dp *Pool) CleanupOrphanedContainers() error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 列出所有带 bobocloud.managed=true 标签的容器
	out, err := dp.executeDockerCommand(ctx, "ps", "-aq", "--filter", "label=bobocloud.managed=true")
	if err != nil {
		slog.Warn("Failed to list orphaned containers", "error", err)
		return fmt.Errorf("list orphaned containers: %w", err)
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var orphans []string
	for _, line := range lines {
		id := strings.TrimSpace(line)
		if id == "" {
			continue
		}
		dp.mu.Lock()
		_, known := dp.containerUser[id]
		dp.mu.Unlock()
		if !known {
			orphans = append(orphans, id)
		}
	}

	if len(orphans) == 0 {
		slog.Info("No orphaned containers found")
		return nil
	}

	slog.Info("Cleaning up orphaned containers", "count", len(orphans))
	destroyed := 0
	var cleanupErrors []error
	for _, id := range orphans {
		if destroyErr := dp.destroyContainer(id); destroyErr != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("destroy %s: %w", shortContainerID(id), destroyErr))
			continue
		}
		destroyed++
	}
	slog.Info("Orphaned container cleanup complete", "destroyed", destroyed, "failed", len(cleanupErrors))
	return errors.Join(cleanupErrors...)
}

// DestroyUserContainers freezes the user and destroys every container that may
// still hold one of their bind mounts. Ownership and quota accounting are
// released per container only after Docker confirms that container is absent.
// A caller must not remove the user's data directory when this method returns
// an error; the idempotent deletion-cleanup pipeline can retry it later.
func (dp *Pool) DestroyUserContainers(userID string) error {
	if strings.TrimSpace(userID) == "" {
		return fmt.Errorf("destroy user containers: user ID is required")
	}

	dp.mu.Lock()
	if dp.deletedUsers == nil {
		dp.deletedUsers = make(map[string]bool)
	}
	dp.deletedUsers[userID] = true
	dp.mu.Unlock()
	if dp.queue != nil {
		dp.queue.RemoveByUser(userID, fmt.Errorf("user %s was deleted", userID))
	}

	ids, pending, background := dp.snapshotUserContainersForDeletion(userID)
	if pending > 0 || background > 0 {
		return fmt.Errorf("destroy user containers: user %s still has %d acquisition(s) and %d background creation(s) draining", userID, pending, background)
	}

	destroyed := 0
	var cleanupErrors []error
	for _, id := range ids {
		if err := dp.destroyUserContainerWithRetry(id); err != nil {
			cleanupErrors = append(cleanupErrors, err)
			continue
		}
		if dp.forgetConfirmedUserContainer(id, userID) {
			destroyed++
			dp.wakeNextQueued()
		}
	}

	remaining, pending, background := dp.finishUserContainerDeletion(userID)
	if pending > 0 || background > 0 {
		cleanupErrors = append(cleanupErrors, fmt.Errorf("user %s still has %d acquisition(s) and %d background creation(s) draining", userID, pending, background))
	}
	if len(remaining) > 0 {
		cleanupErrors = append(cleanupErrors, fmt.Errorf("user %s still owns %d container(s): %s", userID, len(remaining), strings.Join(remaining, ", ")))
	}
	if err := errors.Join(cleanupErrors...); err != nil {
		return fmt.Errorf("destroy user containers: %w", err)
	}
	if destroyed > 0 {
		slog.Info("Destroyed user containers after account deletion",
			"user_id", userID, "count", destroyed)
	}
	return nil
}

// InvalidateIdleBuildCacheContainers unmounts cache directories held by idle
// context containers. Manual cache deletion calls this synchronously so
// deleted bind-mounted files release their disk blocks before the API returns.
// Leased containers are not present in idlePool and are never interrupted.
func (dp *Pool) InvalidateIdleBuildCacheContainers() {
	ids := dp.detachIdleContextContainers(func(cacheKey string) bool { return cacheKey != "" })
	for _, id := range ids {
		if err := dp.removeQuarantinedContainer(id); err != nil {
			slog.Warn("Idle cache container removal was not confirmed", "container_id", shortContainerID(id), "error", err)
		}
	}
	if len(ids) > 0 {
		slog.Info("Invalidated idle team-cache containers", "count", len(ids))
	}
}

// InvalidateIdlePersonalDependencyContainers removes idle containers pinned to
// older generations and marks matching active containers stale. An active old
// generation is destroyed when it is released, while a concurrently acquired
// container for currentGeneration remains reusable. publication orders
// callbacks that can finish out of order after the personal-cache gate opens.
func (dp *Pool) InvalidateIdlePersonalDependencyContainers(cacheKey, currentGeneration string, publication uint64) {
	cacheKey = strings.TrimSpace(cacheKey)
	currentGeneration = strings.TrimSpace(currentGeneration)
	if cacheKey == "" || currentGeneration == "" {
		return
	}

	dp.mu.Lock()
	if dp.stalePersonalContext == nil {
		dp.stalePersonalContext = make(map[string]bool)
	}
	if dp.currentPersonalGeneration == nil {
		dp.currentPersonalGeneration = make(map[string]personalGenerationState)
	}
	if previous, exists := dp.currentPersonalGeneration[cacheKey]; exists {
		if publication < previous.publication {
			dp.mu.Unlock()
			slog.Debug("Ignored out-of-order personal dependency publication", "cache_key", cacheKey, "publication", publication, "current_publication", previous.publication)
			return
		}
		if publication == previous.publication && previous.generation != currentGeneration {
			dp.mu.Unlock()
			slog.Warn("Ignored conflicting personal dependency publication", "cache_key", cacheKey, "publication", publication)
			return
		}
	}
	dp.currentPersonalGeneration[cacheKey] = personalGenerationState{generation: currentGeneration, publication: publication}
	for contextKey := range dp.stalePersonalContext {
		contextCacheKey, generation, personal := parsePersonalDependencyContext(contextKey)
		if personal && contextCacheKey == cacheKey && generation == currentGeneration {
			delete(dp.stalePersonalContext, contextKey)
		}
	}
	isOldGeneration := func(contextKey string) bool {
		contextCacheKey, generation, personal := parsePersonalDependencyContext(contextKey)
		return personal && contextCacheKey == cacheKey && generation != currentGeneration
	}
	ids := dp.detachIdleContextContainersLocked(isOldGeneration)
	for _, contextKey := range dp.containerContext {
		if isOldGeneration(contextKey) {
			dp.stalePersonalContext[contextKey] = true
		}
	}
	dp.pruneUnusedStalePersonalContextsLocked()
	dp.mu.Unlock()

	for _, id := range ids {
		if err := dp.removeQuarantinedContainer(id); err != nil {
			slog.Warn("Old personal dependency container removal was not confirmed", "container_id", shortContainerID(id), "cache_key", cacheKey, "error", err)
		}
	}
	if len(ids) > 0 {
		slog.Info("Invalidated old personal dependency containers", "cache_key", cacheKey, "count", len(ids))
	}
}

func parsePersonalDependencyContext(contextKey string) (cacheKey, generation string, ok bool) {
	const prefix = "personal/"
	if !strings.HasPrefix(contextKey, prefix) {
		return "", "", false
	}
	remainder := strings.TrimPrefix(contextKey, prefix)
	modeSeparator := strings.LastIndexByte(remainder, ':')
	if modeSeparator <= 0 || modeSeparator == len(remainder)-1 {
		return "", "", false
	}
	mode := remainder[modeSeparator+1:]
	if mode != "ro" && mode != "rw" {
		return "", "", false
	}
	generationSeparator := strings.LastIndexByte(remainder[:modeSeparator], '@')
	if generationSeparator <= 0 || generationSeparator == modeSeparator-1 {
		return "", "", false
	}
	return remainder[:generationSeparator], remainder[generationSeparator+1 : modeSeparator], true
}

func (dp *Pool) personalContextSupersededLocked(contextKey string) bool {
	cacheKey, generation, personal := parsePersonalDependencyContext(contextKey)
	if !personal {
		return false
	}
	current, known := dp.currentPersonalGeneration[cacheKey]
	return known && current.generation != generation
}

func (dp *Pool) recordContainerContextLocked(containerID, contextKey string) {
	if contextKey == "" {
		return
	}
	if dp.containerContext == nil {
		dp.containerContext = make(map[string]string)
	}
	dp.containerContext[containerID] = contextKey
	if dp.personalContextSupersededLocked(contextKey) {
		if dp.stalePersonalContext == nil {
			dp.stalePersonalContext = make(map[string]bool)
		}
		dp.stalePersonalContext[contextKey] = true
	}
}

func (dp *Pool) detachIdleBuildCacheContainers() []string {
	return dp.detachIdleContextContainers(func(cacheKey string) bool { return cacheKey != "" })
}

func (dp *Pool) detachIdleContextContainers(matches func(string) bool) []string {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	return dp.detachIdleContextContainersLocked(matches)
}

// detachIdleContextContainersLocked removes matching containers from reuse
// while preserving their owner and mount generation. Docker removal happens
// after unlocking, so an uncertain result remains tracked and quarantined.
func (dp *Pool) detachIdleContextContainersLocked(matches func(string) bool) []string {
	var removed []string
	if dp.pendingRemoval == nil {
		dp.pendingRemoval = make(map[string]bool)
	}
	for image, ids := range dp.idlePool {
		kept := ids[:0]
		for _, id := range ids {
			if matches == nil || !matches(dp.containerContext[id]) {
				kept = append(kept, id)
				continue
			}
			removed = append(removed, id)
			dp.pendingRemoval[id] = false
			delete(dp.lruByImage, id)
		}
		if len(kept) == 0 {
			delete(dp.idlePool, image)
		} else {
			dp.idlePool[image] = kept
		}
	}
	dp.idleCount -= len(removed)
	if dp.idleCount < 0 {
		dp.idleCount = 0
	}
	return removed
}

// quarantinePooledContainerLocked transitions an already-detached hot/idle
// container into a non-reusable capacity bucket without releasing ownership.
// The caller must hold dp.mu and pass the bucket returned by the detach helper.
func (dp *Pool) quarantinePooledContainerLocked(containerID, poolKind string) {
	if dp.pendingRemoval == nil {
		dp.pendingRemoval = make(map[string]bool)
	}
	dp.pendingRemoval[containerID] = false
	delete(dp.lruByImage, containerID)
	switch poolKind {
	case "idle":
		if dp.idleCount > 0 {
			dp.idleCount--
		}
	case "hot":
		if dp.activeCount > 0 {
			dp.activeCount--
		}
	}
}

// removeQuarantinedContainer makes one immediate removal attempt. A transient
// failure starts one retry loop and keeps the container outside every reuse
// list while it continues to count against the pool's global capacity.
func (dp *Pool) removeQuarantinedContainer(containerID string) error {
	if err := dp.destroyContainer(containerID); err != nil {
		dp.mu.Lock()
		retrying, tracked := dp.pendingRemoval[containerID]
		if tracked && !retrying {
			dp.pendingRemoval[containerID] = true
		}
		dp.mu.Unlock()
		if tracked && !retrying {
			go dp.retryQuarantinedContainerRemoval(containerID)
		}
		return err
	}
	dp.finishQuarantinedContainerRemoval(containerID)
	return nil
}

func (dp *Pool) retryQuarantinedContainerRemoval(containerID string) {
	delay := 250 * time.Millisecond
	for attempt := 1; ; attempt++ {
		if dp.waitDockerRetry != nil {
			dp.waitDockerRetry(delay)
		} else {
			time.Sleep(delay)
		}
		dp.mu.Lock()
		_, tracked := dp.pendingRemoval[containerID]
		dp.mu.Unlock()
		if !tracked {
			return
		}
		if err := dp.destroyContainer(containerID); err == nil {
			dp.finishQuarantinedContainerRemoval(containerID)
			slog.Info("Quarantined container removal confirmed", "container_id", shortContainerID(containerID), "attempt", attempt+1)
			return
		} else if attempt == 1 || attempt%10 == 0 {
			slog.Warn("Quarantined container still holds pool ownership", "container_id", shortContainerID(containerID), "attempt", attempt+1, "error", err)
		}
		if delay < 30*time.Second {
			delay *= 2
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
		}
	}
}

func (dp *Pool) finishQuarantinedContainerRemoval(containerID string) {
	dp.mu.Lock()
	if _, tracked := dp.pendingRemoval[containerID]; !tracked {
		dp.mu.Unlock()
		return
	}
	contextKey := dp.containerContext[containerID]
	delete(dp.pendingRemoval, containerID)
	delete(dp.containerUser, containerID)
	delete(dp.containerContext, containerID)
	delete(dp.taintedContainers, containerID)
	delete(dp.lruByImage, containerID)
	delete(dp.imageByContainerID, containerID)
	dp.pruneStalePersonalContextLocked(contextKey)
	dp.mu.Unlock()
	dp.wakeNextQueued()
}

func (dp *Pool) snapshotUserContainersForDeletion(userID string) (ids []string, pending, background int) {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	for id, owner := range dp.containerUser {
		if owner == userID {
			ids = append(ids, id)
		}
	}
	return ids, dp.userPendingContainers[userID], dp.userBackgroundCreates[userID]
}

const userContainerRemovalAttempts = 3

func (dp *Pool) destroyUserContainerWithRetry(containerID string) error {
	delay := 250 * time.Millisecond
	var lastErr error
	for attempt := 1; attempt <= userContainerRemovalAttempts; attempt++ {
		if err := dp.destroyContainer(containerID); err == nil {
			return nil
		} else {
			lastErr = err
		}
		if attempt == userContainerRemovalAttempts {
			break
		}
		if dp.waitDockerRetry != nil {
			dp.waitDockerRetry(delay)
		} else {
			time.Sleep(delay)
		}
		delay *= 2
	}
	return fmt.Errorf("container %s removal was not confirmed after %d attempt(s): %w", shortContainerID(containerID), userContainerRemovalAttempts, lastErr)
}

// forgetConfirmedUserContainer performs the accounting transition that used to
// happen before docker rm. It classifies the container while holding dp.mu so a
// concurrent release or health check cannot decrement a different bucket.
func (dp *Pool) forgetConfirmedUserContainer(containerID, userID string) bool {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	owner, known := dp.containerUser[containerID]
	if !known || owner != userID {
		return false
	}
	contextKey := dp.containerContext[containerID]
	if _, quarantined := dp.pendingRemoval[containerID]; quarantined {
		delete(dp.pendingRemoval, containerID)
	} else {
		poolKind := dp.detachPooledContainerLocked(containerID)
		switch poolKind {
		case "idle":
			if dp.idleCount > 0 {
				dp.idleCount--
			}
		case "hot":
			if dp.activeCount > 0 {
				dp.activeCount--
			}
		default:
			if dp.activeCount > 0 {
				dp.activeCount--
			}
			if dp.userActiveContainers[userID] > 1 {
				dp.userActiveContainers[userID]--
			} else {
				delete(dp.userActiveContainers, userID)
			}
		}
	}
	delete(dp.containerUser, containerID)
	delete(dp.containerContext, containerID)
	delete(dp.taintedContainers, containerID)
	delete(dp.lruByImage, containerID)
	delete(dp.imageByContainerID, containerID)
	dp.pruneStalePersonalContextLocked(contextKey)
	return true
}

func (dp *Pool) finishUserContainerDeletion(userID string) (remaining []string, pending, background int) {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	for id, owner := range dp.containerUser {
		if owner == userID {
			remaining = append(remaining, id)
		}
	}
	pending = dp.userPendingContainers[userID]
	background = dp.userBackgroundCreates[userID]
	if len(remaining) == 0 && pending == 0 && background == 0 {
		delete(dp.userActiveContainers, userID)
		delete(dp.userPendingContainers, userID)
		delete(dp.userBackgroundCreates, userID)
		delete(dp.userContainerLimits, userID)
		for key, ch := range dp.hotPool {
			if key.userID == userID && len(ch) == 0 {
				delete(dp.hotPool, key)
			}
		}
	}
	return remaining, pending, background
}

// SetUserLimit 设置用户的容器配额上限
func (dp *Pool) SetUserLimit(userID string, limit int) {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	dp.userContainerLimits[userID] = limit
	delete(dp.deletedUsers, userID)
}

// GetUserActive 获取用户当前活跃容器数
func (dp *Pool) GetUserActive(userID string) int {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	return dp.userActiveContainers[userID]
}

// Acquire 获取容器（Phase 1 兼容，不检查用户配额）。
// 新代码应使用 AcquireForUser。
func (dp *Pool) Acquire(ctx context.Context, image string, output session.OutputWriter) (string, error) {
	return dp.acquireInternal(ctx, "", image, output, "", nil, nil)
}

// AcquireForUser 获取容器，同时检查用户配额。
// userID 为空时跳过配额检查。
func (dp *Pool) AcquireForUser(ctx context.Context, userID, image string, output session.OutputWriter) (string, error) {
	return dp.acquireForUser(ctx, userID, image, "", nil, nil, output)
}

// AcquireForUserWithContext acquires a container with build-specific mounts.
// Reuse requires an exact image, user and cache mount generation match.
func (dp *Pool) AcquireForUserWithContext(ctx context.Context, userID, image, cacheKey string, volumes, env map[string]string, output session.OutputWriter) (string, error) {
	if cacheKey == "" {
		return dp.AcquireForUser(ctx, userID, image, output)
	}
	return dp.acquireForUser(ctx, userID, image, cacheKey, volumes, env, output)
}

func (dp *Pool) acquireForUser(ctx context.Context, userID, image, cacheKey string, volumes, env map[string]string, output session.OutputWriter) (string, error) {
	dp.mu.Lock()
	closed := dp.closed
	dp.mu.Unlock()
	if closed {
		return "", fmt.Errorf("docker pool is shutting down")
	}
	// 原子预留用户配额。只做“先检查再获取”会让并发请求同时通过检查，
	// 最终超过用户上限；pending 预留会一直保留到获取成功或失败。
	if userID != "" {
		dp.mu.Lock()
		if dp.deletedUsers[userID] {
			dp.mu.Unlock()
			return "", fmt.Errorf("user %s is no longer available", userID)
		}
		limit, hasLimit := dp.userContainerLimits[userID]
		current := dp.userActiveContainers[userID] + dp.userPendingContainers[userID]
		if hasLimit && current >= limit {
			dp.mu.Unlock()
			return "", fmt.Errorf("user %s has reached container quota (%d/%d)", userID, current, limit)
		}
		dp.userPendingContainers[userID]++
		dp.mu.Unlock()
		defer func() {
			dp.mu.Lock()
			if dp.userPendingContainers[userID] > 0 {
				dp.userPendingContainers[userID]--
			}
			dp.mu.Unlock()
		}()
	}

	// 先尝试直接获取：热池(L1)/空闲池(L2) 命中，或仍有容量新建(L3/L4)。
	// 注意：activeCount 包含热池中预创建的空闲容器，故 activeCount >= maxTotal
	// 并不代表"全部忙"。acquireInternal 在 L3/L4 容量满时会尝试淘汰其它用户的
	// 空闲热池容器来腾出槽位；只有真正无可复用容器且无法新建时才进入排队。
	id, err := dp.acquireInternal(ctx, userID, image, output, cacheKey, volumes, env)
	if err == nil {
		return dp.finishUserAcquisition(id, userID)
	}

	// 直接获取失败且全局已满 -> 进入排队等待其它请求释放
	dp.mu.Lock()
	full := dp.totalContainersLocked() >= dp.maxTotal
	dp.mu.Unlock()

	if full && dp.queue != nil && userID != "" {
		id, err = dp.acquireViaQueue(ctx, userID, image, cacheKey, volumes, env, output)
		if err == nil {
			return dp.finishUserAcquisition(id, userID)
		}
		return "", err
	}

	return "", err
}

// finishUserAcquisition closes the race where account deletion begins after an
// acquisition reserved quota but before it returns a container to the caller.
// The pending reservation remains held until removal is confirmed.
func (dp *Pool) finishUserAcquisition(containerID, userID string) (string, error) {
	if userID == "" || containerID == "" {
		return containerID, nil
	}
	dp.mu.Lock()
	deleted := dp.deletedUsers[userID]
	dp.mu.Unlock()
	if !deleted {
		return containerID, nil
	}
	dp.DiscardForUser(containerID, userID)
	return "", fmt.Errorf("user %s is no longer available", userID)
}

// acquireViaQueue 通过请求队列等待容器
func (dp *Pool) acquireViaQueue(ctx context.Context, userID, image, cacheKey string, volumes, env map[string]string, output session.OutputWriter) (string, error) {
	queuedAt := time.Now()
	defer func() {
		if dp.metrics != nil {
			dp.metrics.Observe("queue.wait", time.Since(queuedAt))
		}
	}()
	if output != nil {
		output.WriteStatus("docker", fmt.Sprintf("All containers busy (%d/%d), entering queue...",
			dp.activeCount, dp.maxTotal))
	}

	timeout := dp.queue.Timeout()
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		resultCh := make(chan QueueResult, 1)
		req := &QueueRequest{
			UserID: userID, Image: image, ResultCh: resultCh,
			Ctx: ctx, CreatedAt: time.Now(),
		}
		if err := dp.queue.Enqueue(req); err != nil {
			return "", err
		}
		// Enqueue first, then recheck deletion. In either ordering, account
		// deletion can now observe and remove this exact queued request.
		dp.mu.Lock()
		deleted := dp.deletedUsers[userID]
		dp.mu.Unlock()
		if deleted {
			dp.queue.Remove(req)
			return "", fmt.Errorf("user %s is no longer available", userID)
		}

		select {
		case result := <-resultCh:
			if result.Error != nil {
				return "", result.Error
			}
			// Release only signals that capacity may now be available. The
			// requester acquires its own image/user container so /persist mounts
			// can never be transferred across users.
			id, err := dp.acquireInternal(ctx, userID, image, output, cacheKey, volumes, env)
			if err == nil {
				return id, nil
			}
			if !strings.Contains(err.Error(), "maximum container count") {
				dp.wakeNextQueued()
				return "", err
			}
			// A concurrent request won the released slot. Re-enter FIFO until
			// this request's original timeout expires.
		case <-ctx.Done():
			dp.queue.Remove(req)
			return "", fmt.Errorf("queue wait cancelled: %w", ctx.Err())
		case <-timer.C:
			dp.queue.Remove(req)
			dp.queue.RecordTimeout()
			return "", fmt.Errorf("request timed out after %v waiting for container", timeout)
		}
	}
}

// acquireInternal 实际获取容器的内部实现。
// Phase 3: L1=热池 → L2=空闲复用池 → L3=本地镜像创建 → L4=拉取镜像创建
func (dp *Pool) acquireInternal(ctx context.Context, userID, image string, output session.OutputWriter, cacheKey string, contextVolumes, contextEnv map[string]string) (string, error) {
	dp.mu.Lock()
	if dp.closed {
		dp.mu.Unlock()
		return "", fmt.Errorf("docker pool is shutting down")
	}
	if userID != "" && dp.deletedUsers[userID] {
		dp.mu.Unlock()
		return "", fmt.Errorf("user %s is no longer available", userID)
	}
	dp.mu.Unlock()

	// L1: 热池命中（预创建的新容器，按用户隔离，已挂载 /persist 卷）
	if cacheKey == "" {
		if id := dp.tryHotPool(image, userID); id != "" {
			if dp.metrics != nil {
				dp.metrics.Cache("container.hot_pool", true)
			}
			if output != nil {
				output.WriteStatus("docker", fmt.Sprintf("Container ready (hot pool): %s", id[:12]))
			}
			dp.incUserActive(userID)
			dp.mu.Lock()
			dp.containerUser[id] = userID
			dp.mu.Unlock()
			return id, nil
		}
		if dp.metrics != nil {
			dp.metrics.Cache("container.hot_pool", false)
		}
	}

	// Phase 3 L2: 空闲复用池（仅复用同用户容器，防卷泄漏）
	if id := dp.tryIdlePool(image, userID, cacheKey); id != "" {
		if dp.metrics != nil {
			dp.metrics.Cache("container.idle_pool", true)
		}
		if output != nil {
			kind := "idle pool"
			if cacheKey != "" {
				kind = "team cache pool"
			}
			output.WriteStatus("docker", fmt.Sprintf("Container reused (%s): %s", kind, id[:12]))
		}
		dp.mu.Lock()
		dp.containerUser[id] = userID
		dp.recordContainerContextLocked(id, dp.containerContext[id])
		dp.mu.Unlock()
		dp.incUserActive(userID)
		dp.mu.Lock()
		dp.activeCount++
		dp.idleCount--
		dp.mu.Unlock()
		return id, nil
	}
	if dp.metrics != nil {
		dp.metrics.Cache("container.idle_pool", false)
	}

	// L3/L4: 需要创建新容器
	dp.mu.Lock()
	if dp.closed {
		dp.mu.Unlock()
		return "", fmt.Errorf("docker pool is shutting down")
	}
	if userID != "" && dp.deletedUsers[userID] {
		dp.mu.Unlock()
		return "", fmt.Errorf("user %s is no longer available", userID)
	}
	if dp.totalContainersLocked() >= dp.maxTotal {
		// 容量满：尝试淘汰一个其它用户的空闲热池容器腾出槽位。
		// 这样即使活跃用户没有命中自己的热池（例如预热时容量不足未为其创建），
		// 也能从闲置用户的预热容器中回收一个槽位，而不必无限排队。
		evictedID, evictedUser := dp.tryEvictHotPoolLocked(userID)
		evictedIdle := false
		if evictedID == "" {
			evictedID, evictedUser = dp.tryEvictIdlePoolLocked(userID)
			evictedIdle = evictedID != ""
		}
		if evictedID == "" {
			dp.mu.Unlock()
			return "", fmt.Errorf("maximum container count (%d) reached", dp.maxTotal)
		}
		poolKind := "hot"
		if evictedIdle {
			poolKind = "idle"
		}
		dp.quarantinePooledContainerLocked(evictedID, poolKind)
		dp.mu.Unlock()
		if err := dp.removeQuarantinedContainer(evictedID); err != nil {
			return "", fmt.Errorf("evict pooled container %s: %w", shortContainerID(evictedID), err)
		}

		// Container absence, capacity reservation, and deletion state are all
		// revalidated because another request may claim the released slot while
		// docker rm is in flight.
		dp.mu.Lock()
		if dp.closed {
			dp.mu.Unlock()
			return "", fmt.Errorf("docker pool is shutting down")
		}
		if dp.deletedUsers[userID] {
			dp.mu.Unlock()
			return "", fmt.Errorf("user %s is no longer available", userID)
		}
		if dp.totalContainersLocked() >= dp.maxTotal {
			dp.mu.Unlock()
			return "", fmt.Errorf("maximum container count (%d) reached", dp.maxTotal)
		}
		dp.activeCount++
		dp.mu.Unlock()
		slog.Info("Evicted pooled container to free slot for new container",
			"evicted_id", evictedID[:12], "from_user", evictedUser, "for_user", userID, "image", image)
	} else {
		dp.activeCount++
		dp.mu.Unlock()
	}

	if !dp.hasLocalImage(image) {
		if output != nil {
			output.WriteStatus("docker", fmt.Sprintf("Pulling image %s...", image))
		}
		if err := dp.pullImage(ctx, image, output); err != nil {
			dp.decActive()
			return "", fmt.Errorf("failed to pull image %s: %w", image, err)
		}
		dp.markImageLocal(image)
		if output != nil {
			output.WriteStatus("docker", fmt.Sprintf("Image %s pulled", image))
		}
	}

	// 构建用户持久化卷挂载 + 环境变量
	extraVolumes := dp.buildUserVolumes(userID, image)
	extraEnv := dp.buildPersistEnvForUser(userID, image)
	for hostPath, containerPath := range contextVolumes {
		extraVolumes[hostPath] = containerPath
	}
	for key, value := range contextEnv {
		extraEnv[key] = value
	}

	createStarted := time.Now()
	containerID, err := dp.createContainer(ctx, image, extraVolumes, extraEnv)
	if dp.metrics != nil {
		dp.metrics.Observe("container.create", time.Since(createStarted))
	}
	if err != nil {
		if containerID == "" {
			dp.decActive()
		} else {
			dp.mu.Lock()
			dp.containerUser[containerID] = userID
			dp.imageByContainerID[containerID] = image
			dp.recordContainerContextLocked(containerID, cacheKey)
			dp.mu.Unlock()
			dp.DiscardForUser(containerID, userID)
		}
		return "", fmt.Errorf("failed to create container: %w", err)
	}

	dp.mu.Lock()
	if dp.closed || (userID != "" && dp.deletedUsers[userID]) {
		dp.containerUser[containerID] = userID
		dp.imageByContainerID[containerID] = image
		dp.recordContainerContextLocked(containerID, cacheKey)
		closed := dp.closed
		dp.mu.Unlock()
		dp.DiscardForUser(containerID, userID)
		if closed {
			return "", fmt.Errorf("docker pool is shutting down")
		}
		return "", fmt.Errorf("user %s is no longer available", userID)
	}
	dp.containerUser[containerID] = userID
	dp.imageByContainerID[containerID] = image
	dp.recordContainerContextLocked(containerID, cacheKey)
	dp.mu.Unlock()
	dp.incUserActive(userID)
	if output != nil {
		output.WriteStatus("docker", fmt.Sprintf("Container created: %s", containerID[:12]))
	}
	return containerID, nil
}

// Release 销毁容器（Phase 1 兼容接口）。
// Phase 3 新行为：优先尝试回池复用，满时才销毁。
func (dp *Pool) Release(containerID string) {
	if containerID == "" {
		return
	}
	userID := dp.getContainerUser(containerID)
	dp.releaseInternal(containerID, userID)
}

// ReleaseForUser 带 userID 的释放。
// Phase 3: 清理工作区后回池复用（LRU），满时淘汰最旧。
func (dp *Pool) ReleaseForUser(containerID, userID string) {
	if containerID == "" {
		return
	}
	dp.releaseInternal(containerID, userID)
}

// DiscardForUser permanently removes an actively leased container instead of
// returning it to the reuse pool. Callers use this only when the attached
// process cannot be verified as stopped; retaining such a container could let
// a later request inherit a live process or a partially cleaned workspace.
func (dp *Pool) DiscardForUser(containerID, userID string) {
	if containerID == "" {
		return
	}
	delay := 250 * time.Millisecond
	for attempt := 1; ; attempt++ {
		if err := dp.DiscardForUserAndWait(containerID, userID); err == nil {
			return
		} else if attempt == 1 || attempt%10 == 0 {
			slog.Warn("Discarded container is still potentially writable; retaining ownership", "container_id", shortContainerID(containerID), "attempt", attempt, "error", err)
		}
		if dp.waitDockerRetry != nil {
			dp.waitDockerRetry(delay)
		} else {
			time.Sleep(delay)
		}
		if delay < 30*time.Second {
			delay *= 2
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
		}
	}
}

// DiscardForUserAndWait removes the Docker container before dropping its pool
// ownership. A project dependency writer may release its cache lease only after
// this method succeeds: on failure the still-addressable active lease prevents
// a new request from treating a potentially live bind mount as inactive.
func (dp *Pool) DiscardForUserAndWait(containerID, userID string) error {
	if containerID == "" {
		return nil
	}
	if err := dp.destroyContainer(containerID); err != nil {
		return err
	}
	if dp.discardActiveLease(containerID, userID) {
		dp.wakeNextQueued()
	}
	return nil
}

// discardActiveLease drops pool accounting only after Docker has confirmed the
// container cannot keep writing through its mounts. The caller owns that
// ordering; this helper performs no Docker I/O itself.
func (dp *Pool) discardActiveLease(containerID, userID string) bool {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	owner, known := dp.containerUser[containerID]
	if !known {
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
	if dp.activeCount > 0 {
		dp.activeCount--
	}
	if dp.userActiveContainers[userID] > 1 {
		dp.userActiveContainers[userID]--
	} else {
		delete(dp.userActiveContainers, userID)
	}
	dp.pruneStalePersonalContextLocked(contextKey)
	return true
}

func (dp *Pool) pruneStalePersonalContextLocked(contextKey string) {
	if contextKey == "" || !dp.stalePersonalContext[contextKey] {
		return
	}
	for _, activeContext := range dp.containerContext {
		if activeContext == contextKey {
			return
		}
	}
	delete(dp.stalePersonalContext, contextKey)
}

func (dp *Pool) pruneUnusedStalePersonalContextsLocked() {
	for contextKey := range dp.stalePersonalContext {
		dp.pruneStalePersonalContextLocked(contextKey)
	}
}

// releaseInternal 释放容器核心逻辑。
// Phase 3 复用策略：
//  1. 重启容器以终止所有 exec 后台进程，再清理工作区
//  2. 若空闲池未满 → 清理后回空闲池
//  3. 若空闲池已满 → LRU 淘汰最旧的，当前容器入池
//  4. 唤醒一个排队者，让其按自己的用户和镜像重新获取
func (dp *Pool) releaseInternal(containerID, userID string) {
	dp.mu.Lock()
	owner, known := dp.containerUser[containerID]
	tainted := dp.taintedContainers[containerID]
	dp.mu.Unlock()
	if !known {
		// User deletion and health checks can destroy an active container before
		// the runner's deferred Release executes. Treat that later release as an
		// idempotent no-op so it cannot decrement another container's counters.
		return
	}
	if userID == "" || userID != owner {
		userID = owner
	}
	if tainted {
		slog.Info("Discarding container after interrupted exec", "container_id", containerID[:12])
		dp.DiscardForUser(containerID, userID)
		return
	}
	if dp.isStalePersonalContainer(containerID) {
		slog.Info("Discarding container pinned to a stale personal dependency generation", "container_id", shortContainerID(containerID))
		dp.DiscardForUser(containerID, userID)
		return
	}
	if err := dp.resetContainerForReuse(containerID); err != nil {
		slog.Warn("Discarding container that could not be reset", "container_id", containerID[:12], "error", err)
		dp.DiscardForUser(containerID, userID)
		return
	}
	// Cache mounts stay attached and the reset container can be reused only when
	// image, owner and mount generation all match.
	running, statusErr := dp.containerRunningState(containerID)
	if statusErr != nil {
		slog.Warn("Container state is unknown after reset; discarding without releasing ownership", "container_id", shortContainerID(containerID), "error", statusErr)
		dp.DiscardForUser(containerID, userID)
		return
	}
	if !running {
		slog.Info("Container dead after use, destroying", "container_id", shortContainerID(containerID))
		dp.DiscardForUser(containerID, userID)
		return
	}

	returned, stale, evicted, image, idleCount := dp.returnActiveContainerToIdle(containerID, userID)
	if !returned {
		if stale {
			slog.Info("Discarding container invalidated while it was being reset", "container_id", shortContainerID(containerID))
			dp.DiscardForUser(containerID, userID)
		}
		return
	}
	defer dp.wakeNextQueued()
	if evicted != "" {
		if err := dp.removeQuarantinedContainer(evicted); err != nil {
			slog.Warn("Evicted idle container removal was not confirmed", "container_id", shortContainerID(evicted), "error", err)
		}
	}
	slog.Debug("Container returned to idle pool",
		"container_id", shortContainerID(containerID),
		"image", image,
		"idle_count", idleCount,
	)
}

func (dp *Pool) isStalePersonalContainer(containerID string) bool {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	contextKey := dp.containerContext[containerID]
	return dp.stalePersonalContext[contextKey] || dp.personalContextSupersededLocked(contextKey)
}

// returnActiveContainerToIdle makes the stale-generation check and the
// active-to-idle transition atomic with cache invalidation. This closes both
// orderings: invalidation just before return marks the active context stale;
// invalidation just after return removes it from the idle pool.
func (dp *Pool) returnActiveContainerToIdle(containerID, userID string) (returned, stale bool, evicted, image string, idleCount int) {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	owner, known := dp.containerUser[containerID]
	if !known {
		return false, false, "", "", dp.idleCount
	}
	if userID == "" || userID != owner {
		userID = owner
	}
	if dp.deletedUsers[userID] {
		return false, true, "", "", dp.idleCount
	}
	contextKey := dp.containerContext[containerID]
	if dp.stalePersonalContext[contextKey] || dp.personalContextSupersededLocked(contextKey) {
		return false, true, "", "", dp.idleCount
	}

	image = dp.imageByContainerID[containerID]
	if dp.idlePool == nil {
		dp.idlePool = make(map[string][]string)
	}
	if dp.lruByImage == nil {
		dp.lruByImage = make(map[string]time.Time)
	}
	if len(dp.idlePool[image]) >= dp.maxIdle && len(dp.idlePool[image]) > 0 {
		last := len(dp.idlePool[image]) - 1
		evicted = dp.idlePool[image][last]
		dp.idlePool[image] = dp.idlePool[image][:last]
		dp.quarantinePooledContainerLocked(evicted, "idle")
	}
	dp.idlePool[image] = append([]string{containerID}, dp.idlePool[image]...)
	dp.lruByImage[containerID] = time.Now()
	if dp.activeCount > 0 {
		dp.activeCount--
	}
	dp.idleCount++
	if dp.userActiveContainers[userID] > 1 {
		dp.userActiveContainers[userID]--
	} else {
		delete(dp.userActiveContainers, userID)
	}
	return true, false, evicted, image, dp.idleCount
}

// wakeNextQueued only signals a waiter to retry acquisition. It deliberately
// never hands over a running container: its image and /persist bind mount are
// immutable and belong to the releasing user.
func (dp *Pool) wakeNextQueued() {
	if dp.queue == nil {
		return
	}
	if req := dp.queue.DequeueNext(); req != nil {
		select {
		case req.ResultCh <- QueueResult{}:
		default:
		}
	}
}

// ---------- Phase 3: 空闲复用池操作 ----------

// tryIdlePool reuses only an exact owner and cache mount generation match.
func (dp *Pool) tryIdlePool(image, userID, cacheKey string) string {
	for {
		dp.mu.Lock()
		id := dp.takeIdleMatchLocked(image, userID, cacheKey)
		if id == "" {
			dp.mu.Unlock()
			return ""
		}
		dp.mu.Unlock()

		running, statusErr := dp.containerRunningState(id)
		if statusErr != nil {
			// takeIdleMatchLocked removed the candidate from the list. Put an
			// unknown container back without changing counters; it must be neither
			// reused nor detached until Docker can answer authoritatively.
			dp.addToIdlePool(image, id)
			slog.Warn("Idle container state is unknown; keeping it quarantined in the pool", "container_id", shortContainerID(id), "error", statusErr)
			return ""
		}
		if running {
			return id
		}

		dp.mu.Lock()
		dp.quarantinePooledContainerLocked(id, "idle")
		dp.mu.Unlock()
		if err := dp.removeQuarantinedContainer(id); err != nil {
			slog.Warn("Dead idle container removal was not confirmed", "container_id", shortContainerID(id), "error", err)
		} else {
			slog.Warn("Dead idle container removed during acquire", "container_id", shortContainerID(id))
		}
	}
}

func (dp *Pool) takeIdleMatchLocked(image, userID, cacheKey string) string {
	list := dp.idlePool[image]
	for i, id := range list {
		ownerMatches := dp.containerUser[id] == userID || userID == ""
		if !ownerMatches || dp.containerContext[id] != cacheKey {
			continue
		}
		dp.idlePool[image] = append(list[:i], list[i+1:]...)
		if len(dp.idlePool[image]) == 0 {
			delete(dp.idlePool, image)
		}
		delete(dp.lruByImage, id)
		dp.recordContainerContextLocked(id, dp.containerContext[id])
		return id
	}
	return ""
}

// addToIdlePool 将容器加入空闲复用池头部（最近使用）
func (dp *Pool) addToIdlePool(image, containerID string) {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	dp.idlePool[image] = append([]string{containerID}, dp.idlePool[image]...)
	dp.lruByImage[containerID] = time.Now()
	dp.imageByContainerID[containerID] = image
}

// evictLRU 淘汰指定镜像最久未使用的空闲容器
func (dp *Pool) evictLRU(image string) string {
	dp.mu.Lock()
	defer dp.mu.Unlock()

	list := dp.idlePool[image]
	if len(list) == 0 {
		return ""
	}
	// 取尾部（最久未用）
	lastIdx := len(list) - 1
	evicted := list[lastIdx]
	dp.idlePool[image] = list[:lastIdx]
	dp.quarantinePooledContainerLocked(evicted, "idle")
	return evicted
}

// A managed container runs only tail -f /dev/null, optionally under Docker's
// --init process. verified reset avoids a restart only when docker top proves
// that exact baseline is still the complete process set.
func containerRestartArguments(containerID string) []string {
	return []string{"restart", "-t", "0", containerID}
}

func (dp *Pool) resetContainerForReuse(containerID string) error {
	strategy := dp.containerResetStrategy()
	if strategy == ResetStrategyVerified {
		verifyStarted := time.Now()
		baselineOnly, verifyErr := dp.hasOnlyManagedBaselineProcesses(containerID)
		if dp.metrics != nil {
			dp.metrics.Observe("container.recycle.verify", time.Since(verifyStarted))
		}
		if verifyErr == nil && baselineOnly {
			if cleanErr := dp.cleanWorkspaceObserved(containerID); cleanErr == nil {
				return nil
			} else {
				slog.Warn("Verified container workspace cleanup failed; falling back to restart", "container_id", shortContainerID(containerID), "error", cleanErr)
			}
		} else if verifyErr != nil {
			slog.Warn("Container process verification failed; falling back to restart", "container_id", shortContainerID(containerID), "error", verifyErr)
		} else {
			slog.Info("Container has non-baseline processes; falling back to restart", "container_id", shortContainerID(containerID))
		}
	}

	restartStarted := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	output, restartErr := dp.executeDockerCommand(ctx, containerRestartArguments(containerID)...)
	if dp.metrics != nil {
		dp.metrics.Observe("container.recycle.restart", time.Since(restartStarted))
	}
	if restartErr != nil {
		return fmt.Errorf("restart container: %w: %s", restartErr, strings.TrimSpace(string(output)))
	}
	return dp.cleanWorkspaceObserved(containerID)
}

func (dp *Pool) containerResetStrategy() string {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	if dp.resetStrategy == ResetStrategyRestart {
		return ResetStrategyRestart
	}
	return ResetStrategyVerified
}

func (dp *Pool) hasOnlyManagedBaselineProcesses(containerID string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := dp.executeDockerCommand(ctx, "top", containerID, "-eo", "pid,ppid,comm,args")
	if err != nil {
		return false, fmt.Errorf("docker top: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return parseManagedBaselineProcesses(output)
}

func parseManagedBaselineProcesses(output []byte) (bool, error) {
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) < 2 {
		return false, fmt.Errorf("docker top returned no process rows")
	}
	header := strings.Fields(lines[0])
	if len(header) < 4 || !strings.EqualFold(header[0], "PID") || !strings.EqualFold(header[1], "PPID") {
		return false, fmt.Errorf("docker top returned an unexpected header")
	}

	initCount := 0
	tailCount := 0
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			return false, fmt.Errorf("docker top returned a malformed process row")
		}
		command := filepath.Base(fields[2])
		args := fields[3:]
		switch command {
		case "docker-init":
			if !managedInitArguments(args) {
				return false, nil
			}
			initCount++
		case "tail":
			if !managedTailArguments(args) {
				return false, nil
			}
			tailCount++
		default:
			return false, nil
		}
	}
	return tailCount == 1 && initCount <= 1 && initCount+tailCount == len(lines)-1, nil
}

func managedTailArguments(args []string) bool {
	return len(args) == 3 && filepath.Base(args[0]) == "tail" && args[1] == "-f" && args[2] == "/dev/null"
}

func managedInitArguments(args []string) bool {
	if len(args) < 5 || filepath.Base(args[0]) != "docker-init" {
		return false
	}
	separator := -1
	for index, arg := range args {
		if arg == "--" {
			separator = index
			break
		}
	}
	return separator >= 0 && managedTailArguments(args[separator+1:])
}

func (dp *Pool) cleanWorkspaceObserved(containerID string) error {
	started := time.Now()
	err := dp.cleanWorkspace(containerID)
	if dp.metrics != nil {
		dp.metrics.Observe("container.recycle.workspace", time.Since(started))
	}
	return err
}

func (dp *Pool) cleanWorkspace(containerID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cleanupCommand := "rm -rf /workspace; mkdir -p /workspace"
	if dp.readOnlyRootfs {
		// These paths are independent tmpfs mounts in read-only-rootfs mode.
		// Restarting the container clears them; the verified fast path must
		// provide the same isolation without trying to remove mount points.
		cleanupCommand = "rm -rf -- /workspace/* /workspace/.[!.]* /workspace/..?* /tmp/* /tmp/.[!.]* /tmp/..?* /home/* /home/.[!.]* /home/..?*; mkdir -p /workspace /tmp /home; chmod 1777 /tmp"
	}
	output, err := dp.executeDockerCommand(ctx, "exec", "-w", "/", containerID, "sh", "-c", cleanupCommand)
	if err != nil {
		return fmt.Errorf("workspace reset: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// getContainerImage 获取容器对应的镜像
func (dp *Pool) getContainerImage(containerID string) string {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	if img, ok := dp.imageByContainerID[containerID]; ok {
		return img
	}
	return ""
}

// getContainerUser 获取容器对应的用户
func (dp *Pool) getContainerUser(containerID string) string {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	if u, ok := dp.containerUser[containerID]; ok {
		return u
	}
	return ""
}

// ---------- Phase 3: 镜像预热 ----------

// preWarmImage 同步拉取镜像并预热容器到热池。
// 由 PreWarm（单镜像异步）或 PreWarmAll（串行异步）调用。
func (dp *Pool) preWarmImage(image, userID string) {
	slog.Info("Pre-warming image", "image", image, "user", userID)
	if !dp.hasLocalImage(image) {
		ctx, cancel := context.WithTimeout(context.Background(), dp.pullTimeout)
		defer cancel()
		if err := dp.pullImage(ctx, image, nil); err != nil {
			slog.Warn("Pre-warm pull failed", "image", image, "error", err)
			return
		}
		dp.markImageLocal(image)
	}
	dp.replenishHotPool(image, userID)
	slog.Info("Pre-warm complete", "image", image, "user", userID)
}

// PreWarm 异步拉取单个镜像并预热容器到该用户的热池
func (dp *Pool) PreWarm(image, userID string) {
	go dp.preWarmImage(image, userID)
}

// PreWarmAllForUsers 在后台为指定用户列表串行预热所有镜像。
// 串行而非并发：让每个镜像拿满带宽，总时间通常更短；且用户触发 runCode 时
// 在线拉取只需与"当前这一个"预热镜像竞争带宽，而非全部。
// 按用户隔离预热：每个用户的热池容器挂载各自的 /persist 持久化卷。
func (dp *Pool) PreWarmAllForUsers(images []string, userIDs []string) {
	go func() {
		slog.Info("Pre-warming all images for users (sequential)", "images", len(images), "users", len(userIDs))
		for _, uid := range userIDs {
			for _, img := range images {
				dp.preWarmImage(img, uid)
			}
		}
	}()
}

var projectLockSharedCacheDirectories = []string{"pip-cache", "go-cache", "npm-cache"}

// buildUserVolumes builds the persistent mounts shared by one user. In
// project-lock mode the managed project-dependencies tree is deliberately not
// reachable through /persist; only download/build caches are shared, while the
// exact dependency namespace is mounted separately as /project-deps.
func (dp *Pool) buildUserVolumes(userID, image string) map[string]string {
	if userID == "" || dp.userDataDir == "" {
		return nil
	}
	persistHost := filepath.Join(dp.userDataDir, userID, "persist")
	if dp.personalDependencyScope != "project-lock" {
		return map[string]string{persistHost: "/persist"}
	}
	volumes := make(map[string]string, len(projectLockSharedCacheDirectories))
	for _, directory := range projectLockSharedCacheDirectories {
		volumes[filepath.Join(persistHost, directory)] = "/persist/" + directory
	}
	return volumes
}

const (
	pythonPersistPackagesRoot = "/persist/pip-packages"
	pythonPersistRuntimesRoot = pythonPersistPackagesRoot + "/runtimes"
)

// pythonRuntimePackageTarget derives a stable package namespace from supported
// Python image tags. Only decimal major/minor components are accepted, so an
// arbitrary image value can never affect a container path or shell command.
func pythonRuntimePackageTarget(image string) string {
	name := strings.ToLower(strings.TrimSpace(image))
	if slash := strings.LastIndexByte(name, '/'); slash >= 0 {
		name = name[slash+1:]
	}
	if !strings.HasPrefix(name, "python:") {
		return ""
	}

	tag := strings.TrimPrefix(name, "python:")
	if dash := strings.IndexByte(tag, '-'); dash >= 0 {
		tag = tag[:dash]
	}
	parts := strings.Split(tag, ".")
	if len(parts) < 2 || !decimalComponent(parts[0]) || !decimalComponent(parts[1]) {
		return ""
	}
	return pythonPersistRuntimesRoot + "/python-" + parts[0] + "." + parts[1]
}

func decimalComponent(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

// pythonExecutionPath picks a scoped package directory if it already exists.
// A legacy flat tree remains compatible only until that runtime has a scoped
// directory; it is never appended to a scoped PYTHONPATH.
func (dp *Pool) pythonExecutionPath(userID, target string) string {
	if target == "" || userID == "" || dp.userDataDir == "" {
		return target
	}

	persistRoot := filepath.Join(dp.userDataDir, userID, "persist")
	runtimeDir := filepath.Join(persistRoot, "pip-packages", "runtimes", filepath.Base(target))
	if info, err := os.Stat(runtimeDir); err == nil && info.IsDir() {
		return target
	}
	legacyDir := filepath.Join(persistRoot, "pip-packages")
	if info, err := os.Stat(legacyDir); err == nil && info.IsDir() {
		return pythonPersistPackagesRoot
	}
	return target
}

// memoryLimitForImage returns the Docker memory limit for a given image,
// overriding the default when the language is known to need more RAM.
// Rust (cargo build) and Java (Maven) easily exceed 512MB on real projects.
func memoryLimitForImage(image, defaultLimit string) string {
	switch {
	case strings.HasPrefix(image, "rust:"):
		return "1g"
	case strings.HasPrefix(image, "openjdk:"):
		// Only bump if the configured default is 512m or less
		if defaultLimit == "" || defaultLimit == "512m" || defaultLimit == "256m" {
			return "1g"
		}
		return defaultLimit
	default:
		return defaultLimit
	}
}

// buildPersistEnv keeps the no-user call path for callers that do not mount a
// user persist volume. User-scoped containers use buildPersistEnvForUser.
func (dp *Pool) buildPersistEnv(image string) map[string]string {
	return dp.buildPersistEnvForUser("", image)
}

// buildPersistEnvForUser constructs package-manager environment variables for
// one container. Python installations go into a major/minor runtime namespace.
func (dp *Pool) buildPersistEnvForUser(userID, image string) map[string]string {
	if dp.personalDependencyScope == "project-lock" {
		return map[string]string{
			"PIP_CACHE_DIR":    "/persist/pip-cache",
			"GOCACHE":          "/persist/go-cache",
			"NPM_CONFIG_CACHE": "/persist/npm-cache",
		}
	}
	env := map[string]string{
		// Python: cache plus legacy defaults for non-Python images.
		"PIP_CACHE_DIR": "/persist/pip-cache",
		"PIP_TARGET":    pythonPersistPackagesRoot,
		"PYTHONPATH":    pythonPersistPackagesRoot + ":" + os.Getenv("PYTHONPATH"),
		// Go: 模块缓存 + 构建缓存
		"GOPATH":     "/persist/go",
		"GOMODCACHE": "/persist/go/pkg/mod",
		"GOCACHE":    "/persist/go-cache",
		// Rust: cargo 家目录
		"CARGO_HOME": "/persist/cargo",
		// Java: Maven 本地仓库
		"MAVEN_OPTS":       "-Dmaven.repo.local=/persist/maven",
		"GRADLE_USER_HOME": "/persist/gradle",
		// Node.js: npm 全局安装前缀 + 下载缓存 + 模块搜索路径
		"NPM_CONFIG_PREFIX": "/persist/npm-global",
		"NPM_CONFIG_CACHE":  "/persist/npm-cache",
		"NODE_PATH":         "/persist/npm-global/lib/node_modules",
	}
	if target := pythonRuntimePackageTarget(image); target != "" {
		env["PIP_TARGET"] = target
		// Python containers must not inherit a host PYTHONPATH compiled for a
		// different runtime image or ABI.
		env["PYTHONPATH"] = dp.pythonExecutionPath(userID, target)
	} else if env["PYTHONPATH"] == ":" || env["PYTHONPATH"] == pythonPersistPackagesRoot+":" {
		env["PYTHONPATH"] = pythonPersistPackagesRoot
	}

	return env
}

// ---------- 用户配额追踪 ----------

func (dp *Pool) incUserActive(userID string) {
	if userID == "" {
		return
	}
	dp.mu.Lock()
	dp.userActiveContainers[userID]++
	dp.mu.Unlock()
}

func (dp *Pool) decUser(userID string) {
	if userID == "" {
		return
	}
	dp.mu.Lock()
	if dp.userActiveContainers[userID] > 0 {
		dp.userActiveContainers[userID]--
	}
	dp.mu.Unlock()
}

// ---------- 队列统计 ----------

// QueueStats 返回排队统计信息
func (dp *Pool) QueueStats() map[string]interface{} {
	if dp.queue == nil {
		return map[string]interface{}{"enabled": false}
	}
	queued, timeout, currentLen := dp.queue.Stats()
	return map[string]interface{}{
		"enabled":        true,
		"current_length": currentLen,
		"total_queued":   queued,
		"total_timeout":  timeout,
	}
}

// ---------- 热池操作 ----------

func (dp *Pool) tryHotPool(image, userID string) string {
	dp.mu.Lock()
	ch, ok := dp.hotPool[hotPoolKey{image: image, userID: userID}]
	if !ok {
		dp.mu.Unlock()
		return ""
	}
	dp.mu.Unlock()

	select {
	case containerID := <-ch:
		dp.mu.Lock()
		delete(dp.lruByImage, containerID)
		dp.mu.Unlock()
		running, statusErr := dp.containerRunningState(containerID)
		if statusErr != nil {
			requeued := false
			select {
			case ch <- containerID:
				requeued = true
			default:
			}
			if !requeued {
				// A replenisher may fill the channel while inspect is in flight.
				// This ID is no longer reachable through the hot pool, so retain
				// its accounting until Docker confirms that it cannot write.
				slog.Warn("Hot-pool quarantine is full; destroying unknown container before detaching it", "container_id", shortContainerID(containerID), "error", statusErr)
				dp.DiscardForUser(containerID, userID)
				return ""
			}
			slog.Warn("Hot-pool container state is unknown; keeping it quarantined", "container_id", shortContainerID(containerID), "error", statusErr)
			return ""
		}
		if running {
			return containerID
		}
		// 容器已死：完整清理映射并扣减 activeCount。
		// 热池容器在 replenishHotPool 创建时已计入 activeCount，此处必须 decActive，
		// 否则 activeCount 会持续偏高（计入已销毁容器），最终误判为满。
		dp.mu.Lock()
		dp.quarantinePooledContainerLocked(containerID, "hot")
		dp.mu.Unlock()
		if err := dp.removeQuarantinedContainer(containerID); err != nil {
			slog.Warn("Dead hot-pool container removal was not confirmed", "container_id", shortContainerID(containerID), "error", err)
		}
		slog.Warn("Dead hot-pool container removed during acquire", "container_id", containerID[:12])
		return ""
	default:
		return ""
	}
}

// tryEvictHotPoolLocked 从热池通道中非阻塞地取一个空闲预创建容器 ID，用于在容量满时
// 腾出槽位给在线按需创建。调用方必须持有 dp.mu。
//
// 优先淘汰 nonOwnerID 之外用户的容器（避免抢夺请求者自己的热池）；若没有，则淘汰任意
// （含 nonOwnerID 自己的其它镜像容器--请求者未命中本镜像热池时仍可让出自己别的镜像）。
// 仅从通道取出并返回 ID + 归属用户，不销毁、不改 activeCount、不清理映射（由调用方处理）。
func (dp *Pool) tryEvictHotPoolLocked(nonOwnerID string) (string, string) {
	// 第一轮：优先其它用户
	for key, ch := range dp.hotPool {
		if key.userID == nonOwnerID {
			continue
		}
		select {
		case id := <-ch:
			return id, key.userID
		default:
		}
	}
	// 第二轮：任意用户（含自己其它镜像）
	for key, ch := range dp.hotPool {
		select {
		case id := <-ch:
			return id, key.userID
		default:
		}
	}
	return "", ""
}

// tryEvictIdlePoolLocked removes the least-recently-used idle container from
// its image list. The caller owns accounting, mapping cleanup and Docker I/O.
func (dp *Pool) tryEvictIdlePoolLocked(nonOwnerID string) (string, string) {
	for pass := 0; pass < 2; pass++ {
		var selectedID, selectedImage, selectedUser string
		var selectedAt time.Time
		for image, ids := range dp.idlePool {
			for _, id := range ids {
				owner := dp.containerUser[id]
				if pass == 0 && owner == nonOwnerID {
					continue
				}
				usedAt := dp.lruByImage[id]
				if selectedID == "" || usedAt.Before(selectedAt) {
					selectedID, selectedImage, selectedUser, selectedAt = id, image, owner, usedAt
				}
			}
		}
		if selectedID == "" {
			continue
		}
		ids := dp.idlePool[selectedImage]
		for i, id := range ids {
			if id == selectedID {
				dp.idlePool[selectedImage] = append(ids[:i], ids[i+1:]...)
				break
			}
		}
		if len(dp.idlePool[selectedImage]) == 0 {
			delete(dp.idlePool, selectedImage)
		}
		return selectedID, selectedUser
	}
	return "", ""
}

func (dp *Pool) replenishHotPool(image, userID string) {
	key := hotPoolKey{image: image, userID: userID}
	dp.mu.Lock()
	if dp.closed || dp.deletedUsers[userID] {
		dp.mu.Unlock()
		return
	}
	ch, ok := dp.hotPool[key]
	if !ok {
		ch = make(chan string, dp.poolSize)
		dp.hotPool[key] = ch
	}
	if dp.userBackgroundCreates == nil {
		dp.userBackgroundCreates = make(map[string]int)
	}
	dp.userBackgroundCreates[userID]++
	dp.mu.Unlock()

	go func() {
		defer func() {
			dp.mu.Lock()
			if dp.userBackgroundCreates[userID] > 1 {
				dp.userBackgroundCreates[userID]--
			} else {
				delete(dp.userBackgroundCreates, userID)
			}
			dp.mu.Unlock()
		}()
		for {
			dp.mu.Lock()
			currentSize := len(ch)
			dp.mu.Unlock()

			if currentSize >= dp.poolSize {
				return
			}

			dp.mu.Lock()
			if dp.closed || dp.deletedUsers[userID] || dp.totalContainersLocked() >= dp.maxTotal {
				dp.mu.Unlock()
				return
			}
			dp.activeCount++
			dp.mu.Unlock()

			if !dp.hasLocalImage(image) {
				ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
				if err := dp.pullImage(ctx, image, nil); err != nil {
					cancel()
					dp.decActive()
					return
				}
				cancel()
				dp.markImageLocal(image)
			}

			// 热池容器按目标用户挂载持久化卷 + 注入持久化环境变量，
			// 使 L1 命中时与 L3/L4 新建容器具备一致的 /persist 持久化能力。
			extraVolumes := dp.buildUserVolumes(userID, image)
			extraEnv := dp.buildPersistEnvForUser(userID, image)

			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			containerID, err := dp.createContainer(ctx, image, extraVolumes, extraEnv)
			cancel()
			if err != nil {
				if containerID == "" {
					dp.decActive()
				} else {
					dp.mu.Lock()
					dp.containerUser[containerID] = userID
					dp.imageByContainerID[containerID] = image
					dp.mu.Unlock()
					dp.DiscardForUser(containerID, userID)
				}
				return
			}

			dp.mu.Lock()
			if dp.closed || dp.deletedUsers[userID] || dp.hotPool[key] != ch {
				// Track the just-created container before attempting removal. If
				// Docker is temporarily unavailable, the background-creation count
				// and ownership remain until Discard confirms absence.
				dp.containerUser[containerID] = userID
				dp.imageByContainerID[containerID] = image
				dp.mu.Unlock()
				dp.DiscardForUser(containerID, userID)
				return
			}
			// 记录容器归属用户，供 healthCheckLoop 死容器补池时定位正确的用户热池
			dp.containerUser[containerID] = userID
			select {
			case ch <- containerID:
				dp.lruByImage[containerID] = time.Now()
				dp.imageByContainerID[containerID] = image
			default:
				dp.mu.Unlock()
				dp.DiscardForUser(containerID, userID)
				return
			}
			dp.mu.Unlock()
		}
	}()
}

// ---------- 镜像管理 ----------

func (dp *Pool) hasLocalImage(image string) bool {
	dp.mu.Lock()
	if local, ok := dp.imageLocal[image]; ok && local {
		dp.mu.Unlock()
		return true
	}
	dp.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "image", "inspect", image)
	if err := cmd.Run(); err == nil {
		dp.markImageLocal(image)
		return true
	}
	return false
}

func (dp *Pool) markImageLocal(image string) {
	dp.mu.Lock()
	dp.imageLocal[image] = true
	dp.mu.Unlock()
}

// errPullTimeout 标记拉取超时（带宽不足/镜像过大）。
// pullImage 据此跳过同一 mirror 的其他候选形式，避免逐个等满超时。
var errPullTimeout = errors.New("pull timed out")

func (dp *Pool) pullImage(ctx context.Context, image string, output session.OutputWriter) error {
	// 构建候选拉取列表（按 mirror 分组）：
	//   1. 各 registry mirror 前缀（先试现代代理形式 <mirror>/<image>，
	//      再兜底旧式命名空间形式 <mirror>/library/<image>）
	//   2. 原始镜像名（最后兜底，依赖 Docker daemon 自身的 registry-mirrors 配置）
	//
	// 注意：阿里云个人加速器（<id>.mirror.aliyuncs.com）、daocloud、dockerproxy 等
	// 都是"代理型"镜像加速器，直接代理 Docker Hub，使用 <mirror>/<image> 即可，
	// 不能加 /library/ 前缀（加了反而 404）。
	// 而 registry.cn-hangzhou.aliyuncs.com 是阿里云容器镜像服务（ACR），
	// 并非 Docker Hub 镜像加速器，其 library/ 命名空间下没有官方镜像，
	// 配成 mirror 必然 pull access denied —— 旧代码正是因此失败。
	type candidate struct {
		ref      string
		mirrorID int // 同一 mirror 的候选共享一个 id，-1 表示原始名
	}
	var candidates []candidate
	for mi, mirror := range dp.registryMirrors {
		// 去掉协议前缀（https:// 或 http://），Docker 镜像名不能含协议
		m := strings.TrimPrefix(mirror, "https://")
		m = strings.TrimPrefix(m, "http://")
		m = strings.TrimRight(m, "/")
		if m == "" {
			continue
		}
		// 现代代理型加速器：直接 <mirror>/<image>
		candidates = append(candidates, candidate{ref: m + "/" + image, mirrorID: mi})
		// 旧式命名空间镜像仓库需要 /library/ 前缀，仅对官方镜像（无 /）追加兜底
		if !strings.Contains(image, "/") {
			candidates = append(candidates, candidate{ref: m + "/library/" + image, mirrorID: mi})
		}
	}
	// 最后兜底：原始镜像名（让 daemon 自身的 registry-mirrors 生效）
	candidates = append(candidates, candidate{ref: image, mirrorID: -1})
	if len(candidates) == 0 {
		candidates = []candidate{{ref: image, mirrorID: -1}}
	}

	var lastErr error
	attempted := 0
	for i := 0; i < len(candidates); i++ {
		c := candidates[i]
		if i > 0 && output != nil {
			output.WriteStatus("docker:pull", fmt.Sprintf("Retrying from mirror: %s", c.ref))
		}

		pullCtx, cancel := context.WithTimeout(ctx, dp.pullTimeout)
		err := dp.doPull(pullCtx, c.ref, image, output)
		cancel()
		attempted++
		if err == nil {
			return nil
		}
		lastErr = err
		slog.Warn("Docker pull failed, trying next candidate", "candidate", c.ref, "error", err)

		// 超时（带宽不足/镜像太大）时，同一 mirror 的其他候选形式一样慢，
		// 跳过该 mirror 剩余候选，直接换下一个 mirror 或原始名，
		// 避免逐个等满超时把单次拉取拖成 N × timeout。
		if errors.Is(err, errPullTimeout) {
			for i+1 < len(candidates) && candidates[i+1].mirrorID == c.mirrorID {
				i++
			}
		}
	}

	return fmt.Errorf("all pull attempts failed (tried %d sources): %w", attempted, lastErr)
}

// doPull 执行 docker pull 并可选地 tag 回原始镜像名
func (dp *Pool) doPull(ctx context.Context, pullName, originalName string, output session.OutputWriter) error {
	cmd := exec.CommandContext(ctx, "docker", "pull", pullName)

	if output != nil {
		stdout, _ := cmd.StdoutPipe()
		stderr, _ := cmd.StderrPipe()

		if err := cmd.Start(); err != nil {
			return fmt.Errorf("pull start failed: %w", err)
		}

		done := make(chan error, 1)
		go func() {
			done <- cmd.Wait()
		}()

		// 读取输出
		go func() {
			buf := make([]byte, 4096)
			for {
				n, err := stdout.Read(buf)
				if n > 0 {
					output.WriteStatus("docker:pull", strings.TrimSpace(string(buf[:n])))
				}
				if err != nil {
					break
				}
			}
		}()
		go func() {
			buf := make([]byte, 4096)
			for {
				n, err := stderr.Read(buf)
				if n > 0 {
					output.WriteStatus("docker:pull", strings.TrimSpace(string(buf[:n])))
				}
				if err != nil {
					break
				}
			}
		}()

		select {
		case err := <-done:
			if err != nil {
				// 进程被杀且 ctx 已超时 → 判定为拉取超时
				if ctx.Err() != nil {
					return fmt.Errorf("pull timed out after %v: %w", dp.pullTimeout, errPullTimeout)
				}
				return err
			}
		case <-ctx.Done():
			return fmt.Errorf("pull timed out after %v: %w", dp.pullTimeout, errPullTimeout)
		}
	} else {
		// 非流式路径（如 terminal）：捕获 stderr 以便诊断拉取失败原因
		var stderrBuf strings.Builder
		cmd.Stderr = &stderrBuf
		if err := cmd.Run(); err != nil {
			if ctx.Err() != nil {
				return fmt.Errorf("pull timed out after %v: %w", dp.pullTimeout, errPullTimeout)
			}
			stderrOut := strings.TrimSpace(stderrBuf.String())
			if stderrOut != "" {
				return fmt.Errorf("pull failed: %s", stderrOut)
			}
			return fmt.Errorf("pull failed: %w", err)
		}
	}

	// 如果是从镜像拉取的，tag 回原始名（方便后续 docker create 使用）
	if pullName != originalName {
		tagCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		tagCmd := exec.CommandContext(tagCtx, "docker", "tag", pullName, originalName)
		if out, err := tagCmd.CombinedOutput(); err != nil {
			slog.Warn("Failed to tag mirrored image", "from", pullName, "to", originalName, "error", string(out))
			// tag 失败不致命——后续 docker create 可能需要用 mirror 名
		}
	}

	return nil
}

// ---------- 容器生命周期 ----------

func (dp *Pool) createContainer(ctx context.Context, image string, extraVolumes map[string]string, extraEnv map[string]string) (string, error) {
	networkFlag := "--network=bridge"
	if !dp.sec.AllowNetwork(image) {
		networkFlag = "--network=none"
	}

	memLimit := dp.memLimit
	if memLimit == "" {
		memLimit = "512m"
	}
	// 编译型语言（Rust/Java）内存消耗大，按镜像覆写为更高限制
	// 防止 cargo build / mvn compile 被 OOM kill（退出码 137）
	memLimit = memoryLimitForImage(image, memLimit)
	cpuLimit := dp.cpuLimit
	if cpuLimit == "" {
		cpuLimit = "1.0"
	}

	args := []string{
		"create",
		"--label", "bobocloud.managed=true", // 标记为本服务管理的容器，便于启动时清理孤儿
		networkFlag,
		"-w", "/workspace",
		"-m", memLimit,
		"--cpus", cpuLimit,
	}

	// ── 安全加固（G1）──
	// 这些 flag 对所有运行时（C/C++/Python/Java/Go/Rust）都是安全的：
	// 编译/运行普通代码不需要任何 Linux capability，也不需要提权。
	if dp.hardening {
		args = append(args,
			"--cap-drop=ALL",                   // 丢弃所有 Linux capabilities —— 最重要的逃逸防线
			"--security-opt=no-new-privileges", // 禁止 setuid/setgid 提权
			"--pids-limit", "256",              // 限制进程数，防 fork 炸弹
			"--init",                  // 用 tini 回收僵尸进程
			"--memory-swap", memLimit, // 限制 swap（=memory 则无额外 swap）
		)
		// seccomp：Docker 默认已启用 seccomp profile（未传 seccomp=unconfined 即默认开启），
		// 已封锁 ~44 个危险 syscall（mount/keyctl/...），无需额外配置。
	}

	// 只读根文件系统：把可写需求转移到 tmpfs。
	// 缓存目录由 buildPersistEnv 重定向到 /persist（可写卷），
	// 这里再为无 /persist 的场景（如热池容器）以及 /tmp /home 提供可写 tmpfs。
	if dp.readOnlyRootfs {
		args = append(args,
			"--read-only",
			"--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
			"--tmpfs", "/workspace:rw,nosuid,nodev,size=256m",
			"--tmpfs", "/home:rw,nosuid,nodev,size=128m",
		)
	}

	// 环境变量：只读根文件系统下，为各语言缓存目录提供可写默认值。
	// 若 buildPersistEnv 已为该 key 设置 /persist 值（extraEnv），则不覆盖。
	if dp.readOnlyRootfs {
		baseEnv := map[string]string{
			"HOME":          "/home",
			"TMPDIR":        "/tmp",
			"GOCACHE":       "/tmp/go-build",
			"GOPATH":        "/tmp/gopath",
			"CARGO_HOME":    "/tmp/cargo",
			"PIP_CACHE_DIR": "/tmp/pip-cache",
		}
		for k, v := range baseEnv {
			if _, exists := extraEnv[k]; !exists {
				args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
			}
		}
	}
	// 环境变量：将各语言包管理器重定向到 /persist
	for k, v := range extraEnv {
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
	}

	// 持久化卷挂载
	for hostPath, containerPath := range extraVolumes {
		if err := ensureDockerBindDirectory(hostPath); err != nil {
			return "", fmt.Errorf("prepare persistent mount %q: %w", hostPath, err)
		}
		args = append(args, "-v", fmt.Sprintf("%s:%s", hostPath, containerPath))
	}

	args = append(args, image, "tail", "-f", "/dev/null")

	cmd := exec.CommandContext(ctx, "docker", args...)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("docker create failed: %s", string(exitErr.Stderr))
		}
		return "", fmt.Errorf("docker create failed: %w", err)
	}

	containerID := strings.TrimSpace(string(out))

	startCmd := exec.CommandContext(ctx, "docker", "start", containerID)
	if err := startCmd.Run(); err != nil {
		return containerID, fmt.Errorf("docker start failed: %w", err)
	}

	// Ensure /workspace exists before any later exec selects it as a working
	// directory. The image itself may declare /workspace as WorkingDir while the
	// directory is absent, so this bootstrap command must run from / explicitly.
	mkdirCtx, mkdirCancel := context.WithTimeout(ctx, 10*time.Second)
	defer mkdirCancel()
	mkdirCmd := exec.CommandContext(mkdirCtx, "docker", containerWorkspaceBootstrapArguments(containerID)...)
	if output, err := mkdirCmd.CombinedOutput(); err != nil {
		return containerID, fmt.Errorf("docker workspace initialization failed: %s", strings.TrimSpace(string(output)))
	}

	return containerID, nil
}

func ensureDockerBindDirectory(path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("host path is empty")
	}
	if err := os.MkdirAll(path, 0755); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("host path must be a real directory")
	}
	return nil
}

// containerWorkspaceBootstrapArguments intentionally chooses / rather than
// inheriting the container WorkingDir. The workspace can be absent in a fresh
// image, and the terminal reset path deliberately removes it before recreating
// a clean snapshot.
func containerWorkspaceBootstrapArguments(containerID string) []string {
	return []string{"exec", "-w", "/", containerID, "mkdir", "-p", "/workspace"}
}

func (dp *Pool) containerRunningState(containerID string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := dp.executeDockerCommand(ctx, "inspect", "-f", "{{.State.Running}}", containerID)
	if err != nil {
		if dockerReportsMissingContainer(out) {
			return false, nil
		}
		return false, fmt.Errorf("inspect container %s: %w: %s", shortContainerID(containerID), err, strings.TrimSpace(string(out)))
	}
	switch strings.TrimSpace(string(out)) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("inspect container %s returned an invalid running state", shortContainerID(containerID))
	}
}

func shortContainerID(containerID string) string {
	if len(containerID) <= 12 {
		return containerID
	}
	return containerID[:12]
}

func (dp *Pool) executeDockerCommand(ctx context.Context, args ...string) ([]byte, error) {
	if dp != nil && dp.runDockerCommand != nil {
		return dp.runDockerCommand(ctx, args...)
	}
	return exec.CommandContext(ctx, "docker", args...).CombinedOutput()
}

func dockerReportsMissingContainer(output []byte) bool {
	message := strings.ToLower(string(output))
	return strings.Contains(message, "no such container") || strings.Contains(message, "no such object")
}

func (dp *Pool) destroyContainer(containerID string) error {
	if containerID == "" {
		return nil
	}
	// `docker rm -f` already kills the container. Running `docker stop` first
	// used to consume the entire shared timeout, leaving the subsequent rm with
	// an already-cancelled context while callers still assumed cleanup succeeded.
	removeCtx, cancelRemove := context.WithTimeout(context.Background(), 10*time.Second)
	output, err := dp.executeDockerCommand(removeCtx, "rm", "-f", containerID)
	cancelRemove()
	if err == nil || dockerReportsMissingContainer(output) {
		slog.Info("Container destroyed", "container_id", shortContainerID(containerID))
		return nil
	}

	// Only confirmed absence is equivalent to a successful removal. A stopped
	// container still retains its bind mounts and could be restarted after the
	// cache path is deleted or recreated, so it must retain ownership and retry.
	inspectCtx, cancelInspect := context.WithTimeout(context.Background(), 5*time.Second)
	state, inspectErr := dp.executeDockerCommand(inspectCtx, "inspect", "-f", "{{.State.Running}}", containerID)
	cancelInspect()
	if inspectErr != nil && dockerReportsMissingContainer(state) {
		slog.Warn("Container removal returned an error but absence was confirmed", "container_id", shortContainerID(containerID), "error", err)
		return nil
	}
	return fmt.Errorf("force-remove container %s: %w: %s (inspect: %v: %s)", shortContainerID(containerID), err, strings.TrimSpace(string(output)), inspectErr, strings.TrimSpace(string(state)))
}

// Exec 在容器内执行命令并返回结果
func (dp *Pool) Exec(ctx context.Context, containerID string, cmd []string, workDir string) (stdout, stderr string, exitCode int, err error) {
	args := []string{"exec"}
	if workDir != "" {
		args = append(args, "-w", workDir)
	}
	args = append(args, containerID)
	args = append(args, cmd...)

	execCmd := exec.CommandContext(ctx, "docker", args...)
	stdoutBuf := newCappedBuffer(4 << 20)
	stderrBuf := newCappedBuffer(4 << 20)
	execCmd.Stdout = stdoutBuf
	execCmd.Stderr = stderrBuf

	err = execCmd.Run()
	if ctx.Err() != nil {
		dp.markContainerTainted(containerID)
	}
	stdout = stdoutBuf.String()
	stderr = stderrBuf.String()

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
			err = nil
		}
	} else {
		exitCode = 0
	}

	return stdout, stderr, exitCode, err
}

type cappedBuffer struct {
	buf       strings.Builder
	remaining int
	truncated bool
}

func newCappedBuffer(limit int) *cappedBuffer {
	return &cappedBuffer{remaining: limit}
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	originalLen := len(p)
	if len(p) > b.remaining {
		p = p[:b.remaining]
		b.truncated = true
	}
	if len(p) > 0 {
		_, _ = b.buf.Write(p)
		b.remaining -= len(p)
	}
	return originalLen, nil
}

func (b *cappedBuffer) String() string {
	value := b.buf.String()
	if b.truncated {
		value += "\n[bobocloud] Output truncated at 4 MB.\n"
	}
	return value
}

// ExecStreaming 在容器内流式执行命令
func (dp *Pool) ExecStreaming(ctx context.Context, containerID string, cmd []string, workDir string, output session.OutputWriter, stage string) *model.RunResult {
	result := dockerStreamProcess(ctx, containerID, cmd, workDir, output, stage, nil, nil, dp.outputRetainedBytes)
	if ctx.Err() != nil {
		dp.markContainerTainted(containerID)
	}
	return result
}

// ExecStreamingEnv 在容器内流式执行命令，并注入额外的环境变量（docker exec -e K=V）
func (dp *Pool) ExecStreamingEnv(ctx context.Context, containerID string, cmd []string, workDir string, output session.OutputWriter, stage string, env map[string]string, stdin io.Reader) *model.RunResult {
	result := dockerStreamProcess(ctx, containerID, cmd, workDir, output, stage, env, stdin, dp.outputRetainedBytes)
	if ctx.Err() != nil {
		dp.markContainerTainted(containerID)
	}
	return result
}

func (dp *Pool) markContainerTainted(containerID string) {
	if dp == nil || strings.TrimSpace(containerID) == "" {
		return
	}
	dp.mu.Lock()
	if dp.taintedContainers == nil {
		dp.taintedContainers = make(map[string]bool)
	}
	dp.taintedContainers[containerID] = true
	dp.mu.Unlock()
}

// ---------- 内部辅助 ----------

// totalContainersLocked includes hot, leased and idle containers. Callers
// must hold dp.mu. Creation reservations are represented in activeCount.
func (dp *Pool) totalContainersLocked() int {
	return dp.activeCount + dp.idleCount + len(dp.pendingRemoval)
}

func (dp *Pool) decActive() {
	dp.mu.Lock()
	if dp.activeCount > 0 {
		dp.activeCount--
	}
	dp.mu.Unlock()
}

func (dp *Pool) replenishLoop() {
	ticker := time.NewTicker(dp.replenishInterval)
	defer ticker.Stop()
	for range ticker.C {
		dp.mu.Lock()
		if dp.closed {
			dp.mu.Unlock()
			return
		}
		keys := make([]hotPoolKey, 0, len(dp.hotPool))
		for k := range dp.hotPool {
			keys = append(keys, k)
		}
		dp.mu.Unlock()

		for _, k := range keys {
			dp.replenishHotPool(k.image, k.userID)
		}
	}
}

func (dp *Pool) healthCheckLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		// Snapshot pooled containers so Docker I/O never happens under dp.mu.
		type containerInfo struct{ id, image, userID string }
		dp.mu.Lock()
		if dp.closed {
			dp.mu.Unlock()
			return
		}
		toCheck := make([]containerInfo, 0, len(dp.lruByImage))
		for id := range dp.lruByImage {
			toCheck = append(toCheck, containerInfo{
				id:     id,
				image:  dp.imageByContainerID[id],
				userID: dp.containerUser[id],
			})
		}
		dp.mu.Unlock()

		for _, c := range toCheck {
			running, statusErr := dp.containerRunningState(c.id)
			if statusErr != nil {
				slog.Warn("Pooled container health is unknown; leaving it attached", "container_id", shortContainerID(c.id), "error", statusErr)
				continue
			}
			if running {
				continue
			}
			dp.mu.Lock()
			if dp.closed {
				dp.mu.Unlock()
				return
			}
			poolKind := dp.detachPooledContainerLocked(c.id)
			if poolKind == "" {
				// It was acquired after the snapshot and now belongs to a run.
				dp.mu.Unlock()
				continue
			}
			dp.quarantinePooledContainerLocked(c.id, poolKind)
			dp.mu.Unlock()

			if err := dp.removeQuarantinedContainer(c.id); err != nil {
				slog.Warn("Dead pooled container removal was not confirmed", "container_id", shortContainerID(c.id), "error", err)
			}

			if poolKind == "hot" && c.image != "" {
				go dp.replenishHotPool(c.image, c.userID)
			}
			slog.Warn("Dead container removed", "container_id", c.id[:12])
		}
	}
}

// detachPooledContainerLocked removes id from the concrete hot/idle
// collection and reports which accounting bucket owned it. Callers hold dp.mu.
func (dp *Pool) detachPooledContainerLocked(id string) string {
	for image, ids := range dp.idlePool {
		for i, candidate := range ids {
			if candidate != id {
				continue
			}
			dp.idlePool[image] = append(ids[:i], ids[i+1:]...)
			if len(dp.idlePool[image]) == 0 {
				delete(dp.idlePool, image)
			}
			return "idle"
		}
	}

	for key, ch := range dp.hotPool {
		found := false
		kept := make([]string, 0, len(ch))
	drain:
		for {
			select {
			case candidate := <-ch:
				if candidate == id {
					found = true
				} else {
					kept = append(kept, candidate)
				}
			default:
				break drain
			}
		}
		for _, candidate := range kept {
			ch <- candidate
		}
		if found {
			if len(ch) == 0 && dp.deletedUsers[key.userID] {
				delete(dp.hotPool, key)
			}
			return "hot"
		}
	}
	return ""
}

// ---------- Docker 流式进程执行 ----------

func dockerStreamProcess(ctx context.Context, containerID string, command []string, workDir string, output session.OutputWriter, stage string, env map[string]string, stdin io.Reader, retainedBytes int) *model.RunResult {
	cmdDisplay := strings.Join(command, " ")
	output.WriteStatus(stage, fmt.Sprintf("[docker] %s", cmdDisplay))

	args := []string{"exec"}
	// 交互式输入：加 -i 使 docker exec 保持 stdin 打开（Python input() / C scanf 等）
	if stdin != nil {
		args = append(args, "-i")
	}
	// 按步骤注入环境变量（如 PYTHONPATH=/workspace），在 -w 与容器 ID 之前
	for k, v := range env {
		args = append(args, "-e", k+"="+v)
	}
	if workDir != "" {
		args = append(args, "-w", workDir)
	}
	args = append(args, containerID)
	args = append(args, command...)

	cmd := exec.CommandContext(ctx, "docker", args...)

	// 连接 stdin（交互式输入）
	if stdin != nil {
		cmd.Stdin = stdin
	}

	stdoutPipe, _ := cmd.StdoutPipe()
	stderrPipe, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		output.WriteError(fmt.Sprintf("Docker exec start failed: %v", err))
		return &model.RunResult{Success: false, ReturnCode: 1}
	}

	limit := retainedBytes
	if limit <= 0 {
		limit = 256 << 10
	}
	stdoutLines := ringbuffer.New(limit)
	stderrLines := ringbuffer.New(limit)
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, err := stdoutPipe.Read(buf)
			if n > 0 {
				for _, line := range strings.Split(strings.TrimSuffix(string(buf[:n]), "\n"), "\n") {
					if ctx.Err() != nil {
						return // cancel：停止向客户端转发剩余缓冲输出
					}
					if line != "" {
						stdoutLines.WriteLine(line)
						output.WriteStdout(line, stage)
					}
				}
			}
			if err != nil || ctx.Err() != nil {
				break
			}
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, err := stderrPipe.Read(buf)
			if n > 0 {
				for _, line := range strings.Split(strings.TrimSuffix(string(buf[:n]), "\n"), "\n") {
					if ctx.Err() != nil {
						return // cancel：停止向客户端转发剩余缓冲输出
					}
					if line != "" {
						stderrLines.WriteLine(line)
						output.WriteStderr(line, stage)
					}
				}
			}
			if err != nil || ctx.Err() != nil {
				break
			}
		}
	}()

	wg.Wait()
	err := cmd.Wait()

	timedOut := ctx.Err() == context.DeadlineExceeded
	if timedOut {
		output.WriteStderr(fmt.Sprintf("[%s] Process timed out", stage), stage)
	}

	returnCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			returnCode = exitErr.ExitCode()
		} else if !timedOut {
			returnCode = 1
		}
	}

	return &model.RunResult{
		Success:         returnCode == 0 && !timedOut,
		ReturnCode:      returnCode,
		Stdout:          stdoutLines.String(),
		Stderr:          stderrLines.String(),
		TimedOut:        timedOut,
		StdoutTruncated: stdoutLines.Truncated(),
		StderrTruncated: stderrLines.Truncated(),
	}
}
