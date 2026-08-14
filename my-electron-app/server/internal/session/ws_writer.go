package session

import (
	"log/slog"
)

// ============================================================
// ws_writer.go — WebSocket 实现的 OutputWriter
// ============================================================

// OutputWriter 是输出目标的抽象接口。
type OutputWriter interface {
	WriteStatus(stage, msg string)
	WriteStdout(line, stage string)
	WriteStderr(line, stage string)
	WriteArtifactBegin()
	WriteArtifact(relPath string, data []byte, fileType string)
	WriteArtifactEnd()
	WriteResult(success bool, returnCode int)
	WriteError(msg string)
}

// WebSocketWriter 通过 RunChannel 将输出写入 WebSocket 连接
type WebSocketWriter struct {
	channel   *RunChannel
	chunkSize int
}

// NewWebSocketWriter 创建 WebSocket 输出写入器
func NewWebSocketWriter(channel *RunChannel, chunkSize int) *WebSocketWriter {
	return &WebSocketWriter{channel: channel, chunkSize: chunkSize}
}

func (w *WebSocketWriter) WriteStatus(stage, msg string) {
	w.channel.SendJSON(MakeStatus(stage, msg))
}

func (w *WebSocketWriter) WriteStdout(line, stage string) {
	w.channel.SendJSON(MakeStreamLine("stdout", line, stage))
}

func (w *WebSocketWriter) WriteStderr(line, stage string) {
	w.channel.SendJSON(MakeStreamLine("stderr", line, stage))
}

func (w *WebSocketWriter) WriteArtifactBegin() {
	// no-op
}

func (w *WebSocketWriter) WriteArtifact(relPath string, data []byte, fileType string) {
	content := string(data)
	cs := w.chunkSize
	if cs <= 0 {
		cs = 200000
	}
	chunkCount := (len(content) + cs - 1) / cs
	if chunkCount < 1 {
		chunkCount = 1
	}
	for i := 0; i < chunkCount; i++ {
		end := (i + 1) * cs
		if end > len(content) {
			end = len(content)
		}
		part := content[i*cs : end]
		w.channel.SendJSON(MakeArtifact(relPath, fileType, i, chunkCount, part))
	}
}

func (w *WebSocketWriter) WriteArtifactEnd() {
	w.channel.SendJSON(map[string]interface{}{"type": "artifactsComplete"})
}

func (w *WebSocketWriter) WriteResult(success bool, returnCode int) {
	w.channel.SendJSON(MakeResult(success, returnCode))
}

func (w *WebSocketWriter) WriteError(msg string) {
	w.channel.SendJSON(MakeError(msg))
	slog.Error("Run error", "message", msg)
}
