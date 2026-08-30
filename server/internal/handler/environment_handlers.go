package handler

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/packagecatalog"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/resourcecontrol"
)

const (
	projectEnvironmentSchema       = "project-environment/v1"
	projectEnvironmentPlanSchema   = "project-environment-repair-plan/v1"
	projectEnvironmentActionSchema = "project-environment-action/v1"
	maxEnvironmentFiles            = 4096
	maxEnvironmentDepth            = 5
	maxEnvironmentManifestBytes    = int64(8 << 20)
)

var environmentSkippedDirs = map[string]bool{
	".git": true, ".bobocloud": true, ".gradle": true, ".idea": true,
	".next": true, ".venv": true, "venv": true, "node_modules": true,
	"target": true, "vendor": true, "build": true, "dist": true,
	"out": true, "coverage": true,
}

type environmentManifestSpec struct {
	Kind, Manager, Language string
	Lockfile, Parse         bool
}

var environmentManifestSpecs = map[string]environmentManifestSpec{
	"requirements.txt":    {"requirements", "pip", "python", false, true},
	"pyproject.toml":      {"pyproject", "python", "python", false, true},
	"pipfile":             {"pipfile", "pipenv", "python", false, false},
	"pipfile.lock":        {"pipfile-lock", "pipenv", "python", true, false},
	"poetry.lock":         {"poetry-lock", "poetry", "python", true, false},
	"pdm.lock":            {"pdm-lock", "pdm", "python", true, false},
	"package.json":        {"package", "npm", "node", false, true},
	"package-lock.json":   {"package-lock", "npm", "node", true, false},
	"npm-shrinkwrap.json": {"npm-shrinkwrap", "npm", "node", true, false},
	"pnpm-lock.yaml":      {"pnpm-lock", "pnpm", "node", true, false},
	"pnpm-workspace.yaml": {"pnpm-workspace", "pnpm", "node", false, false},
	"yarn.lock":           {"yarn-lock", "yarn", "node", true, false},
	"bun.lock":            {"bun-lock", "bun", "node", true, false},
	"go.mod":              {"go-module", "go", "go", false, true},
	"go.sum":              {"go-sum", "go", "go", true, false},
	"cargo.toml":          {"cargo", "cargo", "rust", false, true},
	"cargo.lock":          {"cargo-lock", "cargo", "rust", true, false},
	"pom.xml":             {"maven", "maven", "java", false, true},
	"build.gradle":        {"gradle", "gradle", "java", false, false},
	"build.gradle.kts":    {"gradle-kotlin", "gradle", "java", false, false},
	"gradle.lockfile":     {"gradle-lock", "gradle", "java", true, false},
	"cmakelists.txt":      {"cmake", "cmake", "cpp", false, false},
	"vcpkg.json":          {"vcpkg", "vcpkg", "cpp", false, false},
	"conanfile.txt":       {"conan", "conan", "cpp", false, false},
	"conanfile.py":        {"conan", "conan", "cpp", false, false},
}

type environmentResolved struct {
	root, folderKey, branch string
	workspace               model.ProjectEnvironmentWorkspace
}

type installedEnvironmentInspection struct {
	Packages  []model.ProjectEnvironmentPackage
	Exact     bool
	CheckedAt int64
	State     string
	Detail    string
}

type environmentDependencySnapshot struct {
	managed   bool
	reader    *personalcache.ReadLease
	entry     personalcache.Entry
	inventory personalcache.InventoryInspection
	exists    bool
	err       error
}

func (snapshot *environmentDependencySnapshot) Release() {
	if snapshot != nil && snapshot.reader != nil {
		snapshot.reader.Release()
		snapshot.reader = nil
	}
}

func (h *HTTPHandler) handleProjectEnvironment(w http.ResponseWriter, r *http.Request, req *model.Request) {
	switch req.Action {
	case "getProjectEnvironment":
		environment, _, err := h.inspectProjectEnvironment(r, req)
		if err != nil {
			writeProjectEnvironmentError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: environment})
	case "planProjectEnvironmentRepair":
		environment, resolved, err := h.inspectProjectEnvironment(r, req)
		if err != nil {
			writeProjectEnvironmentError(w, err)
			return
		}
		plan := buildProjectEnvironmentPlan(environment, resolved.root, req.EnvironmentAction)
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: plan})
	case "applyProjectEnvironmentAction":
		h.applyProjectEnvironmentAction(w, r, req)
	}
}

func writeProjectEnvironmentError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	if errors.Is(err, os.ErrNotExist) {
		status = http.StatusNotFound
	}
	writeJSON(w, status, model.Response{Success: false, Error: err.Error()})
}

func (h *HTTPHandler) resolveProjectEnvironment(r *http.Request, req *model.Request) (environmentResolved, error) {
	userID := auth.UserIDFromContext(r.Context())
	if req.TeamID != "" || req.ProjectID != "" {
		if h.Collaboration == nil || req.TeamID == "" || req.ProjectID == "" {
			return environmentResolved{}, fmt.Errorf("teamId and projectId are required")
		}
		project, err := h.Collaboration.Store().GetProject(req.ProjectID)
		if err != nil || project.TeamID != req.TeamID {
			return environmentResolved{}, fmt.Errorf("team project not found")
		}
		branch := strings.TrimSpace(req.Branch)
		if branch == "" {
			branch = project.DefaultBranch
		}
		root, err := h.Collaboration.ResolveWorktree(r.Context(), userID, req.TeamID, req.ProjectID, branch)
		if err != nil {
			return environmentResolved{}, err
		}
		return environmentResolved{root: root, branch: branch, workspace: model.ProjectEnvironmentWorkspace{
			Kind: "team", ID: lsp.StableWorkspaceIdentity(userID, req.TeamID, req.ProjectID, branch, ""),
			Name: project.Name, TeamID: req.TeamID, ProjectID: req.ProjectID, Branch: branch,
		}}, nil
	}
	key := strings.TrimSpace(req.FolderKey)
	if key == "" {
		key = strings.TrimSpace(req.FolderName)
	}
	if key == "" {
		return environmentResolved{}, fmt.Errorf("folderKey or folderName is required")
	}
	root, err := h.resolveWorkspace(r, req.FolderName, key)
	if err != nil {
		return environmentResolved{}, err
	}
	name := strings.TrimSpace(req.FolderName)
	if name == "" {
		name = key
	}
	return environmentResolved{root: root, folderKey: key, workspace: model.ProjectEnvironmentWorkspace{
		Kind: "personal", ID: lsp.StableWorkspaceIdentity(userID, "", "", "", key), Name: name, Key: key,
	}}, nil
}

func (h *HTTPHandler) inspectProjectEnvironment(r *http.Request, req *model.Request) (*model.ProjectEnvironment, environmentResolved, error) {
	resolved, err := h.resolveProjectEnvironment(r, req)
	if err != nil {
		return nil, resolved, err
	}
	info, err := os.Stat(resolved.root)
	if err != nil || !info.IsDir() {
		if err == nil {
			err = fmt.Errorf("workspace does not exist")
		}
		return nil, resolved, err
	}
	language := canonicalEnvironmentLanguage(req.Language)
	runtimeStatus := "local"
	runtime := model.ProjectEnvironmentRuntime{ID: "local", Status: runtimeStatus}
	if strings.TrimSpace(req.Runtime) != "" && req.Runtime != "local" {
		rt := model.GetRuntimeDef(req.Runtime)
		if rt == nil {
			return nil, resolved, fmt.Errorf("unknown runtime: %s", req.Runtime)
		}
		metadata := resolveProjectRuntimeMetadata(r.Context(), h.RuntimeMetadata, rt.RuntimeID, rt.DockerImage, rt.Version)
		runtime = model.ProjectEnvironmentRuntime{
			ID: rt.RuntimeID, Language: rt.Language, Version: rt.Version,
			ResolvedVersion: metadata.Version, ResolvedVersionSource: metadata.VersionSource, ResolvedVersionTrust: metadata.VersionTrust,
			Image: rt.DockerImage, DisplayName: rt.DisplayName, Status: "ready",
		}
		if language == "" {
			language = rt.Language
		}
	}
	manifests, declared, manifestTimes, err := inspectEnvironmentManifests(resolved.root, language)
	if err != nil {
		return nil, resolved, err
	}
	if language == "" {
		language = inferEnvironmentLanguage(manifests)
	}
	dependencySnapshot := h.acquireEnvironmentDependencySnapshot(r, req, resolved, runtime, language)
	if dependencySnapshot != nil {
		defer dependencySnapshot.Release()
	}
	installedInspection := h.inspectInstalledEnvironmentPackages(r, req, resolved, runtime, language, dependencySnapshot)
	installed, installedTrusted, installedAt := installedInspection.Packages, installedInspection.Exact, installedInspection.CheckedAt
	if language == "python" {
		var inventory []personalcache.InventoryPackage
		if dependencySnapshot != nil {
			inventory = dependencySnapshot.inventory.Packages
		}
		declared = resolvePythonSourceDistributions(declared, inventory)
	}
	dependencyCache := h.inspectProjectDependencyCache(r, req, resolved, runtime, language, dependencySnapshot)
	if dependencyCache.Scope == "project-lock" {
		dependencyCache.InventoryStatus = installedInspection.State
		dependencyCache.InventoryDetail = installedInspection.Detail
		dependencyCache.InventoryCheckedAt = installedInspection.CheckedAt
	}
	packages := classifyEnvironmentPackages(declared, installed, language, installedTrusted)
	dependencyStatus, indexedAt := h.resolveEnvironmentDependencyStatus(r, req, resolved, runtime, language, dependencySnapshot)
	languageRuntime := model.ProjectEnvironmentCheck{Status: "unknown", Detail: "Language or runtime is not selected"}
	if language != "" && runtime.ID == "local" {
		languageRuntime.Detail = "The local runtime toolchain cannot be verified without executing it"
	} else if language != "" && runtime.Language == language {
		languageRuntime = model.ProjectEnvironmentCheck{Status: "aligned", Detail: fmt.Sprintf("Language %s matches runtime %s", language, runtime.ID)}
	} else if language != "" && runtime.Language != "" {
		languageRuntime = model.ProjectEnvironmentCheck{Status: "mismatch", Detail: fmt.Sprintf("Language %s does not match runtime %s (%s)", language, runtime.ID, runtime.Language)}
	}
	dependencyRuntime := projectEnvironmentDependencyRuntimeCheck(runtime, language, packages, installedTrusted, resolved.workspace.Kind, installedInspection.State, installedInspection.Detail)
	lspDependencies := model.ProjectEnvironmentCheck{Status: dependencyStatus.Status, Detail: dependencyStatus.Detail}
	consistencyStatus, consistencyDetail := projectEnvironmentOverallConsistency(languageRuntime, dependencyRuntime, lspDependencies)
	if dependencyStatus.Detail == "" {
		lspDependencies.Detail = fmt.Sprintf("LSP dependency view status is %s for runtime %s", dependencyStatus.Status, runtime.ID)
	}
	lastCompiled := h.lastProjectCompile(r.Context(), resolved.workspace, runtime.ID)
	lastManifest := int64(0)
	for _, value := range manifestTimes {
		if value > lastManifest {
			lastManifest = value
		}
	}
	if installedAt == 0 && len(installed) > 0 {
		installedAt = lastManifest
	}
	environment := &model.ProjectEnvironment{
		Schema: projectEnvironmentSchema, CheckedAt: time.Now().UTC().UnixMilli(), Workspace: resolved.workspace,
		Language: model.ProjectEnvironmentLanguage{ID: language, Source: environmentLanguageSource(req.Language, runtime, manifests)}, Runtime: runtime,
		Manifests: manifests, Packages: packages,
		Consistency:     model.ProjectEnvironmentConsistency{Status: consistencyStatus, LanguageRuntime: languageRuntime, DependencyRuntime: dependencyRuntime, LSPDependencies: lspDependencies, Detail: consistencyDetail},
		Activity:        model.ProjectEnvironmentActivity{LastIndexedAt: indexedAt, LastInstalledAt: installedAt, LastCompiledAt: lastCompiled},
		DependencyCache: dependencyCache,
	}
	environment.Actions = h.projectEnvironmentCapabilities(environment, r)
	environment.Revision = environmentRevision(environment, dependencyStatus.Revision)
	return environment, resolved, nil
}

func projectEnvironmentDependencyRuntimeCheck(runtime model.ProjectEnvironmentRuntime, language string, packages model.ProjectEnvironmentPackages, trusted bool, workspaceKind, inspectionState, inspectionDetail string) model.ProjectEnvironmentCheck {
	if inspectionState != "" && inspectionState != "ready" && inspectionState != "legacy-ready" {
		detail := strings.TrimSpace(inspectionDetail)
		if detail == "" {
			detail = fmt.Sprintf("Installed package inventory is %s", inspectionState)
		}
		return model.ProjectEnvironmentCheck{Status: "unknown", Detail: detail}
	}
	if trusted {
		if len(packages.Declared) == 0 {
			return model.ProjectEnvironmentCheck{Status: "unknown", Detail: fmt.Sprintf("The installed package inventory for runtime %s is exact, but the project has no parseable dependency declarations, so required packages cannot be proven", runtime.ID)}
		}
		if len(packages.Missing) > 0 {
			return model.ProjectEnvironmentCheck{Status: "mismatch", Detail: fmt.Sprintf("The exact installed state for runtime %s is missing %d declared dependencies", runtime.ID, len(packages.Missing))}
		}
		if len(packages.Unknown) > 0 {
			return model.ProjectEnvironmentCheck{Status: "unknown", Detail: fmt.Sprintf("The exact installed state for runtime %s cannot verify %d declared dependency constraints", runtime.ID, len(packages.Unknown))}
		}
		return model.ProjectEnvironmentCheck{Status: "aligned", Detail: fmt.Sprintf("The exact installed state for runtime %s contains all %d declared dependencies", runtime.ID, len(packages.Declared))}
	}
	if workspaceKind == "team" {
		return model.ProjectEnvironmentCheck{Status: "unknown", Detail: "Installed package truth is unavailable because the team dependency cache has no read-only inspection lease"}
	}
	if language == "" {
		return model.ProjectEnvironmentCheck{Status: "unknown", Detail: "Installed package truth cannot be selected until the project language is known"}
	}
	if runtime.ID == "" || runtime.ID == "local" {
		return model.ProjectEnvironmentCheck{Status: "unknown", Detail: "Installed package truth cannot be verified for the local runtime without executing it"}
	}
	return model.ProjectEnvironmentCheck{Status: "unknown", Detail: fmt.Sprintf("Installed package truth is not exact for %s runtime %s; %d declarations remain unknown", language, runtime.ID, len(packages.Unknown))}
}

func projectEnvironmentOverallConsistency(languageRuntime, dependencyRuntime, lspDependencies model.ProjectEnvironmentCheck) (string, string) {
	if languageRuntime.Status == "mismatch" {
		return "mismatch", languageRuntime.Detail
	}
	if dependencyRuntime.Status == "mismatch" {
		return "mismatch", dependencyRuntime.Detail
	}
	if languageRuntime.Status == "aligned" && dependencyRuntime.Status == "aligned" && lspDependencies.Status == "ready" {
		return "aligned", "Language, installed packages, and the LSP dependency view agree"
	}
	if lspDependencies.Status == "mixed" {
		return "unknown", lspDependencies.Detail
	}
	if dependencyRuntime.Status == "unknown" {
		return "unknown", dependencyRuntime.Detail
	}
	if lspDependencies.Status != "ready" {
		return "unknown", lspDependencies.Detail
	}
	return "unknown", "The environment could not be fully verified"
}

func canonicalEnvironmentLanguage(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "javascript", "typescript", "js", "ts", "nodejs":
		return "node"
	case "c++", "cc", "cxx":
		return "cpp"
	case "py":
		return "python"
	case "golang":
		return "go"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func environmentLanguageSource(requested string, runtime model.ProjectEnvironmentRuntime, manifests []model.ProjectEnvironmentManifest) string {
	if canonicalEnvironmentLanguage(requested) != "" {
		return "editor"
	}
	if runtime.Language != "" {
		return "runtime"
	}
	if len(manifests) > 0 {
		return "manifest"
	}
	return "unknown"
}

func inferEnvironmentLanguage(manifests []model.ProjectEnvironmentManifest) string {
	counts := map[string]int{}
	for _, manifest := range manifests {
		if manifest.Language != "" {
			counts[manifest.Language]++
		}
	}
	best, count := "", 0
	for language, value := range counts {
		if value > count || (value == count && language < best) {
			best, count = language, value
		}
	}
	return best
}

func inspectEnvironmentManifests(root, preferredLanguage string) ([]model.ProjectEnvironmentManifest, []model.ProjectEnvironmentPackage, []int64, error) {
	manifests := make([]model.ProjectEnvironmentManifest, 0)
	declared := make([]model.ProjectEnvironmentPackage, 0)
	modTimes := make([]int64, 0)
	visited := 0
	err := filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		visited++
		if visited > maxEnvironmentFiles {
			return fs.SkipAll
		}
		if entry.IsDir() {
			if current != root && environmentSkippedDirs[strings.ToLower(entry.Name())] {
				return filepath.SkipDir
			}
			if current != root {
				rel, _ := filepath.Rel(root, current)
				if strings.Count(filepath.ToSlash(rel), "/") >= maxEnvironmentDepth {
					return filepath.SkipDir
				}
			}
			return nil
		}
		spec, ok := environmentManifestSpecs[strings.ToLower(entry.Name())]
		if !ok && strings.HasPrefix(strings.ToLower(entry.Name()), "requirements") && strings.HasSuffix(strings.ToLower(entry.Name()), ".txt") {
			spec, ok = environmentManifestSpec{"requirements", "pip", "python", false, true}, true
		}
		if !ok {
			return nil
		}
		rel, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		parsed := false
		status := "recognized"
		if spec.Parse && (preferredLanguage == "" || preferredLanguage == spec.Language) {
			items, parseErr := parseEnvironmentManifest(current, rel, spec)
			if parseErr == nil {
				declared = append(declared, items...)
				parsed = true
			} else {
				status = "unparsed"
			}
		}
		if spec.Language == "node" && strings.EqualFold(entry.Name(), "package.json") {
			if manager := inspectNodePackageManagerDeclaration(current); manager != "" {
				spec.Manager = manager
			}
		}
		if info, statErr := entry.Info(); statErr == nil {
			modTimes = append(modTimes, info.ModTime().UTC().UnixMilli())
		}
		manifests = append(manifests, model.ProjectEnvironmentManifest{Path: rel, Kind: spec.Kind, Manager: spec.Manager, Language: spec.Language, Lockfile: spec.Lockfile, Parsed: parsed, Status: status})
		return nil
	})
	if err != nil {
		return nil, nil, nil, err
	}
	if preferredLanguage == "" || preferredLanguage == "python" {
		sourceManifests, sourcePackages, sourceTimes, sourceErr := inspectPythonSourceDependencies(root)
		if sourceErr != nil {
			return nil, nil, nil, sourceErr
		}
		manifests = append(manifests, sourceManifests...)
		declared = append(declared, sourcePackages...)
		modTimes = append(modTimes, sourceTimes...)
	}
	sort.Slice(manifests, func(i, j int) bool { return manifests[i].Path < manifests[j].Path })
	declared = dedupeEnvironmentPackages(declared)
	return manifests, declared, modTimes, nil
}

func parseEnvironmentManifest(path, rel string, spec environmentManifestSpec) ([]model.ProjectEnvironmentPackage, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > maxEnvironmentManifestBytes {
		return nil, fmt.Errorf("manifest is not a bounded regular file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	switch spec.Kind {
	case "requirements":
		return parseRequirements(data, rel), nil
	case "package":
		return parsePackageJSON(data, rel)
	case "go-module":
		return parseGoMod(data, rel), nil
	case "cargo":
		return parseCargoManifest(data, rel), nil
	case "maven":
		return parseMavenManifest(data, rel), nil
	case "pyproject":
		return parsePyproject(data, rel)
	default:
		return nil, nil
	}
}

func parseRequirements(data []byte, source string) []model.ProjectEnvironmentPackage {
	items := make([]model.ProjectEnvironmentPackage, 0)
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(strings.SplitN(scanner.Text(), "#", 2)[0])
		if line == "" || strings.HasPrefix(line, "-") || strings.Contains(line, "://") || strings.Contains(line, " @ ") {
			continue
		}
		name, constraint := splitPythonRequirement(line)
		if name != "" {
			items = append(items, model.ProjectEnvironmentPackage{Name: normalizePythonPackageName(name), Constraint: constraint, Scope: "runtime", Source: source})
		}
	}
	return items
}

func splitPythonRequirement(value string) (string, string) {
	value = strings.TrimSpace(strings.SplitN(value, ";", 2)[0])
	if index := strings.Index(value, "["); index >= 0 {
		if end := strings.Index(value[index:], "]"); end >= 0 {
			value = value[:index] + value[index+end+1:]
		}
	}
	index := len(value)
	for i, char := range value {
		isPackageNameChar := char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_' || char == '.'
		if strings.ContainsRune("<>=!~", char) || !isPackageNameChar {
			index = i
			break
		}
	}
	return strings.TrimSpace(value[:index]), strings.TrimSpace(value[index:])
}

func parsePackageJSON(data []byte, source string) ([]model.ProjectEnvironmentPackage, error) {
	var value struct {
		Dependencies         map[string]string `json:"dependencies"`
		DevDependencies      map[string]string `json:"devDependencies"`
		OptionalDependencies map[string]string `json:"optionalDependencies"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	items := make([]model.ProjectEnvironmentPackage, 0)
	appendMap := func(values map[string]string, scope string) {
		for name, constraint := range values {
			items = append(items, model.ProjectEnvironmentPackage{Name: normalizePackageName(name), Constraint: strings.TrimSpace(constraint), Scope: scope, Source: source})
		}
	}
	appendMap(value.Dependencies, "runtime")
	appendMap(value.DevDependencies, "dev")
	appendMap(value.OptionalDependencies, "optional")
	return items, nil
}

func parseGoMod(data []byte, source string) []model.ProjectEnvironmentPackage {
	items := make([]model.ProjectEnvironmentPackage, 0)
	inRequire := false
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.SplitN(raw, "//", 2)[0])
		if line == "require (" {
			inRequire = true
			continue
		}
		if inRequire && line == ")" {
			inRequire = false
			continue
		}
		if strings.HasPrefix(line, "require ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "require "))
		} else if !inRequire {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			items = append(items, model.ProjectEnvironmentPackage{Name: normalizePackageName(fields[0]), Constraint: fields[1], Scope: "runtime", Source: source})
		}
	}
	return items
}

func parseCargoManifest(data []byte, source string) []model.ProjectEnvironmentPackage {
	items := make([]model.ProjectEnvironmentPackage, 0)
	scope := ""
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.SplitN(raw, "#", 2)[0])
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section := strings.ToLower(strings.Trim(line, "[] "))
			scope = ""
			if section == "dependencies" || strings.HasSuffix(section, ".dependencies") {
				scope = "runtime"
			} else if section == "dev-dependencies" || strings.HasSuffix(section, ".dev-dependencies") {
				scope = "development"
			} else if section == "build-dependencies" || strings.HasSuffix(section, ".build-dependencies") {
				scope = "build"
			}
			continue
		}
		if scope == "" {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		name := strings.Trim(strings.TrimSpace(parts[0]), "'\"")
		constraint := strings.TrimSpace(parts[1])
		if strings.HasPrefix(constraint, "{") {
			if marker := strings.Index(constraint, "version"); marker >= 0 {
				constraint = strings.TrimSpace(strings.SplitN(constraint[marker+len("version"):], ",", 2)[0])
				constraint = strings.Trim(constraint, " =\"'")
			} else {
				constraint = ""
			}
		} else {
			constraint = strings.Trim(constraint, "\"'")
		}
		if name != "" {
			items = append(items, model.ProjectEnvironmentPackage{Name: normalizePackageName(name), Constraint: constraint, Scope: scope, Source: source})
		}
	}
	return items
}

func parseMavenManifest(data []byte, source string) []model.ProjectEnvironmentPackage {
	var project struct {
		Dependencies []struct {
			GroupID    string `xml:"groupId"`
			ArtifactID string `xml:"artifactId"`
			Version    string `xml:"version"`
		} `xml:"dependencies>dependency"`
		DependencyManagement []struct {
			GroupID    string `xml:"groupId"`
			ArtifactID string `xml:"artifactId"`
			Version    string `xml:"version"`
		} `xml:"dependencyManagement>dependencies>dependency"`
	}
	if xml.Unmarshal(data, &project) != nil {
		return nil
	}
	items := make([]model.ProjectEnvironmentPackage, 0, len(project.Dependencies)+len(project.DependencyManagement))
	appendDependencies := func(dependencies []struct {
		GroupID    string `xml:"groupId"`
		ArtifactID string `xml:"artifactId"`
		Version    string `xml:"version"`
	}, scope string) {
		for _, dependency := range dependencies {
			group, artifact := strings.TrimSpace(dependency.GroupID), strings.TrimSpace(dependency.ArtifactID)
			if group != "" && artifact != "" {
				items = append(items, model.ProjectEnvironmentPackage{Name: normalizePackageName(group + ":" + artifact), Constraint: strings.TrimSpace(dependency.Version), Scope: scope, Source: source})
			}
		}
	}
	appendDependencies(project.Dependencies, "runtime")
	appendDependencies(project.DependencyManagement, "managed")
	return items
}

func parsePyproject(data []byte, source string) ([]model.ProjectEnvironmentPackage, error) {
	items := make([]model.ProjectEnvironmentPackage, 0)
	section := ""
	inProjectArray := false
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.SplitN(raw, "#", 2)[0])
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			if inProjectArray {
				return nil, fmt.Errorf("project dependencies array is not closed")
			}
			section = strings.ToLower(strings.Trim(line, "[] "))
			continue
		}
		if section == "project" && strings.HasPrefix(line, "dependencies") {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) != 2 || strings.TrimSpace(parts[0]) != "dependencies" || !containsUnquotedTOMLRune(parts[1], '[') {
				return nil, fmt.Errorf("project dependencies must be a TOML string array")
			}
			inProjectArray = !containsUnquotedTOMLRune(parts[1], ']')
			line = strings.TrimSpace(parts[1])
		}
		if section == "project" && (inProjectArray || strings.HasPrefix(line, "[")) {
			tokens, err := quotedTOMLStrings(line)
			if err != nil {
				return nil, err
			}
			for _, token := range tokens {
				name, constraint := splitPythonRequirement(token)
				if name != "" {
					items = append(items, model.ProjectEnvironmentPackage{Name: normalizePythonPackageName(name), Constraint: constraint, Scope: "runtime", Source: source})
				}
			}
			if containsUnquotedTOMLRune(line, ']') {
				inProjectArray = false
			}
			continue
		}
		if section == "tool.poetry.dependencies" {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 && strings.TrimSpace(parts[0]) != "python" {
				items = append(items, model.ProjectEnvironmentPackage{Name: normalizePythonPackageName(strings.Trim(parts[0], " \"'")), Constraint: strings.Trim(parts[1], " \"'"), Scope: "runtime", Source: source})
			}
		}
	}
	if inProjectArray {
		return nil, fmt.Errorf("project dependencies array is not closed")
	}
	return items, nil
}

func quotedTOMLStrings(value string) ([]string, error) {
	items := make([]string, 0)
	var current strings.Builder
	var quote rune
	escaped := false
	for _, char := range value {
		if quote == 0 {
			if char == '\'' || char == '"' {
				quote = char
				current.Reset()
				continue
			}
			if char != '[' && char != ']' && char != ',' && char != ' ' && char != '\t' && char != '\r' {
				return nil, fmt.Errorf("project dependencies contain an unquoted value")
			}
			continue
		}
		if quote == '"' && escaped {
			current.WriteRune(char)
			escaped = false
			continue
		}
		if quote == '"' && char == '\\' {
			escaped = true
			continue
		}
		if char == quote {
			items = append(items, current.String())
			quote = 0
			continue
		}
		current.WriteRune(char)
	}
	if quote != 0 || escaped {
		return nil, fmt.Errorf("project dependencies contain an unterminated TOML string")
	}
	return items, nil
}

func containsUnquotedTOMLRune(value string, target rune) bool {
	var quote rune
	escaped := false
	for _, char := range value {
		if quote == 0 {
			if char == '\'' || char == '"' {
				quote = char
				continue
			}
			if char == target {
				return true
			}
			continue
		}
		if quote == '"' && escaped {
			escaped = false
			continue
		}
		if quote == '"' && char == '\\' {
			escaped = true
			continue
		}
		if char == quote {
			quote = 0
		}
	}
	return false
}

func normalizePackageName(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizePythonPackageName(value string) string {
	value = normalizePackageName(value)
	var builder strings.Builder
	separator := false
	for _, char := range value {
		if char == '-' || char == '_' || char == '.' {
			separator = builder.Len() > 0
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

func dedupeEnvironmentPackages(items []model.ProjectEnvironmentPackage) []model.ProjectEnvironmentPackage {
	byKey := map[string]model.ProjectEnvironmentPackage{}
	for _, item := range items {
		key := item.Name + "\x00" + item.Scope
		if existing, ok := byKey[key]; ok {
			if existing.Constraint == "" {
				existing.Constraint = item.Constraint
			}
			if existing.Source != item.Source && !strings.Contains(existing.Source, ", "+item.Source) {
				existing.Source += ", " + item.Source
			}
			byKey[key] = existing
			continue
		}
		byKey[key] = item
	}
	out := make([]model.ProjectEnvironmentPackage, 0, len(byKey))
	for _, item := range byKey {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (h *HTTPHandler) acquireEnvironmentDependencySnapshot(r *http.Request, req *model.Request, resolved environmentResolved, runtime model.ProjectEnvironmentRuntime, language string) *environmentDependencySnapshot {
	managed := resolved.workspace.Kind == "personal" && h.PersonalCache != nil && runtime.ID != "" && runtime.ID != "local" && projectLockDependencyLanguage(language)
	if !managed {
		return nil
	}
	cacheRequest := h.environmentCacheRequest(r, req, resolved, runtime, language)
	snapshot := &environmentDependencySnapshot{managed: true}
	if language == "python" || language == "node" {
		snapshot.reader, snapshot.entry, snapshot.inventory, snapshot.exists = h.PersonalCache.AcquirePackageInventorySnapshotRead(cacheRequest)
		return snapshot
	}
	snapshot.reader, snapshot.entry, snapshot.exists, snapshot.err = h.PersonalCache.AcquireRead(cacheRequest)
	return snapshot
}

func environmentDependencySnapshotArg(snapshots []*environmentDependencySnapshot) *environmentDependencySnapshot {
	if len(snapshots) == 0 {
		return nil
	}
	return snapshots[0]
}

func installedEnvironmentInspectionFromPythonInventory(inventory personalcache.InventoryInspection) installedEnvironmentInspection {
	return installedEnvironmentInspectionFromManagedInventory(inventory, "python")
}

func installedEnvironmentInspectionFromManagedInventory(inventory personalcache.InventoryInspection, language string) installedEnvironmentInspection {
	checkedAt := int64(0)
	if !inventory.GeneratedAt.IsZero() {
		checkedAt = inventory.GeneratedAt.UTC().UnixMilli()
	}
	items := make([]model.ProjectEnvironmentPackage, 0, len(inventory.Packages))
	for _, item := range inventory.Packages {
		trust := "observed"
		if inventory.Exact {
			trust = "exact"
		}
		name := normalizePackageName(item.Name)
		if language == "python" {
			name = normalizePythonPackageName(item.Name)
		}
		items = append(items, model.ProjectEnvironmentPackage{
			Name: name, Version: item.Version,
			Scope: "project-lock", Source: "project-lock-" + language, Trust: trust,
		})
	}
	return installedEnvironmentInspection{
		Packages: items, Exact: inventory.Exact, CheckedAt: checkedAt,
		State: inventory.State, Detail: inventory.Detail,
	}
}

func inspectNodePackageManagerDeclaration(pathValue string) string {
	info, err := os.Lstat(pathValue)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 1<<20 {
		return ""
	}
	data, err := os.ReadFile(pathValue)
	if err != nil || int64(len(data)) != info.Size() {
		return ""
	}
	var metadata struct {
		PackageManager string `json:"packageManager"`
	}
	if json.Unmarshal(data, &metadata) != nil {
		return ""
	}
	manager := strings.ToLower(strings.TrimSpace(strings.SplitN(metadata.PackageManager, "@", 2)[0]))
	if manager == "npm" || manager == "pnpm" {
		return manager
	}
	return ""
}

func inspectInstalledEnvironmentSnapshot(root, language string) installedEnvironmentInspection {
	var items []model.ProjectEnvironmentPackage
	var at int64
	switch language {
	case "node":
		items, at, _ = inspectNodeInstalled(filepath.Join(root, "node_modules"))
	case "go":
		items, at = inspectGoInstalled(filepath.Join(root, "go", "pkg", "mod"))
	case "rust":
		items, at = inspectRustInstalled(filepath.Join(root, "cargo", "registry", "src"))
	case "java":
		items, at = inspectMavenInstalled(filepath.Join(root, "maven"))
	}
	for index := range items {
		items[index].Scope = "project-lock"
		items[index].Source = "project-lock-" + language
		items[index].Trust = "observed"
	}
	return installedEnvironmentInspection{Packages: items, CheckedAt: at, State: "observed"}
}

func (h *HTTPHandler) inspectInstalledEnvironmentPackages(r *http.Request, req *model.Request, resolved environmentResolved, runtime model.ProjectEnvironmentRuntime, language string, snapshots ...*environmentDependencySnapshot) installedEnvironmentInspection {
	if resolved.workspace.Kind == "team" {
		return installedEnvironmentInspection{State: "unavailable", Detail: "The team dependency cache has no read-only package inventory lease"}
	}
	if h.PersonalCache != nil && runtime.ID != "" && runtime.ID != "local" {
		cacheRequest := h.environmentCacheRequest(r, req, resolved, runtime, language)
		snapshot := environmentDependencySnapshotArg(snapshots)
		if snapshot != nil && snapshot.managed {
			if language == "python" || language == "node" {
				return installedEnvironmentInspectionFromManagedInventory(snapshot.inventory, language)
			}
			if errors.Is(snapshot.err, personalcache.ErrCacheInUse) {
				return installedEnvironmentInspection{State: "busy", Detail: "The package cache is being written and cannot be inspected yet"}
			}
			if snapshot.err != nil || !snapshot.exists || snapshot.reader == nil {
				state, detail := "missing", "No cache exists for the current project dependency digest"
				if snapshot.err != nil {
					state, detail = "error", "The project dependency digest could not be resolved"
				}
				return installedEnvironmentInspection{State: state, Detail: detail}
			}
			return inspectInstalledEnvironmentSnapshot(snapshot.reader.HostRoot, language)
		}
		if language == "python" || language == "node" {
			return installedEnvironmentInspectionFromManagedInventory(h.PersonalCache.InspectPackageInventory(cacheRequest), language)
		}
		reader, _, exists, err := h.PersonalCache.AcquireRead(cacheRequest)
		if errors.Is(err, personalcache.ErrCacheInUse) {
			return installedEnvironmentInspection{State: "busy", Detail: "The package cache is being written and cannot be inspected yet"}
		}
		if err != nil || !exists {
			state, detail := "missing", "No cache exists for the current project dependency digest"
			if err != nil {
				state, detail = "error", "The project dependency digest could not be resolved"
			}
			return installedEnvironmentInspection{State: state, Detail: detail}
		}
		defer reader.Release()
		var items []model.ProjectEnvironmentPackage
		var at int64
		var exact bool
		switch language {
		case "python":
			items, at, exact = inspectPythonInstalled(filepath.Join(reader.HostRoot, "python"))
		case "node":
			items, at, _ = inspectNodeInstalled(filepath.Join(reader.HostRoot, "node_modules"))
			// package.json proves a package identity, not that every entry point and
			// payload file survived an interrupted install. Keep Node observational
			// until it has a committed structural inventory like Python.
			exact = false
		case "go":
			items, at = inspectGoInstalled(filepath.Join(reader.HostRoot, "go", "pkg", "mod"))
		case "rust":
			items, at = inspectRustInstalled(filepath.Join(reader.HostRoot, "cargo", "registry", "src"))
		case "java":
			items, at = inspectMavenInstalled(filepath.Join(reader.HostRoot, "maven"))
		}
		stable := reader.Stable()
		if !stable {
			exact = false
		}
		for index := range items {
			items[index].Scope = "project-lock"
			items[index].Source = "project-lock-" + language
			items[index].Trust = "observed"
			if exact {
				items[index].Trust = "exact"
			}
		}
		if !stable {
			return installedEnvironmentInspection{
				Packages: items, CheckedAt: at, State: "incomplete",
				Detail: "The package cache changed while it was being inspected",
			}
		}
		state := "observed"
		if exact {
			state = "ready"
		}
		return installedEnvironmentInspection{Packages: items, Exact: exact, CheckedAt: at, State: state}
	}
	return installedEnvironmentInspection{State: "unavailable", Detail: "The project cache service is unavailable"}
}

func (h *HTTPHandler) inspectProjectDependencyCache(r *http.Request, req *model.Request, resolved environmentResolved, runtime model.ProjectEnvironmentRuntime, language string, snapshots ...*environmentDependencySnapshot) model.ProjectEnvironmentDependencyCache {
	if resolved.workspace.Kind != "personal" || runtime.ID == "" || runtime.ID == "local" {
		return model.ProjectEnvironmentDependencyCache{Scope: "none", Status: "unavailable"}
	}
	if h.PersonalCache == nil {
		return model.ProjectEnvironmentDependencyCache{Scope: "project-lock", Status: "unavailable"}
	}
	var entry personalcache.Entry
	var exists bool
	var err error
	snapshot := environmentDependencySnapshotArg(snapshots)
	if snapshot != nil && snapshot.managed {
		entry, exists, err = snapshot.entry, snapshot.exists, snapshot.err
	} else {
		entry, exists, err = h.PersonalCache.Lookup(h.environmentCacheRequest(r, req, resolved, runtime, language))
	}
	if err != nil {
		return model.ProjectEnvironmentDependencyCache{Scope: "project-lock", Status: "error"}
	}
	result := model.ProjectEnvironmentDependencyCache{
		Scope: "project-lock", CacheID: entry.ID, Digest: entry.Digest, Generation: entry.Generation,
		Source: entry.DigestSource, Status: "miss",
	}
	if exists {
		result.Status = "hit"
		result.SizeBytes = entry.SizeBytes
		result.LastUsedAt = entry.LastUsed.UTC().UnixMilli()
	}
	return result
}

func environmentRuntimePathPart(runtimeID string) string {
	var builder strings.Builder
	for _, char := range strings.ToLower(strings.TrimSpace(runtimeID)) {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '.' || char == '-' || char == '_' {
			builder.WriteRune(char)
		} else {
			builder.WriteByte('-')
		}
	}
	return strings.Trim(builder.String(), "-")
}

func inspectPythonInstalled(root string) ([]model.ProjectEnvironmentPackage, int64, bool) {
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, 0, false
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, 0, false
	}
	items := make([]model.ProjectEnvironmentPackage, 0)
	latest := info.ModTime().UTC().UnixMilli()
	for _, entry := range entries {
		if !strings.HasSuffix(strings.ToLower(entry.Name()), ".dist-info") {
			continue
		}
		directory := filepath.Join(root, entry.Name())
		directoryInfo, statErr := os.Lstat(directory)
		if statErr != nil || !directoryInfo.IsDir() || directoryInfo.Mode()&os.ModeSymlink != 0 {
			return items, latest, false
		}
		metadata := filepath.Join(root, entry.Name(), "METADATA")
		metaInfo, statErr := os.Lstat(metadata)
		if statErr != nil || !metaInfo.Mode().IsRegular() || metaInfo.Mode()&os.ModeSymlink != 0 || metaInfo.Size() > 1<<20 {
			return items, latest, false
		}
		data, readErr := os.ReadFile(metadata)
		if readErr != nil || int64(len(data)) != metaInfo.Size() {
			return items, latest, false
		}
		name, version := metadataField(data, "Name"), metadataField(data, "Version")
		if name == "" || version == "" {
			return items, latest, false
		}
		if metaInfo.ModTime().UTC().UnixMilli() > latest {
			latest = metaInfo.ModTime().UTC().UnixMilli()
		}
		items = append(items, model.ProjectEnvironmentPackage{Name: normalizePythonPackageName(name), Version: version, Scope: "runtime", Source: "runtime-scoped-pip", Trust: "exact"})
	}
	items = dedupeEnvironmentPackages(items)
	return items, latest, true
}

func metadataField(data []byte, field string) string {
	prefix := strings.ToLower(field) + ":"
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(strings.ToLower(line), prefix) {
			return strings.TrimSpace(line[len(prefix):])
		}
	}
	return ""
}

func inspectNodeInstalled(root string) ([]model.ProjectEnvironmentPackage, int64, bool) {
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, 0, false
	}
	items := make([]model.ProjectEnvironmentPackage, 0)
	latest := info.ModTime().UTC().UnixMilli()
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, 0, false
	}
	complete := true
	readPackage := func(directory, publicName string) {
		path := filepath.Join(directory, "package.json")
		packageInfo, statErr := os.Lstat(path)
		if statErr != nil || !packageInfo.Mode().IsRegular() || packageInfo.Mode()&os.ModeSymlink != 0 || packageInfo.Size() > 1<<20 {
			complete = false
			return
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil || int64(len(data)) != packageInfo.Size() {
			complete = false
			return
		}
		var value struct{ Name, Version string }
		if json.Unmarshal(data, &value) != nil || value.Version == "" {
			complete = false
			return
		}
		if value.Name == "" {
			value.Name = publicName
		}
		items = append(items, model.ProjectEnvironmentPackage{Name: normalizePackageName(value.Name), Version: value.Version, Scope: "runtime", Source: "workspace-snapshot", Trust: "exact"})
		if packageInfo.ModTime().UTC().UnixMilli() > latest {
			latest = packageInfo.ModTime().UTC().UnixMilli()
		}
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		entryInfo, statErr := os.Lstat(filepath.Join(root, entry.Name()))
		if statErr != nil || !entryInfo.IsDir() || entryInfo.Mode()&os.ModeSymlink != 0 {
			complete = false
			continue
		}
		if strings.HasPrefix(entry.Name(), "@") {
			scoped, readErr := os.ReadDir(filepath.Join(root, entry.Name()))
			if readErr != nil {
				complete = false
				continue
			}
			for _, child := range scoped {
				if strings.HasPrefix(child.Name(), ".") {
					continue
				}
				childInfo, childErr := os.Lstat(filepath.Join(root, entry.Name(), child.Name()))
				if childErr != nil || !childInfo.IsDir() || childInfo.Mode()&os.ModeSymlink != 0 {
					complete = false
					continue
				}
				readPackage(filepath.Join(root, entry.Name(), child.Name()), entry.Name()+"/"+child.Name())
			}
			continue
		}
		readPackage(filepath.Join(root, entry.Name()), entry.Name())
	}
	items = dedupeEnvironmentPackages(items)
	return items, latest, complete
}

func inspectGoInstalled(root string) ([]model.ProjectEnvironmentPackage, int64) {
	items := make([]model.ProjectEnvironmentPackage, 0)
	latest := int64(0)
	visited := 0
	_ = filepath.WalkDir(root, func(current string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		visited++
		if visited > maxEnvironmentFiles {
			return fs.SkipAll
		}
		if !entry.IsDir() || current == root {
			return nil
		}
		base := entry.Name()
		if index := strings.LastIndex(base, "@"); index > 0 {
			name, version := base[:index], base[index+1:]
			rel, _ := filepath.Rel(root, current)
			parent := filepath.ToSlash(filepath.Dir(rel))
			if parent != "." {
				name = parent + "/" + name
			}
			items = append(items, model.ProjectEnvironmentPackage{Name: normalizePackageName(name), Version: version, Source: "go-module-cache", Trust: "observed"})
			if info, statErr := entry.Info(); statErr == nil && info.ModTime().UTC().UnixMilli() > latest {
				latest = info.ModTime().UTC().UnixMilli()
			}
			return filepath.SkipDir
		}
		return nil
	})
	return dedupeEnvironmentPackages(items), latest
}

func inspectRustInstalled(root string) ([]model.ProjectEnvironmentPackage, int64) {
	items := make([]model.ProjectEnvironmentPackage, 0)
	latest := int64(0)
	registries, _ := os.ReadDir(root)
	for _, registry := range registries {
		if !registry.IsDir() {
			continue
		}
		crates, _ := os.ReadDir(filepath.Join(root, registry.Name()))
		for _, crate := range crates {
			if !crate.IsDir() {
				continue
			}
			name, version := splitNameVersion(crate.Name())
			if name != "" && version != "" {
				items = append(items, model.ProjectEnvironmentPackage{Name: normalizePackageName(name), Version: version, Source: "cargo-registry", Trust: "observed"})
			}
			if info, err := crate.Info(); err == nil && info.ModTime().UTC().UnixMilli() > latest {
				latest = info.ModTime().UTC().UnixMilli()
			}
		}
	}
	return dedupeEnvironmentPackages(items), latest
}

func inspectMavenInstalled(root string) ([]model.ProjectEnvironmentPackage, int64) {
	items := make([]model.ProjectEnvironmentPackage, 0)
	latest := int64(0)
	visited := 0
	_ = filepath.WalkDir(root, func(current string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		visited++
		if visited > maxEnvironmentFiles {
			return fs.SkipAll
		}
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".pom") {
			return nil
		}
		rel, _ := filepath.Rel(root, current)
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if len(parts) >= 3 {
			version := parts[len(parts)-2]
			artifact := parts[len(parts)-3]
			group := strings.Join(parts[:len(parts)-3], ".")
			items = append(items, model.ProjectEnvironmentPackage{Name: normalizePackageName(group + ":" + artifact), Version: version, Source: "maven-repository", Trust: "observed"})
		}
		if info, statErr := entry.Info(); statErr == nil && info.ModTime().UTC().UnixMilli() > latest {
			latest = info.ModTime().UTC().UnixMilli()
		}
		return nil
	})
	return dedupeEnvironmentPackages(items), latest
}

func splitNameVersion(value string) (string, string) {
	for index := len(value) - 1; index > 0; index-- {
		if value[index] != '-' || index+1 >= len(value) || value[index+1] < '0' || value[index+1] > '9' {
			continue
		}
		return value[:index], value[index+1:]
	}
	return value, ""
}

var (
	pythonPublicVersionPattern = regexp.MustCompile(`(?i)^v?(?:([0-9]+)!)?([0-9]+(?:\.[0-9]+)*)(?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?([0-9]+)?)?(?:(?:-([0-9]+))|(?:[-_.]?(post|rev|r)[-_.]?([0-9]+)?))?(?:[-_.]?(dev)[-_.]?([0-9]+)?)?$`)
	pythonLocalVersionPattern  = regexp.MustCompile(`(?i)^[a-z0-9]+(?:[-_.][a-z0-9]+)*$`)
)

type pythonVersion struct {
	epoch            uint64
	release          []uint64
	preKind          uint8
	preNumber        uint64
	postNumber       uint64
	devNumber        uint64
	hasPre, hasPost  bool
	hasDev, hasLocal bool
	local            []pythonLocalPart
}

type pythonLocalPart struct {
	number    uint64
	text      string
	isNumeric bool
}

type pythonVersionSpecifier struct {
	operator string
	version  pythonVersion
}

type pythonVersionConstraint struct {
	specifiers      []pythonVersionSpecifier
	allowPrerelease bool
}

func parsePythonVersion(value string) (pythonVersion, error) {
	var parsed pythonVersion
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return parsed, fmt.Errorf("version is empty")
	}
	public := value
	if strings.Count(value, "+") > 1 {
		return parsed, fmt.Errorf("version contains more than one local separator")
	}
	if index := strings.IndexByte(value, '+'); index >= 0 {
		public = value[:index]
		local := value[index+1:]
		if !pythonLocalVersionPattern.MatchString(local) {
			return parsed, fmt.Errorf("local version %q is malformed", local)
		}
		parsed.hasLocal = true
		for _, part := range strings.FieldsFunc(local, func(char rune) bool { return char == '.' || char == '-' || char == '_' }) {
			numeric := true
			for _, char := range part {
				if char < '0' || char > '9' {
					numeric = false
					break
				}
			}
			if numeric {
				number, err := strconv.ParseUint(part, 10, 64)
				if err != nil {
					return pythonVersion{}, fmt.Errorf("local numeric component is too large")
				}
				parsed.local = append(parsed.local, pythonLocalPart{number: number, isNumeric: true})
				continue
			}
			parsed.local = append(parsed.local, pythonLocalPart{text: part})
		}
	}

	matches := pythonPublicVersionPattern.FindStringSubmatch(public)
	if matches == nil {
		return pythonVersion{}, fmt.Errorf("version %q is outside the supported PEP 440 syntax", value)
	}
	parseNumber := func(raw, field string) (uint64, error) {
		if raw == "" {
			return 0, nil
		}
		number, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("%s is too large", field)
		}
		return number, nil
	}
	var err error
	if parsed.epoch, err = parseNumber(matches[1], "epoch"); err != nil {
		return pythonVersion{}, err
	}
	for _, raw := range strings.Split(matches[2], ".") {
		number, numberErr := parseNumber(raw, "release component")
		if numberErr != nil {
			return pythonVersion{}, numberErr
		}
		parsed.release = append(parsed.release, number)
	}
	if matches[3] != "" {
		parsed.hasPre = true
		switch matches[3] {
		case "a", "alpha":
			parsed.preKind = 0
		case "b", "beta":
			parsed.preKind = 1
		default:
			parsed.preKind = 2
		}
		if parsed.preNumber, err = parseNumber(matches[4], "prerelease number"); err != nil {
			return pythonVersion{}, err
		}
	}
	postNumber := matches[5]
	if postNumber == "" && matches[6] != "" {
		postNumber = matches[7]
	}
	if matches[5] != "" || matches[6] != "" {
		parsed.hasPost = true
		if parsed.postNumber, err = parseNumber(postNumber, "post-release number"); err != nil {
			return pythonVersion{}, err
		}
	}
	if matches[8] != "" {
		parsed.hasDev = true
		if parsed.devNumber, err = parseNumber(matches[9], "development-release number"); err != nil {
			return pythonVersion{}, err
		}
	}
	return parsed, nil
}

func parsePythonVersionConstraint(value string) (pythonVersionConstraint, error) {
	var parsed pythonVersionConstraint
	value = strings.TrimSpace(value)
	if value == "" {
		return parsed, nil
	}
	for _, raw := range strings.Split(value, ",") {
		part := strings.TrimSpace(raw)
		if part == "" {
			return pythonVersionConstraint{}, fmt.Errorf("constraint contains an empty condition")
		}
		operator := ""
		for _, candidate := range []string{"~=", "==", "!=", ">=", "<=", ">", "<"} {
			if strings.HasPrefix(part, candidate) {
				operator = candidate
				break
			}
		}
		if operator == "" {
			return pythonVersionConstraint{}, fmt.Errorf("condition %q uses an unsupported operator", part)
		}
		version, err := parsePythonVersion(strings.TrimSpace(strings.TrimPrefix(part, operator)))
		if err != nil {
			return pythonVersionConstraint{}, err
		}
		if operator == "~=" && len(version.release) < 2 {
			return pythonVersionConstraint{}, fmt.Errorf("compatible-release condition %q needs at least two release components", part)
		}
		if operator == "~=" && version.release[len(version.release)-2] == ^uint64(0) {
			return pythonVersionConstraint{}, fmt.Errorf("compatible-release condition %q has no representable upper bound", part)
		}
		if version.hasLocal && operator != "==" && operator != "!=" {
			return pythonVersionConstraint{}, fmt.Errorf("local versions are only supported with == and !=")
		}
		parsed.allowPrerelease = parsed.allowPrerelease || version.hasPre
		parsed.specifiers = append(parsed.specifiers, pythonVersionSpecifier{operator: operator, version: version})
	}
	return parsed, nil
}

func comparePythonVersions(left, right pythonVersion, includeLocal bool) int {
	compareNumber := func(a, b uint64) int {
		if a < b {
			return -1
		}
		if a > b {
			return 1
		}
		return 0
	}
	if result := compareNumber(left.epoch, right.epoch); result != 0 {
		return result
	}
	length := len(left.release)
	if len(right.release) > length {
		length = len(right.release)
	}
	for index := 0; index < length; index++ {
		var leftPart, rightPart uint64
		if index < len(left.release) {
			leftPart = left.release[index]
		}
		if index < len(right.release) {
			rightPart = right.release[index]
		}
		if result := compareNumber(leftPart, rightPart); result != 0 {
			return result
		}
	}
	preCategory := func(version pythonVersion) uint8 {
		if !version.hasPre && version.hasDev && !version.hasPost {
			return 0
		}
		if version.hasPre {
			return 1
		}
		return 2
	}
	leftPre, rightPre := preCategory(left), preCategory(right)
	if leftPre != rightPre {
		if leftPre < rightPre {
			return -1
		}
		return 1
	}
	if left.hasPre && right.hasPre {
		if left.preKind != right.preKind {
			if left.preKind < right.preKind {
				return -1
			}
			return 1
		}
		if result := compareNumber(left.preNumber, right.preNumber); result != 0 {
			return result
		}
	}
	if left.hasPost != right.hasPost {
		if !left.hasPost {
			return -1
		}
		return 1
	}
	if left.hasPost {
		if result := compareNumber(left.postNumber, right.postNumber); result != 0 {
			return result
		}
	}
	if left.hasDev != right.hasDev {
		if left.hasDev {
			return -1
		}
		return 1
	}
	if left.hasDev {
		if result := compareNumber(left.devNumber, right.devNumber); result != 0 {
			return result
		}
	}
	if !includeLocal {
		return 0
	}
	if left.hasLocal != right.hasLocal {
		if !left.hasLocal {
			return -1
		}
		return 1
	}
	for index := 0; index < len(left.local) && index < len(right.local); index++ {
		leftPart, rightPart := left.local[index], right.local[index]
		if leftPart.isNumeric != rightPart.isNumeric {
			if !leftPart.isNumeric {
				return -1
			}
			return 1
		}
		if leftPart.isNumeric {
			if result := compareNumber(leftPart.number, rightPart.number); result != 0 {
				return result
			}
		} else if leftPart.text != rightPart.text {
			if leftPart.text < rightPart.text {
				return -1
			}
			return 1
		}
	}
	if len(left.local) < len(right.local) {
		return -1
	}
	if len(left.local) > len(right.local) {
		return 1
	}
	return 0
}

func pythonVersionSatisfies(installed pythonVersion, constraint pythonVersionConstraint) bool {
	if installed.hasPre && !constraint.allowPrerelease {
		return false
	}
	for _, specifier := range constraint.specifiers {
		includeLocal := specifier.version.hasLocal && (specifier.operator == "==" || specifier.operator == "!=")
		comparison := comparePythonVersions(installed, specifier.version, includeLocal)
		matched := false
		switch specifier.operator {
		case "==":
			matched = comparison == 0
		case "!=":
			matched = comparison != 0
		case ">=":
			matched = comparison >= 0
		case "<=":
			matched = comparison <= 0
		case ">":
			matched = comparison > 0
		case "<":
			matched = comparison < 0
		case "~=":
			upper := pythonVersion{epoch: specifier.version.epoch, release: append([]uint64(nil), specifier.version.release[:len(specifier.version.release)-1]...)}
			last := len(upper.release) - 1
			if upper.release[last] == ^uint64(0) {
				return false
			}
			upper.release[last]++
			matched = comparison >= 0 && comparePythonVersions(installed, upper, false) < 0
		}
		if !matched {
			return false
		}
	}
	return true
}

func classifyEnvironmentPackages(declared, installed []model.ProjectEnvironmentPackage, language string, trusted bool) model.ProjectEnvironmentPackages {
	result := model.ProjectEnvironmentPackages{Declared: nonNilEnvironmentPackages(declared), Installed: nonNilEnvironmentPackages(installed), Missing: []model.ProjectEnvironmentPackage{}, Unknown: []model.ProjectEnvironmentPackage{}}
	python := canonicalEnvironmentLanguage(language) == "python"
	node := canonicalEnvironmentLanguage(language) == "node"
	installedByName := map[string][]model.ProjectEnvironmentPackage{}
	for _, item := range installed {
		name := normalizePackageName(item.Name)
		if python {
			name = normalizePythonPackageName(item.Name)
		}
		installedByName[name] = append(installedByName[name], item)
	}
	for _, item := range declared {
		name := normalizePackageName(item.Name)
		if python {
			name = normalizePythonPackageName(item.Name)
		}
		installedItems := installedByName[name]
		if item.Trust == "source-ambiguous" {
			result.Unknown = append(result.Unknown, item)
			continue
		}
		if !trusted {
			if len(installedItems) > 0 {
				continue
			}
			item.Reason = "Installed state is not trustworthy for this runtime and package manager"
			result.Unknown = append(result.Unknown, item)
			continue
		}

		var constraint pythonVersionConstraint
		if python && strings.TrimSpace(item.Constraint) != "" {
			parsed, err := parsePythonVersionConstraint(item.Constraint)
			if err != nil {
				item.Reason = fmt.Sprintf("Declared Python version constraint %q cannot be verified: %s", item.Constraint, err)
				result.Unknown = append(result.Unknown, item)
				continue
			}
			constraint = parsed
		}
		if len(installedItems) == 0 {
			item.Reason = "Declared dependency was not found in the selected runtime scope"
			result.Missing = append(result.Missing, item)
			continue
		}
		if node && strings.TrimSpace(item.Constraint) != "" {
			installedVersions := make([]string, 0, len(installedItems))
			unverifiable := false
			matched := false
			for _, installedItem := range installedItems {
				installedVersions = append(installedVersions, strings.TrimSpace(installedItem.Version))
				satisfies, understood := packagecatalog.NPMVersionSatisfies(installedItem.Version, item.Constraint)
				if !understood {
					unverifiable = true
					continue
				}
				if satisfies {
					matched = true
					break
				}
			}
			if matched {
				continue
			}
			if unverifiable {
				item.Reason = fmt.Sprintf("Exact Node inventory cannot verify installed version %q against constraint %q", strings.Join(installedVersions, ", "), item.Constraint)
				result.Unknown = append(result.Unknown, item)
				continue
			}
			item.Reason = fmt.Sprintf("Installed Node version %q does not satisfy declared constraint %q", strings.Join(installedVersions, ", "), item.Constraint)
			result.Missing = append(result.Missing, item)
			continue
		}
		if !python || len(constraint.specifiers) == 0 {
			continue
		}

		invalidVersions := make([]string, 0)
		installedVersions := make([]string, 0, len(installedItems))
		matched := false
		for _, installedItem := range installedItems {
			installedVersions = append(installedVersions, strings.TrimSpace(installedItem.Version))
			version, err := parsePythonVersion(installedItem.Version)
			if err != nil {
				invalidVersions = append(invalidVersions, strings.TrimSpace(installedItem.Version))
				continue
			}
			if pythonVersionSatisfies(version, constraint) {
				matched = true
				break
			}
		}
		if matched {
			continue
		}
		if len(invalidVersions) > 0 {
			item.Reason = fmt.Sprintf("Exact Python inventory has an unverifiable installed version %q for constraint %q", strings.Join(invalidVersions, ", "), item.Constraint)
			result.Unknown = append(result.Unknown, item)
			continue
		}
		item.Reason = fmt.Sprintf("Installed Python version %q does not satisfy declared constraint %q", strings.Join(installedVersions, ", "), item.Constraint)
		result.Missing = append(result.Missing, item)
	}
	return result
}

func nonNilEnvironmentPackages(items []model.ProjectEnvironmentPackage) []model.ProjectEnvironmentPackage {
	if items == nil {
		return []model.ProjectEnvironmentPackage{}
	}
	return items
}

type environmentDependencyStatus struct {
	Status, Revision, Source, RuntimeID, Detail string
}

func personalProjectDependencyViewFromEnvironmentSnapshot(snapshot *environmentDependencySnapshot, language string) personalProjectDependencyView {
	if snapshot == nil || !snapshot.managed || snapshot.reader == nil || !snapshot.exists {
		return personalProjectDependencyView{}
	}
	generation := "project-lock:" + snapshot.entry.Digest
	if snapshot.reader.Generation != "" {
		generation += ":" + snapshot.reader.Generation
	}
	if language == "python" {
		root := filepath.Join(snapshot.reader.HostRoot, "python")
		if !realDependencyDirectory(root) {
			return personalProjectDependencyView{}
		}
		return personalProjectDependencyView{
			Root: snapshot.reader.HostRoot, RevisionRoot: snapshot.entry.HostPath, Generation: generation,
			Extra: map[string][]string{lsp.DependencyRolePythonPackages: {root}},
		}
	}
	extra := personalProjectDependencyPaths(snapshot.reader.HostRoot, language)
	if len(extra) == 0 {
		return personalProjectDependencyView{}
	}
	return personalProjectDependencyView{Root: snapshot.reader.HostRoot, RevisionRoot: snapshot.entry.HostPath, Generation: generation, Extra: extra}
}

func (h *HTTPHandler) resolveEnvironmentDependencyStatus(r *http.Request, req *model.Request, resolved environmentResolved, runtime model.ProjectEnvironmentRuntime, language string, snapshots ...*environmentDependencySnapshot) (environmentDependencyStatus, int64) {
	if h.DependencyViews == nil {
		return environmentDependencyStatus{Status: "unavailable", RuntimeID: runtime.ID, Detail: "The LSP dependency registry is not configured"}, 0
	}
	if language == "" {
		return environmentDependencyStatus{Status: "unavailable", RuntimeID: runtime.ID, Detail: "The LSP dependency view cannot be selected until the project language is known"}, 0
	}
	if runtime.ID == "" || runtime.ID == "local" {
		return environmentDependencyStatus{Status: "unavailable", RuntimeID: runtime.ID, Detail: "The LSP dependency view cannot verify a local runtime"}, 0
	}
	userID := auth.UserIDFromContext(r.Context())
	ownerKind, ownerID := "user", userID
	paths := lsp.AnalysisDependencyPaths{WorkspaceRoot: resolved.root}
	projectScoped := resolved.workspace.Kind == "personal" && h.PersonalCache != nil && projectLockDependencyLanguage(language)
	if resolved.workspace.Kind == "team" {
		// The existing team cache lease prepares directories. A status read must
		// not create cache state, so report unknown until buildcache exposes a
		// read-only resolver.
		return environmentDependencyStatus{Status: "unavailable", RuntimeID: runtime.ID, Detail: "The team LSP dependency view is unavailable until a build publishes a read-only dependency snapshot"}, 0
	}
	dependencyGeneration := ""
	if projectScoped {
		var project personalProjectDependencyView
		snapshot := environmentDependencySnapshotArg(snapshots)
		if snapshot != nil && snapshot.managed {
			project = personalProjectDependencyViewFromEnvironmentSnapshot(snapshot, language)
		} else {
			project = acquirePersonalProjectDependencyView(h.PersonalCache, h.environmentCacheRequest(r, req, resolved, runtime, language))
			if project.Release != nil {
				defer project.Release()
			}
		}
		if project.Root != "" {
			paths.Extra = project.Extra
			paths.AllowedRoots = appendExistingDependencyRoot(paths.AllowedRoots, project.Root)
			dependencyGeneration = project.Generation
			if project.Generation != "" && project.RevisionRoot != "" {
				paths.ExtraRevision = &lsp.AnalysisDependencyExtraRevision{HostRoot: project.Root, IdentityRoot: project.RevisionRoot}
			}
		}
	}
	paths.AllowedRoots = appendExistingDependencyRoot(paths.AllowedRoots, resolved.root)
	view, err := h.DependencyViews.Resolve(lsp.AnalysisDependencyRequest{
		OwnerKind: ownerKind, OwnerID: ownerID, UserID: userID, WorkspaceID: resolved.workspace.ID,
		RuntimeID: runtime.ID, LanguageID: language, Generation: dependencyGeneration, Paths: paths,
	})
	if err != nil {
		return environmentDependencyStatus{Status: "unavailable", RuntimeID: runtime.ID, Detail: fmt.Sprintf("The LSP dependency view for runtime %s could not be resolved", runtime.ID)}, 0
	}
	status := view.PublicStatus(runtime.ID != "local", ownerKind)
	indexedAt := int64(0)
	if h.LSP != nil {
		info := h.LSP.CacheInfo(ownerKind, ownerID)
		for _, namespace := range info.Namespaces {
			matches := namespace.RuntimeID == runtime.ID && canonicalEnvironmentLanguage(namespace.LanguageID) == language
			if resolved.workspace.Kind == "team" {
				matches = matches && namespace.ProjectID == resolved.workspace.ProjectID && namespace.Branch == resolved.workspace.Branch
			} else {
				matches = matches && namespace.FolderKey == resolved.workspace.Key
			}
			if matches && namespace.LastUsed.UTC().UnixMilli() > indexedAt {
				indexedAt = namespace.LastUsed.UTC().UnixMilli()
			}
		}
	}
	detail := fmt.Sprintf("The LSP dependency view is %s from %s for runtime %s", status.Status, status.Source, status.RuntimeID)
	switch status.Status {
	case "empty":
		detail += " and contains no mounted dependency sources"
	case "mixed":
		detail += " and includes legacy dependency sources"
	case "ready":
		detail += " with validated dependency sources"
	}
	if status.Detail != "" {
		detail += ": " + status.Detail
	}
	return environmentDependencyStatus{Status: status.Status, Revision: status.Revision, Source: status.Source, RuntimeID: status.RuntimeID, Detail: detail}, indexedAt
}

func (h *HTTPHandler) lastProjectCompile(ctx context.Context, workspace model.ProjectEnvironmentWorkspace, runtimeID string) int64 {
	if h.RunHistory == nil {
		return 0
	}
	userID := auth.UserIDFromContext(ctx)
	records, err := h.RunHistory.ListByUser(userID, 200)
	if err != nil {
		return 0
	}
	for _, record := range records {
		if workspace.Kind != "personal" || record.FolderName != workspace.Name {
			continue
		}
		if runtimeID != "" && runtimeID != "local" && record.Runtime != runtimeID {
			continue
		}
		return record.CreatedAt.UTC().UnixMilli()
	}
	return 0
}

func (h *HTTPHandler) projectEnvironmentCapabilities(environment *model.ProjectEnvironment, r *http.Request) model.ProjectEnvironmentActions {
	refresh := model.ProjectEnvironmentCapability{Supported: h.LSP != nil && environment.Language.ID != "", Reason: "Remote LSP is not configured or the project language is unknown"}
	if refresh.Supported {
		refresh.Reason = ""
	}
	clear := model.ProjectEnvironmentCapability{Supported: h.LSP != nil, Scope: "project", RequiresConfirmation: true, Reason: "Remote LSP cache is not configured"}
	if environment.Workspace.Kind == "personal" {
		clear.Scope = "workspace"
	}
	if clear.Supported {
		clear.Reason = ""
	}
	repairPlan := buildProjectEnvironmentPlan(environment, "", "repair")
	rebuildPlan := buildProjectEnvironmentPlan(environment, "", "rebuild")
	repair := model.ProjectEnvironmentCapability{Supported: repairPlan.Supported, RequiresConfirmation: true, Reason: repairPlan.Reason}
	rebuild := model.ProjectEnvironmentCapability{Supported: rebuildPlan.Supported, RequiresConfirmation: true, Reason: rebuildPlan.Reason}
	return model.ProjectEnvironmentActions{RefreshIndex: refresh, ClearCache: clear, Repair: repair, Rebuild: rebuild}
}

func environmentRevision(environment *model.ProjectEnvironment, dependencyRevision string) string {
	copyValue := *environment
	copyValue.Revision = ""
	copyValue.CheckedAt = 0
	// Observation timestamps are UI metadata, not package-plan inputs. Reads,
	// indexing, and compile-history updates must not invalidate the same plan.
	copyValue.Activity = model.ProjectEnvironmentActivity{}
	copyValue.DependencyCache.LastUsedAt = 0
	copyValue.DependencyCache.InventoryCheckedAt = 0
	data, _ := json.Marshal(copyValue)
	hash := sha256.Sum256(append(data, dependencyRevision...))
	return hex.EncodeToString(hash[:16])
}

func buildProjectEnvironmentPlan(environment *model.ProjectEnvironment, root, requestedAction string) model.ProjectEnvironmentRepairPlan {
	action := strings.ToLower(strings.TrimSpace(requestedAction))
	if action == "" {
		action = "repair"
	}
	plan := model.ProjectEnvironmentRepairPlan{Schema: projectEnvironmentPlanSchema, Revision: environment.Revision, Action: action, RequiresConfirmation: true, Steps: []model.ProjectEnvironmentRepairStep{}}
	if action != "repair" && action != "rebuild" {
		plan.Reason = "Only repair and rebuild can be planned"
		return plan
	}
	if environment.Runtime.ID == "" || environment.Runtime.ID == "local" {
		plan.Reason = "Select a managed runtime before applying environment changes"
		return plan
	}
	if environment.Language.ID != "python" || environment.Runtime.Language != "python" {
		plan.Reason = "Automatic apply is currently available only for Python managed runtimes"
		return plan
	}
	if environment.Workspace.Kind != "personal" {
		plan.Reason = "Automatic environment changes are not yet available for team dependency caches"
		return plan
	}
	if action == "repair" && environment.Consistency.DependencyRuntime.Status == "aligned" && len(environment.Packages.Missing) == 0 && len(environment.Packages.Unknown) == 0 {
		plan.Reason = "No repairable dependency issues were found"
		return plan
	}
	manifest := ""
	for _, candidate := range environment.Manifests {
		if candidate.Language == "python" && candidate.Kind == "requirements" && candidate.Parsed {
			manifest = candidate.Path
			break
		}
	}
	if manifest == "" {
		plan.Reason = "A parsed requirements file is required for controlled Python repair"
		return plan
	}
	for _, missing := range environment.Packages.Missing {
		if !strings.Contains(missing.Source, manifest) {
			plan.Reason = "The available requirements file does not cover every missing dependency"
			return plan
		}
	}
	if root != "" {
		full, err := safePath(root, manifest)
		if err != nil {
			plan.Reason = "Dependency manifest is outside the project workspace"
			return plan
		}
		if info, err := os.Stat(full); err != nil || !info.Mode().IsRegular() || info.Size() > maxEnvironmentManifestBytes {
			plan.Reason = "Dependency manifest is unavailable or too large"
			return plan
		}
	}
	plan.Supported = true
	plan.Reason = ""
	plan.Steps = append(plan.Steps, model.ProjectEnvironmentRepairStep{ID: "install-python-requirements", Kind: "install", Manager: "pip", ManifestPath: manifest, Description: "Install the declared Python dependencies into the selected runtime scope", Command: "python3 -m pip install -r " + shellQuoteEnvironmentPath(manifest)})
	if action == "rebuild" {
		plan.Steps = append([]model.ProjectEnvironmentRepairStep{{ID: "reset-python-runtime", Kind: "reset", Manager: "pip", Description: "Remove the selected runtime package scope before reinstalling"}}, plan.Steps...)
	}
	return plan
}

func shellQuoteEnvironmentPath(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func (h *HTTPHandler) applyProjectEnvironmentAction(w http.ResponseWriter, r *http.Request, req *model.Request) {
	action := strings.ToLower(strings.TrimSpace(req.EnvironmentAction))
	if action != "repair" && action != "rebuild" && action != "clearcache" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "environmentAction must be repair, rebuild, or clearCache"})
		return
	}
	environment, resolved, err := h.inspectProjectEnvironment(r, req)
	if err != nil {
		writeProjectEnvironmentError(w, err)
		return
	}
	if expected := strings.TrimSpace(req.Revision); expected != "" && expected != environment.Revision {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Project environment changed after the action was planned; refresh and try again", Data: environment})
		return
	}
	if action == "clearcache" {
		h.applyProjectEnvironmentClearCache(w, r, environment, resolved)
		return
	}
	plan := buildProjectEnvironmentPlan(environment, resolved.root, action)
	if !plan.Supported {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: plan.Reason, Data: plan})
		return
	}
	if h.EnvironmentSetup == nil || h.PersonalCache == nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{
			Success: false, Error: "Controlled environment installation requires both the executor and managed project dependency cache",
			ErrorCode: "environment_service_unavailable", Data: plan,
		})
		return
	}
	userID := auth.UserIDFromContext(r.Context())
	workspaceKey := resolved.folderKey
	// A debugger pins the exact project cache against writers. Stop it before
	// repair/rebuild so the install cannot survive in a detached container or
	// leave the namespace permanently reported as in use.
	if resolved.workspace.Kind == "personal" && h.DAP != nil {
		if err := h.DAP.StopUserWorkspace(userID, workspaceKey); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
			return
		}
	}
	if action == "rebuild" && h.LSP != nil {
		if err := h.LSP.StopUserOwner(userID, "user", userID, ""); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
			return
		}
	}
	environmentResourceLease, resourceErr := acquireHandlerRuntimeResource(
		r.Context(), h.Resources, resourcecontrol.WorkloadPackage, userID, environmentResourceScope(environment), "environment:"+workspaceKey+":"+action,
		environment.Runtime.ID, environment.Language.ID, environment.Runtime.Image, true,
	)
	if resourceErr != nil {
		writeResourcePressure(w)
		return
	}
	environmentResourceOwnedByRequest := environmentResourceLease != nil
	releaseEnvironmentResource := func() {
		releaseHandlerResource(environmentResourceLease)
	}
	defer func() {
		if environmentResourceOwnedByRequest {
			releaseEnvironmentResource()
		}
	}()
	var environmentActivityReleases []func()
	defer func() { runReleaseCallbacksReverse(environmentActivityReleases) }()
	if h.Lifecycle != nil {
		if action == "rebuild" {
			mutation, leaseErr := h.Lifecycle.BeginUserMutation(userID)
			if leaseErr != nil {
				writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error()})
				return
			}
			environmentActivityReleases = append(environmentActivityReleases, mutation.Release)
		} else {
			activity, leaseErr := h.Lifecycle.AcquireActivity(userID, workspaceKey)
			if leaseErr != nil {
				writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error()})
				return
			}
			environmentActivityReleases = append(environmentActivityReleases, activity.Release)
		}
	}
	if environment.Workspace.Kind == "team" && h.Collaboration != nil {
		activity, leaseErr := h.Collaboration.AcquireProjectActivity(userID, environment.Workspace.TeamID, environment.Workspace.ProjectID)
		if leaseErr != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error()})
			return
		}
		environmentActivityReleases = append(environmentActivityReleases, activity.Release)
	}
	if action == "rebuild" {
		if err := h.clearProjectEnvironmentDependencyScope(r, req, environment, resolved); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), Data: plan})
			return
		}
	}
	commands := make([]string, 0, len(plan.Steps))
	for _, step := range plan.Steps {
		if step.Command != "" {
			commands = append(commands, step.Command)
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	ctx, finalizeContainerCleanup := WithDeferredContainerCleanup(ctx)
	var dependencyLease *personalcache.Lease
	environmentResourcesFinalized := false
	finalizeEnvironmentResources := func(abort bool, released func()) {
		if environmentResourcesFinalized {
			return
		}
		environmentResourcesFinalized = true
		if abort && dependencyLease != nil {
			dependencyLease.Abort()
		}
		environmentResourceOwnedByRequest = false
		activityReleases := environmentActivityReleases
		environmentActivityReleases = nil
		finalizeContainerCleanup(func() {
			h.releasePersonalCacheLease(dependencyLease, personalDependencyRefreshScope(userID, resolved.folderKey, environment.Runtime.ID, environment.Language.ID))
			releaseEnvironmentResource()
			runReleaseCallbacksReverse(activityReleases)
			if released != nil {
				released()
			}
		})
	}
	defer finalizeEnvironmentResources(true, nil)
	if h.PersonalCache != nil {
		dependencyLease, err = h.PersonalCache.Prepare(ctx, h.environmentCacheRequest(r, req, resolved, environment.Runtime, environment.Language.ID))
		if err != nil {
			writeJSON(w, http.StatusInsufficientStorage, model.Response{Success: false, Error: err.Error(), Data: plan})
			return
		}
		if dependencyLease != nil {
			guard := dependencyLease.StartGuard(ctx)
			if guard != nil {
				ctx = guard.Context
			}
			ctx = personalcache.WithLease(ctx, dependencyLease)
		}
	}
	dependencyStarted := time.Now()
	stdout, stderr, exitCode, execErr := h.EnvironmentSetup(ctx, userID, environment.Runtime.ID, resolved.root, commands)
	if h.Metrics != nil {
		h.Metrics.Observe("dependency.resolve", time.Since(dependencyStarted))
	}
	if dependencyLease != nil {
		if guard := dependencyLease.StartGuard(ctx); guard != nil && guard.Err() != nil {
			execErr = guard.Err()
		}
	}
	finalizeEnvironmentResources(execErr != nil || exitCode != 0, nil)
	if execErr != nil || exitCode != 0 {
		message := "Environment setup failed"
		if execErr != nil {
			message = execErr.Error()
		}
		result := model.ProjectEnvironmentActionResult{Schema: projectEnvironmentActionSchema, Action: action, Applied: false, ExitCode: exitCode, Stdout: stdout, Stderr: stderr, Message: message}
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: message, Data: result})
		return
	}
	if dependencyLease == nil && h.LSP != nil && h.DependencyViews != nil {
		h.LSP.RefreshDependencyViews(h.DependencyViews, lsp.DependencyRefreshScope{UserID: userID, OwnerKind: "user", OwnerID: userID, FolderKey: resolved.folderKey, RuntimeID: environment.Runtime.ID, LanguageID: environment.Language.ID})
	}
	updated, _, inspectErr := h.inspectProjectEnvironment(r, req)
	if inspectErr != nil || updated == nil || len(updated.Packages.Missing) > 0 || len(updated.Packages.Unknown) > 0 || updated.Consistency.DependencyRuntime.Status != "aligned" || !projectEnvironmentInstalledTruthExact(updated) {
		message := "Environment setup completed, but verification still reports unresolved dependencies"
		if inspectErr != nil {
			message = "Environment setup completed, but verification failed: " + inspectErr.Error()
		}
		result := model.ProjectEnvironmentActionResult{Schema: projectEnvironmentActionSchema, Action: action, Applied: false, ExitCode: exitCode, Stdout: stdout, Stderr: stderr, Message: message, Environment: updated}
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: message, Data: result})
		return
	}
	result := model.ProjectEnvironmentActionResult{Schema: projectEnvironmentActionSchema, Action: action, Applied: true, ExitCode: exitCode, Stdout: stdout, Stderr: stderr, Message: "Environment setup completed", Environment: updated}
	if inspectErr != nil {
		result.Message = "Environment setup completed; refresh the environment status"
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: result})
}

func projectEnvironmentInstalledTruthExact(environment *model.ProjectEnvironment) bool {
	if environment == nil || environment.Language.ID != "python" {
		return false
	}
	for _, item := range environment.Packages.Installed {
		if item.Trust != "exact" || (item.Source != "runtime-scoped-pip" && item.Source != "project-lock-python") || (item.Scope != "runtime" && item.Scope != "project-lock") {
			return false
		}
	}
	return environment.Consistency.DependencyRuntime.Status == "aligned"
}

func (h *HTTPHandler) clearProjectEnvironmentDependencyScope(r *http.Request, req *model.Request, environment *model.ProjectEnvironment, resolved environmentResolved) error {
	if h.PersonalCache == nil {
		return fmt.Errorf("project cache service is unavailable")
	}
	cacheRequest := h.environmentCacheRequest(r, req, resolved, environment.Runtime, environment.Language.ID)
	entry, exists, err := h.PersonalCache.Lookup(cacheRequest)
	if err != nil || !exists {
		return err
	}
	if err := h.PersonalCache.Delete(cacheRequest.UserID, entry.Path); err != nil {
		return err
	}
	if h.OnPersonalCacheCleared != nil {
		h.OnPersonalCacheCleared()
	}
	return nil
}

func (h *HTTPHandler) applyProjectEnvironmentClearCache(w http.ResponseWriter, r *http.Request, environment *model.ProjectEnvironment, resolved environmentResolved) {
	if h.LSP == nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Remote LSP cache is not configured"})
		return
	}
	userID := auth.UserIDFromContext(r.Context())
	ownerKind, ownerID, scope, projectID := "user", userID, "namespace", ""
	if environment.Workspace.Kind == "team" {
		ownerKind, ownerID, scope, projectID = "team", environment.Workspace.TeamID, "project", environment.Workspace.ProjectID
		if h.Collaboration == nil {
			writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Team collaboration is not configured"})
			return
		}
		team, _, _, err := h.Collaboration.GetTeam(userID, environment.Workspace.TeamID)
		if err != nil || team.AdminUserID != userID {
			writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Only the team administrator can clear project analysis caches"})
			return
		}
		if err := h.LSP.StopUserOwner(userID, ownerKind, ownerID, projectID); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
			return
		}
	} else {
		if err := h.LSP.StopUserWorkspace(userID, resolved.folderKey); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
			return
		}
	}
	if environment.Workspace.Kind == "personal" {
		info := h.LSP.CacheInfo(ownerKind, ownerID)
		for _, namespace := range info.Namespaces {
			if namespace.FolderKey != resolved.folderKey {
				continue
			}
			if _, err := h.LSP.ClearCache(ownerKind, ownerID, scope, "", namespace.Key); err != nil {
				writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
				return
			}
		}
	} else {
		info, err := h.LSP.ClearCache(ownerKind, ownerID, scope, projectID, "")
		if err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), Data: info})
			return
		}
	}
	result := model.ProjectEnvironmentActionResult{Schema: projectEnvironmentActionSchema, Action: "clearCache", Applied: true, Message: "Analysis cache cleared"}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: result})
}
