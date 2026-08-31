package rootbootstrap

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
)

func TestEnsurePersistsAndReusesGeneratedCredential(t *testing.T) {
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	cfg.RootUser.Username = "root"
	store := auth.NewMemoryUserStore()
	created, err := Ensure(cfg, store)
	if err != nil || created == nil {
		t.Fatalf("Ensure() created=%v err=%v", created, err)
	}
	credential, err := readCredentials(cfg.DataDir, "root")
	if err != nil || !auth.CheckPassword(created.PasswordHash, credential.Password) {
		t.Fatalf("credential does not unlock root: err=%v", err)
	}
	info, err := os.Stat(CredentialPath(cfg.DataDir))
	if err != nil || runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatalf("credential info=%v err=%v", info, err)
	}
	if repeated, err := Ensure(cfg, store); err != nil || repeated != nil {
		t.Fatalf("repeated Ensure()=%v err=%v", repeated, err)
	}
}

func TestReadCredentialsRejectsUnsafeFiles(t *testing.T) {
	writeCredential := func(t *testing.T, mode os.FileMode, data []byte) string {
		t.Helper()
		dataDir := t.TempDir()
		if err := os.Mkdir(filepath.Join(dataDir, "bootstrap"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(CredentialPath(dataDir), data, mode); err != nil {
			t.Fatal(err)
		}
		return dataDir
	}
	valid, err := json.Marshal(credentials{Username: "root", Password: "secret"})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("oversized", func(t *testing.T) {
		dataDir := writeCredential(t, 0600, make([]byte, 4097))
		if _, err := readCredentials(dataDir, "root"); err == nil {
			t.Fatal("oversized credential file was accepted")
		}
	})
	t.Run("corrupt", func(t *testing.T) {
		dataDir := writeCredential(t, 0600, []byte("not-json"))
		if _, err := readCredentials(dataDir, "root"); err == nil {
			t.Fatal("corrupt credential file was accepted")
		}
	})
	if runtime.GOOS != "windows" {
		t.Run("wide permissions", func(t *testing.T) {
			dataDir := writeCredential(t, 0644, valid)
			if _, err := readCredentials(dataDir, "root"); err == nil {
				t.Fatal("widely readable credential file was accepted")
			}
		})
	}
	t.Run("symbolic file", func(t *testing.T) {
		dataDir := t.TempDir()
		if err := os.Mkdir(filepath.Join(dataDir, "bootstrap"), 0700); err != nil {
			t.Fatal(err)
		}
		outside := filepath.Join(t.TempDir(), "outside.json")
		if err := os.WriteFile(outside, valid, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, CredentialPath(dataDir)); err != nil {
			if runtime.GOOS == "windows" {
				t.Skipf("symlink unavailable: %v", err)
			}
			t.Fatal(err)
		}
		if _, err := readCredentials(dataDir, "root"); err == nil {
			t.Fatal("symbolic credential file was accepted")
		}
	})
}

func TestConfiguredPasswordDoesNotRewriteEquivalentHash(t *testing.T) {
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	cfg.RootUser.Username = "root"
	cfg.RootUser.Password = "configured-password"
	store := auth.NewMemoryUserStore()
	created, err := Ensure(cfg, store)
	if err != nil {
		t.Fatal(err)
	}
	before := created.PasswordHash
	if _, err := Ensure(cfg, store); err != nil {
		t.Fatal(err)
	}
	after, err := store.Get("root")
	if err != nil || after.PasswordHash != before {
		t.Fatalf("equivalent password was rehashed: err=%v", err)
	}
}
