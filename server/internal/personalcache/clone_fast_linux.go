//go:build linux

package personalcache

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

// GNU cp selects a filesystem reflink when available and falls back to its
// optimized byte-copy path. The source tree is validated before this helper.
func cloneDependencyTreeFast(source, destination string) (bool, error) {
	path, err := exec.LookPath("cp")
	if err != nil {
		return false, nil
	}
	output, err := exec.Command(path, "-a", "--reflink=auto", filepath.Clean(source)+string(filepath.Separator)+".", filepath.Clean(destination)).CombinedOutput()
	if err != nil {
		return true, fmt.Errorf("copy project dependency generation: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return true, nil
}
