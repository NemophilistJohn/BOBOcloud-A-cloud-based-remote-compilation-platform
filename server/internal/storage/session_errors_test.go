package storage

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

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
	if sessions, err := store.GetByUser("user"); err == nil || sessions != nil {
		t.Fatalf("GetByUser after database close = sessions %v, error %v; want storage error", sessions, err)
	}
	if count, err := store.GetActiveCount("user"); err == nil || count != 0 {
		t.Fatalf("GetActiveCount after database close = count %d, error %v; want storage error", count, err)
	}
	if expired, err := store.CleanupExpired(0); err == nil || expired != nil {
		t.Fatalf("CleanupExpired after database close = expired %v, error %v; want storage error", expired, err)
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
			count, err := store.GetActiveCount("")
			if err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatal("process-bound sessions survived recovery")
			}
		})
	}
}

func TestSessionStoreUserQueries(t *testing.T) {
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
			for _, sess := range []*model.RunSession{
				{RunID: name + "-user-a-1", UserID: "user-a"},
				{RunID: name + "-user-b", UserID: "user-b"},
				{RunID: name + "-user-a-2", UserID: "user-a"},
			} {
				if _, err := store.Create(sess); err != nil {
					t.Fatal(err)
				}
			}

			sessions, err := store.GetByUser("user-a")
			if err != nil {
				t.Fatal(err)
			}
			if len(sessions) != 2 {
				t.Fatalf("GetByUser returned %d sessions, want 2", len(sessions))
			}
			for _, sess := range sessions {
				if sess.UserID != "user-a" {
					t.Fatalf("GetByUser returned another user's session: %+v", sess)
				}
			}

			count, err := store.GetActiveCount("user-a")
			if err != nil {
				t.Fatal(err)
			}
			if count != 2 {
				t.Fatalf("GetActiveCount = %d, want 2", count)
			}
		})
	}
}

func TestBoltSessionStoreUserQueriesRejectUnreadableState(t *testing.T) {
	newStore := func(t *testing.T) (*bolt.DB, *BoltSessionStore) {
		t.Helper()
		db, err := bolt.Open(filepath.Join(t.TempDir(), "sessions.db"), 0o600, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = db.Close() })
		store, err := NewBoltSessionStore(db)
		if err != nil {
			t.Fatal(err)
		}
		return db, store
	}

	t.Run("missing bucket", func(t *testing.T) {
		db, store := newStore(t)
		if err := db.Update(func(tx *bolt.Tx) error { return tx.DeleteBucket(sessionsBucket) }); err != nil {
			t.Fatal(err)
		}
		assertSessionScansFail(t, store, errSessionsBucketUnavailable)
	})

	t.Run("corrupt record", func(t *testing.T) {
		db, store := newStore(t)
		if err := db.Update(func(tx *bolt.Tx) error {
			bucket := tx.Bucket(sessionsBucket)
			expired, err := json.Marshal(&model.RunSession{
				RunID:     "aa-expired-run",
				UserID:    "user",
				CreatedAt: time.Now().Add(-time.Hour),
			})
			if err != nil {
				return err
			}
			if err := bucket.Put([]byte("aa-expired-run"), expired); err != nil {
				return err
			}
			valid, err := json.Marshal(&model.RunSession{RunID: "valid-run", UserID: "user"})
			if err != nil {
				return err
			}
			if err := bucket.Put([]byte("valid-run"), valid); err != nil {
				return err
			}
			return bucket.Put([]byte("zz-corrupt-run"), []byte("{"))
		}); err != nil {
			t.Fatal(err)
		}
		assertSessionScansFail(t, store, nil)
		if _, found, err := store.Lookup("aa-expired-run"); err != nil || !found {
			t.Fatalf("failed cleanup transaction did not roll back earlier delete: found=%v error=%v", found, err)
		}
	})
}

func assertSessionScansFail(t *testing.T, store SessionStore, target error) {
	t.Helper()
	sessions, err := store.GetByUser("user")
	if err == nil || sessions != nil {
		t.Fatalf("GetByUser = sessions %v, error %v; want error %v", sessions, err, target)
	}
	if target != nil && !errors.Is(err, target) {
		t.Fatalf("GetByUser error = %v, want wrapped %v", err, target)
	}

	count, err := store.GetActiveCount("user")
	if err == nil || count != 0 {
		t.Fatalf("GetActiveCount = count %d, error %v; want error %v", count, err, target)
	}
	if target != nil && !errors.Is(err, target) {
		t.Fatalf("GetActiveCount error = %v, want wrapped %v", err, target)
	}

	expired, err := store.CleanupExpired(0)
	if err == nil || expired != nil {
		t.Fatalf("CleanupExpired = expired %v, error %v; want error %v", expired, err, target)
	}
	if target != nil && !errors.Is(err, target) {
		t.Fatalf("CleanupExpired error = %v, want wrapped %v", err, target)
	}
}
