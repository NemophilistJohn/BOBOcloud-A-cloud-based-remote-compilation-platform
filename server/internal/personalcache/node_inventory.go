package personalcache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type nodeInventoryCandidate struct {
	Path    string
	Package InventoryPackage
}

func scanNodePackageTree(root string) ([]InventoryPackage, string, int64, error) {
	root, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return nil, "", 0, err
	}
	info, err := os.Lstat(root)
	if os.IsNotExist(err) {
		empty := sha256.Sum256(nil)
		return []InventoryPackage{}, hex.EncodeToString(empty[:]), 0, nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, "", 0, fmt.Errorf("node_modules must be a real directory")
	}

	hash := sha256.New()
	candidates := make([]nodeInventoryCandidate, 0)
	latest := info.ModTime().UTC().UnixMilli()
	visited := 0
	err = filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		visited++
		if visited > maxPackageRecordEntries {
			return fmt.Errorf("Node package tree exceeds %d entries", maxPackageRecordEntries)
		}
		relative, relErr := filepath.Rel(root, current)
		if relErr != nil {
			return relErr
		}
		relative = filepath.ToSlash(relative)
		if relative == "." {
			relative = ""
		}
		entryInfo, infoErr := os.Lstat(current)
		if infoErr != nil {
			return infoErr
		}
		if entryInfo.ModTime().UTC().UnixMilli() > latest {
			latest = entryInfo.ModTime().UTC().UnixMilli()
		}
		fmt.Fprintf(hash, "%s\x00%s\x00%d\x00%d\x00%d\x00", relative, entryInfo.Mode().String(), entryInfo.Size(), entryInfo.ModTime().UnixNano(), entryInfo.Mode().Perm())
		if entryInfo.Mode()&os.ModeSymlink != 0 {
			target, readErr := os.Readlink(current)
			if readErr != nil {
				return readErr
			}
			if filepath.IsAbs(target) {
				return fmt.Errorf("Node package symlink escapes the dependency root: %s", relative)
			}
			resolvedTarget := filepath.Clean(filepath.Join(filepath.Dir(current), target))
			if resolvedTarget != root && !strings.HasPrefix(resolvedTarget, root+string(filepath.Separator)) {
				return fmt.Errorf("Node package symlink escapes the dependency root: %s", relative)
			}
			hash.Write([]byte(target))
			return nil
		}
		if entry.IsDir() && (entry.Name() == ".bin" || entry.Name() == ".cache") {
			return filepath.SkipDir
		}
		if !entryInfo.Mode().IsRegular() || entry.Name() != "package.json" || !nodePackageMetadataPath(relative) {
			return nil
		}
		if entryInfo.Size() < 2 || entryInfo.Size() > maxPackageMetadataBytes {
			return fmt.Errorf("Node package metadata exceeds the size limit: %s", relative)
		}
		data, readErr := readSmallRegularFile(current, maxPackageMetadataBytes)
		if readErr != nil || int64(len(data)) != entryInfo.Size() {
			return fmt.Errorf("read Node package metadata %s: %w", relative, readErr)
		}
		hash.Write(data)
		var metadata struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		}
		if json.Unmarshal(data, &metadata) != nil || strings.TrimSpace(metadata.Name) == "" || strings.TrimSpace(metadata.Version) == "" {
			return fmt.Errorf("invalid Node package metadata: %s", relative)
		}
		candidates = append(candidates, nodeInventoryCandidate{
			Path:    relative,
			Package: InventoryPackage{Name: strings.TrimSpace(metadata.Name), Version: strings.TrimSpace(metadata.Version)},
		})
		return nil
	})
	if err != nil {
		return nil, "", 0, err
	}

	sort.Slice(candidates, func(i, j int) bool {
		leftDepth := strings.Count(candidates[i].Path, "/")
		rightDepth := strings.Count(candidates[j].Path, "/")
		if leftDepth != rightDepth {
			return leftDepth < rightDepth
		}
		return candidates[i].Path < candidates[j].Path
	})
	seen := make(map[string]bool, len(candidates))
	packages := make([]InventoryPackage, 0, len(candidates))
	for _, candidate := range candidates {
		key := strings.ToLower(candidate.Package.Name) + "\x00" + candidate.Package.Version
		if seen[key] {
			continue
		}
		seen[key] = true
		packages = append(packages, candidate.Package)
	}
	sort.Slice(packages, func(i, j int) bool {
		left := strings.ToLower(packages[i].Name) + "\x00" + packages[i].Version
		right := strings.ToLower(packages[j].Name) + "\x00" + packages[j].Version
		return left < right
	})
	hash.Write([]byte("entries=" + strconv.Itoa(visited)))
	return packages, hex.EncodeToString(hash.Sum(nil)), latest, nil
}

func nodePackageMetadataPath(relative string) bool {
	parts := strings.Split(filepath.ToSlash(relative), "/")
	if len(parts) < 2 || parts[len(parts)-1] != "package.json" {
		return false
	}
	lastModules := -1
	for index, part := range parts {
		if part == "node_modules" {
			lastModules = index
		}
	}
	if lastModules < 0 {
		// root is already node_modules, so top-level packages do not carry
		// the directory name in their relative path.
		return len(parts) == 2 || (len(parts) == 3 && strings.HasPrefix(parts[0], "@"))
	}
	tail := parts[lastModules+1:]
	return len(tail) == 2 || (len(tail) == 3 && strings.HasPrefix(tail[0], "@"))
}
