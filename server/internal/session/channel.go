package session

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ============================================================
// channel.go — RunChannel 封装 WebSocket 连接
// ============================================================

// RunChannel 封装了一个 WebSocket 连接通道，用于向客户端流式发送消息。
type RunChannel struct {
	RunID  string
	conn   *websocket.Conn
	closed bool
	mu     sync.Mutex
	cond   *sync.Cond
	sendMu sync.Mutex
}

// NewRunChannel 创建新的 RunChannel（尚未关联 WebSocket 连接）
func NewRunChannel(runID string) *RunChannel {
	rc := &RunChannel{RunID: runID}
	rc.cond = sync.NewCond(&rc.mu)
	return rc
}

// Attach 将 WebSocket 连接绑定到此 Channel。返回 false 表示当前 generation
// 已经关闭，调用者不得再启动对应的运行任务。
func (rc *RunChannel) Attach(conn *websocket.Conn) bool {
	if conn == nil {
		return false
	}
	rc.mu.Lock()
	if rc.closed {
		rc.mu.Unlock()
		_ = conn.Close()
		return false
	}
	rc.conn = conn
	rc.cond.Broadcast()
	rc.mu.Unlock()
	return true
}

// SendJSON 向客户端发送 JSON 消息。线程安全，发送失败时自动关闭 Channel。
func (rc *RunChannel) SendJSON(msg interface{}) bool {
	rc.sendMu.Lock()

	rc.mu.Lock()
	isClosed := rc.closed
	conn := rc.conn
	rc.mu.Unlock()

	if isClosed || conn == nil {
		rc.sendMu.Unlock()
		return false
	}

	if err := conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		rc.sendMu.Unlock()
		rc.Close()
		return false
	}

	if err := conn.WriteJSON(msg); err != nil {
		rc.sendMu.Unlock()
		slog.Error("WebSocket send failed", "run_id", rc.RunID, "error", err)
		rc.Close()
		return false
	}
	rc.sendMu.Unlock()
	return true
}

// Close 关闭 Channel，通知所有等待者，并关闭底层 WebSocket 连接。
func (rc *RunChannel) Close() {
	rc.mu.Lock()
	if rc.closed {
		rc.mu.Unlock()
		return
	}
	rc.closed = true
	conn := rc.conn
	rc.conn = nil
	rc.cond.Broadcast()
	rc.mu.Unlock()

	rc.sendMu.Lock()
	if conn != nil {
		conn.Close()
	}
	rc.sendMu.Unlock()
}

// WaitUntilClosed 阻塞直到 Channel 被关闭
func (rc *RunChannel) WaitUntilClosed() {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	for !rc.closed {
		rc.cond.Wait()
	}
}

// ---------- ChannelManager ----------

// ChannelManager 管理 RunChannel 生命周期
type ChannelManager struct {
	mu              sync.Mutex
	channels        map[string]*RunChannel
	pendingCleanups map[string]*RunChannel
}

// NewChannelManager 创建 Channel 管理器
func NewChannelManager() *ChannelManager {
	return &ChannelManager{
		channels:        make(map[string]*RunChannel),
		pendingCleanups: make(map[string]*RunChannel),
	}
}

// GetOrCreate 获取已有 Channel，若不存在且 create=true 则新建
func (cm *ChannelManager) GetOrCreate(runID string, create bool) *RunChannel {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	ch, ok := cm.channels[runID]
	if !ok && create {
		ch = NewRunChannel(runID)
		cm.channels[runID] = ch
	}
	return ch
}

// Remove 删除 Channel
func (cm *ChannelManager) Remove(runID string) {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	delete(cm.channels, runID)
	delete(cm.pendingCleanups, runID)
}

// RemoveIfCurrent removes only the channel generation owned by the caller.
// It is used after storage has already atomically removed expired handshakes.
func (cm *ChannelManager) RemoveIfCurrent(runID string, expected *RunChannel) bool {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	if cm.channels[runID] != expected {
		if cm.pendingCleanups[runID] == expected {
			delete(cm.pendingCleanups, runID)
		}
		return false
	}
	delete(cm.channels, runID)
	if cm.pendingCleanups[runID] == expected {
		delete(cm.pendingCleanups, runID)
	}
	return true
}

// CleanupRun deletes persistent state before releasing its channel identity.
// Keeping the channel mapped on failure makes cleanup retryable; checking the
// expected pointer prevents a late duplicate cleanup from deleting a newer run
// that reused the same run ID.
func (cm *ChannelManager) CleanupRun(runID string, expected *RunChannel, store interface{ Delete(runID string) error }) error {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	if cm.channels[runID] != expected {
		if cm.pendingCleanups[runID] == expected {
			delete(cm.pendingCleanups, runID)
		}
		return nil
	}
	if err := store.Delete(runID); err != nil {
		if expected != nil {
			cm.pendingCleanups[runID] = expected
		}
		return fmt.Errorf("delete persistent run session %q: %w", runID, err)
	}
	delete(cm.channels, runID)
	delete(cm.pendingCleanups, runID)
	return nil
}

// RetryPendingCleanups retries persistent deletes that previously failed while
// their exact channel generation was retained. A replaced or removed channel
// makes the old pending entry stale, so CleanupRun drops it without touching a
// newer persistent session that reused the same run ID.
func (cm *ChannelManager) RetryPendingCleanups(store interface{ Delete(runID string) error }) error {
	type pendingCleanup struct {
		runID    string
		expected *RunChannel
	}

	cm.mu.Lock()
	pending := make([]pendingCleanup, 0, len(cm.pendingCleanups))
	for runID, expected := range cm.pendingCleanups {
		pending = append(pending, pendingCleanup{runID: runID, expected: expected})
	}
	cm.mu.Unlock()

	var retryErrors []error
	for _, cleanup := range pending {
		if err := cm.CleanupRun(cleanup.runID, cleanup.expected, store); err != nil {
			retryErrors = append(retryErrors, err)
		}
	}
	return errors.Join(retryErrors...)
}

// ---------- 消息构建辅助函数 ----------

// MakeStatus 构建一条 status 消息
func MakeStatus(stage, msg string) map[string]interface{} {
	return map[string]interface{}{
		"type":    "status",
		"message": fmt.Sprintf("[%s] %s", stage, msg),
		"stage":   stage,
	}
}

// MakeStreamLine 构建一条 stdout/stderr 行消息
func MakeStreamLine(msgType, line, stage string) map[string]interface{} {
	return map[string]interface{}{
		"type":  msgType,
		"line":  line,
		"stage": stage,
	}
}

// MakeArtifact 构建一条产物分块消息
func MakeArtifact(relPath, fileType string, chunkIdx, chunkCount int, data string) map[string]interface{} {
	return map[string]interface{}{
		"type":       "artifact",
		"path":       relPath,
		"fileType":   fileType,
		"chunkIndex": chunkIdx,
		"chunkCount": chunkCount,
		"data":       data,
	}
}

// MakeResult 构建一条运行结果消息
func MakeResult(success bool, returnCode int) map[string]interface{} {
	return map[string]interface{}{
		"type":       "result",
		"success":    success,
		"returncode": returnCode,
	}
}

// MakeError 构建一条错误消息
func MakeError(msg string) map[string]interface{} {
	return map[string]interface{}{
		"type":    "error",
		"message": msg,
	}
}
