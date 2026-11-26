package rootbootstrap

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/safefile"
)

const credentialFileName = "root-credentials.json"

func CredentialPath(dataDir string) string {
	return filepath.Join(dataDir, "bootstrap", credentialFileName)
}

// RemoveCredentialFile also removes legacy one-time bootstrap files created by
// older server versions. New installs never create such a file.
func RemoveCredentialFile(dataDir string) error {
	err := safefile.RemoveEntryBeneath(dataDir, filepath.Join("bootstrap", credentialFileName))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func Ensure(cfg *config.Config, store auth.UserStore) (*auth.User, error) {
	if cfg == nil || store == nil {
		return nil, fmt.Errorf("root bootstrap requires config and user store")
	}
	users, err := store.List()
	if err != nil {
		return nil, fmt.Errorf("list users before root initialization: %w", err)
	}
	for _, user := range users {
		if user.EffectiveRole() != auth.RoleRoot {
			continue
		}
		slog.Info("Root account already exists; preserving its password", "username", user.Username)
		return nil, nil
	}

	username := cfg.RootUser.Username
	if username == "" {
		username = "root"
	}
	name := cfg.RootUser.Name
	if name == "" {
		name = "Root Admin"
	}
	rootUser := &auth.User{
		ID: username, Username: username, Email: cfg.RootUser.Email, Name: name,
		Role: auth.RoleRoot, APIKey: "bobo_" + auth.GenerateToken(),
		ContainerLimit: 20, RateLimit: 300, DiskQuotaMB: 0,
	}
	if err := store.Create(rootUser); err != nil {
		return nil, fmt.Errorf("create root user: %w", err)
	}
	slog.Info("Unclaimed root account created; retrieve the administrator claim link to set its password", "username", username)
	return rootUser, nil
}
