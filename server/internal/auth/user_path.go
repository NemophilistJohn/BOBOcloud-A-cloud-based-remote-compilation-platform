package auth

import (
	"fmt"
	"path/filepath"
	"strings"
)

// UserDataRoot resolves the existing on-disk identity without changing its
// encoding. Validation guarantees the account maps to exactly one child of
// data_dir/users, preserving valid legacy and UUID directory names.
func UserDataRoot(dataDir, userID string) (string, error) {
	if strings.TrimSpace(dataDir) == "" || strings.ContainsRune(dataDir, '\x00') {
		return "", fmt.Errorf("data directory is required")
	}
	if err := ValidateUserID(userID); err != nil {
		return "", err
	}
	dataRoot, err := filepath.Abs(filepath.Clean(dataDir))
	if err != nil {
		return "", fmt.Errorf("resolve data directory: %w", err)
	}
	usersRoot := filepath.Join(dataRoot, "users")
	target := filepath.Join(usersRoot, userID)
	relative, err := filepath.Rel(usersRoot, target)
	if err != nil || relative != userID {
		return "", fmt.Errorf("user data path escaped users root")
	}
	return target, nil
}
