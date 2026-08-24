package personalcache

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	maxFingerprintBytes   = int64(32 << 20)
	maxFingerprintEntries = 200_000
	maxSetupCommands      = 64
	maxSetupCommandBytes  = 512
)

var ignoredDirectories = map[string]bool{
	".git": true, ".bobocloud": true, ".venv": true, "venv": true,
	"node_modules": true, "target": true, "build": true, "dist": true,
}

var manifestsByLanguage = map[string]map[string]bool{
	"python": {"requirements.txt": false, "pyproject.toml": false, "setup.py": false, "setup.cfg": false, "pipfile": false, "pipfile.lock": true, "poetry.lock": true, "pdm.lock": true, "uv.lock": true, "pixi.lock": true, "environment.yml": false, "environment.yaml": false, "conda-lock.yml": true},
	"node":   {"package.json": false, "package-lock.json": true, "npm-shrinkwrap.json": true, "pnpm-lock.yaml": true, "pnpm-workspace.yaml": false, "yarn.lock": true, "bun.lock": true, "bun.lockb": true},
	"go":     {"go.mod": false, "go.sum": true, "go.work": false, "go.work.sum": true},
	"rust":   {"cargo.toml": false, "cargo.lock": true},
	"java":   {"pom.xml": false, "build.gradle": false, "build.gradle.kts": false, "settings.gradle": false, "settings.gradle.kts": false, "gradle.properties": false, "libs.versions.toml": false, "gradle.lockfile": true},
}

type Fingerprint struct {
	Digest    string
	Source    string
	Manifests []string
}

// DependencyFingerprintFromSnapshot hashes server-reviewed manifest bytes.
// It is used by transactional package changes so SFTP/rclone writes cannot
// change the dependency identity between review and container execution.
func DependencyFingerprintFromSnapshot(language string, setupCommands []string, runtimeFingerprint string, snapshots []ManifestSnapshot) (Fingerprint, error) {
	if len(snapshots) == 0 || len(snapshots) > maxSetupCommands {
		return Fingerprint{}, fmt.Errorf("dependency snapshot must contain between 1 and %d manifests", maxSetupCommands)
	}
	normalizedCommands := make([]string, 0, len(setupCommands))
	for _, command := range setupCommands {
		command = strings.TrimSpace(command)
		if command == "" {
			continue
		}
		if len([]byte(command)) > maxSetupCommandBytes || strings.ContainsAny(command, "\x00\r\n") {
			return Fingerprint{}, fmt.Errorf("dependency setup command is invalid")
		}
		normalizedCommands = append(normalizedCommands, command)
	}
	if len(normalizedCommands) > maxSetupCommands {
		return Fingerprint{}, fmt.Errorf("dependency setup commands exceed %d entries", maxSetupCommands)
	}
	type snapshotItem struct {
		path    string
		content []byte
		lock    bool
	}
	items := make([]snapshotItem, 0, len(snapshots))
	seen := make(map[string]bool, len(snapshots))
	var total int64
	for _, snapshot := range snapshots {
		pathValue := filepath.ToSlash(strings.TrimSpace(snapshot.Path))
		clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(pathValue)))
		if pathValue == "" || clean != pathValue || filepath.IsAbs(filepath.FromSlash(pathValue)) || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || seen[clean] {
			return Fingerprint{}, fmt.Errorf("dependency snapshot path is invalid")
		}
		seen[clean] = true
		total += int64(len(snapshot.Content))
		if total > maxFingerprintBytes {
			return Fingerprint{}, fmt.Errorf("dependency manifests exceed %d bytes", maxFingerprintBytes)
		}
		items = append(items, snapshotItem{path: clean, content: snapshot.Content, lock: snapshot.Lock})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].path < items[j].path })
	hash := sha256.New()
	paths := make([]string, 0, len(items))
	hasLock := false
	for _, item := range items {
		hash.Write([]byte(item.path))
		hash.Write([]byte{0})
		hash.Write(item.content)
		hash.Write([]byte{0})
		paths = append(paths, item.path)
		hasLock = hasLock || item.lock
	}
	for _, command := range normalizedCommands {
		hash.Write([]byte("setup\x00" + command + "\x00"))
	}
	if runtimeFingerprint = strings.TrimSpace(runtimeFingerprint); runtimeFingerprint != "" {
		hash.Write([]byte("runtime\x00" + runtimeFingerprint + "\x00"))
	}
	source := "manifest"
	if hasLock {
		source = "lock"
	}
	return Fingerprint{Digest: hex.EncodeToString(hash.Sum(nil)[:16]), Source: source, Manifests: paths}, nil
}

func DependencyFingerprint(root, language string, setupCommands []string) (Fingerprint, error) {
	return DependencyFingerprintWithRuntime(root, language, setupCommands, "")
}

func DependencyFingerprintWithRuntime(root, language string, setupCommands []string, runtimeFingerprint string) (Fingerprint, error) {
	if strings.TrimSpace(root) == "" {
		return Fingerprint{}, fmt.Errorf("dependency workspace root is required")
	}
	root = filepath.Clean(root)
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return Fingerprint{}, fmt.Errorf("inspect dependency workspace: %w", err)
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return Fingerprint{}, fmt.Errorf("dependency workspace root must be a real directory")
	}
	if len(setupCommands) > maxSetupCommands {
		return Fingerprint{}, fmt.Errorf("dependency setup commands exceed %d entries", maxSetupCommands)
	}
	normalizedCommands := make([]string, 0, len(setupCommands))
	for _, command := range setupCommands {
		command = strings.TrimSpace(command)
		if command == "" {
			continue
		}
		if len([]byte(command)) > maxSetupCommandBytes {
			return Fingerprint{}, fmt.Errorf("dependency setup command exceeds %d bytes", maxSetupCommandBytes)
		}
		if strings.ContainsAny(command, "\x00\r\n") {
			return Fingerprint{}, fmt.Errorf("dependency setup command contains invalid control characters")
		}
		normalizedCommands = append(normalizedCommands, command)
	}
	selected := manifestsByLanguage[strings.ToLower(strings.TrimSpace(language))]
	type item struct {
		path string
		lock bool
	}
	items := make([]item, 0)
	if len(selected) > 0 {
		visited := 0
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			visited++
			if visited > maxFingerprintEntries {
				return fmt.Errorf("dependency workspace exceeds %d entries", maxFingerprintEntries)
			}
			if entry.IsDir() {
				if path != root && ignoredDirectories[strings.ToLower(entry.Name())] {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.Type()&fs.ModeSymlink != 0 {
				return nil
			}
			relative, err := filepath.Rel(root, path)
			if err != nil || relative == "." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
				return fmt.Errorf("dependency manifest escapes workspace")
			}
			relative = filepath.ToSlash(relative)
			lock, selectedByName := selected[strings.ToLower(entry.Name())]
			if !selectedByName {
				lock, selectedByName = dependencyManifestPattern(language, entry.Name())
			}
			if !selectedByName && !setupCommandsReferencePath(normalizedCommands, relative) {
				return nil
			}
			items = append(items, item{path: relative, lock: lock})
			return nil
		})
		if err != nil {
			return Fingerprint{}, err
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].path < items[j].path })
	hash := sha256.New()
	var total int64
	hasLock := false
	paths := make([]string, 0, len(items))
	for _, manifest := range items {
		remaining := maxFingerprintBytes - total
		data, err := readSmallRegularFile(filepath.Join(root, filepath.FromSlash(manifest.path)), remaining)
		if err != nil {
			return Fingerprint{}, fmt.Errorf("read dependency manifest %s: %w", manifest.path, err)
		}
		total += int64(len(data))
		if total > maxFingerprintBytes {
			return Fingerprint{}, fmt.Errorf("dependency manifests exceed %d bytes", maxFingerprintBytes)
		}
		hash.Write([]byte(manifest.path))
		hash.Write([]byte{0})
		hash.Write(data)
		hash.Write([]byte{0})
		hasLock = hasLock || manifest.lock
		paths = append(paths, manifest.path)
	}
	for _, command := range normalizedCommands {
		hash.Write([]byte("setup\x00" + command + "\x00"))
	}
	if runtimeFingerprint = strings.TrimSpace(runtimeFingerprint); runtimeFingerprint != "" {
		hash.Write([]byte("runtime\x00" + runtimeFingerprint + "\x00"))
	}
	source := "empty"
	if hasLock {
		source = "lock"
	} else if len(items) > 0 {
		source = "manifest"
	} else if len(normalizedCommands) > 0 {
		source = "setup"
	} else {
		hash.Write([]byte("empty"))
	}
	return Fingerprint{Digest: hex.EncodeToString(hash.Sum(nil)[:16]), Source: source, Manifests: paths}, nil
}

func dependencyManifestPattern(language, name string) (bool, bool) {
	name = strings.ToLower(strings.TrimSpace(name))
	switch strings.ToLower(strings.TrimSpace(language)) {
	case "python":
		if (strings.HasPrefix(name, "requirements") || strings.HasPrefix(name, "constraints")) &&
			(strings.HasSuffix(name, ".txt") || strings.HasSuffix(name, ".in")) {
			return false, true
		}
	}
	return false, false
}

func setupCommandsReferencePath(commands []string, relative string) bool {
	relative = strings.TrimPrefix(filepath.ToSlash(relative), "./")
	if relative == "" || relative == "." {
		return false
	}
	for _, command := range commands {
		normalized := filepath.ToSlash(command)
		for _, candidate := range []string{relative, "./" + relative} {
			start := 0
			for {
				index := strings.Index(normalized[start:], candidate)
				if index < 0 {
					break
				}
				index += start
				beforeOK := index == 0 || isSetupPathBoundary(normalized[index-1])
				after := index + len(candidate)
				afterOK := after == len(normalized) || isSetupPathBoundary(normalized[after])
				if beforeOK && afterOK {
					return true
				}
				start = index + 1
			}
		}
	}
	return false
}

func isSetupPathBoundary(value byte) bool {
	switch value {
	case ' ', '\t', '\'', '"', '=', ':', ',':
		return true
	default:
		return false
	}
}
