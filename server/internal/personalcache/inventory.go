package personalcache

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	packageInventoryFile     = ".package-inventory.json"
	packageInventorySchema   = 2
	maxPackageMetadataBytes  = int64(1 << 20)
	maxPackageRecordBytes    = int64(16 << 20)
	maxPackageRecordEntries  = 500_000
	maxPackageInventoryBytes = int64(8 << 20)
)

type InventoryPackage struct {
	Name      string   `json:"name"`
	Version   string   `json:"version"`
	Imports   []string `json:"imports,omitempty"`
	SizeBytes int64    `json:"size_bytes,omitempty"`
	Files     int      `json:"files,omitempty"`
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

// PublishedOperation proves that a package operation owns the canonical
// generation for the exact reviewed dependency digest. It is used only to
// reconcile a durable completion intent after a server restart.
func (m *Manager) PublishedOperation(request Request, operationID string) (bool, error) {
	if m == nil || m.options.ScopeMode != "project-lock" || strings.TrimSpace(operationID) == "" {
		return false, nil
	}
	gate := m.userGate(request.UserID)
	gate.Lock()
	defer gate.Unlock()
	resolved, err := m.resolveRequest(request)
	if err != nil {
		return false, err
	}
	valid, meta := readValidMetadata(resolved.hostRoot, request, resolved.fingerprint)
	if !valid || meta.OperationID != strings.TrimSpace(operationID) {
		return false, nil
	}
	entry, exists, err := m.lookupResolvedLocked(request, resolved)
	if err != nil || !exists {
		return false, err
	}
	inspection := m.inspectPackageInventoryEntryLocked(request, entry)
	return inspection.State == "ready" && inspection.Exact, nil
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
	reader, err := m.retainReadLocked(request, entry)
	if err != nil {
		return nil, entry, InventoryInspection{State: "error", Detail: "The published dependency generation could not be retained"}
	}
	entry.Active = true
	return reader, entry, inspection
}

// AcquirePackageInventorySnapshotRead inspects and retains the same published
// Python generation under one user gate. Unlike AcquirePackageInventoryRead,
// a published generation is retained even when its inventory is incomplete or
// corrupt so callers can report inventory health and analyzer visibility from
// one coherent snapshot.
func (m *Manager) AcquirePackageInventorySnapshotRead(request Request) (*ReadLease, Entry, InventoryInspection, bool) {
	if m == nil || m.options.ScopeMode != "project-lock" {
		inspection := InventoryInspection{State: "unavailable", Detail: "Project dependency cache inspection is unavailable"}
		return nil, Entry{}, inspection, false
	}
	gate := m.userGate(request.UserID)
	gate.Lock()
	defer gate.Unlock()
	inspection, entry := m.inspectPackageInventoryLocked(request)
	if entry.absPath == "" {
		return nil, entry, inspection, false
	}
	if inspection.State == "busy" {
		return nil, entry, inspection, true
	}
	reader, err := m.retainReadLocked(request, entry)
	if err != nil {
		return nil, entry, InventoryInspection{State: "error", Detail: "The published dependency generation could not be retained"}, true
	}
	entry.Active = true
	return reader, entry, inspection, true
}

func (m *Manager) inspectPackageInventoryLocked(request Request) (InventoryInspection, Entry) {
	entry, exists, err := m.lookupLocked(request)
	if err != nil {
		return InventoryInspection{State: "error", Detail: "The project dependency digest could not be resolved"}, entry
	}
	if !exists {
		return InventoryInspection{State: "missing", Detail: "No cache exists for the current project dependency digest"}, entry
	}
	return m.inspectPackageInventoryEntryLocked(request, entry), entry
}

func (m *Manager) inspectPackageInventoryEntryLocked(request Request, entry Entry) InventoryInspection {
	if !strings.EqualFold(strings.TrimSpace(entry.Language), "python") {
		return InventoryInspection{State: "unsupported", Detail: "Exact package inventory is not available for this language"}
	}
	m.mu.Lock()
	writerWithoutBase := m.writers[entry.key] > 0 && !m.writerHasBase[entry.key]
	m.mu.Unlock()
	if writerWithoutBase {
		return InventoryInspection{State: "busy", Detail: "The package inventory is changing while the cache is in use"}
	}

	document, err := readPackageInventory(entry.absPath)
	if errors.Is(err, os.ErrNotExist) {
		return InventoryInspection{State: "missing", Detail: "The package inventory snapshot has not been published"}
	}
	if err != nil {
		return InventoryInspection{State: "corrupt", Detail: "The package inventory snapshot is missing or corrupt"}
	}
	if document.Digest != entry.Digest || !strings.EqualFold(document.Language, entry.Language) {
		return InventoryInspection{State: "stale", Detail: "The package inventory belongs to a different dependency digest"}
	}
	if document.Schema != packageInventorySchema {
		if document.Schema == 1 && document.State != "busy" {
			packages, revision, _, scanErr := scanPythonPackageTree(filepath.Join(entry.absPath, "python"))
			if scanErr == nil {
				upgraded := packageInventoryDocument{
					Schema: packageInventorySchema, State: "ready", Language: "python", Digest: entry.Digest,
					GeneratedAt: time.Now().UTC(), TreeRevision: revision, Packages: packages,
				}
				if writeErr := writePackageInventory(entry.absPath, upgraded); writeErr == nil {
					return InventoryInspection{
						State: "ready", Detail: "The package inventory was upgraded and matches the current project dependency digest",
						Packages: packages, Exact: true, GeneratedAt: upgraded.GeneratedAt, Revision: revision,
					}
				}
			} else {
				slog.Warn("Project dependency inventory schema upgrade scan failed",
					"user_id", request.UserID, "workspace_id", request.WorkspaceID,
					"runtime", request.RuntimeID, "language", request.Language,
					"path", entry.Path, "error", scanErr)
			}
		}
		return InventoryInspection{State: "stale", Detail: "The package inventory was published by an incompatible scanner version"}
	}
	if document.State != "ready" {
		// Older servers could publish an incomplete snapshot for a fully valid
		// pip --target tree because relocated bin/share RECORD paths were rejected.
		// Repair only an explicitly completed publication attempt; a leftover
		// busy marker still means an unclean writer and remains fail-closed.
		if document.State == "incomplete" {
			packages, revision, _, scanErr := scanPythonPackageTree(filepath.Join(entry.absPath, "python"))
			if scanErr == nil {
				repaired := packageInventoryDocument{
					Schema: packageInventorySchema, State: "ready", Language: "python", Digest: entry.Digest,
					GeneratedAt: time.Now().UTC(), TreeRevision: revision, Packages: packages,
				}
				if writeErr := writePackageInventory(entry.absPath, repaired); writeErr == nil {
					if m.options.Metrics != nil {
						m.options.Metrics.Cache("dependency.cache.inventory.repair", true)
					}
					return InventoryInspection{
						State: "ready", Detail: "The package inventory matches the current project dependency digest",
						Packages: packages, Exact: true, GeneratedAt: repaired.GeneratedAt, Revision: revision,
					}
				}
			} else {
				slog.Warn("Project dependency inventory repair scan failed",
					"user_id", request.UserID, "workspace_id", request.WorkspaceID,
					"runtime", request.RuntimeID, "language", request.Language,
					"path", entry.Path, "error", scanErr)
			}
			if m.options.Metrics != nil {
				m.options.Metrics.Cache("dependency.cache.inventory.repair", false)
			}
		}
		detail := strings.TrimSpace(document.Detail)
		if detail == "" {
			detail = "The package inventory was not published completely"
		}
		return InventoryInspection{State: "incomplete", Detail: detail, GeneratedAt: document.GeneratedAt}
	}
	packages, revision, _, scanErr := scanPythonPackageTree(filepath.Join(entry.absPath, "python"))
	if scanErr != nil {
		return InventoryInspection{State: "incomplete", Detail: "Python package metadata could not be read completely", GeneratedAt: document.GeneratedAt}
	}
	if revision != document.TreeRevision {
		return InventoryInspection{State: "stale", Detail: "The package tree changed after its inventory snapshot was published", Packages: packages, GeneratedAt: document.GeneratedAt, Revision: revision}
	}
	return InventoryInspection{
		State: "ready", Detail: "The package inventory matches the current project dependency digest",
		Packages: packages, Exact: true, GeneratedAt: document.GeneratedAt, Revision: revision,
	}
}

// PreviewPackageInventory scans a writable generation without publishing it.
// Package-center transactions use this as their pre-commit validation step so
// an incomplete install can never replace the last known-good generation.
func (l *Lease) PreviewPackageInventory() InventoryInspection {
	if l == nil || l.manager == nil || !l.writable {
		return InventoryInspection{State: "unavailable", Detail: "A writable project dependency generation is required"}
	}
	if l.aborted.Load() {
		return InventoryInspection{State: "aborted", Detail: "The project dependency generation was aborted"}
	}
	if !strings.EqualFold(strings.TrimSpace(l.request.Language), "python") {
		return InventoryInspection{State: "unsupported", Detail: "Exact package inventory is not available for this language"}
	}
	packages, revision, _, err := scanPythonPackageTree(filepath.Join(l.HostRoot, "python"))
	if err != nil {
		return InventoryInspection{State: "incomplete", Detail: "Python package metadata could not be read completely: " + err.Error()}
	}
	return InventoryInspection{
		State:       "ready",
		Detail:      "The staged package inventory is exact and ready to publish",
		Packages:    packages,
		Exact:       true,
		GeneratedAt: time.Now().UTC(),
		Revision:    revision,
	}
}

func (l *Lease) publishInventory() error {
	if l == nil || l.manager == nil || !strings.EqualFold(strings.TrimSpace(l.request.Language), "python") {
		return nil
	}
	started := time.Now()
	l.manager.mu.Lock()
	lastWriter := l.manager.writers[l.Key] == 1
	l.manager.mu.Unlock()
	if !lastWriter {
		return nil
	}
	err := publishPackageInventory(l.HostRoot, l.request.Language, l.Fingerprint.Digest)
	if l.manager.options.Metrics != nil {
		l.manager.options.Metrics.Observe("dependency.cache.inventory.publish", time.Since(started))
		l.manager.options.Metrics.Cache("dependency.cache.inventory", err == nil)
	}
	return err
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
		document.Detail = "Python package metadata could not be read completely: " + err.Error()
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
	tree, err := scanPythonPackageTreeDetailed(root)
	if err != nil {
		return nil, "", 0, err
	}
	return tree.Packages, tree.Revision, tree.Latest, nil
}

// pip --target relocates scheme data such as console scripts and man pages
// into the target root, but wheel RECORD rows retain paths such as
// ../../bin/f2py and ../../share/man/.... Treat only the standard relocated
// roots as optional relocated data. A caller may grant ownership only after a
// concrete relocated file has been verified.
func pythonTargetRecordPath(root, value string) (string, string, bool, bool) {
	value = filepath.ToSlash(strings.TrimSpace(value))
	if value == "" || strings.HasPrefix(value, "/") {
		return "", "", false, false
	}
	parts := strings.Split(value, "/")
	for len(parts) > 0 && (parts[0] == "" || parts[0] == ".") {
		parts = parts[1:]
	}
	relocated := false
	for len(parts) > 0 && parts[0] == ".." {
		relocated = true
		parts = parts[1:]
	}
	if len(parts) == 0 {
		return "", "", false, false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", "", false, false
		}
	}
	rootName := strings.ToLower(parts[0])
	if relocated {
		switch rootName {
		case "bin", "share", "include":
		default:
			return "", "", false, false
		}
	}
	candidate := filepath.Join(append([]string{root}, parts...)...)
	cleanRoot := filepath.Clean(root)
	cleanCandidate := filepath.Clean(candidate)
	if cleanCandidate == cleanRoot || !strings.HasPrefix(cleanCandidate, cleanRoot+string(filepath.Separator)) {
		return "", "", false, false
	}
	return cleanCandidate, parts[0], relocated, true
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
