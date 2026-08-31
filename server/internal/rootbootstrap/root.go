package rootbootstrap

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/safefile"
)

const credentialFileName = "root-credentials.json"

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func CredentialPath(dataDir string) string {
	return filepath.Join(dataDir, "bootstrap", credentialFileName)
}

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
		if cfg.RootUser.Password != "" && !auth.CheckPassword(user.PasswordHash, cfg.RootUser.Password) {
			hash, hashErr := auth.HashPassword(cfg.RootUser.Password)
			if hashErr != nil {
				return nil, fmt.Errorf("hash root password from config: %w", hashErr)
			}
			user.PasswordHash = hash
			if createErr := store.Create(user); createErr != nil {
				return nil, fmt.Errorf("sync root password from config: %w", createErr)
			}
			slog.Info("Root password synced from config", "username", user.Username)
		}
		if cfg.RootUser.Password != "" {
			_ = RemoveCredentialFile(cfg.DataDir)
		}
		slog.Info("Root account already exists", "username", user.Username)
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
	password := cfg.RootUser.Password
	credentialPath := ""
	createdCredential := false
	if password == "" {
		var credential credentials
		credential, createdCredential, err = loadOrCreateCredentials(cfg.DataDir, username)
		if err != nil {
			return nil, err
		}
		password = credential.Password
		credentialPath = CredentialPath(cfg.DataDir)
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		if createdCredential {
			_ = RemoveCredentialFile(cfg.DataDir)
		}
		return nil, fmt.Errorf("hash root password: %w", err)
	}
	rootUser := &auth.User{
		ID: username, Username: username, Email: cfg.RootUser.Email, Name: name,
		PasswordHash: hash, Role: auth.RoleRoot, APIKey: "bobo_" + auth.GenerateToken(),
		ContainerLimit: 20, RateLimit: 300, DiskQuotaMB: 0, CreatedAt: time.Now(),
	}
	if err := store.Create(rootUser); err != nil {
		if createdCredential {
			_ = RemoveCredentialFile(cfg.DataDir)
		}
		return nil, fmt.Errorf("create root user: %w", err)
	}
	if credentialPath != "" {
		slog.Warn("Root account created; retrieve the one-time credentials file and change the password", "path", credentialPath)
	} else {
		slog.Info("Root account created from configured password", "username", username)
	}
	return rootUser, nil
}

func loadOrCreateCredentials(dataDir, username string) (credentials, bool, error) {
	path := CredentialPath(dataDir)
	if value, err := readCredentials(dataDir, username); err == nil {
		return value, false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return credentials{}, false, err
	}
	password, err := auth.GeneratePassword()
	if err != nil {
		return credentials{}, false, fmt.Errorf("generate root password: %w", err)
	}
	value := credentials{Username: username, Password: password}
	directory, err := safefile.EnsureDirectoryBeneath(dataDir, "bootstrap", 0700)
	if err != nil {
		return credentials{}, false, fmt.Errorf("create root credential directory: %w", err)
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return credentials{}, false, fmt.Errorf("protect root credential directory: %w", err)
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return credentials{}, false, err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		value, readErr := readCredentials(dataDir, username)
		return value, false, readErr
	}
	if err != nil {
		return credentials{}, false, fmt.Errorf("create root credential file: %w", err)
	}
	if _, err = file.Write(append(data, '\n')); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(path)
		return credentials{}, false, fmt.Errorf("write root credential file: %w", err)
	}
	return value, true, nil
}

func readCredentials(dataDir, username string) (credentials, error) {
	path := CredentialPath(dataDir)
	file, info, err := safefile.OpenRegularBeneath(dataDir, filepath.Join("bootstrap", credentialFileName), 4096)
	if err != nil {
		return credentials{}, err
	}
	defer file.Close()
	if (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) || info.Size() <= 0 {
		return credentials{}, fmt.Errorf("root credential file is unsafe: %s", path)
	}
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return credentials{}, err
	}
	if len(data) > 4096 {
		return credentials{}, fmt.Errorf("root credential file is unsafe: %s", path)
	}
	var value credentials
	if err := json.Unmarshal(data, &value); err != nil {
		return credentials{}, fmt.Errorf("parse root credential file: %w", err)
	}
	if value.Username != username || value.Password == "" {
		return credentials{}, fmt.Errorf("root credential file does not match configured root user")
	}
	return value, nil
}
