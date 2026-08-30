package lsp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"bobocloud-server/internal/resourcecontrol"
)

type SessionContext struct {
	UserID                 string
	WorkspaceKind          string
	TeamID                 string
	ProjectID              string
	Branch                 string
	FolderKey              string
	RuntimeID              string
	RuntimeImage           string
	LanguageID             string
	Mode                   Mode
	RemoteRoot             string
	DependencyRequest      AnalysisDependencyRequest
	DependencyView         AnalysisDependencyView
	DependencyResolved     bool
	SharedDependencies     *SharedDependencies
	DependencyStoreRelease func()
	ProcessContext         context.Context
	ResourceLease          *resourcecontrol.Lease
}

// SharedDependencies is a server-issued, non-exclusive lease over a team's
// downloaded packages. Release is owned by the LSP session once Start begins.
type SharedDependencies struct {
	Release func()
}

func (c SessionContext) Owner() (kind, id string) {
	if c.WorkspaceKind == "team" {
		return "team", c.TeamID
	}
	return "user", c.UserID
}

func SessionKey(c SessionContext) string {
	parts := []string{c.UserID, c.WorkspaceKind, c.TeamID, c.ProjectID, c.Branch, c.FolderKey, c.RuntimeID, normalizeLanguage(c.LanguageID), string(c.Mode), c.DependencyView.Revision}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:16])
}

var lockFileNames = map[string]bool{
	"cargo.lock": true, "go.sum": true, "go.mod": true,
	"package-lock.json": true, "pnpm-lock.yaml": true, "yarn.lock": true,
	"poetry.lock": true, "pdm.lock": true, "pipfile.lock": true,
	"pom.xml": true, "gradle.lockfile": true, "build.gradle": true,
	"build.gradle.kts": true, "compile_commands.json": true,
}

var errLockScanBudget = errors.New("dependency lock scan budget reached")

const maxLockScanEntries = 4096

var skippedDependencyDirs = map[string]bool{
	".git": true, ".cache": true, ".gradle": true, ".idea": true,
	".next": true, ".venv": true, "venv": true, "node_modules": true,
	"target": true, "vendor": true, "build": true, "dist": true,
	"out": true, "coverage": true,
}

// DependencyLockHash intentionally scans only dependency/toolchain metadata.
// Source edits therefore reuse the same analysis namespace while dependency
// changes invalidate it. Large/vendor directories are never traversed.
func DependencyLockHash(root string) (string, error) {
	type item struct{ path string }
	items := make([]item, 0, 8)
	visited := 0
	err := filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		visited++
		if visited > maxLockScanEntries {
			return errLockScanBudget
		}
		if entry.IsDir() {
			name := strings.ToLower(entry.Name())
			if current != root && skippedDependencyDirs[name] {
				return filepath.SkipDir
			}
			if current != root {
				rel, _ := filepath.Rel(root, current)
				if strings.Count(filepath.ToSlash(rel), "/") >= 5 {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if lockFileNames[strings.ToLower(entry.Name())] && len(items) < 64 {
			items = append(items, item{path: current})
		}
		return nil
	})
	if err != nil && !os.IsNotExist(err) && !errors.Is(err, errLockScanBudget) {
		return "", err
	}
	sort.Slice(items, func(i, j int) bool { return items[i].path < items[j].path })
	h := sha256.New()
	remaining := int64(16 << 20)
	for _, item := range items {
		rel, _ := filepath.Rel(root, item.path)
		_, _ = io.WriteString(h, filepath.ToSlash(rel)+"\x00")
		file, openErr := os.Open(item.path)
		if openErr != nil {
			continue
		}
		copied, _ := io.CopyN(h, file, remaining)
		_ = file.Close()
		remaining -= copied
		if remaining <= 0 {
			break
		}
	}
	return hex.EncodeToString(h.Sum(nil)[:16]), nil
}

func ToolchainFingerprint(spec ServerSpec, runtimeID string) string {
	h := sha256.New()
	_, _ = io.WriteString(h, spec.LanguageID+"\x00"+runtimeID+"\x00"+spec.Fingerprint+"\x00"+strings.Join(spec.Command, "\x00")+"\x00"+strings.Join(spec.StandardCommand, "\x00")+"\x00"+strings.Join(spec.FullCommand, "\x00")+"\x00"+spec.Docker.Image+"\x00"+strings.Join(spec.Docker.Command, "\x00")+"\x00"+strings.Join(spec.Docker.StandardCommand, "\x00")+"\x00"+strings.Join(spec.Docker.FullCommand, "\x00"))
	if len(spec.Command) > 0 && runtimeID == "local" && spec.Docker.Image == "" {
		if executable, err := exec.LookPath(spec.Command[0]); err == nil {
			if stat, statErr := os.Stat(executable); statErr == nil {
				_, _ = io.WriteString(h, fmt.Sprintf("\x00%s\x00%d\x00%d", executable, stat.Size(), stat.ModTime().Unix()))
			}
		}
	}
	return hex.EncodeToString(h.Sum(nil)[:16])
}

type CacheContext struct {
	OwnerKind            string
	OwnerID              string
	UserID               string
	ProjectID            string
	Branch               string
	FolderKey            string
	RuntimeID            string
	LanguageID           string
	Mode                 Mode
	ToolchainFingerprint string
	LockHash             string
}

func CacheKey(c CacheContext) string {
	// Mode is intentionally excluded: standard/full differ only in gateway
	// method policy and can reuse the same per-user analyzer index safely.
	parts := []string{c.OwnerKind, c.OwnerID, c.UserID, c.ProjectID, c.Branch, c.FolderKey, c.RuntimeID, normalizeLanguage(c.LanguageID), c.ToolchainFingerprint, c.LockHash}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return normalizeLanguage(c.LanguageID) + "-" + hex.EncodeToString(sum[:12])
}
