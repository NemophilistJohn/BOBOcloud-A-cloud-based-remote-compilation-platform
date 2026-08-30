package dap

import (
	"fmt"
	"strings"

	"bobocloud-server/internal/safefile"
)

// validateDAPDependencySource is kept outside the Linux implementation so
// development builds enforce the same real-directory boundary.
func validateDAPDependencySource(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("resolve DAP dependency cache")
	}
	source, err := safefile.RealDirectory(value)
	if err != nil {
		return "", fmt.Errorf("DAP dependency cache must be a real, unredirected directory: %w", err)
	}
	return source, nil
}
