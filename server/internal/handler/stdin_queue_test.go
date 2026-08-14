package handler

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/model"

	"github.com/gorilla/websocket"
)

type blockingStdinWriter struct {
	started chan struct{}
	closed  chan struct{}
	once    sync.Once
}

func newBlockingStdinWriter() *blockingStdinWriter {
	return &blockingStdinWriter{
		started: make(chan struct{}),
		closed:  make(chan struct{}),
	}
}

func (w *blockingStdinWriter) Write(_ []byte) (int, error) {
	w.once.Do(func() { close(w.started) })
	<-w.closed
	return 0, io.ErrClosedPipe
}

func (w *blockingStdinWriter) Close() error {
	select {
	case <-w.closed:
	default:
		close(w.closed)
	}
	return nil
}

func TestStdinWriteQueueIsBoundedAndStopUnblocksWriter(t *testing.T) {
	writer := newBlockingStdinWriter()
	queue := newStdinWriteQueue(writer, 3, 13, nil)

	if !queue.Enqueue("first") {
		t.Fatal("first input was rejected")
	}
	select {
	case <-writer.started:
	case <-time.After(time.Second):
		t.Fatal("stdin writer did not start")
	}
	if !queue.Enqueue("1234") || !queue.Enqueue("5678") {
		t.Fatal("input within queue limits was rejected")
	}
	if queue.Enqueue("x") {
		t.Fatal("queue accepted input beyond its byte bound")
	}

	queue.Stop()
	select {
	case <-queue.Done():
	case <-time.After(time.Second):
		t.Fatal("closing the queue did not unblock the stdin writer")
	}
}

func TestReadRunMessagesHandlesCancelAndDisconnectWhileStdinBlocked(t *testing.T) {
	for _, testCase := range []struct {
		name string
		stop func(*websocket.Conn) error
	}{
		{
			name: "cancel",
			stop: func(conn *websocket.Conn) error {
				return conn.WriteJSON(model.WSMessage{Type: "cancel", RunID: "blocked-stdin"})
			},
		},
		{
			name: "disconnect",
			stop: func(conn *websocket.Conn) error { return conn.Close() },
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			writer := newBlockingStdinWriter()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			handlerDone := make(chan struct{})

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := wsUpgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				queue := newStdinWriteQueue(writer, stdinQueueMaxMessages, stdinQueueMaxBytes, nil)
				readRunMessages(conn, "blocked-stdin", queue, cancel)
				close(handlerDone)
			}))
			t.Cleanup(server.Close)

			conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := conn.WriteJSON(model.WSMessage{Type: "stdin", Data: "blocked"}); err != nil {
				t.Fatal(err)
			}
			select {
			case <-writer.started:
			case <-time.After(time.Second):
				t.Fatal("stdin writer did not block")
			}

			if err := testCase.stop(conn); err != nil {
				t.Fatal(err)
			}
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
				t.Fatal("run was not cancelled while stdin writer was blocked")
			}
			select {
			case <-handlerDone:
			case <-time.After(time.Second):
				t.Fatal("WebSocket reader did not exit after cancellation")
			}
		})
	}
}
