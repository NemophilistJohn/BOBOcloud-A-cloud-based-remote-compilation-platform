package lsp

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"bobocloud-server/internal/safefile"
)

const (
	// DependencyAPIIndexSchema is intentionally independent from the analyzer
	// cache format. Clients can discard an unknown schema without trusting a
	// source path or analyzer-specific payload.
	DependencyAPIIndexSchema = "dependency-api-index-v1"

	dependencyAPIIndexFile = ".dependency-api-index-v1.json"
	// Keep the complete, static payload below the client-side dependency-index
	// transfer/cache envelope. The page minimum below guarantees <=128 pages.
	dependencyAPIIndexMaxBytes                        = 5 << 20
	dependencyAPIIndexMaxEntries                      = 8_192
	dependencyAPIIndexMaxRoots                        = 2_048
	dependencyAPIIndexMaxSymbolsPerModule             = 256
	dependencyAPIIndexMaxTotalSymbols                 = 65_536
	dependencyAPIIndexMaxSymbolBytes                  = 128
	dependencyAPIIndexMaxStaticImportsPerModule       = 64
	dependencyAPIIndexMaxAllExportsPerModule          = 256
	dependencyAPIIndexMaxParseLines                   = 4_096
	dependencyAPIIndexMaxConditionalBranches          = 32
	dependencyAPIIndexMaxConditionalBodyLines         = 1_024
	dependencyAPIIndexMaxConditionalStatements        = 256
	dependencyAPIIndexMaxResolveSteps                 = 65_536
	dependencyAPIIndexMaxDirectories                  = 2_048
	dependencyAPIIndexMaxDirectoryItems               = 1_024
	dependencyAPIIndexMaxFiles                        = 8_192
	dependencyAPIIndexMaxSourceBytes            int64 = 256 << 10
	dependencyAPIIndexMaxDepth                        = 8
	dependencyAPIIndexScanBudget                      = 1500 * time.Millisecond

	// Every control response, including its wrapper, stays below this cap.
	DependencyAPIIndexPageDefaultBytes = DependencyAPIIndexPageMaxBytes
	DependencyAPIIndexPageMinBytes     = 64 << 10
	DependencyAPIIndexPageMaxBytes     = (192 << 10) - (2 << 10)
	DependencyAPIIndexMaxPages         = 128
)

var (
	ErrDependencyAPIIndexUnsupported = errors.New("dependency API index is unsupported for this language")
	ErrDependencyAPIIndexUnavailable = errors.New("dependency API index is unavailable")
	ErrDependencyAPIIndexCursor      = errors.New("dependency API index cursor is invalid")
	ErrDependencyAPIIndexPageSize    = errors.New("dependency API index page size is invalid")
)

// DependencyAPIIndex contains only sanitized module names and public symbol
// summaries. Dotted module names encode the package tree compactly; host paths
// and package source text never leave the server.
type DependencyAPIIndex struct {
	Schema     string                    `json:"schema"`
	LanguageID string                    `json:"languageId"`
	RuntimeID  string                    `json:"runtimeId"`
	Revision   string                    `json:"revision"`
	Roots      []string                  `json:"roots"`
	Entries    []DependencyAPIIndexEntry `json:"entries"`
	Truncated  bool                      `json:"truncated,omitempty"`
}

// DependencyAPIIndexEntry represents one Python package or module. Symbols
// are direct public exports after resolving bounded, static star re-exports.
type DependencyAPIIndexEntry struct {
	Module  string                     `json:"module"`
	Kind    string                     `json:"kind"`
	Symbols []DependencyAPIIndexSymbol `json:"symbols,omitempty"`
}

type DependencyAPIIndexSymbol struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// DependencyAPIIndexPage is a self-describing fragment. Roots contains the
// top-level package names represented by this page, allowing a client to merge
// pages without reconstructing host-side mount information.
type DependencyAPIIndexPage struct {
	Schema     string                    `json:"schema"`
	LanguageID string                    `json:"languageId"`
	RuntimeID  string                    `json:"runtimeId"`
	Revision   string                    `json:"revision"`
	Roots      []string                  `json:"roots"`
	Entries    []DependencyAPIIndexEntry `json:"entries"`
	Cursor     string                    `json:"cursor,omitempty"`
	NextCursor string                    `json:"nextCursor,omitempty"`
	Complete   bool                      `json:"complete"`
	Truncated  bool                      `json:"truncated,omitempty"`
}

type pythonIndexModule struct {
	module      string
	kind        string
	symbols     map[string]string
	starImports []string
	all         []string
}

type dependencyAPIIndexBuild struct {
	modules      map[string]*pythonIndexModule
	deadline     time.Time
	directories  int
	items        int
	files        int
	symbols      int
	parseSteps   int
	resolveSteps int
	truncated    bool
}

func newDependencyAPIIndexBuild() *dependencyAPIIndexBuild {
	return &dependencyAPIIndexBuild{
		modules:  make(map[string]*pythonIndexModule),
		deadline: time.Now().Add(dependencyAPIIndexScanBudget),
	}
}

func (b *dependencyAPIIndexBuild) exhausted() bool {
	return b == nil || time.Now().After(b.deadline)
}

func (b *dependencyAPIIndexBuild) consumeDirectory() bool {
	if b.exhausted() || b.directories >= dependencyAPIIndexMaxDirectories {
		b.truncated = true
		return false
	}
	b.directories++
	return true
}

func (b *dependencyAPIIndexBuild) consumeItems(count int) bool {
	if b.exhausted() || count < 0 || b.items+count > dependencyAPIIndexMaxEntries*4 {
		b.truncated = true
		return false
	}
	b.items += count
	return true
}

func (b *dependencyAPIIndexBuild) consumeFile() bool {
	if b.exhausted() || b.files >= dependencyAPIIndexMaxFiles {
		b.truncated = true
		return false
	}
	b.files++
	return true
}

func (b *dependencyAPIIndexBuild) consumeParseStep() bool {
	if b.exhausted() || b.parseSteps >= dependencyAPIIndexMaxResolveSteps {
		b.truncated = true
		return false
	}
	b.parseSteps++
	return true
}

func (b *dependencyAPIIndexBuild) consumeResolveStep() bool {
	if b.exhausted() || b.resolveSteps >= dependencyAPIIndexMaxResolveSteps {
		b.truncated = true
		return false
	}
	b.resolveSteps++
	return true
}

func (b *dependencyAPIIndexBuild) limitedUniqueStrings(target, values []string, max int) []string {
	if b == nil || len(values) == 0 || max <= 0 {
		return target
	}
	seen := make(map[string]struct{}, len(target)+len(values))
	for _, value := range target {
		seen[value] = struct{}{}
	}
	for _, value := range values {
		if !b.consumeParseStep() {
			break
		}
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		if len(target) >= max {
			b.truncated = true
			break
		}
		seen[value] = struct{}{}
		target = append(target, value)
	}
	return target
}

func (b *dependencyAPIIndexBuild) addParsedPythonSymbol(values map[string]string, name, kind string) {
	if b == nil || values == nil || !isPublicPythonSymbol(name) {
		return
	}
	if existing, found := values[name]; found {
		if dependencyAPIIndexSymbolPriority(kind) > dependencyAPIIndexSymbolPriority(existing) {
			values[name] = kind
		}
		return
	}
	if len(values) >= dependencyAPIIndexMaxSymbolsPerModule {
		b.truncated = true
		return
	}
	values[name] = kind
}

func (b *dependencyAPIIndexBuild) mergePythonSymbol(record *pythonIndexModule, name, kind string) {
	if b == nil || record == nil || !isPublicPythonSymbol(name) {
		return
	}
	if existing, found := record.symbols[name]; found {
		if dependencyAPIIndexSymbolPriority(kind) > dependencyAPIIndexSymbolPriority(existing) {
			record.symbols[name] = kind
		}
		return
	}
	if len(record.symbols) >= dependencyAPIIndexMaxSymbolsPerModule || b.symbols >= dependencyAPIIndexMaxTotalSymbols {
		b.truncated = true
		return
	}
	record.symbols[name] = kind
	b.symbols++
}

// DependencyAPIIndexPage returns a bounded fragment from the current session's
// immutable dependency view. The cache lives in the session analysis namespace,
// so normal LSP cache pruning and manual clear operations remove it together.
func (s *Session) DependencyAPIIndexPage(cursor string, maxBytes int) (DependencyAPIIndexPage, error) {
	if s == nil || normalizeLanguage(s.Context.LanguageID) != "python" {
		return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnsupported
	}
	if !dependencyAPIIndexAvailable(s.Context.LanguageID, s.Context.RuntimeID, s.Context.DependencyResolved, s.Context.DependencyView) {
		return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
	}
	if err := ValidateDependencyAPIIndexPageBytes(maxBytes); err != nil {
		return DependencyAPIIndexPage{}, err
	}
	if !s.beginDependencyAPIIndex() {
		return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
	}
	defer s.finishDependencyAPIIndex()
	index, err := s.dependencyAPIIndex()
	if err != nil {
		return DependencyAPIIndexPage{}, err
	}
	return dependencyAPIIndexPage(index, cursor, dependencyAPIIndexPageBytes(maxBytes))
}

func (s *Session) beginDependencyAPIIndex() bool {
	if s == nil {
		return false
	}
	s.dependencyIndexGate.Lock()
	defer s.dependencyIndexGate.Unlock()
	if s.dependencyIndexClosed {
		return false
	}
	select {
	case <-s.stopping:
		return false
	default:
	}
	s.dependencyIndexTasks.Add(1)
	return true
}

func (s *Session) finishDependencyAPIIndex() {
	if s != nil {
		s.dependencyIndexTasks.Add(-1)
	}
}

func (s *Session) closeDependencyAPIIndex() {
	if s == nil {
		return
	}
	s.dependencyIndexGate.Lock()
	s.dependencyIndexClosed = true
	s.dependencyIndexGate.Unlock()
}

func hasPythonDependencyMount(view AnalysisDependencyView) bool {
	for _, mount := range view.Mounts {
		if mount.Role == DependencyRolePythonPackages && strings.TrimSpace(mount.HostPath) != "" && mount.ReadOnly {
			return true
		}
	}
	return false
}

func dependencyAPIIndexAvailable(languageID, runtimeID string, dependenciesResolved bool, view AnalysisDependencyView) bool {
	return normalizeLanguage(languageID) == "python" &&
		strings.TrimSpace(runtimeID) != "" &&
		dependenciesResolved &&
		strings.TrimSpace(view.Revision) != "" &&
		hasPythonDependencyMount(view)
}

func (s *Session) waitDependencyAPIIndex(timeout time.Duration) bool {
	if s == nil || s.dependencyIndexTasks.Load() == 0 {
		return true
	}
	if timeout <= 0 {
		return false
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if s.dependencyIndexTasks.Load() == 0 {
			return true
		}
		select {
		case <-deadline.C:
			return s.dependencyIndexTasks.Load() == 0
		case <-ticker.C:
		}
	}
}

// ValidateDependencyAPIIndexPageBytes keeps client-provided response budgets
// inside a fixed server-side envelope. Zero means use the documented default.
func ValidateDependencyAPIIndexPageBytes(maxBytes int) error {
	if maxBytes == 0 {
		return nil
	}
	if maxBytes < DependencyAPIIndexPageMinBytes || maxBytes > DependencyAPIIndexPageMaxBytes {
		return ErrDependencyAPIIndexPageSize
	}
	return nil
}

// DependencyAPIIndexCapability is included in lsp.ready so a client can avoid
// speculative control requests on language sessions that cannot provide a
// static dependency summary. It never exposes mount paths or cache locations.
func DependencyAPIIndexCapability(languageID string, dependenciesResolved bool) map[string]any {
	languageID = normalizeLanguage(languageID)
	enabled := languageID == "python" && dependenciesResolved
	return map[string]any{
		"enabled":              enabled,
		"schema":               DependencyAPIIndexSchema,
		"languages":            []string{"python"},
		"maxPageBytes":         DependencyAPIIndexPageMaxBytes,
		"recommendedPageBytes": DependencyAPIIndexPageDefaultBytes,
		"maxIndexBytes":        dependencyAPIIndexMaxBytes,
		"maxPages":             DependencyAPIIndexMaxPages,
	}
}

// DependencyAPIIndexCapability reports availability for this exact immutable
// view. A resolved but empty environment must not advertise an index that
// cannot answer dependency completions.
func (s *Session) DependencyAPIIndexCapability() map[string]any {
	if s == nil {
		return DependencyAPIIndexCapability("", false)
	}
	return DependencyAPIIndexCapability(s.Context.LanguageID, dependencyAPIIndexAvailable(s.Context.LanguageID, s.Context.RuntimeID, s.Context.DependencyResolved, s.Context.DependencyView))
}

func dependencyAPIIndexPageBytes(maxBytes int) int {
	if maxBytes == 0 {
		return DependencyAPIIndexPageDefaultBytes
	}
	return maxBytes
}

func (s *Session) dependencyAPIIndex() (*DependencyAPIIndex, error) {
	s.dependencyIndexMu.Lock()
	defer s.dependencyIndexMu.Unlock()
	revision := s.Context.DependencyView.Revision
	if s.dependencyIndex != nil && s.dependencyIndex.Revision == revision && s.dependencyIndex.RuntimeID == s.Context.RuntimeID {
		return s.dependencyIndex, nil
	}
	index, err := loadOrBuildDependencyAPIIndex(s.Cache.Path, s.Context.LanguageID, s.Context.RuntimeID, s.Context.DependencyView)
	if err != nil {
		return nil, err
	}
	s.dependencyIndex = index
	return index, nil
}

func loadOrBuildDependencyAPIIndex(cacheDir, languageID, runtimeID string, view AnalysisDependencyView) (*DependencyAPIIndex, error) {
	languageID = normalizeLanguage(languageID)
	runtimeID = strings.TrimSpace(runtimeID)
	if languageID != "python" {
		return nil, ErrDependencyAPIIndexUnsupported
	}
	if cacheDir == "" || runtimeID == "" || strings.TrimSpace(view.Revision) == "" {
		return nil, ErrDependencyAPIIndexUnavailable
	}
	if data, err := safefile.ReadSmallRegular(cacheDir, dependencyAPIIndexFile, dependencyAPIIndexMaxBytes); err == nil {
		var cached DependencyAPIIndex
		if json.Unmarshal(data, &cached) == nil && validDependencyAPIIndex(&cached, languageID, runtimeID, view.Revision) {
			return &cached, nil
		}
	}

	index, err := buildPythonDependencyAPIIndex(runtimeID, view)
	if err != nil {
		return nil, err
	}
	if !trimDependencyAPIIndex(index, dependencyAPIIndexMaxBytes) {
		return nil, ErrDependencyAPIIndexUnavailable
	}
	data, err := json.Marshal(index)
	if err != nil || len(data) > dependencyAPIIndexMaxBytes {
		return nil, ErrDependencyAPIIndexUnavailable
	}
	if err := safefile.WriteAtomic(cacheDir, dependencyAPIIndexFile, data, 0600); err != nil {
		return nil, ErrDependencyAPIIndexUnavailable
	}
	return index, nil
}

// trimDependencyAPIIndex preserves the first deterministic module prefix when
// a large environment exceeds the durable index budget. A partial useful tree
// is preferable to discarding all import assistance; Truncated makes the loss
// explicit to the client. Entries stay sorted, so cursor pagination remains
// stable for this dependency revision.
func trimDependencyAPIIndex(index *DependencyAPIIndex, maxBytes int) bool {
	if index == nil || maxBytes <= 0 {
		return false
	}
	if data, err := json.Marshal(index); err == nil && len(data) <= maxBytes {
		return true
	}
	if len(index.Entries) == 0 {
		return false
	}
	low, high := 0, len(index.Entries)
	for low < high {
		middle := low + (high-low+1)/2
		candidate := *index
		candidate.Entries = index.Entries[:middle]
		candidate.Roots = dependencyAPIIndexRoots(candidate.Entries)
		candidate.Truncated = true
		data, err := json.Marshal(candidate)
		if err == nil && len(data) <= maxBytes {
			low = middle
		} else {
			high = middle - 1
		}
	}
	if low == 0 {
		return false
	}
	index.Entries = append([]DependencyAPIIndexEntry(nil), index.Entries[:low]...)
	index.Roots = dependencyAPIIndexRoots(index.Entries)
	index.Truncated = true
	return true
}

func validDependencyAPIIndex(index *DependencyAPIIndex, languageID, runtimeID, revision string) bool {
	if index == nil || index.Schema != DependencyAPIIndexSchema || index.LanguageID != languageID || index.RuntimeID != runtimeID || index.Revision != revision || len(index.Roots) > dependencyAPIIndexMaxRoots || len(index.Entries) > dependencyAPIIndexMaxEntries {
		return false
	}
	previous := ""
	totalSymbols := 0
	rootSet := make(map[string]struct{}, len(index.Roots))
	lastRoot := ""
	for _, root := range index.Roots {
		if root <= lastRoot || !validPythonIdentifier(root) {
			return false
		}
		lastRoot = root
		rootSet[root] = struct{}{}
	}
	entryRoots := make(map[string]struct{}, len(index.Roots))
	for _, entry := range index.Entries {
		if entry.Module <= previous || !validPythonModulePath(entry.Module) || (entry.Kind != "package" && entry.Kind != "module") || len(entry.Symbols) > dependencyAPIIndexMaxSymbolsPerModule {
			return false
		}
		root, _, _ := strings.Cut(entry.Module, ".")
		entryRoots[root] = struct{}{}
		previous = entry.Module
		totalSymbols += len(entry.Symbols)
		if totalSymbols > dependencyAPIIndexMaxTotalSymbols {
			return false
		}
		last := ""
		for _, symbol := range entry.Symbols {
			if symbol.Name <= last || !validPythonIdentifier(symbol.Name) || !validDependencyAPIIndexSymbolKind(symbol.Kind) {
				return false
			}
			last = symbol.Name
		}
	}
	if len(rootSet) != len(entryRoots) {
		return false
	}
	for root := range entryRoots {
		if _, exists := rootSet[root]; !exists {
			return false
		}
	}
	return true
}

func validDependencyAPIIndexSymbolKind(value string) bool {
	switch value {
	case "function", "class", "module", "alias", "value":
		return true
	default:
		return false
	}
}

func dependencyAPIIndexPage(index *DependencyAPIIndex, cursor string, maxBytes int) (DependencyAPIIndexPage, error) {
	if index == nil || !validDependencyAPIIndexPageIndex(index) {
		return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
	}
	offset, err := dependencyAPIIndexCursorOffset(cursor, index.Revision, len(index.Entries))
	if err != nil {
		return DependencyAPIIndexPage{}, err
	}
	page := DependencyAPIIndexPage{
		Schema: index.Schema, LanguageID: index.LanguageID, RuntimeID: index.RuntimeID,
		Revision: index.Revision, Cursor: cursor, Truncated: index.Truncated,
		Entries: []DependencyAPIIndexEntry{}, Roots: []string{},
	}
	totalBudget := minInt(maxBytes, DependencyAPIIndexPageMaxBytes)
	position := offset
	for position < len(index.Entries) {
		candidate := cloneDependencyAPIIndexEntry(index.Entries[position])
		probe := page
		probe.Entries = append(probe.Entries, candidate)
		probe.Roots = dependencyAPIIndexFragmentRoots(probe.Entries)
		nextPosition := position + 1
		if nextPosition < len(index.Entries) {
			probe.NextCursor = dependencyAPIIndexCursor(index.Revision, nextPosition)
		}
		probe.Complete = nextPosition >= len(index.Entries)
		data, marshalErr := dependencyAPIIndexControlPayload(probe)
		if marshalErr != nil {
			return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
		}
		if len(data) <= totalBudget {
			page = probe
			position = nextPosition
			continue
		}
		if len(page.Entries) > 0 {
			break
		}
		// A single module can contain many symbols. Trim it deterministically
		// rather than producing a page that exceeds the wire limit.
		for len(candidate.Symbols) > 0 {
			candidate.Symbols = candidate.Symbols[:len(candidate.Symbols)-1]
			probe = page
			probe.Truncated = true
			probe.Entries = append(probe.Entries, candidate)
			probe.Roots = dependencyAPIIndexFragmentRoots(probe.Entries)
			if nextPosition < len(index.Entries) {
				probe.NextCursor = dependencyAPIIndexCursor(index.Revision, nextPosition)
			}
			probe.Complete = nextPosition >= len(index.Entries)
			data, marshalErr = dependencyAPIIndexControlPayload(probe)
			if marshalErr == nil && len(data) <= totalBudget {
				page = probe
				position = nextPosition
				break
			}
		}
		if len(page.Entries) == 0 {
			return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
		}
		break
	}
	if position >= len(index.Entries) {
		page.NextCursor = ""
		page.Complete = true
	} else {
		page.NextCursor = dependencyAPIIndexCursor(index.Revision, position)
		page.Complete = false
	}
	return page, nil
}

// The gateway adds this control wrapper before writing the page. Size against
// the real protocol shape, rather than assuming JSON overhead, so the 192 KiB
// page guarantee remains true even with escaped module names.
func dependencyAPIIndexControlPayload(page DependencyAPIIndexPage) ([]byte, error) {
	return json.Marshal(map[string]any{"type": "lsp.dependency.index", "requestId": strings.Repeat("x", 96), "success": true, "page": page})
}

func validDependencyAPIIndexPageIndex(index *DependencyAPIIndex) bool {
	return index.Schema == DependencyAPIIndexSchema && index.LanguageID == "python" && index.RuntimeID != "" && index.Revision != ""
}

func cloneDependencyAPIIndexEntry(entry DependencyAPIIndexEntry) DependencyAPIIndexEntry {
	entry.Symbols = append([]DependencyAPIIndexSymbol(nil), entry.Symbols...)
	return entry
}

func dependencyAPIIndexFragmentRoots(entries []DependencyAPIIndexEntry) []string {
	seen := make(map[string]struct{}, len(entries))
	roots := make([]string, 0, len(entries))
	for _, entry := range entries {
		root, _, _ := strings.Cut(entry.Module, ".")
		if root == "" {
			continue
		}
		if _, exists := seen[root]; !exists {
			seen[root] = struct{}{}
			roots = append(roots, root)
		}
	}
	sort.Strings(roots)
	return roots
}

func dependencyAPIIndexCursor(revision string, offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(revision + "\n" + strconv.Itoa(offset)))
}

func dependencyAPIIndexCursorOffset(cursor, revision string, entries int) (int, error) {
	if cursor == "" {
		return 0, nil
	}
	if len(cursor) > 128 {
		return 0, ErrDependencyAPIIndexCursor
	}
	data, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, ErrDependencyAPIIndexCursor
	}
	parts := strings.Split(string(data), "\n")
	if len(parts) != 2 || parts[0] != revision {
		return 0, ErrDependencyAPIIndexCursor
	}
	offset, err := strconv.Atoi(parts[1])
	if err != nil || offset < 0 || offset > entries {
		return 0, ErrDependencyAPIIndexCursor
	}
	return offset, nil
}

func buildPythonDependencyAPIIndex(runtimeID string, view AnalysisDependencyView) (*DependencyAPIIndex, error) {
	if normalizeLanguage(view.LanguageID) != "" && normalizeLanguage(view.LanguageID) != "python" {
		return nil, ErrDependencyAPIIndexUnsupported
	}
	builder := newDependencyAPIIndexBuild()
	for _, mount := range view.Mounts {
		if mount.Role != DependencyRolePythonPackages || strings.TrimSpace(mount.HostPath) == "" {
			continue
		}
		directory, openErr := openDependencyAPIIndexDirectory(mount.HostPath)
		if openErr != nil {
			// The view already validated this path. A later replacement, including a
			// symlink swap, must result in a partial index rather than a fallback read.
			builder.truncated = true
			continue
		}
		builder.scanPythonSitePackages(directory)
		_ = directory.Close()
		if builder.exhausted() {
			builder.truncated = true
			break
		}
	}
	entries, roots, truncated := builder.finalizePythonModules()
	return &DependencyAPIIndex{
		Schema: DependencyAPIIndexSchema, LanguageID: "python", RuntimeID: runtimeID,
		Revision: view.Revision, Roots: roots, Entries: entries, Truncated: builder.truncated || truncated,
	}, nil
}

func (b *dependencyAPIIndexBuild) scanPythonSitePackages(directory *dependencyAPIIndexDirectory) {
	entries, ok := b.readPythonDirectory(directory)
	if !ok {
		return
	}
	files := pythonSourceFiles(entries)
	for _, file := range files {
		if b.exhausted() {
			b.truncated = true
			return
		}
		stem, _ := strings.CutSuffix(file, filepath.Ext(file))
		if stem == "__init__" || !validPythonIdentifier(stem) {
			continue
		}
		b.addPythonModule(directory, stem, "module", stem)
	}
	for _, entry := range entries {
		if b.exhausted() {
			b.truncated = true
			return
		}
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !validPythonIdentifier(entry.Name()) || ignoredPythonTopLevelDirectory(entry.Name()) {
			continue
		}
		child, openErr := directory.OpenChild(entry.Name())
		if openErr != nil {
			b.truncated = true
			continue
		}
		b.scanPythonPackage(child, entry.Name(), 1)
		_ = child.Close()
	}
}

func (b *dependencyAPIIndexBuild) scanPythonPackage(directory *dependencyAPIIndexDirectory, module string, depth int) {
	if depth > dependencyAPIIndexMaxDepth {
		b.truncated = true
		return
	}
	entries, ok := b.readPythonDirectory(directory)
	if !ok {
		return
	}
	files := pythonSourceFiles(entries)
	hasPython := len(files) > 0
	if !hasPython {
		for _, entry := range entries {
			if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 && validPythonIdentifier(entry.Name()) && !ignoredPythonPackageDirectory(entry.Name()) {
				hasPython = true
				break
			}
		}
	}
	if !hasPython {
		return
	}
	b.addPythonModule(directory, module, "package", "__init__")
	for _, file := range files {
		if b.exhausted() {
			b.truncated = true
			return
		}
		stem, _ := strings.CutSuffix(file, filepath.Ext(file))
		if stem == "__init__" || !validPythonIdentifier(stem) {
			continue
		}
		b.addPythonModule(directory, module+"."+stem, "module", stem)
	}
	for _, entry := range entries {
		if b.exhausted() {
			b.truncated = true
			return
		}
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !validPythonIdentifier(entry.Name()) || ignoredPythonPackageDirectory(entry.Name()) {
			continue
		}
		child, openErr := directory.OpenChild(entry.Name())
		if openErr != nil {
			b.truncated = true
			continue
		}
		b.scanPythonPackage(child, module+"."+entry.Name(), depth+1)
		_ = child.Close()
	}
}

func (b *dependencyAPIIndexBuild) readPythonDirectory(directory *dependencyAPIIndexDirectory) ([]os.DirEntry, bool) {
	if !b.consumeDirectory() {
		return nil, false
	}
	if directory == nil {
		return nil, false
	}
	candidates := make([]os.DirEntry, 0, minInt(128, dependencyAPIIndexMaxDirectoryItems))
	for {
		if b.exhausted() {
			b.truncated = true
			break
		}
		entries, readErr := directory.ReadDir(128)
		if len(entries) > 0 {
			if !b.consumeItems(len(entries)) {
				break
			}
			for _, entry := range entries {
				if isPythonDirectoryCandidate(entry) {
					candidates = append(candidates, entry)
				}
			}
			if len(candidates) > dependencyAPIIndexMaxDirectoryItems {
				sort.Slice(candidates, func(i, j int) bool { return candidates[i].Name() < candidates[j].Name() })
				candidates = candidates[:dependencyAPIIndexMaxDirectoryItems:dependencyAPIIndexMaxDirectoryItems]
				b.truncated = true
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			b.truncated = true
			break
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Name() < candidates[j].Name() })
	return candidates, true
}

func isPythonDirectoryCandidate(entry os.DirEntry) bool {
	if entry == nil || entry.Type()&os.ModeSymlink != 0 {
		return false
	}
	name := entry.Name()
	if entry.IsDir() {
		return validPythonIdentifier(name) && !ignoredPythonTopLevelDirectory(name)
	}
	return validPythonSourceFileName(name)
}

func validPythonSourceFileName(name string) bool {
	extension := strings.ToLower(filepath.Ext(name))
	if extension != ".py" && extension != ".pyi" {
		return false
	}
	stem := strings.TrimSuffix(name, extension)
	return stem == "__init__" || validPythonIdentifier(stem)
}

func pythonSourceFiles(entries []os.DirEntry) []string {
	byStem := make(map[string]map[string]string)
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		name := entry.Name()
		extension := strings.ToLower(filepath.Ext(name))
		if extension != ".py" && extension != ".pyi" {
			continue
		}
		stem := strings.TrimSuffix(name, extension)
		if !validPythonIdentifier(stem) && stem != "__init__" {
			continue
		}
		if byStem[stem] == nil {
			byStem[stem] = make(map[string]string, 2)
		}
		byStem[stem][extension] = name
	}
	stems := make([]string, 0, len(byStem))
	for stem := range byStem {
		stems = append(stems, stem)
	}
	sort.Strings(stems)
	files := make([]string, 0, len(stems))
	for _, stem := range stems {
		if stub := byStem[stem][".pyi"]; stub != "" {
			files = append(files, stub)
		} else {
			files = append(files, byStem[stem][".py"])
		}
	}
	return files
}

func ignoredPythonPackageDirectory(name string) bool {
	switch strings.ToLower(name) {
	case "__pycache__", "test", "tests", "testing", "docs", "doc", "examples", "example", "benchmarks", "benchmark":
		return true
	default:
		return false
	}
}

func ignoredPythonTopLevelDirectory(name string) bool {
	if ignoredPythonPackageDirectory(name) {
		return true
	}
	name = strings.ToLower(name)
	return strings.HasSuffix(name, ".dist-info") || strings.HasSuffix(name, ".egg-info") || strings.HasSuffix(name, ".data")
}

func (b *dependencyAPIIndexBuild) addPythonModule(directory *dependencyAPIIndexDirectory, module, kind, stem string) {
	if b.exhausted() {
		b.truncated = true
		return
	}
	if len(b.modules) >= dependencyAPIIndexMaxEntries && b.modules[module] == nil {
		b.truncated = true
		return
	}
	record := b.modules[module]
	if record == nil {
		record = &pythonIndexModule{module: module, kind: kind, symbols: make(map[string]string)}
		b.modules[module] = record
	} else if kind == "package" {
		record.kind = "package"
	}
	if !b.consumeFile() {
		return
	}
	source, ok := readPythonModuleSource(directory, stem)
	if !ok {
		return
	}
	parsed := b.parsePythonModuleSource(source, module, record.kind == "package")
	for name, symbolKind := range parsed.symbols {
		b.mergePythonSymbol(record, name, symbolKind)
	}
	record.starImports = b.limitedUniqueStrings(record.starImports, parsed.starImports, dependencyAPIIndexMaxStaticImportsPerModule)
	record.all = b.limitedUniqueStrings(record.all, parsed.all, dependencyAPIIndexMaxAllExportsPerModule)
}

func readPythonModuleSource(directory *dependencyAPIIndexDirectory, stem string) ([]byte, bool) {
	if directory == nil {
		return nil, false
	}
	for _, extension := range []string{".pyi", ".py"} {
		data, err := directory.ReadSmallRegular(stem+extension, dependencyAPIIndexMaxSourceBytes)
		if err == nil {
			return data, true
		}
	}
	return nil, false
}

type parsedPythonModule struct {
	symbols     map[string]string
	starImports []string
	all         []string
}

func (b *dependencyAPIIndexBuild) parsePythonModuleSource(source []byte, module string, isPackage bool) parsedPythonModule {
	parsed := parsedPythonModule{symbols: make(map[string]string)}
	lines := strings.Split(string(source), "\n")
	if len(lines) > dependencyAPIIndexMaxParseLines {
		lines = lines[:dependencyAPIIndexMaxParseLines:dependencyAPIIndexMaxParseLines]
		b.truncated = true
	}
	for index := 0; index < len(lines); index++ {
		if !b.consumeParseStep() {
			break
		}
		raw := strings.TrimRight(lines[index], "\r")
		if raw == "" || strings.TrimLeft(raw, " \t") != raw {
			continue
		}
		line := strings.TrimSpace(stripPythonLineComment(raw))
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "@") {
			continue
		}
		if isPythonTopLevelConditionalOrTryHeader(line) {
			statements, end := b.collectPythonTopLevelBranchStatements(lines, index)
			index = end
			for _, statement := range statements {
				b.parsePythonImportsAndAll(&parsed, statement, module, isPackage)
			}
			continue
		}
		if isPythonStaticImportOrAll(line) {
			statement, end := collectPythonStatement(lines, index)
			index = end
			line = strings.TrimSpace(stripPythonLineComment(statement))
		}
		if b.parsePythonImportsAndAll(&parsed, line, module, isPackage) {
			continue
		}
		switch {
		case strings.HasPrefix(line, "async def "):
			if name := pythonDeclaredName(strings.TrimPrefix(line, "async def ")); name != "" {
				b.addParsedPythonSymbol(parsed.symbols, name, "function")
			}
		case strings.HasPrefix(line, "def "):
			if name := pythonDeclaredName(strings.TrimPrefix(line, "def ")); name != "" {
				b.addParsedPythonSymbol(parsed.symbols, name, "function")
			}
		case strings.HasPrefix(line, "class "):
			if name := pythonDeclaredName(strings.TrimPrefix(line, "class ")); name != "" {
				b.addParsedPythonSymbol(parsed.symbols, name, "class")
			}
		default:
			if name := pythonAssignedName(line); name != "" && name != "__all__" {
				b.addParsedPythonSymbol(parsed.symbols, name, "value")
			}
		}
	}
	return parsed
}

func isPythonStaticImportOrAll(line string) bool {
	return strings.HasPrefix(line, "from ") || strings.HasPrefix(line, "import ") || strings.HasPrefix(line, "__all__")
}

// parsePythonImportsAndAll intentionally handles only static re-exports. It
// is shared by a module's true top level and the direct suites of a top-level
// if/try. Function, class, and nested-control-flow bodies never reach it.
func (b *dependencyAPIIndexBuild) parsePythonImportsAndAll(parsed *parsedPythonModule, line, module string, isPackage bool) bool {
	if parsed == nil {
		return false
	}
	switch {
	case strings.HasPrefix(line, "from "):
		symbols, stars := parsePythonFromImport(line, module, isPackage)
		for name, kind := range symbols {
			b.addParsedPythonSymbol(parsed.symbols, name, kind)
		}
		parsed.starImports = b.limitedUniqueStrings(parsed.starImports, stars, dependencyAPIIndexMaxStaticImportsPerModule)
		return true
	case strings.HasPrefix(line, "import "):
		for name, kind := range parsePythonImport(line) {
			b.addParsedPythonSymbol(parsed.symbols, name, kind)
		}
		return true
	case strings.HasPrefix(line, "__all__"):
		parsed.all = b.limitedUniqueStrings(parsed.all, pythonQuotedNames(line), dependencyAPIIndexMaxAllExportsPerModule)
		return true
	default:
		return false
	}
}

// collectPythonTopLevelBranchStatements extracts only direct import/__all__
// statements from the suites of a top-level if or try. This covers common
// package import guards (including NumPy's try/except re-exports) while
// deliberately excluding nested conditionals and callable bodies.
func (b *dependencyAPIIndexBuild) collectPythonTopLevelBranchStatements(lines []string, start int) ([]string, int) {
	if b == nil || start < 0 || start >= len(lines) {
		return nil, start
	}
	statements := make([]string, 0, 8)
	branchIndent := ""
	hasBranchIndent := false
	branches := 1
	for index := start + 1; index < len(lines); index++ {
		if index-start > dependencyAPIIndexMaxConditionalBodyLines || !b.consumeParseStep() {
			b.truncated = true
			return statements, index - 1
		}
		raw := strings.TrimRight(lines[index], "\r")
		trimmed := strings.TrimSpace(stripPythonLineComment(raw))
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := pythonIndentation(raw)
		if indent == "" {
			if isPythonConditionalOrTryContinuationHeader(trimmed) {
				branches++
				if branches > dependencyAPIIndexMaxConditionalBranches {
					b.truncated = true
					return statements, index
				}
				branchIndent, hasBranchIndent = "", false
				continue
			}
			return statements, index - 1
		}
		if !hasBranchIndent {
			branchIndent, hasBranchIndent = indent, true
		}
		if indent != branchIndent || !isPythonStaticImportOrAll(trimmed) {
			continue
		}
		if len(statements) >= dependencyAPIIndexMaxConditionalStatements {
			b.truncated = true
			return statements, index - 1
		}
		statement, end := collectPythonStatement(lines, index)
		statements = append(statements, strings.TrimSpace(stripPythonLineComment(statement)))
		index = end
	}
	return statements, len(lines) - 1
}

func isPythonTopLevelConditionalOrTryHeader(line string) bool {
	line = strings.TrimSpace(line)
	return (strings.HasPrefix(line, "if ") && strings.HasSuffix(line, ":")) || line == "try:"
}

func isPythonConditionalOrTryContinuationHeader(line string) bool {
	line = strings.TrimSpace(line)
	if line == "else:" || line == "finally:" {
		return true
	}
	return (strings.HasPrefix(line, "elif ") || strings.HasPrefix(line, "except")) && strings.HasSuffix(line, ":")
}

func pythonIndentation(line string) string {
	for index := 0; index < len(line); index++ {
		if line[index] != ' ' && line[index] != '\t' {
			return line[:index]
		}
	}
	return line
}

func stripPythonLineComment(line string) string {
	inSingle, inDouble, escaped := false, false, false
	for index, value := range line {
		if escaped {
			escaped = false
			continue
		}
		if value == '\\' {
			escaped = true
			continue
		}
		if value == '\'' && !inDouble {
			inSingle = !inSingle
			continue
		}
		if value == '"' && !inSingle {
			inDouble = !inDouble
			continue
		}
		if value == '#' && !inSingle && !inDouble {
			return line[:index]
		}
	}
	return line
}

func collectPythonStatement(lines []string, start int) (string, int) {
	if start >= len(lines) {
		return "", start
	}
	statement := strings.TrimSpace(lines[start])
	depth := pythonDelimiterDepth(statement)
	for index := start + 1; index < len(lines) && index-start < 32 && len(statement) < 32<<10; index++ {
		if depth <= 0 && !strings.HasSuffix(strings.TrimRight(statement, " \t"), "\\") {
			return statement, index - 1
		}
		statement += " " + strings.TrimSpace(lines[index])
		depth = pythonDelimiterDepth(statement)
	}
	return statement, minInt(len(lines)-1, start+31)
}

func pythonDelimiterDepth(value string) int {
	depth := 0
	inSingle, inDouble, escaped := false, false, false
	for _, char := range value {
		if escaped {
			escaped = false
			continue
		}
		if char == '\\' {
			escaped = true
			continue
		}
		if char == '\'' && !inDouble {
			inSingle = !inSingle
			continue
		}
		if char == '"' && !inSingle {
			inDouble = !inDouble
			continue
		}
		if inSingle || inDouble {
			continue
		}
		switch char {
		case '(', '[', '{':
			depth++
		case ')', ']', '}':
			depth--
		}
	}
	return depth
}

func parsePythonFromImport(statement, current string, isPackage bool) (map[string]string, []string) {
	result := make(map[string]string)
	rest := strings.TrimSpace(strings.TrimPrefix(statement, "from "))
	separator := strings.Index(rest, " import ")
	if separator < 0 {
		return result, nil
	}
	target := resolvePythonImportTarget(strings.TrimSpace(rest[:separator]), current, isPackage)
	if target == "" {
		return result, nil
	}
	values := strings.TrimSpace(rest[separator+len(" import "):])
	values = strings.Trim(values, "()[]{} \t")
	stars := make([]string, 0, 1)
	for _, part := range strings.Split(values, ",") {
		part = strings.TrimSpace(strings.TrimSuffix(part, "\\"))
		if part == "*" {
			stars = append(stars, target)
			continue
		}
		if aliasIndex := strings.Index(part, " as "); aliasIndex >= 0 {
			part = strings.TrimSpace(part[aliasIndex+len(" as "):])
		} else if dot := strings.LastIndex(part, "."); dot >= 0 {
			part = part[dot+1:]
		}
		if isPublicPythonSymbol(part) {
			result[part] = "alias"
		}
	}
	return result, stars
}

func parsePythonImport(statement string) map[string]string {
	result := make(map[string]string)
	values := strings.TrimSpace(strings.TrimPrefix(statement, "import "))
	for _, part := range strings.Split(values, ",") {
		part = strings.TrimSpace(part)
		name := part
		if aliasIndex := strings.Index(part, " as "); aliasIndex >= 0 {
			name = strings.TrimSpace(part[aliasIndex+len(" as "):])
		} else if dot := strings.Index(name, "."); dot >= 0 {
			name = name[:dot]
		}
		if isPublicPythonSymbol(name) {
			result[name] = "module"
		}
	}
	return result
}

func resolvePythonImportTarget(target, current string, isPackage bool) string {
	target = strings.TrimSpace(target)
	if target == "" {
		return ""
	}
	if !strings.HasPrefix(target, ".") {
		if validPythonModulePath(target) {
			return target
		}
		return ""
	}
	dots := 0
	for dots < len(target) && target[dots] == '.' {
		dots++
	}
	base := current
	if !isPackage {
		base, _, _ = strings.Cut(base, ".")
		if strings.Contains(current, ".") {
			base = current[:strings.LastIndex(current, ".")]
		}
	}
	for parents := 1; parents < dots; parents++ {
		if !strings.Contains(base, ".") {
			return ""
		}
		base = base[:strings.LastIndex(base, ".")]
	}
	suffix := strings.TrimPrefix(target[dots:], ".")
	if suffix == "" {
		return base
	}
	result := base + "." + suffix
	if !validPythonModulePath(result) {
		return ""
	}
	return result
}

func pythonDeclaredName(value string) string {
	value = strings.TrimSpace(value)
	for index, char := range value {
		if char == '(' || char == ':' || char == '[' || char == ' ' || char == '\t' {
			value = value[:index]
			break
		}
	}
	if isPublicPythonSymbol(value) {
		return value
	}
	return ""
}

func pythonAssignedName(value string) string {
	separator := strings.Index(value, "=")
	annotation := strings.Index(value, ":")
	if separator < 0 && annotation < 0 {
		return ""
	}
	stop := separator
	if stop < 0 || (annotation >= 0 && annotation < stop) {
		stop = annotation
	}
	name := strings.TrimSpace(value[:stop])
	if isPublicPythonSymbol(name) {
		return name
	}
	return ""
}

func pythonQuotedNames(value string) []string {
	result := make([]string, 0)
	for index := 0; index < len(value); index++ {
		quote := value[index]
		if quote != '\'' && quote != '"' {
			continue
		}
		start := index + 1
		escaped := false
		for index = start; index < len(value); index++ {
			if escaped {
				escaped = false
				continue
			}
			if value[index] == '\\' {
				escaped = true
				continue
			}
			if value[index] == quote {
				if name := value[start:index]; isPublicPythonSymbol(name) {
					result = append(result, name)
				}
				break
			}
		}
	}
	return result
}

func (b *dependencyAPIIndexBuild) finalizePythonModules() ([]DependencyAPIIndexEntry, []string, bool) {
	keys := make([]string, 0, len(b.modules))
	for module := range b.modules {
		keys = append(keys, module)
	}
	sort.Strings(keys)
	allRoots := dependencyAPIIndexRootsForModules(keys)
	truncated := false
	if len(allRoots) > dependencyAPIIndexMaxRoots {
		allRoots = allRoots[:dependencyAPIIndexMaxRoots]
		truncated = true
	}
	allowedRoots := make(map[string]struct{}, len(allRoots))
	for _, root := range allRoots {
		allowedRoots[root] = struct{}{}
	}
	resolved := make(map[string]map[string]string, len(keys))
	visiting := make(map[string]bool)
	var resolve func(string, int) map[string]string
	resolve = func(module string, depth int) map[string]string {
		if !b.consumeResolveStep() {
			return nil
		}
		if current, found := resolved[module]; found {
			return current
		}
		record := b.modules[module]
		if record == nil || depth > 8 || visiting[module] {
			return nil
		}
		visiting[module] = true
		values := make(map[string]string, len(record.symbols))
		for name, kind := range record.symbols {
			values[name] = kind
		}
		for _, imported := range record.starImports {
			if !b.consumeResolveStep() {
				break
			}
			for name, kind := range resolve(imported, depth+1) {
				if !b.consumeResolveStep() {
					break
				}
				if isPublicPythonSymbol(name) {
					if _, exists := values[name]; !exists && len(values) < dependencyAPIIndexMaxSymbolsPerModule {
						values[name] = kind
					} else if len(values) >= dependencyAPIIndexMaxSymbolsPerModule {
						b.truncated = true
						break
					}
				}
			}
		}
		if len(record.all) > 0 {
			filtered := make(map[string]string, len(record.all))
			for _, name := range record.all {
				if !b.consumeResolveStep() {
					break
				}
				if !isPublicPythonSymbol(name) {
					continue
				}
				kind := values[name]
				if kind == "" {
					kind = "value"
				}
				if len(filtered) >= dependencyAPIIndexMaxSymbolsPerModule {
					b.truncated = true
					break
				}
				filtered[name] = kind
			}
			values = filtered
		}
		delete(visiting, module)
		resolved[module] = values
		return values
	}

	entries := make([]DependencyAPIIndexEntry, 0, len(keys))
	for _, module := range keys {
		if !b.consumeResolveStep() {
			break
		}
		root, _, _ := strings.Cut(module, ".")
		if _, allowed := allowedRoots[root]; !allowed {
			continue
		}
		values := resolve(module, 0)
		names := make([]string, 0, len(values))
		for name := range values {
			if isPublicPythonSymbol(name) && len(name) <= dependencyAPIIndexMaxSymbolBytes {
				names = append(names, name)
			}
		}
		sort.Strings(names)
		if len(names) > dependencyAPIIndexMaxSymbolsPerModule {
			names = names[:dependencyAPIIndexMaxSymbolsPerModule]
			truncated = true
		}
		symbols := make([]DependencyAPIIndexSymbol, 0, len(names))
		for _, name := range names {
			symbols = append(symbols, DependencyAPIIndexSymbol{Name: name, Kind: values[name]})
		}
		record := b.modules[module]
		entries = append(entries, DependencyAPIIndexEntry{Module: module, Kind: record.kind, Symbols: symbols})
	}
	roots := dependencyAPIIndexRoots(entries)
	return entries, roots, truncated || b.truncated
}

func dependencyAPIIndexRoots(entries []DependencyAPIIndexEntry) []string {
	modules := make([]string, 0, len(entries))
	for _, entry := range entries {
		modules = append(modules, entry.Module)
	}
	return dependencyAPIIndexRootsForModules(modules)
}

func dependencyAPIIndexRootsForModules(modules []string) []string {
	seen := make(map[string]struct{}, len(modules))
	roots := make([]string, 0, len(modules))
	for _, module := range modules {
		root, _, _ := strings.Cut(module, ".")
		if root == "" {
			continue
		}
		if _, exists := seen[root]; !exists {
			seen[root] = struct{}{}
			roots = append(roots, root)
		}
	}
	sort.Strings(roots)
	return roots
}

func dependencyAPIIndexSymbolPriority(kind string) int {
	switch kind {
	case "class":
		return 5
	case "function":
		return 4
	case "module":
		return 3
	case "alias":
		return 2
	default:
		return 1
	}
}

func validPythonModulePath(value string) bool {
	if value == "" || len(value) > 512 {
		return false
	}
	for _, part := range strings.Split(value, ".") {
		if !validPythonIdentifier(part) {
			return false
		}
	}
	return true
}

func validPythonIdentifier(value string) bool {
	if value == "" || len(value) > dependencyAPIIndexMaxSymbolBytes {
		return false
	}
	for index, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char == '_' || (index > 0 && char >= '0' && char <= '9') {
			continue
		}
		return false
	}
	return true
}

func isPublicPythonSymbol(value string) bool {
	return validPythonIdentifier(value) && !strings.HasPrefix(value, "_")
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
