package auth

import (
	"path/filepath"
	"sync"
	"testing"

	bolt "go.etcd.io/bbolt"
)

func forEachUserStore(t *testing.T, run func(t *testing.T, store UserStore)) {
	t.Helper()
	t.Run("memory", func(t *testing.T) {
		run(t, NewMemoryUserStore())
	})
	t.Run("bolt", func(t *testing.T) {
		db, err := bolt.Open(filepath.Join(t.TempDir(), "profile-users.db"), 0600, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = db.Close() })
		run(t, NewBoltUserStore(db))
	})
}

func testUser(id, username, email, key string) *User {
	return &User{ID: id, Username: username, Email: email, APIKey: key, Role: RoleMember}
}

func TestMemoryUserStoreReturnsCopies(t *testing.T) {
	store := NewMemoryUserStore()
	if err := store.Create(testUser("one", "One", "one@example.com", "key-one")); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get("one")
	if err != nil {
		t.Fatal(err)
	}
	got.Role = RoleRoot
	again, _ := store.Get("one")
	if again.Role == RoleRoot {
		t.Fatal("mutating a returned user changed store state without Create")
	}
}

func TestMemoryUserStoreRejectsDuplicateIndexes(t *testing.T) {
	store := NewMemoryUserStore()
	if err := store.Create(testUser("one", "One", "one@example.com", "key-one")); err != nil {
		t.Fatal(err)
	}
	duplicates := []*User{
		testUser("two", "ONE", "two@example.com", "key-two"),
		testUser("two", "Two", "ONE@example.com", "key-two"),
		testUser("two", "Two", "two@example.com", "key-one"),
	}
	for _, user := range duplicates {
		if err := store.Create(user); err == nil {
			t.Fatalf("expected duplicate index rejection for %+v", user)
		}
	}
}

func TestBoltUserStoreRejectsDuplicateIndexes(t *testing.T) {
	db, err := bolt.Open(filepath.Join(t.TempDir(), "users.db"), 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := NewBoltUserStore(db)
	if err := store.Create(testUser("one", "One", "one@example.com", "key-one")); err != nil {
		t.Fatal(err)
	}
	if err := store.Create(testUser("two", "ONE", "two@example.com", "key-two")); err == nil {
		t.Fatal("expected duplicate username rejection")
	}
	if err := store.Create(testUser("two", "Two", "ONE@example.com", "key-two")); err == nil {
		t.Fatal("expected duplicate email rejection")
	}
	if err := store.Create(testUser("two", "Two", "two@example.com", "key-one")); err == nil {
		t.Fatal("expected duplicate API key rejection")
	}
}

func TestUserStoreUpdateProfilePreservesConcurrentAdministrativeFields(t *testing.T) {
	forEachUserStore(t, func(t *testing.T, store UserStore) {
		original := testUser("profile-user", "Profile", "profile@example.com", "profile-key")
		original.Name = "Before"
		original.Avatar = "ocean"
		original.ContainerLimit = 1
		original.RateLimit = 10
		original.DiskQuotaMB = 100
		if err := store.Create(original); err != nil {
			t.Fatal(err)
		}
		staleRequestSnapshot, err := store.Get(original.ID)
		if err != nil {
			t.Fatal(err)
		}

		adminCommitted := make(chan struct{})
		var wg sync.WaitGroup
		var adminErr, profileErr error
		var patched *User
		wg.Add(2)
		go func() {
			defer wg.Done()
			latest, err := store.Get(original.ID)
			if err == nil {
				latest.Role = RoleAdmin
				latest.Disabled = true
				latest.ContainerLimit = 7
				latest.RateLimit = 77
				latest.DiskQuotaMB = 2048
				err = store.Create(latest)
			}
			adminErr = err
			close(adminCommitted)
		}()
		go func() {
			defer wg.Done()
			<-adminCommitted
			// The request still owns the pre-admin snapshot. UpdateProfile must
			// identify the account by ID and patch the latest stored record.
			patched, profileErr = store.UpdateProfile(staleRequestSnapshot.ID, "After", "forest")
		}()
		wg.Wait()
		if adminErr != nil || profileErr != nil {
			t.Fatalf("admin update err=%v, profile update err=%v", adminErr, profileErr)
		}

		stored, err := store.Get(original.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, user := range []*User{patched, stored} {
			if user.Name != "After" || user.Avatar != "forest" || user.Role != RoleAdmin || !user.Disabled ||
				user.ContainerLimit != 7 || user.RateLimit != 77 || user.DiskQuotaMB != 2048 {
				t.Fatalf("profile patch reverted administrative fields: %+v", user)
			}
		}
	})
}

func TestUserStoreRestoreRecreatesExactRecordAndIndexes(t *testing.T) {
	forEachUserStore(t, func(t *testing.T, store UserStore) {
		original := testUser("restore-user", "Restore", "restore@example.com", "restore-key")
		original.UID = "u_restore"
		original.Name = "Restored user"
		original.Avatar = "forest"
		original.Disabled = true
		original.ContainerLimit = 7
		original.RateLimit = 77
		original.DiskQuotaMB = 2048
		if err := store.Create(original); err != nil {
			t.Fatal(err)
		}
		stored, err := store.Get(original.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.DeleteWithCleanupMarker(original.ID); err != nil {
			t.Fatal(err)
		}
		pending, err := store.ListDeletionCleanup()
		if err != nil || len(pending) != 1 || pending[0] != original.ID {
			t.Fatalf("atomic deletion marker = %v, err=%v", pending, err)
		}
		if err := store.Restore(stored); err != nil {
			t.Fatal(err)
		}
		pending, err = store.ListDeletionCleanup()
		if err != nil || len(pending) != 0 {
			t.Fatalf("restore retained deletion marker = %v, err=%v", pending, err)
		}
		for label, lookup := range map[string]func() (*User, error){
			"id":       func() (*User, error) { return store.Get(original.ID) },
			"uid":      func() (*User, error) { return store.GetByUID(original.UID) },
			"username": func() (*User, error) { return store.GetByUsername(original.Username) },
			"email":    func() (*User, error) { return store.GetByEmail(original.Email) },
			"api key":  func() (*User, error) { return store.GetByAPIKey(original.APIKey) },
		} {
			got, err := lookup()
			if err != nil {
				t.Fatalf("%s lookup after restore: %v", label, err)
			}
			if *got != *stored {
				t.Fatalf("%s lookup restored %+v, want %+v", label, got, stored)
			}
		}
	})
}

func TestUserDeletionCleanupMarkerLifecycle(t *testing.T) {
	forEachUserStore(t, func(t *testing.T, store UserStore) {
		for _, userID := range []string{"user-b", "user-a"} {
			if err := store.SaveDeletionCleanup(userID); err != nil {
				t.Fatal(err)
			}
		}
		pending, err := store.ListDeletionCleanup()
		if err != nil {
			t.Fatal(err)
		}
		if len(pending) != 2 || pending[0] != "user-a" || pending[1] != "user-b" {
			t.Fatalf("pending markers = %v", pending)
		}
		if err := store.DeleteDeletionCleanup("user-a"); err != nil {
			t.Fatal(err)
		}
		pending, err = store.ListDeletionCleanup()
		if err != nil || len(pending) != 1 || pending[0] != "user-b" {
			t.Fatalf("markers after delete = %v, err=%v", pending, err)
		}
		if err := store.Create(testUser("user-b", "Pending", "pending@example.com", "pending-key")); err == nil {
			t.Fatal("store recreated an account while deletion cleanup was pending")
		}
	})
}

func TestBoltUserDeletionCleanupMarkerSurvivesStoreRecreation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cleanup-restart.db")
	db, err := bolt.Open(path, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	store := NewBoltUserStore(db)
	original := testUser("restart-user", "Restart", "restart@example.com", "restart-key")
	original.UID = "u_restart"
	if err := store.Create(original); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteWithCleanupMarker(original.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = bolt.Open(path, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	restarted := NewBoltUserStore(db)
	pending, err := restarted.ListDeletionCleanup()
	if err != nil || len(pending) != 1 || pending[0] != original.ID {
		t.Fatalf("marker after restart = %v, err=%v", pending, err)
	}
	for label, lookup := range map[string]func() (*User, error){
		"id":       func() (*User, error) { return restarted.Get(original.ID) },
		"uid":      func() (*User, error) { return restarted.GetByUID(original.UID) },
		"username": func() (*User, error) { return restarted.GetByUsername(original.Username) },
		"email":    func() (*User, error) { return restarted.GetByEmail(original.Email) },
		"api key":  func() (*User, error) { return restarted.GetByAPIKey(original.APIKey) },
	} {
		if _, err := lookup(); err == nil {
			t.Fatalf("%s index survived atomic deletion", label)
		}
	}
}
