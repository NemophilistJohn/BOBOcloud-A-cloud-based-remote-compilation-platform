package personalcache

import (
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	packageInventoryFile     = ".package-inventory.json"
	packageInventorySchema   = 1
	maxPackageMetadataBytes  = int64(1 << 20)
	maxPackageRecordBytes    = int64(16 << 20)
	maxPackageRecordEntries  = 500_000
	maxPackageInventoryBytes = int64(8 << 20)
)

type InventoryPackage struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type InventoryInspection struct {
	State       string
	Detail      string
	Packages    []InventoryPackage
	Exact       bool
	GeneratedAt time.Time
	Revision    string
}

type packageInventoryDocument struct {
	Schema       int                `json:"schema"`
	State        string             `json:"state"`
	Language     string             `json:"language"`
	Digest       string             `json:"digest"`
	GeneratedAt  time.Time          `json:"generated_at"`
	TreeRevision string             `json:"tree_revision,omitempty"`
	Packages     []InventoryPackage `json:"packages"`
	Detail       string             `json:"detail,omitempty"`
}

// InspectPackageInventory returns package truth only for the exact cache
// namespace selected by request. It never falls back to another project,
// runtime, language, or dependency digest.
func (m *Manager) InspectPackageInventory(request Request) InventoryInspection {
	if m == nil || m.options.ScopeMode != "project-lock" {
		return InventoryInspection{State: "unavailable", Detail: "Project dependency cache inspection is unavailable"}
	}
	gate := m.userGate(request.UserID)
	gate.Lock()
	defer gate.Unlock()
	inspection, _ := m.inspectPackageInventoryLocked(request)
	return inspection
}

// AcquirePackageInventoryRead validates and retains one exact package
// inventory under the same per-user gate. Delete and LRU cannot remove the
// namespace until the returned lease is released.
func (m *Manager) AcquirePackageInventoryRead(request Request) (*ReadLease, Entry, InventoryInspection) {
	if m == nil || m.options.ScopeMode != "project-lock" {
		inspection := InventoryInspection{State: "unavailable", Detail: "Project dependency cache inspection is unavailable"}
		return nil, Entry{}, inspection
	}
	gate := m.userGate(request.UserID)
	gate.Lock()
	defer gate.Unlock()
	inspection, entry := m.inspectPackageInventoryLocked(request)
	if inspection.State != "ready" || !inspection.Exact {
		return nil, entry, inspection
	}
	reader := m.retainReadLocked(request, entry)
	entry.Active = true
	return reader, entry, inspection
}

func (m *Manager) inspectPackageInventoryLocked(request Request) (InventoryInspection, Entry) {
	entry, exists, err := m.lookupLocked(request)
	if err != nil {
		return InventoryInspection{State: "error", Detail: "The project dependency digest could not be resolved"}, entry
	}
	if !exists {
		return InventoryInspection{State: "missing", Detail: "No cache exists for the current project dependency digest"}, entry
	}
	if !strings.EqualFold(strings.TrimSpace(entry.Language), "python") {
		return InventoryInspection{State: "unsupported", Detail: "Exact package inventory is not available for this language"}, entry
	}
	if entry.Writing {
		return InventoryInspection{State: "busy", Detail: "The package inventory is changing while the cache is in use"}, entry
	}

	document, err := readPackageInventory(entry.absPath)
	if errors.Is(err, os.ErrNotExist) {
		return InventoryInspection{State: "missing", Detail: "The package inventory snapshot has not been published"}, entry
	}
	if err != nil {
		return InventoryInspection{State: "corrupt", Detail: "The package inventory snapshot is missing or corrupt"}, entry
	}
	if document.Schema != packageInventorySchema || document.Digest != entry.Digest || !strings.EqualFold(document.Language, entry.Language) {
		return InventoryInspection{State: "stale", Detail: "The package inventory belongs to a different dependency digest"}, entry
	}
	if document.State != "ready" {
		detail := strings.TrimSpace(document.Detail)
		if detail == "" {
			detail = "The package inventory was not published completely"
		}
		return InventoryInspection{State: "incomplete", Detail: detail, GeneratedAt: document.GeneratedAt}, entry
	}
	packages, revision, _, scanErr := scanPythonPackageTree(filepath.Join(entry.absPath, "python"))
	if scanErr != nil {
		return InventoryInspection{State: "incomplete", Detail: "Python package metadata could not be read completely", GeneratedAt: document.GeneratedAt}, entry
	}
	if revision != document.TreeRevision {
		return InventoryInspection{State: "stale", Detail: "The package tree changed after its inventory snapshot was published", Packages: packages, GeneratedAt: document.GeneratedAt, Revision: revision}, entry
	}
	return InventoryInspection{
		State: "ready", Detail: "The package inventory matches the current project dependency digest",
		Packages: packages, Exact: true, GeneratedAt: document.GeneratedAt, Revision: revision,
	}, entry
}

func (l *Lease) publishInventory() error {
	if l == nil || l.manager == nil || !strings.EqualFold(strings.TrimSpace(l.request.Language), "python") {
		return nil
	}
	gate := l.manager.userGate(l.request.UserID)
	gate.Lock()
	defer gate.Unlock()

	l.manager.mu.Lock()
	lastWriter := l.manager.writers[l.Key] == 1
	l.manager.mu.Unlock()
	if !lastWriter {
		return nil
	}
	return publishPackageInventory(l.HostRoot, l.request.Language, l.Fingerprint.Digest)
}

func markPackageInventoryDirty(root, language, digest string) error {
	if !strings.EqualFold(strings.TrimSpace(language), "python") {
		return nil
	}
	return writePackageInventory(root, packageInventoryDocument{
		Schema: packageInventorySchema, State: "busy", Language: "python", Digest: digest,
		GeneratedAt: time.Now().UTC(), Packages: []InventoryPackage{},
		Detail: "The package inventory has an active writer and is not safe to read",
	})
}

func publishPackageInventory(root, language, digest string) error {
	document := packageInventoryDocument{
		Schema: packageInventorySchema, State: "incomplete", Language: strings.ToLower(strings.TrimSpace(language)),
		Digest: digest, GeneratedAt: time.Now().UTC(), Packages: []InventoryPackage{},
	}
	packages, revision, _, err := scanPythonPackageTree(filepath.Join(root, "python"))
	if err != nil {
		document.Detail = "Python package metadata could not be read completely"
		_ = writePackageInventory(root, document)
		return err
	}
	document.State = "ready"
	document.TreeRevision = revision
	document.Packages = packages
	return writePackageInventory(root, document)
}

func readPackageInventory(root string) (packageInventoryDocument, error) {
	path := filepath.Join(root, packageInventoryFile)
	data, err := readSmallRegularFile(path, maxPackageInventoryBytes)
	if err != nil {
		return packageInventoryDocument{}, err
	}
	var document packageInventoryDocument
	if json.Unmarshal(data, &document) != nil {
		return packageInventoryDocument{}, fmt.Errorf("decode package inventory")
	}
	if document.Packages == nil {
		document.Packages = []InventoryPackage{}
	}
	return document, nil
}

func writePackageInventory(root string, document packageInventoryDocument) error {
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	if int64(len(data)) > maxPackageInventoryBytes {
		return fmt.Errorf("package inventory exceeds %d bytes", maxPackageInventoryBytes)
	}
	return atomicWriteFile(root, packageInventoryFile, append(data, '\n'), 0600)
}

func scanPythonPackageTree(root string) ([]InventoryPackage, string, int64, error) {
	info, err := os.Lstat(root)
	if err != nil {
		return nil, "", 0, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, "", 0, fmt.Errorf("Python package root is not a real directory")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, "", 0, err
	}
	sort.Slice(entries, func(i, j int) bool { return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name()) })
	hash := sha256.New()
	packages := make([]InventoryPackage, 0)
	latest := info.ModTime().UTC().UnixMilli()
	seen := make(map[string]string)
	ownedRoots := make(map[string]bool)
	for _, entry := range entries {
		if strings.HasSuffix(strings.ToLower(entry.Name()), ".egg-info") {
			return nil, "", 0, fmt.Errorf("unsupported Python distribution metadata directory %q", entry.Name())
		}
		if !strings.HasSuffix(strings.ToLower(entry.Name()), ".dist-info") {
			continue
		}
		directory := filepath.Join(root, entry.Name())
		directoryInfo, statErr := os.Lstat(directory)
		if statErr != nil || !directoryInfo.IsDir() || directoryInfo.Mode()&os.ModeSymlink != 0 {
			return nil, "", 0, fmt.Errorf("invalid Python distribution metadata directory %q", entry.Name())
		}
		metadataPath := filepath.Join(directory, "METADATA")
		metadataInfo, statErr := os.Lstat(metadataPath)
		if statErr != nil || !metadataInfo.Mode().IsRegular() || metadataInfo.Mode()&os.ModeSymlink != 0 || metadataInfo.Size() > maxPackageMetadataBytes {
			return nil, "", 0, fmt.Errorf("invalid Python distribution metadata for %q", entry.Name())
		}
		data, readErr := readSmallRegularFile(metadataPath, maxPackageMetadataBytes)
		if readErr != nil {
			return nil, "", 0, fmt.Errorf("read Python distribution metadata for %q", entry.Name())
		}
		name := inventoryMetadataField(data, "Name")
		version := inventoryMetadataField(data, "Version")
		if name == "" || version == "" {
			return nil, "", 0, fmt.Errorf("Python distribution metadata is incomplete for %q", entry.Name())
		}
		recordPath := filepath.Join(directory, "RECORD")
		recordInfo, statErr := os.Lstat(recordPath)
		if statErr != nil || !recordInfo.Mode().IsRegular() || recordInfo.Mode()&os.ModeSymlink != 0 || recordInfo.Size() > maxPackageRecordBytes {
			return nil, "", 0, fmt.Errorf("invalid Python installation record for %q", entry.Name())
		}
		recordData, readErr := readSmallRegularFile(recordPath, maxPackageRecordBytes)
		if readErr != nil {
			return nil, "", 0, fmt.Errorf("read Python installation record for %q", entry.Name())
		}
		records, parseErr := csv.NewReader(strings.NewReader(string(recordData))).ReadAll()
		if parseErr != nil || len(records) == 0 || len(records) > maxPackageRecordEntries {
			return nil, "", 0, fmt.Errorf("invalid Python installation record entries for %q", entry.Name())
		}
		for _, record := range records {
			if len(record) == 0 || strings.TrimSpace(record[0]) == "" {
				return nil, "", 0, fmt.Errorf("empty Python installation record entry for %q", entry.Name())
			}
			recorded := filepath.Clean(filepath.FromSlash(record[0]))
			_, _ = hash.Write([]byte("record\x00" + filepath.ToSlash(recorded) + "\x00"))
			if filepath.IsAbs(recorded) || recorded == ".." || strings.HasPrefix(recorded, ".."+string(filepath.Separator)) {
				// Console entry points can live outside site-packages. They are
				// represented in the revision, but are not trusted as package roots.
				continue
			}
			recordedParts := strings.Split(filepath.ToSlash(recorded), "/")
			if len(recordedParts) > 0 && recordedParts[0] != "" && recordedParts[0] != "." {
				ownedRoots[strings.ToLower(recordedParts[0])] = true
			}
			lowerRecorded := strings.ToLower(filepath.ToSlash(recorded))
			if strings.HasSuffix(lowerRecorded, ".pyc") || strings.HasSuffix(lowerRecorded, ".pyo") || strings.Contains(lowerRecorded, "/__pycache__/") {
				continue
			}
			recordedPath := filepath.Join(root, recorded)
			recordedInfo, recordErr := os.Lstat(recordedPath)
			if recordErr != nil || !recordedInfo.Mode().IsRegular() || recordedInfo.Mode()&os.ModeSymlink != 0 {
				return nil, "", 0, fmt.Errorf("Python package file %q is missing or invalid", filepath.ToSlash(recorded))
			}
			_, _ = hash.Write([]byte(fmt.Sprintf("%d\x00%d\x00", recordedInfo.Size(), recordedInfo.ModTime().UTC().UnixNano())))
			if recordedInfo.ModTime().UTC().UnixMilli() > latest {
				latest = recordedInfo.ModTime().UTC().UnixMilli()
			}
		}
		name = normalizeInventoryPythonName(name)
		if previous, duplicate := seen[name]; duplicate && previous != version {
			return nil, "", 0, fmt.Errorf("conflicting Python distribution metadata for %q", name)
		}
		seen[name] = version
		_, _ = hash.Write([]byte(strings.ToLower(entry.Name())))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write(data)
		_, _ = hash.Write([]byte{0})
		if metadataInfo.ModTime().UTC().UnixMilli() > latest {
			latest = metadataInfo.ModTime().UTC().UnixMilli()
		}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	for _, entry := range entries {
		name := strings.ToLower(entry.Name())
		if name == "__pycache__" {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 || !ownedRoots[name] {
			return nil, "", 0, fmt.Errorf("Python package tree contains unowned top-level entry %q", entry.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		packages = append(packages, InventoryPackage{Name: name, Version: seen[name]})
	}
	_, _ = hash.Write([]byte("complete"))
	return packages, hex.EncodeToString(hash.Sum(nil)), latest, nil
}

func inventoryMetadataField(data []byte, field string) string {
	prefix := strings.ToLower(field) + ":"
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if strings.HasPrefix(strings.ToLower(line), prefix) {
			return strings.TrimSpace(line[len(prefix):])
		}
	}
	return ""
}

func normalizeInventoryPythonName(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	separator := false
	for _, char := range value {
		if char == '-' || char == '_' || char == '.' {
			if builder.Len() > 0 {
				separator = true
			}
			continue
		}
		if separator {
			builder.WriteByte('-')
			separator = false
		}
		builder.WriteRune(char)
	}
	return strings.Trim(builder.String(), "-")
}
