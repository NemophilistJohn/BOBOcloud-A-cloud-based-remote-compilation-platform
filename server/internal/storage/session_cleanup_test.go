package storage

import (
	"path/filepath"
	"testing"
	"time"

	"bobocloud-server/internal/model"

	bolt "go.etcd.io/bbolt"
)

func TestMemorySessionCleanupKeepsStartedSessions(t *testing.T) {
	store := NewMemorySessionStore()
	assertCleanupKeepsStartedSession(t, store)
}

func TestBoltSessionCleanupKeepsStartedSessions(t *testing.T) {
	db, err := bolt.Open(filepath.Join(t.TempDir(), "sessions.db"), 0o600, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close BoltDB: %v", err)
		}
	})

	store := NewBoltSessionStore(db)
	assertCleanupKeepsStartedSession(t, store)
}

func assertCleanupKeepsStartedSession(t *testing.T, store SessionStore) {
	t.Helper()
	store.Create(&model.RunSession{RunID: "expired-pending", UserID: "user"})
	store.Create(&model.RunSession{RunID: "expired-started", UserID: "user"})
	if !store.MarkStarted("expired-started") {
		t.Fatal("failed to mark fixture session started")
	}

	time.Sleep(time.Millisecond)
	expired := store.CleanupExpired(0)
	if len(expired) != 1 || expired[0] != "expired-pending" {
		t.Fatalf("unexpected expired run IDs: %v", expired)
	}

	if _, exists := store.Get("expired-pending"); exists {
		t.Fatal("expired pending session was not removed")
	}
	started, exists := store.Get("expired-started")
	if !exists || !started.Started {
		t.Fatal("expired started session was removed or reset")
	}
	if repeated := store.CleanupExpired(0); len(repeated) != 0 {
		t.Fatalf("cleanup returned already removed or started sessions: %v", repeated)
	}
}
