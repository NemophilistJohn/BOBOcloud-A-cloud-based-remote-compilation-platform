package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/model"

	"github.com/gorilla/websocket"
)

// ============================================================
// terminal_ws.go - Interactive terminal over WebSocket
//
// Each terminal session acquires a Docker container and runs
// `docker exec -i sh` (or bash) with stdin/stdout piped to the
// WebSocket. xterm.js on the frontend renders the output.
// ============================================================

var termUpgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// TerminalMessage is the JSON protocol for terminal WebSocket.
type TerminalMessage struct {
	Type    string `json:"type"` // "start" | "input" | "resize" | "ping"
	Data    string `json:"data,omitempty"`
	Cols    int    `json:"cols,omitempty"`
	Rows    int    `json:"rows,omitempty"`
	Runtime string `json:"runtime,omitempty"`
}

// HandleTerminalWebSocket handles /term WebSocket connections.
func (h *WSHandler) HandleTerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := termUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("Terminal WS upgrade failed", "error", err)
		return
	}
	conn.SetReadLimit(int64(h.Config.WSReadLimit))
	conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	var writeMu sync.Mutex
	writeJSON := func(value interface{}) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteJSON(value)
	}

	// 1. Read the start message (auth + runtime selection)
	_, raw, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return
	}

	var msg TerminalMessage
	if err := json.Unmarshal(raw, &msg); err != nil || msg.Type != "start" {
		writeJSON(map[string]interface{}{"type": "error", "data": "First message must be type=start"})
		conn.Close()
		return
	}
	conn.SetReadDeadline(time.Time{})

	// 2. Authenticate
	userID := "default"
	if h.AuthEnabled {
		token := strings.TrimPrefix(msg.Data, "Bearer ")
		token = strings.TrimSpace(token)
		if token == "" {
			writeJSON(map[string]interface{}{"type": "error", "data": "Authentication required"})
			conn.Close()
			return
		}
		// Try session token first
		if h.AuthSessions != nil {
			if sess, err := h.AuthSessions.Validate(token, h.Config.SessionTokenTTL()); err == nil {
				if user, err := h.UserStore.Get(sess.UserID); err == nil && !user.Disabled {
					userID = user.ID
				}
			}
		}
		// Fallback to API key
		if userID == "default" && h.Authenticator != nil {
			if user, err := h.Authenticator.Validate(token); err == nil && !user.Disabled {
				userID = user.ID
			}
		}
		if userID == "default" {
			writeJSON(map[string]interface{}{"type": "error", "data": "Invalid credentials"})
			conn.Close()
			return
		}
	}
	// 3. Resolve runtime
	runtimeID := msg.Runtime
	if runtimeID == "" {
		runtimeID = "python:3.11"
	}
	rt := model.GetRuntimeDef(runtimeID)
	if rt == nil {
		writeJSON(map[string]interface{}{"type": "error", "data": "Unknown runtime: " + runtimeID})
		conn.Close()
		return
	}
	var releaseActivity func()
	if h.Lifecycle != nil {
		activity, leaseErr := h.Lifecycle.AcquireActivity(userID, "")
		if leaseErr != nil {
			writeJSON(map[string]interface{}{"type": "error", "data": leaseErr.Error()})
			conn.Close()
			return
		}
		releaseActivity = activity.Release
	}
	if releaseActivity == nil {
		releaseActivity = func() {}
	}

	// 4. Acquire container
	containerID, err := h.DockerPool.AcquireForUser(r.Context(), userID, rt.DockerImage, nil)
	if err != nil {
		releaseActivity()
		writeJSON(map[string]interface{}{"type": "error", "data": "Failed to acquire container: " + err.Error()})
		conn.Close()
		return
	}

	slog.Info("Terminal session started",
		"user_id", userID,
		"runtime", runtimeID,
		"container", containerID[:12],
	)

	// 5. Start interactive shell via docker exec
	execCmd := exec.Command("docker", "exec", "-i",
		"-e", "TERM=xterm-256color",
		"-w", "/workspace",
		containerID, "sh", "-c",
		"if command -v bash >/dev/null 2>&1; then exec bash --norc; else exec sh; fi")

	stdinPipe, err := execCmd.StdinPipe()
	if err != nil {
		h.DockerPool.ReleaseForUser(containerID, userID)
		releaseActivity()
		writeJSON(map[string]interface{}{"type": "error", "data": "Failed to create stdin pipe"})
		conn.Close()
		return
	}
	stdoutPipe, err := execCmd.StdoutPipe()
	if err != nil {
		h.DockerPool.ReleaseForUser(containerID, userID)
		releaseActivity()
		writeJSON(map[string]interface{}{"type": "error", "data": "Failed to create stdout pipe"})
		conn.Close()
		return
	}
	execCmd.Stderr = execCmd.Stdout // merge stderr into stdout

	if err := execCmd.Start(); err != nil {
		h.DockerPool.ReleaseForUser(containerID, userID)
		releaseActivity()
		writeJSON(map[string]interface{}{"type": "error", "data": "Failed to start shell: " + err.Error()})
		conn.Close()
		return
	}

	// Send ready signal
	writeJSON(map[string]interface{}{"type": "ready", "data": ""})

	// 6. Goroutine: docker exec stdout -> WebSocket
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, 8192)
		for {
			n, err := stdoutPipe.Read(buf)
			if n > 0 {
				if wErr := writeJSON(map[string]interface{}{"type": "output", "data": string(buf[:n])}); wErr != nil {
					return
				}
			}
			if err != nil {
				break
			}
		}
	}()

	// 7. Read loop: WebSocket -> docker exec stdin
	done := make(chan struct{})
	go func() {
		defer func() {
			stdinPipe.Close()
			if execCmd.Process != nil {
				execCmd.Process.Kill()
			}
			execCmd.Wait()
			wg.Wait()
			h.DockerPool.ReleaseForUser(containerID, userID)
			releaseActivity()
			slog.Info("Terminal session ended",
				"user_id", userID,
				"container", containerID[:12],
			)
			writeJSON(map[string]interface{}{"type": "exit", "data": ""})
			conn.Close()
			close(done)
		}()

		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var msg TerminalMessage
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			switch msg.Type {
			case "input":
				stdinPipe.Write([]byte(msg.Data))
			case "resize":
				if msg.Cols > 0 && msg.Rows > 0 {
					resizeCmd := exec.Command("docker", "exec", containerID,
						"sh", "-c",
						"stty cols "+itoa(msg.Cols)+" rows "+itoa(msg.Rows)+" 2>/dev/null")
					resizeCmd.Run()
				}
			case "ping":
				writeJSON(map[string]interface{}{"type": "pong", "data": ""})
			}
		}
	}()

	<-done
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
