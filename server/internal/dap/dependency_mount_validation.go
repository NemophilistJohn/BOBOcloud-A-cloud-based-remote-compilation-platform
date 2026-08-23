package dap

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// validateDAPDependencySource is kept outside the Linux implementation so
// development builds enforce the same real-directory boundary.
func validateDAPDependencySource(value string) (string, error) {
	source, err := filepath.Abs(strings.TrimSpace(value))
	if err != nil || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("resolve DAP dependency cache")
	}
	info, err := os.Lstat(source)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("DAP dependency cache must be a real directory")
	}
	resolved, err := filepath.EvalSymlinks(source)
	if err != nil || filepath.Clean(resolved) != filepath.Clean(source) {
		return "", fmt.Errorf("DAP dependency cache must not be redirected")
	}
	return source, nil
}
