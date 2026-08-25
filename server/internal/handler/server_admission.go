package handler

import (
	"context"
	"net/http"
	"sync"

	"bobocloud-server/internal/model"

	"github.com/gorilla/websocket"
)

const serverDrainingErrorCode = "server_draining"

func serverAccepting(check func() bool) bool {
	return check == nil || check()
}

// rejectWhileDraining is evaluated before request decoding or a WebSocket
// upgrade. Existing handlers continue through their own request context; only
// new work is rejected.
func rejectWhileDraining(w http.ResponseWriter, check func() bool) bool {
	if serverAccepting(check) {
		return false
	}
	writeServerDraining(w)
	return true
}

func writeServerDraining(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Retry-After", "1")
	writeJSON(w, http.StatusServiceUnavailable, model.Response{
		Success:   false,
		Error:     "Server is shutting down; retry after it restarts",
		ErrorCode: serverDrainingErrorCode,
	})
}

func acquireLongLivedWork(w http.ResponseWriter, check func() bool, acquire func(string) (func(), error), name string) (func(), bool) {
	if acquire == nil {
		if rejectWhileDraining(w, check) {
			return nil, false
		}
		return func() {}, true
	}
	release, err := acquire(name)
	if err != nil {
		writeServerDraining(w)
		return nil, false
	}
	return release, true
}

// closeWebSocketOnContext unblocks a handler sitting in ReadMessage when the
// process root is cancelled. http.Server.Shutdown does not manage hijacked
// connections, so this is part of the long-lived work contract.
func closeWebSocketOnContext(ctx context.Context, conn *websocket.Conn) func() {
	if ctx == nil || conn == nil {
		return func() {}
	}
	done := make(chan struct{})
	var once sync.Once
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-done:
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}
