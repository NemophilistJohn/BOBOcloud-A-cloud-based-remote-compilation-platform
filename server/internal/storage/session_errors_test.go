package storage

import (
	"errors"
	"path/filepath"
	"testing"

	"bobocloud-server/internal/model"

	bolt "go.etcd.io/bbolt"
)

func TestMemorySessionStoreMarkStartedErrorsAreDistinct(t *testing.T) {
	store := NewMemorySessionStore()
	if _, err := store.Create(&model.RunSession{RunID: "run"}); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkStarted("run"); err != nil {
		t.Fatalf("first claim failed: %v", err)
	}
	if err := store.MarkStarted("run"); !errors.Is(err, ErrSessionAlreadyStarted) {
		t.Fatalf("second claim error = %v, want ErrSessionAlreadyStarted", err)
	}
	if err := store.MarkStarted("missing"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing claim error = %v, want ErrSessionNotFound", err)
	}
}

func TestBoltSessionStoreReportsInitializationAndWriteErrors(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "sessions.db")
	db, err := bolt.Open(dbPath, 0o600, nil)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewBoltSessionStore(db)
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := store.Create(&model.RunSession{RunID: "run"}); err == nil {
		t.Fatal("Create succeeded after the database was closed")
	}
	if _, found, err := store.Lookup("run"); err == nil || found {
		t.Fatalf("Lookup after database close = found %v, error %v; want storage error", found, err)
	}
	if err := store.MarkStarted("run"); err == nil || errors.Is(err, ErrSessionNotFound) || errors.Is(err, ErrSessionAlreadyStarted) {
		t.Fatalf("MarkStarted error = %v, want a storage error", err)
	}
	if err := store.Delete("run"); err == nil {
		t.Fatal("Delete succeeded after the database was closed")
	}
	if _, err := NewBoltSessionStore(db); err == nil {
		t.Fatal("constructor hid the closed database initialization error")
	}
}

func TestBoltSessionStoreDeleteIsIdempotent(t *testing.T) {
	db, err := bolt.Open(filepath.Join(t.TempDir(), "sessions.db"), 0o600, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	store, err := NewBoltSessionStore(db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(&model.RunSession{RunID: "delete-run", Token: "generation-a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete("delete-run"); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete("delete-run"); err != nil {
		t.Fatalf("repeated delete was not idempotent: %v", err)
	}
	if _, exists := store.Get("delete-run"); exists {
		t.Fatal("deleted Bolt session still exists")
	}
}

func TestBoltSessionStoreMarkStartedErrorsAreDistinct(t *testing.T) {
	db, err := bolt.Open(filepath.Join(t.TempDir(), "sessions.db"), 0o600, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	store, err := NewBoltSessionStore(db)
	if err != nil {
		t.Fatal(err)
	}

	if err := store.MarkStarted("missing"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing claim error = %v, want ErrSessionNotFound", err)
	}
	if _, err := store.Create(&model.RunSession{RunID: "run"}); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkStarted("run"); err != nil {
		t.Fatalf("first claim failed: %v", err)
	}
	if err := store.MarkStarted("run"); !errors.Is(err, ErrSessionAlreadyStarted) {
		t.Fatalf("second claim error = %v, want ErrSessionAlreadyStarted", err)
	}
}

func TestSessionStoresDeleteProcessBoundState(t *testing.T) {
	db, err := bolt.Open(filepath.Join(t.TempDir(), "sessions.db"), 0o600, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	boltStore, err := NewBoltSessionStore(db)
	if err != nil {
		t.Fatal(err)
	}
	stores := map[string]SessionStore{
		"memory": NewMemorySessionStore(),
		"bolt":   boltStore,
	}
	for name, store := range stores {
		t.Run(name, func(t *testing.T) {
			if _, err := store.Create(&model.RunSession{RunID: name + "-pending"}); err != nil {
				t.Fatal(err)
			}
			startedID := name + "-started"
			if _, err := store.Create(&model.RunSession{RunID: startedID}); err != nil {
				t.Fatal(err)
			}
			if err := store.MarkStarted(startedID); err != nil {
				t.Fatal(err)
			}
			ids, err := store.DeleteAllProcessSessions()
			if err != nil {
				t.Fatal(err)
			}
			if len(ids) != 2 || ids[0] != name+"-pending" || ids[1] != startedID {
				t.Fatalf("deleted IDs = %v", ids)
			}
			if store.GetActiveCount("") != 0 {
				t.Fatal("process-bound sessions survived recovery")
			}
		})
	}
}
