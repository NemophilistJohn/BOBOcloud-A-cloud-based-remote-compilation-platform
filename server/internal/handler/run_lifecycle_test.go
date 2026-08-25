package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
)

type cancelRunResponse struct {
	Success   bool   `json:"success"`
	Error     string `json:"error"`
	ErrorCode string `json:"errorCode"`
	Data      struct {
		Status                  string `json:"status"`
		RequiresWebSocketCancel bool   `json:"requiresWebSocketCancel"`
	} `json:"data"`
}

type createFailingSessionStore struct {
	*storage.MemorySessionStore
	createErr error
}

func (s *createFailingSessionStore) Create(*model.RunSession) (*model.RunSession, error) {
	return nil, s.createErr
}

type deleteFailingSessionStore struct {
	*storage.MemorySessionStore
	deleteErr error
	failures  int
}

type lookupFailingSessionStore struct {
	*storage.MemorySessionStore
	err error
}

func (s *lookupFailingSessionStore) Lookup(string) (*model.RunSession, bool, error) {
	return nil, false, s.err
}

func (s *deleteFailingSessionStore) Delete(runID string) error {
	if s.failures > 0 {
		s.failures--
		return s.deleteErr
	}
	return s.MemorySessionStore.Delete(runID)
}

func newCancelRunTestHandler(t *testing.T) (*HTTPHandler, *storage.MemorySessionStore, *session.ChannelManager) {
	t.Helper()
	runSessionLifecycleMu.Lock()
	clear(runCancellationTombstones)
	runSessionLifecycleMu.Unlock()
	store := storage.NewMemorySessionStore()
	channels := session.NewChannelManager()
	handler := NewHTTPHandler(config.Default(), store, channels, false, nil, nil, nil, nil, nil)
	return handler, store, channels
}

func newRunLifecycleHTTPHandler(t *testing.T) (*HTTPHandler, *storage.MemorySessionStore, *session.ChannelManager) {
	t.Helper()
	handler, store, channels := newCancelRunTestHandler(t)
	handler.Config.ServerRoot = t.TempDir()
	projectDir := filepath.Join(handler.Config.ServerRoot, "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return handler, store, channels
}

func callCancelRun(t *testing.T, handler http.Handler, runID string) (*httptest.ResponseRecorder, cancelRunResponse) {
	t.Helper()
	body, err := json.Marshal(map[string]string{"action": "cancelRun", "runId": runID})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api", bytes.NewReader(body))
	handler.ServeHTTP(recorder, request)
	var response cancelRunResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode cancelRun response: %v\n%s", err, recorder.Body.String())
	}
	return recorder, response
}

func callRunCode(t *testing.T, handler http.Handler, runID string) (*httptest.ResponseRecorder, model.Response) {
	t.Helper()
	recorder, response, err := issueRunCode(handler, runID)
	if err != nil {
		t.Fatal(err)
	}
	return recorder, response
}

func issueRunCode(handler http.Handler, runID string) (*httptest.ResponseRecorder, model.Response, error) {
	body, err := json.Marshal(map[string]string{
		"action":     "runCode",
		"runId":      runID,
		"folderName": "project",
		"filePath":   "main.go",
	})
	if err != nil {
		return nil, model.Response{}, err
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api", bytes.NewReader(body))
	handler.ServeHTTP(recorder, request)
	var response model.Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		return recorder, model.Response{}, fmt.Errorf("decode runCode response: %w: %s", err, recorder.Body.String())
	}
	return recorder, response, nil
}

func TestCancelRunBeforeCreateLeavesTombstone(t *testing.T) {
	handler, store, channels := newRunLifecycleHTTPHandler(t)

	_, cancellation := callCancelRun(t, handler, "future-run")
	if !cancellation.Success || cancellation.Data.Status != "absent" {
		t.Fatalf("unexpected cancellation response: %+v", cancellation)
	}

	recorder, creation := callRunCode(t, handler, "future-run")
	if recorder.Code != http.StatusConflict || creation.Success || creation.Error != "Run was cancelled before it started" {
		t.Fatalf("cancelled run was recreated: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, exists := store.Get("future-run"); exists {
		t.Fatal("cancelled-before-create session was persisted")
	}
	if channel := channels.GetOrCreate("future-run", false); channel != nil {
		t.Fatal("cancelled-before-create channel was persisted")
	}
}

func TestCancelRunLookupFailureDoesNotMutateRun(t *testing.T) {
	handler, base, channels := newRunLifecycleHTTPHandler(t)
	if _, err := base.Create(&model.RunSession{RunID: "lookup-failure-run", UserID: "default"}); err != nil {
		t.Fatal(err)
	}
	originalChannel := channels.GetOrCreate("lookup-failure-run", true)
	handler.Sessions = &lookupFailingSessionStore{
		MemorySessionStore: base,
		err:                errors.New("database is temporarily read-only"),
	}

	recorder, response := callCancelRun(t, handler, "lookup-failure-run")
	if recorder.Code != http.StatusServiceUnavailable || response.Success || response.ErrorCode != "run_session_storage_unavailable" {
		t.Fatalf("lookup failure response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, exists := base.Get("lookup-failure-run"); !exists {
		t.Fatal("lookup failure removed the persistent run")
	}
	if current := channels.GetOrCreate("lookup-failure-run", false); current != originalChannel {
		t.Fatal("lookup failure removed or replaced the channel")
	}
	closed := make(chan struct{})
	go func() {
		originalChannel.WaitUntilClosed()
		close(closed)
	}()
	select {
	case <-closed:
		t.Fatal("lookup failure closed the channel")
	default:
	}
	originalChannel.Close()
	<-closed
}

func TestRunCodeLookupFailureDoesNotCreateHandshake(t *testing.T) {
	handler, base, channels := newRunLifecycleHTTPHandler(t)
	handler.Sessions = &lookupFailingSessionStore{
		MemorySessionStore: base,
		err:                errors.New("database is temporarily read-only"),
	}

	recorder, response := callRunCode(t, handler, "lookup-failure-create")
	if recorder.Code != http.StatusServiceUnavailable || response.Success || response.ErrorCode != "run_session_storage_unavailable" {
		t.Fatalf("lookup failure response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, exists := base.Get("lookup-failure-create"); exists {
		t.Fatal("lookup failure persisted a new run")
	}
	if channel := channels.GetOrCreate("lookup-failure-create", false); channel != nil {
		t.Fatal("lookup failure created a channel")
	}
}

func TestCancelRunAfterCreateRemovesHandshake(t *testing.T) {
	handler, store, channels := newRunLifecycleHTTPHandler(t)

	creationRecorder, creation := callRunCode(t, handler, "created-run")
	if creationRecorder.Code != http.StatusOK || !creation.Success {
		t.Fatalf("runCode fixture failed: status=%d body=%s", creationRecorder.Code, creationRecorder.Body.String())
	}

	cancelRecorder, cancellation := callCancelRun(t, handler, "created-run")
	if cancelRecorder.Code != http.StatusOK || !cancellation.Success || cancellation.Data.Status != "cancelled" {
		t.Fatalf("unexpected cancellation response: status=%d body=%s", cancelRecorder.Code, cancelRecorder.Body.String())
	}
	if _, exists := store.Get("created-run"); exists {
		t.Fatal("cancelled-after-create session was not removed")
	}
	if channel := channels.GetOrCreate("created-run", false); channel != nil {
		t.Fatal("cancelled-after-create channel was not removed")
	}
}

func TestCancelRunDeleteFailureKeepsPairForRetry(t *testing.T) {
	handler, base, channels := newRunLifecycleHTTPHandler(t)
	deleteErr := errors.New("database is temporarily read-only")
	store := &deleteFailingSessionStore{MemorySessionStore: base, deleteErr: deleteErr, failures: 1}
	handler.Sessions = store

	creationRecorder, creation := callRunCode(t, handler, "retry-cancel-run")
	if creationRecorder.Code != http.StatusOK || !creation.Success {
		t.Fatalf("runCode fixture failed: status=%d body=%s", creationRecorder.Code, creationRecorder.Body.String())
	}
	originalChannel := channels.GetOrCreate("retry-cancel-run", false)
	if originalChannel == nil {
		t.Fatal("runCode fixture did not create a channel")
	}

	failedRecorder, failed := callCancelRun(t, handler, "retry-cancel-run")
	if failedRecorder.Code != http.StatusServiceUnavailable || failed.Success || failed.ErrorCode != "run_session_cleanup_failed" {
		t.Fatalf("failed cleanup response: status=%d body=%s", failedRecorder.Code, failedRecorder.Body.String())
	}
	if _, exists := base.Get("retry-cancel-run"); !exists {
		t.Fatal("failed cancellation lost its persistent retry state")
	}
	if current := channels.GetOrCreate("retry-cancel-run", false); current != originalChannel {
		t.Fatal("failed cancellation released or replaced its channel generation")
	}

	retryRecorder, retried := callCancelRun(t, handler, "retry-cancel-run")
	if retryRecorder.Code != http.StatusOK || !retried.Success || retried.Data.Status != "cancelled" {
		t.Fatalf("retry cleanup response: status=%d body=%s", retryRecorder.Code, retryRecorder.Body.String())
	}
	if _, exists := base.Get("retry-cancel-run"); exists {
		t.Fatal("successful cancellation retry retained its session")
	}
	if current := channels.GetOrCreate("retry-cancel-run", false); current != nil {
		t.Fatal("successful cancellation retry retained its channel")
	}
}

func TestCleanupExpiredRunsRetriesFailedStartedCleanup(t *testing.T) {
	base := storage.NewMemorySessionStore()
	deleteErr := errors.New("database is temporarily read-only")
	store := &deleteFailingSessionStore{MemorySessionStore: base, deleteErr: deleteErr, failures: 1}
	channels := session.NewChannelManager()
	if _, err := base.Create(&model.RunSession{RunID: "started-cleanup-retry", UserID: "default"}); err != nil {
		t.Fatal(err)
	}
	if err := base.MarkStarted("started-cleanup-retry"); err != nil {
		t.Fatal(err)
	}
	owned := channels.GetOrCreate("started-cleanup-retry", true)
	owned.Close()
	if err := channels.CleanupRun("started-cleanup-retry", owned, store); !errors.Is(err, deleteErr) {
		t.Fatalf("first cleanup error = %v, want %v", err, deleteErr)
	}

	if expired := CleanupExpiredRuns(store, channels, time.Hour); len(expired) != 0 {
		t.Fatalf("started cleanup retry was treated as TTL expiry: %v", expired)
	}
	if _, exists := base.Get("started-cleanup-retry"); exists {
		t.Fatal("periodic cleanup retained the failed started session")
	}
	if current := channels.GetOrCreate("started-cleanup-retry", false); current != nil {
		t.Fatal("periodic cleanup retained the failed channel generation")
	}
}

func TestCancelRunRemovesOwnedPendingSessionAndChannel(t *testing.T) {
	handler, store, channels := newCancelRunTestHandler(t)
	store.Create(&model.RunSession{RunID: "pending-run", UserID: "default"})
	channels.GetOrCreate("pending-run", true)

	recorder, response := callCancelRun(t, handler, "pending-run")
	if recorder.Code != http.StatusOK || !response.Success || response.Data.Status != "cancelled" || response.Data.RequiresWebSocketCancel {
		t.Fatalf("unexpected response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, exists := store.Get("pending-run"); exists {
		t.Fatal("pending session was not removed")
	}
	if channel := channels.GetOrCreate("pending-run", false); channel != nil {
		t.Fatal("pending channel was not removed")
	}

	_, repeated := callCancelRun(t, handler, "pending-run")
	if !repeated.Success || repeated.Data.Status != "absent" {
		t.Fatalf("repeated cancellation was not idempotent: %+v", repeated)
	}
}

func TestCancelRunStartedSessionRequiresWebSocketCancellation(t *testing.T) {
	handler, store, channels := newCancelRunTestHandler(t)
	store.Create(&model.RunSession{RunID: "started-run", UserID: "default"})
	if err := store.MarkStarted("started-run"); err != nil {
		t.Fatalf("failed to mark fixture session started: %v", err)
	}
	originalChannel := channels.GetOrCreate("started-run", true)

	recorder, response := callCancelRun(t, handler, "started-run")
	if recorder.Code != http.StatusOK || !response.Success || response.Data.Status != "started" || !response.Data.RequiresWebSocketCancel {
		t.Fatalf("unexpected response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, exists := store.Get("started-run"); !exists {
		t.Fatal("started session was removed")
	}
	if channel := channels.GetOrCreate("started-run", false); channel != originalChannel {
		t.Fatal("started channel was removed or replaced")
	}
}

func TestCancelRunAbsentSessionIsIdempotent(t *testing.T) {
	handler, _, channels := newCancelRunTestHandler(t)
	channels.GetOrCreate("missing-run", true)
	recorder, response := callCancelRun(t, handler, "missing-run")
	if recorder.Code != http.StatusOK || !response.Success || response.Data.Status != "absent" || response.Data.RequiresWebSocketCancel {
		t.Fatalf("unexpected response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if channel := channels.GetOrCreate("missing-run", false); channel != nil {
		t.Fatal("orphan channel was not removed during idempotent cancellation")
	}
}

func TestCancelRunDoesNotRemoveAnotherUsersSession(t *testing.T) {
	handler, store, channels := newCancelRunTestHandler(t)
	store.Create(&model.RunSession{RunID: "other-run", UserID: "other-user"})
	originalChannel := channels.GetOrCreate("other-run", true)

	recorder, response := callCancelRun(t, handler, "other-run")
	if recorder.Code != http.StatusForbidden || response.Success {
		t.Fatalf("unexpected response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, exists := store.Get("other-run"); !exists {
		t.Fatal("another user's session was removed")
	}
	if channel := channels.GetOrCreate("other-run", false); channel != originalChannel {
		t.Fatal("another user's channel was removed or replaced")
	}
}

func TestCancelRunRequiresRunID(t *testing.T) {
	handler, _, _ := newCancelRunTestHandler(t)
	recorder, response := callCancelRun(t, handler, "")
	if recorder.Code != http.StatusBadRequest || response.Success || response.Error != "runId is required" {
		t.Fatalf("unexpected response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestRunIDIsNormalizedAcrossCreateAndCancel(t *testing.T) {
	handler, store, channels := newRunLifecycleHTTPHandler(t)

	creationRecorder, creation := callRunCode(t, handler, "  normalized.run:1  ")
	if creationRecorder.Code != http.StatusOK || !creation.Success || creation.RunID != "normalized.run:1" {
		t.Fatalf("unexpected creation response: status=%d body=%s", creationRecorder.Code, creationRecorder.Body.String())
	}
	if _, exists := store.Get("  normalized.run:1  "); exists {
		t.Fatal("session was stored under the unnormalized run ID")
	}
	if _, exists := store.Get("normalized.run:1"); !exists {
		t.Fatal("session was not stored under the normalized run ID")
	}

	cancelRecorder, cancellation := callCancelRun(t, handler, " normalized.run:1 ")
	if cancelRecorder.Code != http.StatusOK || !cancellation.Success || cancellation.Data.Status != "cancelled" {
		t.Fatalf("unexpected cancellation response: status=%d body=%s", cancelRecorder.Code, cancelRecorder.Body.String())
	}
	if _, exists := store.Get("normalized.run:1"); exists {
		t.Fatal("normalized session was not removed")
	}
	if channel := channels.GetOrCreate("normalized.run:1", false); channel != nil {
		t.Fatal("normalized channel was not removed")
	}
}

func TestRunCodeRejectsInvalidRunID(t *testing.T) {
	handler, store, channels := newRunLifecycleHTTPHandler(t)

	for _, runID := range []string{"   ", "bad/run", "bad run", "bad\nrun"} {
		t.Run(fmt.Sprintf("%q", runID), func(t *testing.T) {
			recorder, response := callRunCode(t, handler, runID)
			if recorder.Code != http.StatusBadRequest || response.Success {
				t.Fatalf("invalid run ID was accepted: status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
	if store.GetActiveCount("default") != 0 {
		t.Fatal("invalid run ID created a session")
	}
	if channel := channels.GetOrCreate("bad/run", false); channel != nil {
		t.Fatal("invalid run ID created a channel")
	}
}

func TestRunCodeRejectsExistingSessionOrChannel(t *testing.T) {
	t.Run("session and channel", func(t *testing.T) {
		handler, store, channels := newRunLifecycleHTTPHandler(t)
		firstRecorder, first := callRunCode(t, handler, "duplicate-run")
		if firstRecorder.Code != http.StatusOK || !first.Success {
			t.Fatalf("initial runCode failed: status=%d body=%s", firstRecorder.Code, firstRecorder.Body.String())
		}
		originalChannel := channels.GetOrCreate("duplicate-run", false)

		secondRecorder, second := callRunCode(t, handler, "duplicate-run")
		if secondRecorder.Code != http.StatusConflict || second.Success || second.Error != "Run ID already exists" {
			t.Fatalf("duplicate run ID was not rejected: status=%d body=%s", secondRecorder.Code, secondRecorder.Body.String())
		}
		sess, exists := store.Get("duplicate-run")
		if !exists || sess.Token != first.Token {
			t.Fatal("duplicate request replaced the original session")
		}
		if channel := channels.GetOrCreate("duplicate-run", false); channel != originalChannel {
			t.Fatal("duplicate request replaced the original channel")
		}
	})

	t.Run("orphan channel", func(t *testing.T) {
		handler, store, channels := newRunLifecycleHTTPHandler(t)
		originalChannel := channels.GetOrCreate("orphan-channel", true)

		recorder, response := callRunCode(t, handler, "orphan-channel")
		if recorder.Code != http.StatusConflict || response.Success || response.Error != "Run ID already exists" {
			t.Fatalf("orphan channel run ID was not rejected: status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		if _, exists := store.Get("orphan-channel"); exists {
			t.Fatal("orphan channel conflict created a session")
		}
		if channel := channels.GetOrCreate("orphan-channel", false); channel != originalChannel {
			t.Fatal("orphan channel conflict replaced the original channel")
		}
	})
}

func TestConcurrentRunCodeWithSameIDCreatesOneHandshake(t *testing.T) {
	handler, store, channels := newRunLifecycleHTTPHandler(t)
	start := make(chan struct{})
	type result struct {
		status   int
		response model.Response
		body     string
		err      error
	}
	results := make(chan result, 2)

	for range 2 {
		go func() {
			<-start
			recorder, response, err := issueRunCode(handler, "concurrent-run")
			if err != nil {
				results <- result{err: err}
				return
			}
			results <- result{status: recorder.Code, response: response, body: recorder.Body.String()}
		}()
	}
	close(start)

	accepted := 0
	conflicted := 0
	for range 2 {
		got := <-results
		if got.err != nil {
			t.Fatal(got.err)
		}
		switch got.status {
		case http.StatusOK:
			if !got.response.Success {
				t.Fatalf("successful status had unsuccessful response: %s", got.body)
			}
			accepted++
		case http.StatusConflict:
			if got.response.Success || got.response.Error != "Run ID already exists" {
				t.Fatalf("unexpected conflict response: %s", got.body)
			}
			conflicted++
		default:
			t.Fatalf("unexpected status=%d body=%s", got.status, got.body)
		}
	}

	if accepted != 1 || conflicted != 1 {
		t.Fatalf("expected one accepted and one conflicted request, got accepted=%d conflicted=%d", accepted, conflicted)
	}
	if store.GetActiveCount("default") != 1 {
		t.Fatal("concurrent duplicate requests did not leave exactly one session")
	}
	if channel := channels.GetOrCreate("concurrent-run", false); channel == nil {
		t.Fatal("accepted concurrent request did not leave a channel")
	}
}

func TestRunHandshakeRejectsSessionPersistenceFailureWithoutOrphanChannel(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		issue func(*testing.T, http.Handler) (*httptest.ResponseRecorder, model.Response)
	}{
		{
			name: "runCode",
			issue: func(t *testing.T, handler http.Handler) (*httptest.ResponseRecorder, model.Response) {
				return callRunCode(t, handler, "storage-failure")
			},
		},
		{
			name: "runTask",
			issue: func(t *testing.T, handler http.Handler) (*httptest.ResponseRecorder, model.Response) {
				return issueTaskRequest(t, handler, validTaskRequest("storage-failure"))
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			handler, _, channels := newRunLifecycleHTTPHandler(t)
			store := &createFailingSessionStore{
				MemorySessionStore: storage.NewMemorySessionStore(),
				createErr:          errors.New("database is read-only"),
			}
			handler.Sessions = store

			recorder, response := testCase.issue(t, handler)
			if recorder.Code != http.StatusServiceUnavailable || response.Success || response.Error != "Failed to persist run session; run was not accepted" || response.ErrorCode != "run_session_persistence_failed" {
				t.Fatalf("unexpected response: status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if _, exists := store.Get("storage-failure"); exists {
				t.Fatal("failed handshake left a session")
			}
			if channel := channels.GetOrCreate("storage-failure", false); channel != nil {
				t.Fatal("failed handshake left an orphan channel")
			}
		})
	}
}

func TestCleanupExpiredRunsRemovesPendingSessionAndChannelTogether(t *testing.T) {
	_, store, channels := newCancelRunTestHandler(t)
	store.Create(&model.RunSession{RunID: "expired-pending-pair", UserID: "default"})
	pendingChannel := channels.GetOrCreate("expired-pending-pair", true)
	store.Create(&model.RunSession{RunID: "expired-started-pair", UserID: "default"})
	if err := store.MarkStarted("expired-started-pair"); err != nil {
		t.Fatalf("failed to mark fixture session started: %v", err)
	}
	startedChannel := channels.GetOrCreate("expired-started-pair", true)
	time.Sleep(time.Millisecond)

	expired := CleanupExpiredRuns(store, channels, 0)
	if len(expired) != 1 || expired[0] != "expired-pending-pair" {
		t.Fatalf("unexpected expired run IDs: %v", expired)
	}
	if _, exists := store.Get("expired-pending-pair"); exists {
		t.Fatal("expired pending session was retained")
	}
	if channel := channels.GetOrCreate("expired-pending-pair", false); channel != nil {
		t.Fatal("expired pending channel was retained")
	}
	pendingClosed := make(chan struct{})
	go func() {
		pendingChannel.WaitUntilClosed()
		close(pendingClosed)
	}()
	select {
	case <-pendingClosed:
	case <-time.After(time.Second):
		t.Fatal("expired pending channel was removed without being closed")
	}

	started, exists := store.Get("expired-started-pair")
	if !exists || !started.Started {
		t.Fatal("started session was removed or reset")
	}
	if channel := channels.GetOrCreate("expired-started-pair", false); channel != startedChannel {
		t.Fatal("started channel was removed or replaced")
	}
}

func TestRunCodeCleansExpiredPendingHandshakeBeforeCreate(t *testing.T) {
	handler, store, channels := newRunLifecycleHTTPHandler(t)
	handler.Config.SessionTTL = 0
	store.Create(&model.RunSession{RunID: "old-pending", UserID: "default"})
	channels.GetOrCreate("old-pending", true)
	store.Create(&model.RunSession{RunID: "old-started", UserID: "default"})
	if err := store.MarkStarted("old-started"); err != nil {
		t.Fatalf("failed to mark fixture session started: %v", err)
	}
	startedChannel := channels.GetOrCreate("old-started", true)
	time.Sleep(time.Millisecond)

	recorder, response := callRunCode(t, handler, "new-run-after-cleanup")
	if recorder.Code != http.StatusOK || !response.Success {
		t.Fatalf("runCode failed: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, exists := store.Get("old-pending"); exists {
		t.Fatal("runCode cleanup retained expired pending session")
	}
	if channel := channels.GetOrCreate("old-pending", false); channel != nil {
		t.Fatal("runCode cleanup retained expired pending channel")
	}
	if _, exists := store.Get("old-started"); !exists {
		t.Fatal("runCode cleanup removed started session")
	}
	if channel := channels.GetOrCreate("old-started", false); channel != startedChannel {
		t.Fatal("runCode cleanup removed or replaced started channel")
	}
	if _, exists := store.Get("new-run-after-cleanup"); !exists {
		t.Fatal("runCode cleanup removed the newly created session")
	}
}
