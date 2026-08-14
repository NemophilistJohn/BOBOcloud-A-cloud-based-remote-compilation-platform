package auth

import "testing"

func TestEnsureSocialIdentitiesBackfillsAndKeepsUIDImmutable(t *testing.T) {
	store := NewMemoryUserStore()
	user := &User{ID: "legacy", Username: "legacy", APIKey: "legacy-key"}
	if err := store.Create(user); err != nil {
		t.Fatal(err)
	}
	if err := EnsureSocialIdentities(store); err != nil {
		t.Fatal(err)
	}
	migrated, err := store.Get("legacy")
	if err != nil {
		t.Fatal(err)
	}
	if migrated.UID == "" || migrated.Avatar == "" {
		t.Fatalf("identity not migrated: %+v", migrated)
	}
	original := migrated.UID
	migrated.UID = GeneratePublicUID()
	if err := store.Create(migrated); err == nil {
		t.Fatal("public UID was mutable")
	}
	stored, _ := store.Get("legacy")
	if stored.UID != original {
		t.Fatal("stored UID changed")
	}
}
