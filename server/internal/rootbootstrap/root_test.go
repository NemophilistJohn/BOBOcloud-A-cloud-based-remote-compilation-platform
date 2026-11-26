package rootbootstrap

import (
	"os"
	"path/filepath"
	"testing"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
)

func TestEnsureCreatesUnclaimedRootWithoutPasswordFile(t *testing.T) {
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	cfg.RootUser.Username = "root"
	cfg.RootUser.Password = "legacy-config-value"
	store := auth.NewMemoryUserStore()

	created, err := Ensure(cfg, store)
	if err != nil || created == nil {
		t.Fatalf("Ensure() created=%v err=%v", created, err)
	}
	if created.PasswordHash != "" {
		t.Fatal("new root account must wait for claim-link password setup")
	}
	if _, err := os.Stat(CredentialPath(cfg.DataDir)); !os.IsNotExist(err) {
		t.Fatalf("generated root password file exists: %v", err)
	}
	if repeated, err := Ensure(cfg, store); err != nil || repeated != nil {
		t.Fatalf("repeated Ensure()=%v err=%v", repeated, err)
	}
}

func TestEnsurePreservesExistingRootPassword(t *testing.T) {
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	cfg.RootUser.Username = "root"
	cfg.RootUser.Password = "replacement-from-config"
	store := auth.NewMemoryUserStore()
	hash, err := auth.HashPassword("existing-password")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Create(&auth.User{ID: "root", Username: "root", Role: auth.RoleRoot, PasswordHash: hash}); err != nil {
		t.Fatal(err)
	}

	if created, err := Ensure(cfg, store); err != nil || created != nil {
		t.Fatalf("Ensure() created=%v err=%v", created, err)
	}
	stored, err := store.Get("root")
	if err != nil || stored.PasswordHash != hash || !auth.CheckPassword(stored.PasswordHash, "existing-password") {
		t.Fatalf("existing password changed: err=%v", err)
	}
}

func TestRemoveLegacyCredentialFile(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Dir(CredentialPath(dataDir)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(CredentialPath(dataDir), []byte("legacy"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := RemoveCredentialFile(dataDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(CredentialPath(dataDir)); !os.IsNotExist(err) {
		t.Fatalf("legacy credential file remains: %v", err)
	}
}
