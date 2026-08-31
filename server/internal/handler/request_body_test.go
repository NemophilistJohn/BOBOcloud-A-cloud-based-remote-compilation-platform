package handler

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
)

type deadlineResponseRecorder struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (recorder *deadlineResponseRecorder) SetReadDeadline(deadline time.Time) error {
	recorder.deadlines = append(recorder.deadlines, deadline)
	return nil
}

type timeoutRequestBody struct{}

func (timeoutRequestBody) Read([]byte) (int, error) { return 0, timeoutReadError{} }
func (timeoutRequestBody) Close() error             { return nil }

type timeoutReadError struct{}

func (timeoutReadError) Error() string   { return "read timeout" }
func (timeoutReadError) Timeout() bool   { return true }
func (timeoutReadError) Temporary() bool { return true }

func TestHTTPRequestBodyDeadlineIsAppliedAndCleared(t *testing.T) {
	handler := NewHTTPHandler(config.Default(), storage.NewMemorySessionStore(), session.NewChannelManager(), false, nil, nil, nil, nil, nil)
	recorder := &deadlineResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"action":"serverInfo"}`))
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if len(recorder.deadlines) != 2 || recorder.deadlines[0].IsZero() || !recorder.deadlines[1].IsZero() {
		t.Fatalf("request body deadlines = %v", recorder.deadlines)
	}
}

func TestHTTPRequestBodyTimeoutReturnsRequestTimeout(t *testing.T) {
	handler := NewHTTPHandler(config.Default(), storage.NewMemorySessionStore(), session.NewChannelManager(), false, nil, nil, nil, nil, nil)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/", io.NopCloser(timeoutRequestBody{}))
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestTimeout {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
}
