package lsp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Catalogs describe import identities. API summaries describe direct public
// declarations from one module. Keeping these operations separate makes a
// first import independent of parsing all installed libraries.
type DependencyAPIQuery struct {
	Kind     string
	Module   string
	Prefix   string
	Cursor   string
	MaxBytes int
}

const (
	dependencyQueryVersion       = "dependency-query-v1"
	dependencyQueryMaxModules    = 8192
	dependencyQueryMaxDirs       = 4096
	dependencyQueryMaxItems      = 65536
	dependencyQueryMaxSummaries  = 128
	dependencyQueryMaxCacheBytes = 8 << 20
	dependencyQueryMaxArchive    = 32 << 20
	dependencyQueryMaxSymbols    = 512
)

type dependencyModuleSource struct {
	mount int
	parts []string
	file  string
	kind  string
	// Java and Go may expose source or class records from a bounded archive.
	archive string
	prefix  string
}

type dependencyQueryState struct {
	revision       string
	language       string
	modules        map[string][]dependencyModuleSource
	roots          []string
	project        []string
	queued         map[string]bool
	summaries      map[string]DependencyAPIIndexPage
	summaryOrder   []string
	durableLoaded  bool
	truncated      bool
	catalogStarted bool
	catalogPending []dependencyCatalogTask
	catalogDirs    int
	catalogItems   int
	runtimePending bool
}

type dependencyCatalogTask struct {
	mount int
	parts []string
	depth int
	kind  string
	file  string
}

// A transient discovery failure must never become a completed empty catalog.
// Clients retry the same cursor with backoff, retaining earlier pages.
var ErrDependencyDiscoveryBusy = errors.New("dependency discovery is temporarily busy")

type dependencyQueryScan struct {
	session *Session
	state   *dependencyQueryState
	dirs    int
	items   int
}

func dependencyQueryKinds(language string, available bool) []string {
	if !available || !supportedDependencyQueryLanguage(language) {
		return []string{}
	}
	return []string{"catalog", "module", "project"}
}

func supportedDependencyQueryLanguage(language string) bool {
	switch normalizeLanguage(language) {
	case "python", "node", "go", "rust", "java", "c", "cpp":
		return true
	default:
		return false
	}
}

func dependencyQueryMountRole(language, role string) bool {
	switch normalizeLanguage(language) {
	case "python":
		return role == DependencyRolePythonPackages
	case "node":
		return role == DependencyRoleNodeModules
	case "go":
		return role == DependencyRoleGoModules
	case "rust":
		return role == DependencyRoleRustRegistrySrc || role == DependencyRoleRustGitCheckout
	case "java":
		return role == DependencyRoleJavaMaven || role == DependencyRoleJavaGradle
	case "c", "cpp":
		return role == DependencyRoleNativeIncludes || role == DependencyRoleNativeSysroot
	default:
		return false
	}
}

func dependencyQueryAvailable(context SessionContext) bool {
	if !context.DependencyResolved || context.RuntimeID == "" || context.DependencyView.Revision == "" || !supportedDependencyQueryLanguage(context.LanguageID) {
		return false
	}
	for _, mount := range context.DependencyView.Mounts {
		if mount.ReadOnly && mount.HostPath != "" && dependencyQueryMountRole(context.LanguageID, mount.Role) {
			return true
		}
	}
	return context.RuntimeDependencyQuery != nil && context.RuntimeDependencyRevision != ""
}

func validDependencyQueryName(value string) bool {
	if value == "" || len(value) > 256 || strings.ContainsAny(value, "\x00\r\n\\") || strings.HasPrefix(value, "/") || strings.Contains(value, "://") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func validDependencyQuerySymbol(language, value string) bool {
	if normalizeLanguage(language) != "node" {
		return validPythonIdentifier(value)
	}
	if value == "" || len(value) > 128 {
		return false
	}
	for index, char := range value {
		if char == '$' || char == '_' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || index > 0 && char >= '0' && char <= '9' {
			continue
		}
		return false
	}
	return true
}

func ValidateDependencyAPIQuery(query DependencyAPIQuery) error {
	if err := ValidateDependencyAPIIndexPageBytes(query.MaxBytes); err != nil {
		return err
	}
	if query.Kind != "" && query.Kind != "catalog" && query.Kind != "module" && query.Kind != "project" {
		return fmt.Errorf("invalid dependency query kind")
	}
	if len(query.Cursor) > 128 || len(query.Prefix) > 128 || strings.ContainsAny(query.Prefix, "\x00\r\n\\") ||
		(query.Module != "" && !validDependencyQueryName(query.Module)) || (query.Kind == "module" && query.Module == "") {
		return fmt.Errorf("invalid dependency query")
	}
	return nil
}

func (s *Session) DependencyAPIQueryPage(query DependencyAPIQuery) (DependencyAPIIndexPage, error) {
	if err := ValidateDependencyAPIQuery(query); err != nil {
		return DependencyAPIIndexPage{}, err
	}
	if query.Kind == "" {
		return s.DependencyAPIIndexPage(query.Cursor, query.MaxBytes)
	}
	if s == nil || !dependencyQueryAvailable(s.Context) || !s.beginDependencyAPIIndex() {
		return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
	}
	defer s.finishDependencyAPIIndex()
	s.dependencyIndexMu.Lock()
	defer s.dependencyIndexMu.Unlock()
	if s.dependencyQueries == nil || s.dependencyQueries.revision != s.dependencyQueryRevision() {
		state := &dependencyQueryState{
			revision: s.dependencyQueryRevision(), language: normalizeLanguage(s.Context.LanguageID),
			modules: make(map[string][]dependencyModuleSource), queued: make(map[string]bool),
			summaries: make(map[string]DependencyAPIIndexPage),
		}
		s.dependencyQueries = state
	}
	state := s.dependencyQueries
	if err := s.discoverDependencyCatalog(state); err != nil {
		return DependencyAPIIndexPage{}, err
	}
	if s.dependencyQueryStopped() {
		return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
	}
	identity := s.dependencyQueryIdentity(query)
	offset, err := dependencyAPIIndexCursorOffset(query.Cursor, identity, dependencyQueryMaxModules)
	if err != nil {
		return DependencyAPIIndexPage{}, err
	}
	if query.Kind == "module" {
		if offset != 0 {
			return DependencyAPIIndexPage{}, ErrDependencyAPIIndexCursor
		}
		if len(state.modules[query.Module]) == 0 && len(s.resolveDependencyModule(state, query.Module)) == 0 && !state.catalogComplete() {
			return DependencyAPIIndexPage{}, ErrDependencyDiscoveryBusy
		}
		page, err := s.dependencyModuleSummary(state, query.Module)
		if err != nil {
			return DependencyAPIIndexPage{}, err
		}
		page.Cursor = query.Cursor
		return fitDependencyQueryPage(page, query.MaxBytes), nil
	}
	if query.Kind == "project" {
		if offset >= len(state.project) {
			if offset != len(state.project) {
				return DependencyAPIIndexPage{}, ErrDependencyAPIIndexCursor
			}
			if !state.catalogComplete() {
				return DependencyAPIIndexPage{}, ErrDependencyDiscoveryBusy
			}
			return s.newDependencyQueryPage(query.Kind, "", state.truncated), nil
		}
		module := state.project[offset]
		page, err := s.dependencyModuleSummary(state, module)
		if err != nil {
			return DependencyAPIIndexPage{}, err
		}
		page.QueryKind = "project"
		page.Cursor = query.Cursor
		page.Complete = offset+1 >= len(state.project) && state.catalogComplete()
		if !page.Complete {
			page.NextCursor = dependencyAPIIndexCursor(identity, offset+1)
		}
		return fitDependencyQueryPage(page, query.MaxBytes), nil
	}
	page := s.newDependencyQueryPage("catalog", "", state.truncated)
	var names []string
	for _, name := range state.roots {
		if query.Prefix == "" || strings.HasPrefix(strings.ToLower(name), strings.ToLower(query.Prefix)) {
			names = append(names, name)
		}
	}
	if offset > len(names) {
		return DependencyAPIIndexPage{}, ErrDependencyAPIIndexCursor
	}
	page.Cursor = query.Cursor
	position := offset
	envelope, _ := dependencyAPIIndexControlPayload(page)
	pageBytes := len(envelope)
	for position < len(names) {
		entry := DependencyAPIIndexEntry{Module: names[position], Kind: "module"}
		encodedName, _ := json.Marshal(names[position])
		encodedEntry, _ := json.Marshal(entry)
		addedBytes := len(encodedName) + len(encodedEntry) + 2
		if pageBytes+addedBytes > dependencyAPIIndexPageBytes(query.MaxBytes)-512 && len(page.Entries) > 0 {
			break
		}
		page.Roots = append(page.Roots, names[position])
		page.Entries = append(page.Entries, entry)
		pageBytes += addedBytes
		position++
	}
	page.Complete = position == len(names) && state.catalogComplete()
	if position == offset && !page.Complete {
		return DependencyAPIIndexPage{}, ErrDependencyDiscoveryBusy
	}
	if !page.Complete {
		page.NextCursor = dependencyAPIIndexCursor(identity, position)
	}
	return page, nil
}

func (s *Session) dependencyQueryIdentity(query DependencyAPIQuery) string {
	hash := sha256.Sum256([]byte(strings.Join([]string{s.ID, s.dependencyQueryRevision(), query.Kind, query.Module, query.Prefix}, "\x00")))
	return hex.EncodeToString(hash[:16])
}

func (s *Session) dependencyQueryRevision() string {
	if s.Context.RuntimeDependencyRevision == "" {
		return s.Context.DependencyView.Revision
	}
	hash := sha256.Sum256([]byte(s.Context.DependencyView.Revision + "\x00" + s.Context.RuntimeDependencyRevision))
	return hex.EncodeToString(hash[:])
}

func (s *Session) dependencyQueryStopped() bool {
	select {
	case <-s.stopping:
		return true
	default:
		return false
	}
}

func (s *Session) queryRuntimeDependencies(query DependencyAPIQuery) (DependencyAPIIndexPage, error) {
	if s.Context.RuntimeDependencyQuery == nil {
		return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-s.stopping:
			cancel()
		case <-ctx.Done():
		}
	}()
	page, err := s.Context.RuntimeDependencyQuery(ctx, query)
	if err == nil {
		page.Revision = s.dependencyQueryRevision()
	}
	return page, err
}

func (s *Session) newDependencyQueryPage(kind, module string, truncated bool) DependencyAPIIndexPage {
	coverage := "direct"
	if truncated {
		coverage = "partial"
	}
	return DependencyAPIIndexPage{
		Schema: DependencyAPIIndexSchema, LanguageID: normalizeLanguage(s.Context.LanguageID),
		RuntimeID: s.Context.RuntimeID, Revision: s.dependencyQueryRevision(),
		QueryKind: kind, Module: module, Coverage: coverage, Truncated: truncated,
		Roots: []string{}, Entries: []DependencyAPIIndexEntry{}, Complete: true,
	}
}

func fitDependencyQueryPage(page DependencyAPIIndexPage, maxBytes int) DependencyAPIIndexPage {
	for {
		data, err := dependencyAPIIndexControlPayload(page)
		if err == nil && len(data) <= dependencyAPIIndexPageBytes(maxBytes) {
			return page
		}
		page.Truncated, page.Coverage = true, "partial"
		if len(page.Entries) == 0 {
			return page
		}
		last := len(page.Entries) - 1
		if len(page.Entries[last].Symbols) > 0 {
			page.Entries[last].Symbols = page.Entries[last].Symbols[:len(page.Entries[last].Symbols)-1]
		} else {
			page.Entries = page.Entries[:last]
		}
	}
}
