package lsp

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"bobocloud-server/internal/safefile"
)

const (
	// AnalysisDependenciesRoot is the only container namespace adapters may use.
	// It is deliberately separate from the writable analyzer cache.
	AnalysisDependenciesRoot       = "/analysis-deps"
	dependencyViewVersion          = 1
	maxDependencyScanEntries       = 512
	maxDependencyDirectItems       = 1024
	maxDependencyScanDepth         = 4
	maxDependencyMarkerBytes int64 = 4096
)

const (
	DependencyRolePythonPackages  = "python.site-packages"
	DependencyRoleNodeModules     = "node.global-modules"
	DependencyRoleGoModules       = "go.module-cache"
	DependencyRoleRustCargoHome   = "rust.cargo-home"
	DependencyRoleRustRegistrySrc = "rust.registry-source"
	DependencyRoleRustRegistryIdx = "rust.registry-index"
	DependencyRoleRustGitCheckout = "rust.git-checkouts"
	DependencyRoleRustGitDB       = "rust.git-database"
	DependencyRoleJavaMaven       = "java.maven-repository"
	DependencyRoleJavaGradle      = "java.gradle-home"
	DependencyRoleNativeSysroot   = "native.sysroot"
	DependencyRoleNativeIncludes  = "native.include"
)

// AnalysisDependencyPaths contains only paths resolved by the server. None of
// these values should be accepted directly from an LSP client.
type AnalysisDependencyPaths struct {
	WorkspaceRoot   string
	UserPersistRoot string
	SharedCacheRoot string
	SnapshotRoot    string
	ToolchainRoots  []string
	Extra           map[string][]string
	AllowedRoots    []string
}

// AnalysisDependencyRequest identifies the runtime dependency view that an
// analyzer should see. Generation can be a package-manager revision or an
// existing cache ContainerKey; directory metadata is also sampled so legacy
// caches work without a generation marker.
type AnalysisDependencyRequest struct {
	OwnerKind   string
	OwnerID     string
	UserID      string
	WorkspaceID string
	RuntimeID   string
	LanguageID  string
	Generation  string
	Paths       AnalysisDependencyPaths
}

// AnalysisDependencyMount is a validated, server-issued bind mount. ReadOnly
// is always true for views returned by DependencyRegistry.Resolve.
type AnalysisDependencyMount struct {
	Role          string `json:"role"`
	HostPath      string `json:"-"`
	ContainerPath string `json:"containerPath"`
	ReadOnly      bool   `json:"readOnly"`
	Legacy        bool   `json:"legacy,omitempty"`
	Managed       bool   `json:"-"`
	Pinned        bool   `json:"-"`
}

type AnalysisDependencySourceMetadata struct {
	Role      string `json:"role"`
	Legacy    bool   `json:"legacy,omitempty"`
	Signature string `json:"signature"`
}

type AnalysisDependencyMetadata struct {
	Version            int                                `json:"version"`
	Adapter            string                             `json:"adapter"`
	Generation         string                             `json:"generation,omitempty"`
	SnapshotGeneration string                             `json:"snapshotGeneration,omitempty"`
	SharedGeneration   string                             `json:"sharedGeneration,omitempty"`
	Sources            []AnalysisDependencySourceMetadata `json:"sources"`
}

// AnalysisDependencyView can be consumed by either a host or Docker language
// server. Settings use analyzer-native sections (for example "python" and
// "rust-analyzer") and remain separate because host and container paths differ.
type AnalysisDependencyView struct {
	LanguageID        string                     `json:"-"`
	RuntimeID         string                     `json:"-"`
	Revision          string                     `json:"-"`
	Mounts            []AnalysisDependencyMount  `json:"-"`
	LocalEnvironment  map[string]string          `json:"-"`
	DockerEnvironment map[string]string          `json:"-"`
	LocalLSPSettings  map[string]any             `json:"-"`
	DockerLSPSettings map[string]any             `json:"-"`
	Metadata          AnalysisDependencyMetadata `json:"-"`
}

// UsesHostRoot reports whether a validated dependency mount is rooted at the
// supplied server-owned directory. Both sides are resolved before comparison,
// so sibling path prefixes and symlink aliases cannot retain the wrong lease.
func (v AnalysisDependencyView) UsesHostRoot(root string) bool {
	root, ok := resolvedDependencyHostPath(root)
	if !ok {
		return false
	}
	for _, mount := range v.Mounts {
		host, valid := resolvedDependencyHostPath(mount.HostPath)
		if !valid {
			continue
		}
		relative, err := filepath.Rel(root, host)
		if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func resolvedDependencyHostPath(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsRune(value, '\x00') {
		return "", false
	}
	absolute, err := filepath.Abs(filepath.Clean(value))
	if err != nil {
		return "", false
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", false
	}
	return filepath.Clean(resolved), true
}

// WorkspaceConfigurationOwnedByDependencySettings returns true only when the
// complete analyzer request can be answered from server-issued dependency
// settings. Mixed or unknown sections must retain the normal client round trip.
func WorkspaceConfigurationOwnedByDependencySettings(payload []byte, settings map[string]any) bool {
	var request workspaceConfigurationRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return false
	}
	if request.JSONRPC != "2.0" || request.Method != "workspace/configuration" || len(request.ID) == 0 || string(request.ID) == "null" {
		return false
	}
	for _, item := range request.Params.Items {
		if !dependencySettingsContainSection(settings, item.Section) {
			return false
		}
	}
	return true
}

func dependencySettingsContainSection(settings map[string]any, section string) bool {
	section = strings.TrimSpace(section)
	if section == "" {
		return false
	}
	if _, ok := settings[section]; ok {
		return true
	}
	var current any = settings
	for _, part := range strings.Split(section, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			return false
		}
		current, ok = object[part]
		if !ok {
			return false
		}
	}
	return true
}

// DependencyMountSpec is adapter output. Registry validation resolves
// symlinks, enforces AllowedRoots, and forces every resulting mount read-only.
type DependencyMountSpec struct {
	Role          string
	HostPath      string
	ContainerPath string
	Legacy        bool
	Managed       bool
}

type DependencyAdapterResult struct {
	Mounts            []DependencyMountSpec
	LocalEnvironment  map[string]string
	DockerEnvironment map[string]string
	LocalLSPSettings  map[string]any
	DockerLSPSettings map[string]any
}

type DependencyAdapterContext struct {
	OwnerKind   string
	OwnerID     string
	UserID      string
	WorkspaceID string
	RuntimeID   string
	LanguageID  string
	Paths       AnalysisDependencyPaths
}

// DependencyAdapter is the extension point for future analyzers. Adapters are
// administrator-owned code and may only request paths under /analysis-deps;
// the registry still validates every host path before returning it.
type DependencyAdapter interface {
	Name() string
	Languages() []string
	Resolve(DependencyAdapterContext) (DependencyAdapterResult, error)
}

type DependencyRegistry struct {
	mu         sync.RWMutex
	byLanguage map[string]DependencyAdapter
}

func NewDependencyRegistry(adapters ...DependencyAdapter) (*DependencyRegistry, error) {
	registry := &DependencyRegistry{byLanguage: make(map[string]DependencyAdapter)}
	for _, adapter := range adapters {
		if err := registry.Register(adapter); err != nil {
			return nil, err
		}
	}
	return registry, nil
}

func NewDefaultDependencyRegistry() *DependencyRegistry {
	registry, err := NewDependencyRegistry(
		pythonDependencyAdapter{},
		nodeDependencyAdapter{},
		goDependencyAdapter{},
		rustDependencyAdapter{},
		javaDependencyAdapter{},
		nativeDependencyAdapter{},
	)
	if err != nil {
		panic(err)
	}
	return registry
}

func (r *DependencyRegistry) Register(adapter DependencyAdapter) error {
	if r == nil || adapter == nil {
		return fmt.Errorf("dependency adapter is required")
	}
	name := strings.TrimSpace(adapter.Name())
	if name == "" {
		return fmt.Errorf("dependency adapter name is required")
	}
	languages := adapter.Languages()
	if len(languages) == 0 {
		return fmt.Errorf("dependency adapter %q has no languages", name)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	seen := make(map[string]bool)
	normalized := make([]string, 0, len(languages))
	for _, language := range languages {
		language = normalizeLanguage(language)
		if language == "" {
			return fmt.Errorf("dependency adapter %q has an empty language", name)
		}
		if seen[language] {
			continue
		}
		seen[language] = true
		normalized = append(normalized, language)
		if existing := r.byLanguage[language]; existing != nil {
			return fmt.Errorf("dependency language %q is already registered by %q", language, existing.Name())
		}
	}
	for _, language := range normalized {
		r.byLanguage[language] = adapter
	}
	return nil
}

func (r *DependencyRegistry) Languages() []string {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.byLanguage))
	for language := range r.byLanguage {
		out = append(out, language)
	}
	sort.Strings(out)
	return out
}

func (r *DependencyRegistry) Resolve(request AnalysisDependencyRequest) (AnalysisDependencyView, error) {
	request.OwnerKind = strings.ToLower(strings.TrimSpace(request.OwnerKind))
	request.OwnerID = strings.TrimSpace(request.OwnerID)
	request.UserID = strings.TrimSpace(request.UserID)
	request.WorkspaceID = strings.TrimSpace(request.WorkspaceID)
	request.RuntimeID = strings.TrimSpace(request.RuntimeID)
	request.LanguageID = normalizeLanguage(request.LanguageID)
	request.Generation = strings.TrimSpace(request.Generation)
	if request.OwnerKind == "personal" {
		request.OwnerKind = "user"
	}
	if request.OwnerKind != "user" && request.OwnerKind != "team" {
		return AnalysisDependencyView{}, fmt.Errorf("dependency owner kind must be user or team")
	}
	if request.UserID == "" {
		return AnalysisDependencyView{}, fmt.Errorf("dependency user is required")
	}
	if request.OwnerKind == "user" {
		if request.OwnerID == "" {
			request.OwnerID = request.UserID
		}
		if request.OwnerID != request.UserID {
			return AnalysisDependencyView{}, fmt.Errorf("personal dependency owner must match user")
		}
	} else if request.OwnerID == "" {
		return AnalysisDependencyView{}, fmt.Errorf("team dependency owner is required")
	}
	if request.RuntimeID == "" {
		request.RuntimeID = "local"
	}
	if request.LanguageID == "" {
		return AnalysisDependencyView{}, fmt.Errorf("dependency language is required")
	}
	if !runtimeMatchesLanguage(request.RuntimeID, request.LanguageID) {
		return AnalysisDependencyView{}, fmt.Errorf("runtime %q does not match language %q", request.RuntimeID, request.LanguageID)
	}
	if r == nil {
		return AnalysisDependencyView{}, fmt.Errorf("dependency registry is unavailable")
	}
	r.mu.RLock()
	adapter := r.byLanguage[request.LanguageID]
	r.mu.RUnlock()
	if adapter == nil {
		return AnalysisDependencyView{}, fmt.Errorf("no dependency adapter for language %q", request.LanguageID)
	}
	allowed, err := secureAllowedRoots(request.Paths.AllowedRoots)
	if err != nil {
		return AnalysisDependencyView{}, err
	}
	result, err := adapter.Resolve(DependencyAdapterContext{
		OwnerKind: request.OwnerKind, OwnerID: request.OwnerID, UserID: request.UserID,
		WorkspaceID: request.WorkspaceID, RuntimeID: request.RuntimeID, LanguageID: request.LanguageID, Paths: request.Paths,
	})
	if err != nil {
		return AnalysisDependencyView{}, fmt.Errorf("resolve %s dependencies: %w", adapter.Name(), err)
	}
	if err := validateAdapterEnvironment(result.LocalEnvironment); err != nil {
		return AnalysisDependencyView{}, err
	}
	if err := validateAdapterEnvironment(result.DockerEnvironment); err != nil {
		return AnalysisDependencyView{}, err
	}
	mounts, sources, err := validateDependencyMounts(result.Mounts, allowed)
	if err != nil {
		return AnalysisDependencyView{}, err
	}
	sharedGeneration := ""
	if (AnalysisDependencyView{Mounts: mounts}).UsesHostRoot(request.Paths.SharedCacheRoot) {
		sharedGeneration = trustedAnalysisDependencyGeneration(request.Paths.SharedCacheRoot, allowed)
	}
	metadata := AnalysisDependencyMetadata{
		Version:            dependencyViewVersion,
		Adapter:            adapter.Name(),
		Generation:         request.Generation,
		SnapshotGeneration: trustedAnalysisDependencyGeneration(request.Paths.SnapshotRoot, allowed),
		SharedGeneration:   sharedGeneration,
		Sources:            sources,
	}
	view := AnalysisDependencyView{
		LanguageID: request.LanguageID, RuntimeID: request.RuntimeID, Mounts: mounts,
		LocalEnvironment: cloneStringMap(result.LocalEnvironment), DockerEnvironment: cloneStringMap(result.DockerEnvironment),
		LocalLSPSettings: cloneAnyMap(result.LocalLSPSettings), DockerLSPSettings: cloneAnyMap(result.DockerLSPSettings), Metadata: metadata,
	}
	view.Revision = dependencyRevision(request, adapter.Name(), mounts, metadata)
	return view, nil
}

func runtimeMatchesLanguage(runtimeID, languageID string) bool {
	if runtimeID == "local" {
		return true
	}
	prefix, _, found := strings.Cut(strings.ToLower(runtimeID), ":")
	if !found {
		return true
	}
	runtimeLanguage, requestedLanguage := normalizeLanguage(prefix), normalizeLanguage(languageID)
	if (runtimeLanguage == "c" || runtimeLanguage == "cpp") && (requestedLanguage == "c" || requestedLanguage == "cpp") {
		return true
	}
	return runtimeLanguage == requestedLanguage
}

func secureAllowedRoots(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	seen := make(map[string]bool)
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || !filepath.IsAbs(value) {
			return nil, fmt.Errorf("dependency allowlist roots must be absolute")
		}
		resolved, err := filepath.EvalSymlinks(filepath.Clean(value))
		if err != nil {
			return nil, fmt.Errorf("resolve dependency allowlist root: %w", err)
		}
		info, err := os.Stat(resolved)
		if err != nil || !info.IsDir() {
			return nil, fmt.Errorf("dependency allowlist root is not a directory")
		}
		key := filepath.Clean(resolved)
		if !seen[key] {
			seen[key] = true
			result = append(result, key)
		}
	}
	return result, nil
}

func validateDependencyMounts(specs []DependencyMountSpec, allowed []string) ([]AnalysisDependencyMount, []AnalysisDependencySourceMetadata, error) {
	if len(specs) > 0 && len(allowed) == 0 {
		return nil, nil, fmt.Errorf("dependency mounts require an explicit host path allowlist")
	}
	mounts := make([]AnalysisDependencyMount, 0, len(specs))
	sources := make([]AnalysisDependencySourceMetadata, 0, len(specs))
	targets := make(map[string]bool)
	for _, spec := range specs {
		source := strings.TrimSpace(spec.HostPath)
		if source == "" {
			continue
		}
		if !filepath.IsAbs(source) {
			return nil, nil, fmt.Errorf("dependency mount source must be absolute")
		}
		info, statErr := os.Stat(source)
		if errors.Is(statErr, fs.ErrNotExist) {
			continue
		}
		if statErr != nil {
			return nil, nil, fmt.Errorf("inspect dependency mount source: %w", statErr)
		}
		if !info.IsDir() {
			return nil, nil, fmt.Errorf("dependency mount source is not a directory")
		}
		resolved, err := filepath.EvalSymlinks(filepath.Clean(source))
		if err != nil {
			return nil, nil, fmt.Errorf("resolve dependency mount source: %w", err)
		}
		if !pathWithinAny(allowed, resolved) {
			return nil, nil, fmt.Errorf("dependency mount source is outside the server allowlist")
		}
		target := path.Clean(strings.TrimSpace(spec.ContainerPath))
		if strings.ContainsRune(target, '\x00') || !dependencyMountTargetAllowed(target) {
			return nil, nil, fmt.Errorf("dependency mount target is outside the fixed analysis dependency paths")
		}
		if targets[target] {
			return nil, nil, fmt.Errorf("duplicate dependency mount target %q", target)
		}
		targets[target] = true
		signature := dependencyDirectorySignature(resolved)
		mounts = append(mounts, AnalysisDependencyMount{Role: spec.Role, HostPath: resolved, ContainerPath: target, ReadOnly: true, Legacy: spec.Legacy, Managed: spec.Managed})
		sources = append(sources, AnalysisDependencySourceMetadata{Role: spec.Role, Legacy: spec.Legacy, Signature: signature})
	}
	return mounts, sources, nil
}

func dependencyMountTargetAllowed(target string) bool {
	if target == DockerWorkspaceRoot+"/node_modules" {
		return true
	}
	if target != AnalysisDependenciesRoot && strings.HasPrefix(target, AnalysisDependenciesRoot+"/") {
		return true
	}
	// Cargo and Gradle resolve selected stores below writable analysis homes.
	// Only these exact children may be overlaid read-only.
	for _, allowed := range []string{
		rustRegistrySrcContainer,
		rustRegistryIndexContainer,
		rustGitCheckoutsContainer,
		rustGitDBContainer,
		javaGradleModulesContainer,
	} {
		if target == allowed {
			return true
		}
	}
	return false
}

func pathWithinAny(roots []string, candidate string) bool {
	candidate = filepath.Clean(candidate)
	for _, root := range roots {
		relative, err := filepath.Rel(filepath.Clean(root), candidate)
		if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

var errDependencyScanBudget = errors.New("dependency metadata scan budget reached")

func dependencyDirectorySignature(root string) string {
	hash := sha256.New()
	rootInfo, rootErr := os.Stat(root)
	if rootErr == nil {
		_, _ = fmt.Fprintf(hash, ".\x00%d\x00%d\x00%d\x00", rootInfo.Mode(), rootInfo.Size(), rootInfo.ModTime().UnixNano())
	}
	type scanDirectory struct {
		absolute string
		relative string
		depth    int
	}
	queue := make([]scanDirectory, 0, 32)
	// Direct metadata catches normal package installs cheaply. File.ReadDir is
	// deliberately bounded; os.ReadDir and filepath.WalkDir both materialize an
	// unbounded directory before a callback can stop them.
	directory, openErr := os.Open(root)
	if openErr == nil {
		entries, readErr := directory.ReadDir(maxDependencyDirectItems + 1)
		_ = directory.Close()
		if readErr == nil || errors.Is(readErr, io.EOF) {
			sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
			if len(entries) > maxDependencyDirectItems {
				entries = entries[:maxDependencyDirectItems]
				_, _ = hash.Write([]byte("direct-items-truncated"))
			}
			for _, entry := range entries {
				info, err := entry.Info()
				if err == nil {
					_, _ = fmt.Fprintf(hash, "%s\x00%d\x00%d\x00%d\x00", entry.Name(), info.Mode(), info.Size(), info.ModTime().UnixNano())
				}
				if entry.IsDir() {
					queue = append(queue, scanDirectory{absolute: filepath.Join(root, entry.Name()), relative: entry.Name(), depth: 1})
				} else if dependencyGenerationMetadata(entry.Name()) {
					data, err := safefile.ReadSmallRegular(root, entry.Name(), maxDependencyMarkerBytes)
					if err == nil {
						_, _ = hash.Write(data)
					}
				}
			}
		}
	}
	visited := 0
	truncated := false
	for len(queue) > 0 && visited < maxDependencyScanEntries {
		current := queue[0]
		queue = queue[1:]
		if current.depth >= maxDependencyScanDepth {
			continue
		}
		remaining := maxDependencyScanEntries - visited
		directory, err := os.Open(current.absolute)
		if err != nil {
			continue
		}
		entries, readErr := directory.ReadDir(remaining + 1)
		_ = directory.Close()
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			_, _ = fmt.Fprintf(hash, "scan-error:%T", readErr)
			continue
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		if len(entries) > remaining {
			entries = entries[:remaining]
			truncated = true
		}
		for _, entry := range entries {
			visited++
			relative := filepath.Join(current.relative, entry.Name())
			info, err := entry.Info()
			if err == nil {
				_, _ = fmt.Fprintf(hash, "%s\x00%d\x00%d\x00%d\x00", filepath.ToSlash(relative), info.Mode(), info.Size(), info.ModTime().UnixNano())
			}
			if entry.IsDir() {
				queue = append(queue, scanDirectory{absolute: filepath.Join(current.absolute, entry.Name()), relative: relative, depth: current.depth + 1})
			}
		}
		if truncated {
			break
		}
	}
	if len(queue) > 0 {
		truncated = true
	}
	if truncated {
		_, _ = hash.Write([]byte("truncated"))
	}
	return hex.EncodeToString(hash.Sum(nil)[:12])
}

func dependencyGenerationMetadata(name string) bool {
	switch strings.ToLower(name) {
	case ".analysis-generation", ".container-generation", ".dependency-generation", ".cache-meta.json":
		return true
	default:
		return false
	}
}

func dependencyRevision(request AnalysisDependencyRequest, adapter string, mounts []AnalysisDependencyMount, metadata AnalysisDependencyMetadata) string {
	hash := sha256.New()
	_, _ = fmt.Fprintf(hash, "%d\x00%s\x00%s\x00%s\x00%s\x00%s\x00%s\x00%s\x00%s\x00", dependencyViewVersion, adapter, request.OwnerKind, request.OwnerID, request.UserID, request.WorkspaceID, request.RuntimeID, request.LanguageID, request.Generation)
	if metadata.SnapshotGeneration != "" {
		_, _ = fmt.Fprintf(hash, "snapshot-generation\x00%s\x00", metadata.SnapshotGeneration)
	}
	if metadata.SharedGeneration != "" {
		_, _ = fmt.Fprintf(hash, "shared-generation\x00%s\x00", metadata.SharedGeneration)
	}
	for i, mount := range mounts {
		source := ""
		if i < len(metadata.Sources) {
			source = metadata.Sources[i].Signature
		}
		_, _ = fmt.Fprintf(hash, "%s\x00%s\x00%s\x00%t\x00%s\x00", mount.Role, mount.HostPath, mount.ContainerPath, mount.Legacy, source)
	}
	return hex.EncodeToString(hash.Sum(nil)[:16])
}

func cloneStringMap(source map[string]string) map[string]string {
	if len(source) == 0 {
		return nil
	}
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cloneAnyMap(source map[string]any) map[string]any {
	if len(source) == 0 {
		return nil
	}
	result := make(map[string]any, len(source))
	for key, value := range source {
		switch typed := value.(type) {
		case map[string]any:
			result[key] = cloneAnyMap(typed)
		case []string:
			result[key] = append([]string(nil), typed...)
		case []any:
			result[key] = append([]any(nil), typed...)
		default:
			result[key] = value
		}
	}
	return result
}
