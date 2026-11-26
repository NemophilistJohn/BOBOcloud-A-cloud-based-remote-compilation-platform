package auth

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

func TestBoltDeviceSessionsListAndRevokeLegacySession(t *testing.T) {
	db, err := bolt.Open(filepath.Join(t.TempDir(), "sessions.db"), 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := NewBoltAuthSessionStore(db)
	current, err := store.CreateForDevice("user-1", "BOBOCLOUD desktop", "windows", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	legacy := &AuthSession{Token: "legacy-session-token", UserID: "user-1", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)}
	encoded, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(authSessionsBucket).Put([]byte(legacy.Token), encoded)
	}); err != nil {
		t.Fatal(err)
	}

	devices, err := store.ListByUser("user-1")
	if err != nil || len(devices) != 2 {
		t.Fatalf("device list size=%d err=%v", len(devices), err)
	}
	legacyID := sessionDeviceID(legacy)
	foundLegacy := false
	for _, device := range devices {
		if device.ID == legacyID {
			foundLegacy = true
			if device.Token != legacy.Token {
				t.Fatal("legacy session token changed")
			}
		}
	}
	if !foundLegacy {
		t.Fatal("legacy session has no stable device identifier")
	}
	if err := store.RevokeDevice("user-1", current.ID, current.Token); err == nil {
		t.Fatal("current device was revoked")
	}
	if err := store.RevokeDevice("user-1", legacyID, current.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Validate(legacy.Token, time.Hour); err == nil {
		t.Fatal("revoked legacy session remained valid")
	}
	if _, err := store.Validate(current.Token, time.Hour); err != nil {
		t.Fatalf("current session was revoked: %v", err)
	}
}
