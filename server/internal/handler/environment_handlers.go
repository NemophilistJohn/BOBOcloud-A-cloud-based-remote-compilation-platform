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
	"sort"
	"strings"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
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
		runtime = model.ProjectEnvironmentRuntime{ID: rt.RuntimeID, Language: rt.Language, Version: rt.Version, Image: rt.DockerImage, DisplayName: rt.DisplayName, Status: "ready"}
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
	installed, installedTrusted, installedAt := h.inspectInstalledEnvironmentPackages(r, resolved, runtime, language)
	packages := classifyEnvironmentPackages(declared, installed, installedTrusted)
	dependencyStatus, indexedAt := h.resolveEnvironmentDependencyStatus(r, resolved, runtime, language)
	languageRuntime := model.ProjectEnvironmentCheck{Status: "unknown", Detail: "Language or runtime is not selected"}
	if language != "" && runtime.ID == "local" {
		languageRuntime.Detail = "The local runtime toolchain cannot be verified without executing it"
	} else if language != "" && runtime.Language == language {
		languageRuntime = model.ProjectEnvironmentCheck{Status: "aligned", Detail: fmt.Sprintf("Language %s matches runtime %s", language, runtime.ID)}
	} else if language != "" && runtime.Language != "" {
		languageRuntime = model.ProjectEnvironmentCheck{Status: "mismatch", Detail: fmt.Sprintf("Language %s does not match runtime %s (%s)", language, runtime.ID, runtime.Language)}
	}
	dependencyRuntime := projectEnvironmentDependencyRuntimeCheck(runtime, language, packages, installedTrusted, resolved.workspace.Kind)
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
		Consistency: model.ProjectEnvironmentConsistency{Status: consistencyStatus, LanguageRuntime: languageRuntime, DependencyRuntime: dependencyRuntime, LSPDependencies: lspDependencies, Detail: consistencyDetail},
		Activity:    model.ProjectEnvironmentActivity{LastIndexedAt: indexedAt, LastInstalledAt: installedAt, LastCompiledAt: lastCompiled},
	}
	environment.Actions = h.projectEnvironmentCapabilities(environment, r)
	environment.Revision = environmentRevision(environment, dependencyStatus.Revision)
	return environment, resolved, nil
}

func projectEnvironmentDependencyRuntimeCheck(runtime model.ProjectEnvironmentRuntime, language string, packages model.ProjectEnvironmentPackages, trusted bool, workspaceKind string) model.ProjectEnvironmentCheck {
	if trusted {
		if len(packages.Missing) > 0 {
			return model.ProjectEnvironmentCheck{Status: "mismatch", Detail: fmt.Sprintf("The exact installed state for runtime %s is missing %d declared dependencies", runtime.ID, len(packages.Missing))}
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
		if info, statErr := entry.Info(); statErr == nil {
			modTimes = append(modTimes, info.ModTime().UTC().UnixMilli())
		}
		manifests = append(manifests, model.ProjectEnvironmentManifest{Path: rel, Kind: spec.Kind, Manager: spec.Manager, Language: spec.Language, Lockfile: spec.Lockfile, Parsed: parsed, Status: status})
		return nil
	})
	if err != nil {
		return nil, nil, nil, err
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
		return parsePyproject(data, rel), nil
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
		if strings.ContainsRune("<>=!~", char) {
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
	appendMap(value.DevDependencies, "development")
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

func parsePyproject(data []byte, source string) []model.ProjectEnvironmentPackage {
	items := make([]model.ProjectEnvironmentPackage, 0)
	section := ""
	inProjectArray := false
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.SplitN(raw, "#", 2)[0])
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.ToLower(strings.Trim(line, "[] "))
			inProjectArray = false
			continue
		}
		if section == "project" && strings.HasPrefix(line, "dependencies") {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) != 2 {
				continue
			}
			inProjectArray = strings.Contains(line, "[") && !strings.Contains(line, "]")
			line = strings.TrimSpace(parts[1])
		}
		if section == "project" && (inProjectArray || strings.HasPrefix(line, "[")) {
			for _, token := range strings.Split(strings.Trim(line, "[], "), ",") {
				token = strings.Trim(strings.TrimSpace(token), "\"'")
				name, constraint := splitPythonRequirement(token)
				if name != "" {
					items = append(items, model.ProjectEnvironmentPackage{Name: normalizePythonPackageName(name), Constraint: constraint, Scope: "runtime", Source: source})
				}
			}
			if strings.Contains(line, "]") {
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
	return items
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

func (h *HTTPHandler) inspectInstalledEnvironmentPackages(r *http.Request, resolved environmentResolved, runtime model.ProjectEnvironmentRuntime, language string) ([]model.ProjectEnvironmentPackage, bool, int64) {
	userID := auth.UserIDFromContext(r.Context())
	if resolved.workspace.Kind == "team" {
		return nil, false, 0
	}
	persist := filepath.Join(h.Config.DataDir, "users", userID, "persist")
	switch language {
	case "python":
		if runtime.ID == "local" || runtime.ID == "" {
			return nil, false, 0
		}
		root := filepath.Join(persist, "pip-packages", "runtimes", environmentRuntimePathPart(runtime.ID))
		items, at, ok := inspectPythonInstalled(root)
		return items, ok, at
	case "node":
		if runtime.ID == "local" || runtime.ID == "" {
			return nil, false, 0
		}
		inspection, err := lsp.InspectPersonalDependencies(h.Config.DataDir, userID)
		if err != nil || !inspection.Exists {
			return nil, false, 0
		}
		root := lsp.NodeDependencySnapshot(inspection.Root, resolved.workspace.ID, runtime.ID)
		items, at, ok := inspectNodeInstalled(root)
		return items, ok, at
	case "go":
		items, at := inspectGoInstalled(filepath.Join(persist, "go", "pkg", "mod"))
		return items, false, at
	case "rust":
		items, at := inspectRustInstalled(filepath.Join(persist, "cargo", "registry", "src"))
		return items, false, at
	case "java":
		items, at := inspectMavenInstalled(filepath.Join(persist, "maven"))
		return items, false, at
	default:
		return nil, false, 0
	}
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
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, 0, false
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, 0, false
	}
	items := make([]model.ProjectEnvironmentPackage, 0)
	latest := info.ModTime().UTC().UnixMilli()
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".dist-info") {
			continue
		}
		metadata := filepath.Join(root, entry.Name(), "METADATA")
		data, readErr := os.ReadFile(metadata)
		if readErr != nil || len(data) > 1<<20 {
			continue
		}
		name, version := metadataField(data, "Name"), metadataField(data, "Version")
		if name == "" || version == "" {
			continue
		}
		if metaInfo, statErr := os.Stat(metadata); statErr == nil && metaInfo.ModTime().UTC().UnixMilli() > latest {
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
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, 0, false
	}
	items := make([]model.ProjectEnvironmentPackage, 0)
	latest := info.ModTime().UTC().UnixMilli()
	entries, _ := os.ReadDir(root)
	readPackage := func(directory, publicName string) {
		data, err := os.ReadFile(filepath.Join(directory, "package.json"))
		if err != nil || len(data) > 1<<20 {
			return
		}
		var value struct{ Name, Version string }
		if json.Unmarshal(data, &value) != nil || value.Version == "" {
			return
		}
		if value.Name == "" {
			value.Name = publicName
		}
		items = append(items, model.ProjectEnvironmentPackage{Name: normalizePackageName(value.Name), Version: value.Version, Scope: "runtime", Source: "workspace-snapshot", Trust: "exact"})
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if strings.HasPrefix(entry.Name(), "@") {
			scoped, _ := os.ReadDir(filepath.Join(root, entry.Name()))
			for _, child := range scoped {
				if child.IsDir() {
					readPackage(filepath.Join(root, entry.Name(), child.Name()), entry.Name()+"/"+child.Name())
				}
			}
			continue
		}
		readPackage(filepath.Join(root, entry.Name()), entry.Name())
	}
	items = dedupeEnvironmentPackages(items)
	return items, latest, true
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

func classifyEnvironmentPackages(declared, installed []model.ProjectEnvironmentPackage, trusted bool) model.ProjectEnvironmentPackages {
	result := model.ProjectEnvironmentPackages{Declared: nonNilEnvironmentPackages(declared), Installed: nonNilEnvironmentPackages(installed), Missing: []model.ProjectEnvironmentPackage{}, Unknown: []model.ProjectEnvironmentPackage{}}
	installedNames := map[string]bool{}
	for _, item := range installed {
		installedNames[normalizePackageName(item.Name)] = true
	}
	for _, item := range declared {
		if installedNames[normalizePackageName(item.Name)] {
			continue
		}
		item.Reason = "Installed state is not trustworthy for this runtime and package manager"
		if trusted {
			item.Reason = "Declared dependency was not found in the selected runtime scope"
			result.Missing = append(result.Missing, item)
		} else {
			result.Unknown = append(result.Unknown, item)
		}
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

func (h *HTTPHandler) resolveEnvironmentDependencyStatus(r *http.Request, resolved environmentResolved, runtime model.ProjectEnvironmentRuntime, language string) (environmentDependencyStatus, int64) {
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
	if resolved.workspace.Kind == "team" {
		// The existing team cache lease prepares directories. A status read must
		// not create cache state, so report unknown until buildcache exposes a
		// read-only resolver.
		return environmentDependencyStatus{Status: "unavailable", RuntimeID: runtime.ID, Detail: "The team LSP dependency view is unavailable until a build publishes a read-only dependency snapshot"}, 0
	} else {
		userRoot := filepath.Join(h.Config.DataDir, "users", userID)
		paths.UserPersistRoot = filepath.Join(userRoot, "persist")
		paths.AllowedRoots = appendExistingDependencyRoot(paths.AllowedRoots, userRoot)
		inspection, err := lsp.InspectPersonalDependencies(h.Config.DataDir, userID)
		if err == nil && inspection.Exists {
			paths.SnapshotRoot = inspection.Root
			paths.AllowedRoots = appendExistingDependencyRoot(paths.AllowedRoots, inspection.Root)
		}
	}
	paths.AllowedRoots = appendExistingDependencyRoot(paths.AllowedRoots, resolved.root)
	view, err := h.DependencyViews.Resolve(lsp.AnalysisDependencyRequest{
		OwnerKind: ownerKind, OwnerID: ownerID, UserID: userID, WorkspaceID: resolved.workspace.ID,
		RuntimeID: runtime.ID, LanguageID: language, Paths: paths,
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
	if h.EnvironmentSetup == nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Controlled environment executor is not configured", Data: plan})
		return
	}
	userID := auth.UserIDFromContext(r.Context())
	workspaceKey := resolved.folderKey
	if action == "rebuild" && h.LSP != nil {
		if err := h.LSP.StopUserOwner(userID, "user", userID, ""); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
			return
		}
	}
	if h.Lifecycle != nil {
		if action == "rebuild" {
			mutation, leaseErr := h.Lifecycle.BeginUserMutation(userID)
			if leaseErr != nil {
				writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error()})
				return
			}
			defer mutation.Release()
		} else {
			activity, leaseErr := h.Lifecycle.AcquireActivity(userID, workspaceKey)
			if leaseErr != nil {
				writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error()})
				return
			}
			defer activity.Release()
		}
	}
	if environment.Workspace.Kind == "team" && h.Collaboration != nil {
		activity, leaseErr := h.Collaboration.AcquireProjectActivity(userID, environment.Workspace.TeamID, environment.Workspace.ProjectID)
		if leaseErr != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error()})
			return
		}
		defer activity.Release()
	}
	if action == "rebuild" {
		if err := h.clearPythonRuntimeScope(userID, environment.Runtime.ID); err != nil {
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
	stdout, stderr, exitCode, execErr := h.EnvironmentSetup(ctx, userID, environment.Runtime.ID, resolved.root, commands)
	if execErr != nil || exitCode != 0 {
		message := "Environment setup failed"
		if execErr != nil {
			message = execErr.Error()
		}
		result := model.ProjectEnvironmentActionResult{Schema: projectEnvironmentActionSchema, Action: action, Applied: false, ExitCode: exitCode, Stdout: stdout, Stderr: stderr, Message: message}
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: message, Data: result})
		return
	}
	if h.LSP != nil && h.DependencyViews != nil {
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
		if item.Trust != "exact" || item.Source != "runtime-scoped-pip" || item.Scope != "runtime" {
			return false
		}
	}
	return environment.Consistency.DependencyRuntime.Status == "aligned"
}

func (h *HTTPHandler) clearPythonRuntimeScope(userID, runtimeID string) error {
	persistRoot := filepath.Join(h.Config.DataDir, "users", userID, "persist")
	relative := filepath.Join("pip-packages", "runtimes", environmentRuntimePathPart(runtimeID))
	target, err := safePath(persistRoot, relative)
	if err != nil {
		return fmt.Errorf("invalid Python runtime scope")
	}
	if filepath.Dir(target) != filepath.Join(persistRoot, "pip-packages", "runtimes") {
		return fmt.Errorf("invalid Python runtime scope")
	}
	if info, statErr := os.Lstat(target); statErr == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Python runtime scope is not a real directory")
		}
		if err := os.RemoveAll(target); err != nil {
			return fmt.Errorf("clear Python runtime scope: %w", err)
		}
	} else if !os.IsNotExist(statErr) {
		return statErr
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
