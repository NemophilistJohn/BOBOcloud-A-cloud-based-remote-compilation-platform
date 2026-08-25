package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/serverruntime"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"

	"github.com/gorilla/websocket"
)

type gatedRequestBody struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (body *gatedRequestBody) Read([]byte) (int, error) {
	body.once.Do(func() { close(body.entered) })
	<-body.release
	return 0, io.EOF
}

func TestDrainingKeepsLivenessButRejectsReadinessAndHTTPWork(t *testing.T) {
	handler := NewHTTPHandler(
		config.Default(), storage.NewMemorySessionStore(), session.NewChannelManager(),
		false, nil, nil, nil, nil, nil,
	)
	handler.Accepting = func() bool { return false }
	handler.Readiness = func(context.Context) error { return nil }

	live := httptest.NewRecorder()
	handler.ServeHTTP(live, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if live.Code != http.StatusOK {
		t.Fatalf("healthz status = %d, want 200", live.Code)
	}

	ready := httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz status = %d, want 503", ready.Code)
	}

	work := httptest.NewRecorder()
	handler.ServeHTTP(work, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"action":"serverInfo"}`)))
	var response model.Response
	if err := json.Unmarshal(work.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if work.Code != http.StatusServiceUnavailable || response.ErrorCode != serverDrainingErrorCode {
		t.Fatalf("draining response: status=%d body=%s", work.Code, work.Body.String())
	}
}

func TestOrdinaryHTTPRequestParticipatesInRuntimeDrainBarrier(t *testing.T) {
	runtime := serverruntime.New(context.Background())
	handler := NewHTTPHandler(
		config.Default(), storage.NewMemorySessionStore(), session.NewChannelManager(),
		false, nil, nil, nil, nil, nil,
	)
	handler.Accepting = runtime.IsAccepting
	handler.AcquireWork = runtime.Acquire
	handler.Readiness = func(context.Context) error { return nil }
	body := &gatedRequestBody{entered: make(chan struct{}), release: make(chan struct{})}
	request := httptest.NewRequest(http.MethodPost, "/", body)
	response := httptest.NewRecorder()
	handlerDone := make(chan struct{})
	go func() {
		defer close(handlerDone)
		handler.ServeHTTP(response, request)
	}()
	select {
	case <-body.entered:
	case <-time.After(time.Second):
		t.Fatal("HTTP handler did not begin reading the request")
	}

	runtime.BeginDrain(errors.New("test shutdown"))
	waitCtx, cancelWait := context.WithTimeout(context.Background(), 30*time.Millisecond)
	err := runtime.Wait(waitCtx)
	cancelWait()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Wait() error = %v, want active HTTP request to hold the barrier", err)
	}

	close(body.release)
	select {
	case <-handlerDone:
	case <-time.After(time.Second):
		t.Fatal("HTTP handler did not finish after the request body was released")
	}
	waitCtx, cancelWait = context.WithTimeout(context.Background(), time.Second)
	defer cancelWait()
	if err := runtime.Wait(waitCtx); err != nil {
		t.Fatalf("Wait() after HTTP completion = %v", err)
	}

	live := httptest.NewRecorder()
	handler.ServeHTTP(live, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if live.Code != http.StatusOK {
		t.Fatalf("healthz status while draining = %d, want 200", live.Code)
	}
	ready := httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz status while draining = %d, want 503", ready.Code)
	}
}

func TestDrainingRejectsEveryWebSocketEntryBeforeUpgrade(t *testing.T) {
	ws := &WSHandler{Accepting: func() bool { return false }}
	dap := &DAPHandler{Accepting: func() bool { return false }}
	tests := map[string]http.HandlerFunc{
		"run":       ws.HandleWebSocket,
		"terminal":  ws.HandleTerminalWebSocket,
		"lsp":       ws.HandleLSPWebSocket,
		"dap":       dap.HandleWebSocket,
		"dap-child": dap.HandleChildWebSocket,
	}
	for name, endpoint := range tests {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "http://cloud.example/"+name, nil)
			endpoint.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503", recorder.Code)
			}
			var response model.Response
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if response.ErrorCode != serverDrainingErrorCode {
				t.Fatalf("response = %#v", response)
			}
		})
	}
}

func TestRootCancellationClosesHijackedWebSocketAndReleasesWork(t *testing.T) {
	runtime := serverruntime.New(context.Background())
	handler := &WSHandler{
		Config:      config.Default(),
		Sessions:    storage.NewMemorySessionStore(),
		Channels:    session.NewChannelManager(),
		Accepting:   runtime.IsAccepting,
		AcquireWork: runtime.Acquire,
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(handler.HandleWebSocket))
	server.Config.BaseContext = func(net.Listener) context.Context { return runtime.Context() }
	server.Start()
	t.Cleanup(server.Close)

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	runtime.BeginDrain(errors.New("test shutdown"))

	waitCtx, cancelWait := context.WithTimeout(context.Background(), time.Second)
	defer cancelWait()
	if err := runtime.Wait(waitCtx); err != nil {
		t.Fatalf("runtime did not wait for the hijacked handler to exit: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("WebSocket remained open after root cancellation")
	}
}
