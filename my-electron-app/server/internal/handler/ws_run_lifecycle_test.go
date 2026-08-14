package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"

	"github.com/gorilla/websocket"
)

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
