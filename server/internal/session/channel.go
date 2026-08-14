package session

import (
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

// Attach 将 WebSocket 连接绑定到此 Channel
func (rc *RunChannel) Attach(conn *websocket.Conn) {
	rc.mu.Lock()
	if rc.closed {
		rc.mu.Unlock()
		conn.Close()
		return
	}
	rc.conn = conn
	rc.cond.Broadcast()
	rc.mu.Unlock()
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
	mu       sync.Mutex
	channels map[string]*RunChannel
}

// NewChannelManager 创建 Channel 管理器
func NewChannelManager() *ChannelManager {
	return &ChannelManager{
		channels: make(map[string]*RunChannel),
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
}

// CleanupRun 同时删除 Channel 和对应的 Session
func (cm *ChannelManager) CleanupRun(runID string, store interface{ Delete(runID string) }) {
	cm.Remove(runID)
	store.Delete(runID)
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
