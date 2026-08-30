package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
)

func TestHTTPTerminalRetainsOperationUntilContainerRemoval(t *testing.T) {
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	cleanup := make(chan struct{})
	cleanupStarted := make(chan struct{})
	executor := func(ctx context.Context, _, _, _ string) (string, string, int, error) {
		if !RetainResourcesUntilContainerRemoved(ctx, func() {
			close(cleanupStarted)
			<-cleanup
		}) {
			t.Fatal("failed terminal container cleanup did not retain storage ownership")
		}
		return "", "", 1, errors.New("destroy terminal container")
	}
	handler := NewHTTPHandler(cfg, storage.NewMemorySessionStore(), session.NewChannelManager(), false, nil, nil, executor, nil, nil)
	handler.PersonalCache = personalcache.NewManager(cfg.DataDir, personalcache.Options{ReservationBytes: 8, ReservationFiles: 1})
	handler.Resources = newTestResourceController(t, 1)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api", strings.NewReader(`{"action":"terminal","runtime":"python:3.11","command":"true"}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("terminal cleanup response=%d body=%s", recorder.Code, recorder.Body.String())
	}
	select {
	case <-cleanupStarted:
	case <-time.After(time.Second):
		t.Fatal("deferred terminal cleanup did not start")
	}
	if info := handler.PersonalCache.Inspect("default", 0); info.ReservedBytes == 0 || info.ReservedFiles == 0 {
		t.Fatalf("terminal operation released quota before container removal: %+v", info)
	}
	if snapshot := handler.Resources.Snapshot(); snapshot.Used.Slots != 1 || len(snapshot.Leases) != 1 {
		t.Fatalf("terminal operation released node resources before container removal: %+v", snapshot)
	}

	close(cleanup)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if info := handler.PersonalCache.Inspect("default", 0); info.ReservedBytes == 0 && info.ReservedFiles == 0 && handler.Resources.Snapshot().Used.Slots == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("terminal operation did not release quota/resources after removal: quota=%+v resources=%+v", handler.PersonalCache.Inspect("default", 0), handler.Resources.Snapshot())
}

func TestHTTPTerminalRequestCancellationReachesExecutorAndReleasesResources(t *testing.T) {
	started := make(chan struct{})
	observedCancellation := make(chan error, 1)
	executor := func(ctx context.Context, _, _, _ string) (string, string, int, error) {
		close(started)
		<-ctx.Done()
		observedCancellation <- ctx.Err()
		return "", "", 1, ctx.Err()
	}
	handler := NewHTTPHandler(config.Default(), storage.NewMemorySessionStore(), session.NewChannelManager(), false, nil, nil, executor, nil, nil)
	handler.Resources = newTestResourceController(t, 1)

	requestContext, cancelRequest := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodPost, "/api", strings.NewReader(`{"action":"terminal","runtime":"python:3.11","command":"true"}`)).WithContext(requestContext)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(recorder, request)
		close(done)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("terminal executor did not start")
	}
	cancelRequest()
	select {
	case err := <-observedCancellation:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("executor cancellation = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("request cancellation did not reach terminal executor")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancelled terminal request did not return")
	}
	if snapshot := handler.Resources.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("cancelled terminal request leaked resources: %+v", snapshot)
	}
}
