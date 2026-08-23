package personalcache

import (
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type pythonOwnedPath struct {
	Relative string
	Absolute string
	Size     int64
	Owners   map[string]bool
}

type pythonDistributionInventory struct {
	Package      InventoryPackage
	MetadataRoot string
	OwnedPaths   map[string]bool
}

type pythonPackageTree struct {
	Packages      []InventoryPackage
	Distributions map[string]*pythonDistributionInventory
	OwnedPaths    map[string]*pythonOwnedPath
	Revision      string
	Latest        int64
}

func scanPythonPackageTreeDetailed(root string) (pythonPackageTree, error) {
	info, err := os.Lstat(root)
	if err != nil {
		return pythonPackageTree{}, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return pythonPackageTree{}, fmt.Errorf("Python package root is not a real directory")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return pythonPackageTree{}, err
	}
	sort.Slice(entries, func(i, j int) bool {
		return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
	})

	tree := pythonPackageTree{
		Distributions: make(map[string]*pythonDistributionInventory),
		OwnedPaths:    make(map[string]*pythonOwnedPath),
		Latest:        info.ModTime().UTC().UnixMilli(),
	}
	hash := sha256.New()
	ownedRoots := make(map[string]bool)

	for _, entry := range entries {
		lowerEntry := strings.ToLower(entry.Name())
		if strings.HasSuffix(lowerEntry, ".egg-info") {
			return pythonPackageTree{}, fmt.Errorf("unsupported Python distribution metadata directory %q", entry.Name())
		}
		if !strings.HasSuffix(lowerEntry, ".dist-info") {
			continue
		}
		directory := filepath.Join(root, entry.Name())
		directoryInfo, statErr := os.Lstat(directory)
		if statErr != nil || !directoryInfo.IsDir() || directoryInfo.Mode()&os.ModeSymlink != 0 {
			return pythonPackageTree{}, fmt.Errorf("invalid Python distribution metadata directory %q", entry.Name())
		}
		metadataPath := filepath.Join(directory, "METADATA")
		metadataInfo, statErr := pythonInventoryRegularFile(root, metadataPath)
		if statErr != nil || metadataInfo.Size() > maxPackageMetadataBytes {
			return pythonPackageTree{}, fmt.Errorf("invalid Python distribution metadata for %q", entry.Name())
		}
		data, readErr := readSmallRegularFile(metadataPath, maxPackageMetadataBytes)
		if readErr != nil {
			return pythonPackageTree{}, fmt.Errorf("read Python distribution metadata for %q", entry.Name())
		}
		name := normalizeInventoryPythonName(inventoryMetadataField(data, "Name"))
		version := inventoryMetadataField(data, "Version")
		if name == "" || version == "" {
			return pythonPackageTree{}, fmt.Errorf("Python distribution metadata is incomplete for %q", entry.Name())
		}
		if _, duplicate := tree.Distributions[name]; duplicate {
			return pythonPackageTree{}, fmt.Errorf("duplicate Python distribution metadata for %q", name)
		}

		recordPath := filepath.Join(directory, "RECORD")
		recordInfo, statErr := pythonInventoryRegularFile(root, recordPath)
		if statErr != nil || recordInfo.Size() > maxPackageRecordBytes {
			return pythonPackageTree{}, fmt.Errorf("invalid Python installation record for %q", entry.Name())
		}
		recordData, readErr := readSmallRegularFile(recordPath, maxPackageRecordBytes)
		if readErr != nil {
			return pythonPackageTree{}, fmt.Errorf("read Python installation record for %q", entry.Name())
		}
		records, parseErr := csv.NewReader(strings.NewReader(string(recordData))).ReadAll()
		if parseErr != nil || len(records) == 0 || len(records) > maxPackageRecordEntries {
			return pythonPackageTree{}, fmt.Errorf("invalid Python installation record entries for %q", entry.Name())
		}

		distribution := &pythonDistributionInventory{
			Package:      InventoryPackage{Name: name, Version: version},
			MetadataRoot: filepath.ToSlash(entry.Name()),
			OwnedPaths:   make(map[string]bool),
		}
		imports := make(map[string]bool)
		for _, record := range records {
			if len(record) == 0 || strings.TrimSpace(record[0]) == "" {
				return pythonPackageTree{}, fmt.Errorf("empty Python installation record entry for %q", entry.Name())
			}
			recorded := filepath.Clean(filepath.FromSlash(record[0]))
			_, _ = hash.Write([]byte("record\x00" + filepath.ToSlash(recorded) + "\x00"))
			recordedPath, _, relocated, verify := pythonTargetRecordPath(root, record[0])
			if !verify {
				continue
			}
			lowerRecorded := strings.ToLower(filepath.ToSlash(recorded))
			if !relocated && (strings.HasSuffix(lowerRecorded, ".pyc") || strings.HasSuffix(lowerRecorded, ".pyo") || strings.Contains(lowerRecorded, "/__pycache__/")) {
				continue
			}
			recordedInfo, recordErr := pythonInventoryRegularFile(root, recordedPath)
			if relocated && errors.Is(recordErr, os.ErrNotExist) {
				continue
			}
			if recordErr != nil {
				kind := "Python package file"
				if relocated {
					kind = "relocated Python package file"
				}
				return pythonPackageTree{}, fmt.Errorf("%s %q is missing or invalid", kind, filepath.ToSlash(recorded))
			}
			relative, relErr := filepath.Rel(root, recordedPath)
			if relErr != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
				return pythonPackageTree{}, fmt.Errorf("Python package file %q escapes target root", filepath.ToSlash(recorded))
			}
			relative = filepath.ToSlash(filepath.Clean(relative))
			owned := tree.OwnedPaths[relative]
			if owned == nil {
				owned = &pythonOwnedPath{Relative: relative, Absolute: recordedPath, Size: recordedInfo.Size(), Owners: make(map[string]bool)}
				tree.OwnedPaths[relative] = owned
			}
			owned.Owners[name] = true
			duplicateRecord := distribution.OwnedPaths[relative]
			distribution.OwnedPaths[relative] = true
			ownedRoots[strings.ToLower(strings.Split(relative, "/")[0])] = true
			if !relocated {
				if importName := pythonImportRoot(relative, entry.Name()); importName != "" {
					imports[importName] = true
				}
			}
			if !duplicateRecord {
				distribution.Package.SizeBytes += recordedInfo.Size()
				distribution.Package.Files++
			}
			_, _ = hash.Write([]byte(fmt.Sprintf("%d\x00%d\x00", recordedInfo.Size(), recordedInfo.ModTime().UTC().UnixNano())))
			if recordedInfo.ModTime().UTC().UnixMilli() > tree.Latest {
				tree.Latest = recordedInfo.ModTime().UTC().UnixMilli()
			}
		}
		for importName := range imports {
			distribution.Package.Imports = append(distribution.Package.Imports, importName)
		}
		sort.Strings(distribution.Package.Imports)
		tree.Distributions[name] = distribution
		_, _ = hash.Write([]byte(lowerEntry))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write(data)
		_, _ = hash.Write([]byte{0})
		if metadataInfo.ModTime().UTC().UnixMilli() > tree.Latest {
			tree.Latest = metadataInfo.ModTime().UTC().UnixMilli()
		}
	}

	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fmt.Errorf("Python package tree path escapes target root")
		}
		info, infoErr := os.Lstat(path)
		if infoErr != nil {
			return infoErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Python package tree contains symlink %q", filepath.ToSlash(relative))
		}
		if info.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("Python package tree contains unsupported file %q", filepath.ToSlash(relative))
		}
		relative = filepath.ToSlash(filepath.Clean(relative))
		lower := strings.ToLower(relative)
		if strings.HasSuffix(lower, ".pyc") || strings.HasSuffix(lower, ".pyo") || strings.Contains(lower, "/__pycache__/") {
			return nil
		}
		if tree.OwnedPaths[relative] == nil {
			return fmt.Errorf("Python package tree contains unowned file %q", relative)
		}
		return nil
	})
	if err != nil {
		return pythonPackageTree{}, err
	}
	for _, entry := range entries {
		name := strings.ToLower(entry.Name())
		if name == "__pycache__" {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 || !ownedRoots[name] {
			return pythonPackageTree{}, fmt.Errorf("Python package tree contains unowned top-level entry %q", entry.Name())
		}
	}
	names := make([]string, 0, len(tree.Distributions))
	for name := range tree.Distributions {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		tree.Packages = append(tree.Packages, tree.Distributions[name].Package)
	}
	_, _ = hash.Write([]byte("complete"))
	tree.Revision = hex.EncodeToString(hash.Sum(nil))
	return tree, nil
}

func pythonInventoryRegularFile(root, target string) (os.FileInfo, error) {
	cleanRoot := filepath.Clean(root)
	cleanTarget := filepath.Clean(target)
	relative, err := filepath.Rel(cleanRoot, cleanTarget)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("Python package path escapes target root")
	}
	current := cleanRoot
	parts := strings.Split(relative, string(filepath.Separator))
	for index, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, fmt.Errorf("invalid Python package path")
		}
		current = filepath.Join(current, part)
		info, statErr := os.Lstat(current)
		if statErr != nil {
			return nil, statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("Python package path contains symlink")
		}
		if index < len(parts)-1 && !info.IsDir() {
			return nil, fmt.Errorf("Python package path parent is not a directory")
		}
		if index == len(parts)-1 {
			if !info.Mode().IsRegular() {
				return nil, fmt.Errorf("Python package path is not a regular file")
			}
			return info, nil
		}
	}
	return nil, fmt.Errorf("invalid Python package path")
}

func pythonImportRoot(relative, metadataDirectory string) string {
	parts := strings.Split(filepath.ToSlash(relative), "/")
	if len(parts) == 0 {
		return ""
	}
	first := parts[0]
	lower := strings.ToLower(first)
	if lower == strings.ToLower(metadataDirectory) || strings.HasSuffix(lower, ".dist-info") || strings.HasSuffix(lower, ".data") || lower == "bin" || lower == "share" || lower == "include" || strings.HasSuffix(lower, ".pth") {
		return ""
	}
	if strings.HasSuffix(lower, ".py") {
		first = first[:len(first)-len(".py")]
	} else if strings.Contains(first, ".") {
		if strings.HasSuffix(lower, ".so") || strings.HasSuffix(lower, ".pyd") || strings.Contains(lower, ".so.") {
			first = strings.SplitN(first, ".", 2)[0]
		} else {
			return ""
		}
	}
	if !pythonIdentifier(first) {
		return ""
	}
	return first
}

func pythonIdentifier(value string) bool {
	if value == "" {
		return false
	}
	for index, char := range value {
		if index == 0 {
			if !(char == '_' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z') {
				return false
			}
			continue
		}
		if !(char == '_' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9') {
			return false
		}
	}
	return true
}
