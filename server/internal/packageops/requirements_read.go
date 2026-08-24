package packageops

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ReadPythonRequirementsSnapshot opens a requirements manifest through the
// platform-specific no-follow path walk and verifies its reviewed digest.
func ReadPythonRequirementsSnapshot(root, relative, expectedSHA256 string) ([]byte, error) {
	if _, err := safeRequirementsPath(root, relative); err != nil {
		return nil, err
	}
	data, exists, err := readRequirementsFile(root, filepath.Clean(filepath.FromSlash(relative)))
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, fmt.Errorf("requirements manifest is unavailable")
	}
	digest := sha256.Sum256(data)
	if !strings.EqualFold(hex.EncodeToString(digest[:]), strings.TrimSpace(expectedSHA256)) {
		return nil, fmt.Errorf("requirements manifest no longer matches the reviewed package plan")
	}
	return data, nil
}

func readRequirementsFile(root, relative string) ([]byte, bool, error) {
	file, exists, err := openRequirementsFile(root, relative)
	if err != nil || !exists {
		return nil, exists, err
	}
	defer file.Close()

	before, err := file.Stat()
	if err != nil {
		return nil, false, fmt.Errorf("inspect requirements manifest: %w", err)
	}
	if !before.Mode().IsRegular() || before.Size() < 0 || before.Size() > maxRequirementsBytes {
		return nil, false, fmt.Errorf("requirements manifest must be a regular file no larger than %d bytes", maxRequirementsBytes)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxRequirementsBytes+1))
	if err != nil {
		return nil, false, fmt.Errorf("read requirements manifest: %w", err)
	}
	if int64(len(data)) > maxRequirementsBytes {
		return nil, false, fmt.Errorf("requirements manifest must be a regular file no larger than %d bytes", maxRequirementsBytes)
	}
	after, err := file.Stat()
	if err != nil {
		return nil, false, fmt.Errorf("reinspect requirements manifest: %w", err)
	}
	if !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || int64(len(data)) != after.Size() {
		return nil, false, fmt.Errorf("requirements manifest changed while reading")
	}
	return data, true, nil
}
