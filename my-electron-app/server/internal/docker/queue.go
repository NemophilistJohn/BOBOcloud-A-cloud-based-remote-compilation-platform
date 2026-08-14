package docker

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// ============================================================
// queue.go — Docker 容器请求排队（FIFO，有界，超时）
// ============================================================

// QueueRequest 代表一个等待获取容器的请求
type QueueRequest struct {
	UserID    string
	Image     string
	ResultCh  chan QueueResult
	Ctx       context.Context
	CreatedAt time.Time
}

// QueueResult 是 Acquire 排队的结果
type QueueResult struct {
	ContainerID string
	Error       error
}

// RequestQueue 管理容器获取请求的 FIFO 排队。
// 当池中无可用容器时，后续请求进入队列等待，
// 有空闲容器或超时时出队。
type RequestQueue struct {
	mu      sync.Mutex
	queue   []*QueueRequest
	maxLen  int
	timeout time.Duration
	enabled bool

	// 统计
	totalQueued  int64
	totalTimeout int64
}

// NewRequestQueue 创建一个请求队列。
// maxLen: 最大排队长度（超出直接拒绝）。
// timeout: 单个请求最大排队等待时间。
func NewRequestQueue(maxLen int, timeout time.Duration) *RequestQueue {
	rq := &RequestQueue{
		queue:   make([]*QueueRequest, 0, maxLen),
		maxLen:  maxLen,
		timeout: timeout,
		enabled: true,
	}
	return rq
}

// DisabledQueue 返回一个禁用的队列（所有请求直接失败，由 Pool 自行处理）
func DisabledQueue() *RequestQueue {
	return &RequestQueue{enabled: false}
}

// Enqueue 将请求加入队列。等待与超时由 Pool.acquireViaQueue 统一处理，
// ResultCh 始终只有调用方一个消费者，避免唤醒结果被队列内部抢走。
func (rq *RequestQueue) Enqueue(req *QueueRequest) error {
	if !rq.enabled {
		return fmt.Errorf("request queue is disabled")
	}
	if err := req.Ctx.Err(); err != nil {
		return err
	}

	rq.mu.Lock()
	defer rq.mu.Unlock()
	if len(rq.queue) >= rq.maxLen {
		return fmt.Errorf("request queue is full (%d/%d), try again later", len(rq.queue), rq.maxLen)
	}
	position := len(rq.queue)
	rq.queue = append(rq.queue, req)
	rq.totalQueued++
	slog.Info("Request queued for container",
		"user_id", req.UserID,
		"image", req.Image,
		"position", position,
		"queue_len", len(rq.queue),
	)
	return nil
}

// DequeueNext 唤醒队列中的下一个请求。由 Pool.Release 调用。
// 返回被唤醒的请求（如果有）。
func (rq *RequestQueue) DequeueNext() *QueueRequest {
	if !rq.enabled {
		return nil
	}

	rq.mu.Lock()
	defer rq.mu.Unlock()

	if len(rq.queue) == 0 {
		return nil
	}

	for len(rq.queue) > 0 {
		req := rq.queue[0]
		rq.queue = rq.queue[1:]
		if req.Ctx.Err() == nil {
			return req
		}
	}
	return nil
}

// QueueLen 返回当前排队长度
func (rq *RequestQueue) QueueLen() int {
	rq.mu.Lock()
	defer rq.mu.Unlock()
	return len(rq.queue)
}

// Stats 返回排队统计
func (rq *RequestQueue) Stats() (queued, timeout int64, currentLen int) {
	rq.mu.Lock()
	defer rq.mu.Unlock()
	return rq.totalQueued, rq.totalTimeout, len(rq.queue)
}

// Remove 从队列中移除指定请求（超时或调用方取消时使用）。
func (rq *RequestQueue) Remove(target *QueueRequest) {
	rq.mu.Lock()
	defer rq.mu.Unlock()
	for i, req := range rq.queue {
		if req == target {
			rq.queue = append(rq.queue[:i], rq.queue[i+1:]...)
			return
		}
	}
}

// RemoveByUser cancels every queued request owned by a deleted/disabled user.
func (rq *RequestQueue) RemoveByUser(userID string, cause error) int {
	if cause == nil {
		cause = fmt.Errorf("user is no longer available")
	}
	rq.mu.Lock()
	removed := make([]*QueueRequest, 0)
	kept := rq.queue[:0]
	for _, req := range rq.queue {
		if req.UserID == userID {
			removed = append(removed, req)
		} else {
			kept = append(kept, req)
		}
	}
	rq.queue = kept
	rq.mu.Unlock()
	for _, req := range removed {
		select {
		case req.ResultCh <- QueueResult{Error: cause}:
		default:
		}
	}
	return len(removed)
}

// Timeout 返回单个请求允许在队列中等待的最长时间。
func (rq *RequestQueue) Timeout() time.Duration {
	return rq.timeout
}

// RecordTimeout 记录一次真实的队列超时。
func (rq *RequestQueue) RecordTimeout() {
	rq.mu.Lock()
	rq.totalTimeout++
	rq.mu.Unlock()
}
