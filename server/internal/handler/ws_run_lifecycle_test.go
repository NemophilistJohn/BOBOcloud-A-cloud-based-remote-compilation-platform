package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/files"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"

	"github.com/gorilla/websocket"
)

type markStartedFailingSessionStore struct {
	*storage.MemorySessionStore
	startErr error
}

type wsDeleteFailingSessionStore struct {
	*storage.MemorySessionStore
	mu          sync.Mutex
	deleteErr   error
	deleteOK    bool
	deleteCalls int
}

func TestRunTerminationStatusDistinguishesDeadlineAndRevocation(t *testing.T) {
	deadlineCtx, cancelDeadline := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancelDeadline()
	timedOut := &model.RunResult{Success: true}
	applyRunTerminationStatus(deadlineCtx, timedOut)
	if !timedOut.TimedOut || timedOut.Cancelled || timedOut.Success || timedOut.ReturnCode != 124 {
		t.Fatalf("deadline result = %+v", timedOut)
	}

	revokedCtx, revoke := context.WithCancelCause(context.Background())
	revoke(errors.New("account revoked"))
	cancelled := &model.RunResult{Success: true}
	applyRunTerminationStatus(revokedCtx, cancelled)
	if !cancelled.Cancelled || cancelled.TimedOut || cancelled.Success || cancelled.ReturnCode != 130 {
		t.Fatalf("revoked result = %+v", cancelled)
	}
}

type wsTransientGetSessionStore struct {
	*wsDeleteFailingSessionStore
	mu        sync.Mutex
	failures  int
	lookupErr error
}

func (store *wsTransientGetSessionStore) Lookup(runID string) (*model.RunSession, bool, error) {
	store.mu.Lock()
	if store.failures > 0 {
		store.failures--
		lookupErr := store.lookupErr
		store.mu.Unlock()
		return nil, false, lookupErr
	}
	store.mu.Unlock()
	return store.MemorySessionStore.Lookup(runID)
}

func (store *wsDeleteFailingSessionStore) Delete(runID string) error {
	store.mu.Lock()
	store.deleteCalls++
	deleteOK := store.deleteOK
	deleteErr := store.deleteErr
	store.mu.Unlock()
	if !deleteOK {
		return deleteErr
	}
	return store.MemorySessionStore.Delete(runID)
}

func (store *wsDeleteFailingSessionStore) allowDelete() {
	store.mu.Lock()
	store.deleteOK = true
	store.mu.Unlock()
}

func (store *wsDeleteFailingSessionStore) calls() int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.deleteCalls
}

func (s *markStartedFailingSessionStore) MarkStarted(string) error {
	return s.startErr
}

func TestWSAttachInvalidTokenKeepsPendingRun(t *testing.T) {
	store := storage.NewMemorySessionStore()
	channels := session.NewChannelManager()
	store.Create(&model.RunSession{RunID: "valid-run", Token: "valid-token", UserID: "default"})
	originalChannel := channels.GetOrCreate("valid-run", true)
	handler := &WSHandler{Config: config.Default(), Sessions: store, Channels: channels}

	server := httptest.NewServer(http.HandlerFunc(handler.HandleWebSocket))
	t.Cleanup(server.Close)
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(model.WSMessage{Type: "attach", RunID: "valid-run", Token: "wrong-token"}); err != nil {
		conn.Close()
		t.Fatal(err)
	}
	_, _, _ = conn.ReadMessage()
	_ = conn.Close()

	sess, exists := store.Get("valid-run")
	if !exists || sess.Started {
		t.Fatal("invalid token removed or started the pending session")
	}
	if channel := channels.GetOrCreate("valid-run", false); channel != originalChannel {
		t.Fatal("invalid token removed or replaced the pending channel")
	}
}

func TestWSAttachStorageFailureKeepsRetryablePendingRun(t *testing.T) {
	baseStore := storage.NewMemorySessionStore()
	if _, err := baseStore.Create(&model.RunSession{RunID: "valid-run", Token: "valid-token", UserID: "default"}); err != nil {
		t.Fatal(err)
	}
	store := &markStartedFailingSessionStore{MemorySessionStore: baseStore, startErr: errors.New("database is read-only")}
	channels := session.NewChannelManager()
	originalChannel := channels.GetOrCreate("valid-run", true)
	handler := &WSHandler{Config: config.Default(), Sessions: store, Channels: channels}

	server := httptest.NewServer(http.HandlerFunc(handler.HandleWebSocket))
	t.Cleanup(server.Close)
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.WriteJSON(model.WSMessage{Type: "attach", RunID: "valid-run", Token: "valid-token"}); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := conn.ReadJSON(&response); err != nil {
		t.Fatal(err)
	}
	if response["type"] != "error" || response["message"] != "Run session storage is unavailable" {
		t.Fatalf("unexpected response: %#v", response)
	}

	sess, exists := store.Get("valid-run")
	if !exists || sess.Started {
		t.Fatal("storage failure removed or started the pending session")
	}
	if channel := channels.GetOrCreate("valid-run", false); channel != originalChannel {
		t.Fatal("storage failure removed or replaced the retryable channel")
	}
}

func TestWSAttachClosedGenerationNeverStartsRunAndCleanupRetries(t *testing.T) {
	baseStore := storage.NewMemorySessionStore()
	if _, err := baseStore.Create(&model.RunSession{
		RunID: "cancelled-run", Token: "valid-token", UserID: "default",
	}); err != nil {
		t.Fatal(err)
	}
	store := &wsDeleteFailingSessionStore{
		MemorySessionStore: baseStore,
		deleteErr:          errors.New("database is temporarily read-only"),
	}
	channels := session.NewChannelManager()
	closedChannel := channels.GetOrCreate("cancelled-run", true)
	closedChannel.Close()
	handler := &WSHandler{Config: config.Default(), Sessions: store, Channels: channels}
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		handler.HandleWebSocket(w, r)
	}))
	t.Cleanup(server.Close)

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(model.WSMessage{Type: "attach", RunID: "cancelled-run", Token: "valid-token"}); err != nil {
		_ = conn.Close()
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	_, _, _ = conn.ReadMessage()
	_ = conn.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("closed-generation attach did not terminate")
	}
	if got := store.calls(); got != 1 {
		t.Fatalf("persistent cleanup calls = %d, want 1; run execution likely continued after attach rejection", got)
	}
	stored, exists := baseStore.Get("cancelled-run")
	if !exists || !stored.Started {
		t.Fatal("failed attach cleanup lost its retryable started session")
	}
	if current := channels.GetOrCreate("cancelled-run", false); current != closedChannel {
		t.Fatal("failed attach cleanup released its generation anchor")
	}

	store.allowDelete()
	if err := channels.RetryPendingCleanups(store); err != nil {
		t.Fatal(err)
	}
	if _, exists := baseStore.Get("cancelled-run"); exists {
		t.Fatal("cleanup retry retained the rejected started session")
	}
	if current := channels.GetOrCreate("cancelled-run", false); current != nil {
		t.Fatal("cleanup retry retained the rejected channel")
	}
}

func TestWSTransientLookupFailureDoesNotCloseActiveGeneration(t *testing.T) {
	baseStore := storage.NewMemorySessionStore()
	if _, err := baseStore.Create(&model.RunSession{
		RunID: "transient-read-run", Token: "valid-token", UserID: "default",
	}); err != nil {
		t.Fatal(err)
	}
	if err := baseStore.MarkStarted("transient-read-run"); err != nil {
		t.Fatal(err)
	}
	deleteStore := &wsDeleteFailingSessionStore{
		MemorySessionStore: baseStore,
		deleteErr:          errors.New("delete must not be called"),
	}
	store := &wsTransientGetSessionStore{
		wsDeleteFailingSessionStore: deleteStore,
		failures:                    1,
		lookupErr:                   errors.New("database is temporarily read-only"),
	}
	channels := session.NewChannelManager()
	originalChannel := channels.GetOrCreate("transient-read-run", true)
	handler := &WSHandler{Config: config.Default(), Sessions: store, Channels: channels}
	done := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.HandleWebSocket(w, r)
		done <- struct{}{}
	}))
	t.Cleanup(server.Close)
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(model.WSMessage{Type: "attach", RunID: "transient-read-run", Token: "valid-token"}); err != nil {
		_ = conn.Close()
		t.Fatal(err)
	}
	var response map[string]any
	if err := conn.ReadJSON(&response); err != nil {
		_ = conn.Close()
		t.Fatal(err)
	}
	_ = conn.Close()
	if response["type"] != "error" || response["message"] != "Run session storage is unavailable" {
		t.Fatalf("unexpected response: %#v", response)
	}
	waitForWSHandler(t, done)

	stored, exists := baseStore.Get("transient-read-run")
	if !exists || !stored.Started {
		t.Fatal("transient lookup failure changed the active persistent session")
	}
	if current := channels.GetOrCreate("transient-read-run", false); current != originalChannel {
		t.Fatal("transient lookup failure replaced the active generation")
	}
	if got := deleteStore.calls(); got != 0 {
		t.Fatalf("persistent cleanup calls = %d, want 0", got)
	}
	closed := make(chan struct{})
	go func() {
		originalChannel.WaitUntilClosed()
		close(closed)
	}()
	select {
	case <-closed:
		t.Fatal("transient lookup failure closed the active generation")
	default:
	}
	originalChannel.Close()
	<-closed
}

func waitForWSHandler(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("WebSocket handler did not terminate")
	}
}

func TestShouldPublishRunArtifacts(t *testing.T) {
	t.Run("completed", func(t *testing.T) {
		if !shouldPublishRunArtifacts(context.Background(), &model.RunResult{}) {
			t.Fatal("completed run should publish artifacts")
		}
	})

	t.Run("cancelled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if shouldPublishRunArtifacts(ctx, &model.RunResult{}) {
			t.Fatal("cancelled run should not publish artifacts")
		}
	})

	t.Run("deadline", func(t *testing.T) {
		ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
		defer cancel()
		if shouldPublishRunArtifacts(ctx, &model.RunResult{}) {
			t.Fatal("run past its context deadline should not publish artifacts")
		}
	})

	t.Run("runner timeout", func(t *testing.T) {
		if shouldPublishRunArtifacts(context.Background(), &model.RunResult{TimedOut: true}) {
			t.Fatal("timed out run should not publish artifacts")
		}
	})
}

func TestArtifactOmissionWarning(t *testing.T) {
	if message := artifactOmissionWarning(context.Background(), files.ArtifactSyncResult{}); message != "" {
		t.Fatalf("empty result warning=%q", message)
	}
	if message := artifactOmissionWarning(context.Background(), files.ArtifactSyncResult{OmittedFiles: 2}); !strings.Contains(message, "2 known files") {
		t.Fatalf("omission warning=%q", message)
	}
	if message := artifactOmissionWarning(context.Background(), files.ArtifactSyncResult{ScanTruncated: true}); !strings.Contains(message, "before all entries") {
		t.Fatalf("truncation warning=%q", message)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if message := artifactOmissionWarning(ctx, files.ArtifactSyncResult{OmittedFiles: 2, ScanTruncated: true}); message != "" {
		t.Fatalf("cancelled warning=%q", message)
	}
}

func TestRunArtifactScanUsesWorkspaceCopyTraversalBudget(t *testing.T) {
	cfg := &config.Config{
		ArtifactMaxFiles: 17, ArtifactMaxTotalBytes: 1234,
		WorkspaceCopyMaxFiles: 20_000, WorkspaceCopyMaxTotalBytes: 1 << 30, WorkspaceCopyMaxPathBytes: 2048,
	}
	limits := runArtifactLimits(cfg)
	if limits.MaxFiles != 17 || limits.MaxTotalBytes != 1234 || limits.MaxPathBytes != 2048 {
		t.Fatalf("artifact limits=%+v", limits)
	}
	if limits.MaxScanEntries <= 4096 {
		t.Fatalf("artifact scan budget did not inherit workspace traversal bounds: %+v", limits)
	}
}
