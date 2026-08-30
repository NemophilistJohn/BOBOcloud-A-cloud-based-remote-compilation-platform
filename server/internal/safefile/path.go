package safefile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ErrRedirectedPath reports a symbolic link or platform reparse point in a
// path that must remain bound to its original directory entry.
var ErrRedirectedPath = errors.New("path contains a symbolic link or reparse point")

// RealDirectory validates an existing directory without confusing alternate
// spellings of the same file (for example a Windows 8.3 path) with a redirect.
// Every existing component is inspected so real links and reparse points still
// fail closed.
func RealDirectory(value string) (string, error) {
	absolute, err := absolutePath(value)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("path is not a directory: %s", absolute)
	}
	if err := rejectRedirectedComponents(absolute); err != nil {
		return "", err
	}
	resolved, err := canonicalExistingPath(absolute)
	if err != nil {
		return "", err
	}
	resolvedInfo, err := os.Stat(resolved)
	if err != nil || !os.SameFile(info, resolvedInfo) {
		return "", fmt.Errorf("path changed while resolving: %s", absolute)
	}
	return absolute, nil
}

// SameFile reports whether two existing paths identify the same filesystem
// object. It intentionally follows aliases; callers that prohibit links must
// validate the path with RealDirectory first.
func SameFile(left, right string) bool {
	leftInfo, leftErr := os.Stat(left)
	rightInfo, rightErr := os.Stat(right)
	return leftErr == nil && rightErr == nil && os.SameFile(leftInfo, rightInfo)
}

// CanonicalPath resolves an existing path to an absolute path. A final
// os.SameFile check prevents a non-equivalent result from being accepted if the
// entry changes while it is resolved.
func CanonicalPath(value string) (string, error) {
	absolute, err := absolutePath(value)
	if err != nil {
		return "", err
	}
	return canonicalExistingPath(absolute)
}

// CanonicalPathAllowMissing resolves the deepest existing ancestor and then
// appends the missing suffix. This is useful for validating editor URIs for
// files that may not have been created yet.
func CanonicalPathAllowMissing(value string) (string, error) {
	absolute, err := absolutePath(value)
	if err != nil {
		return "", err
	}
	current := absolute
	missing := make([]string, 0, 4)
	for {
		_, statErr := os.Lstat(current)
		if statErr == nil {
			resolved, resolveErr := canonicalExistingPath(current)
			if resolveErr != nil {
				return "", resolveErr
			}
			for index := len(missing) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missing[index])
			}
			return filepath.Clean(resolved), nil
		}
		if !errors.Is(statErr, os.ErrNotExist) {
			return "", statErr
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", statErr
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
}

// PathWithin reports whether candidate is root or one of its descendants
// after resolving filesystem aliases and links. The root must exist; the
// candidate may have a missing suffix.
func PathWithin(root, candidate string) (bool, error) {
	canonicalRoot, err := CanonicalPath(root)
	if err != nil {
		return false, err
	}
	canonicalCandidate, err := CanonicalPathAllowMissing(candidate)
	if err != nil {
		return false, err
	}
	relative, err := filepath.Rel(canonicalRoot, canonicalCandidate)
	if err != nil {
		return false, err
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))), nil
}

func absolutePath(value string) (string, error) {
	if value == "" || strings.ContainsRune(value, '\x00') {
		return "", fmt.Errorf("path is empty or invalid")
	}
	absolute, err := filepath.Abs(filepath.Clean(value))
	if err != nil {
		return "", err
	}
	return filepath.Clean(absolute), nil
}

func canonicalExistingPath(absolute string) (string, error) {
	before, err := os.Stat(absolute)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return "", err
	}
	resolved = filepath.Clean(resolved)
	after, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !os.SameFile(before, after) {
		return "", fmt.Errorf("path changed while resolving: %s", absolute)
	}
	return resolved, nil
}

func rejectRedirectedComponents(absolute string) error {
	current := absolute
	for {
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if pathComponentRedirected(current, info) {
			return fmt.Errorf("%w: %s", ErrRedirectedPath, current)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
		current = parent
	}
}
