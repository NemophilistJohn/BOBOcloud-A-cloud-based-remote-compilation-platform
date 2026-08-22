package lsp

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"bobocloud-server/internal/safefile"
)

const (
	pythonRuntimePackagesContainer = AnalysisDependenciesRoot + "/python/runtime-site-packages"
	pythonLegacyPackagesContainer  = AnalysisDependenciesRoot + "/python/legacy-site-packages"
	pythonExtraPackagesRoot        = AnalysisDependenciesRoot + "/python/extra"
	pythonAnalyzerInterpreter      = "/usr/local/bin/bobocloud-python"
	nodeModulesContainer           = DockerWorkspaceRoot + "/node_modules"
	typescriptServerContainer      = "/opt/node-lsp/node_modules/typescript/lib/tsserver.js"
	goModulesContainer             = AnalysisDependenciesRoot + "/go/pkg/mod"
	goModuleProxyContainer         = AnalysisDependenciesRoot + "/go/proxy"
	rustCargoContainer             = "/analysis-cache/cargo-home"
	rustRegistrySrcContainer       = rustCargoContainer + "/registry/src"
	rustRegistryIndexContainer     = rustCargoContainer + "/registry/index"
	rustGitCheckoutsContainer      = rustCargoContainer + "/git/checkouts"
	rustGitDBContainer             = rustCargoContainer + "/git/db"
	javaMavenSourceContainer       = AnalysisDependenciesRoot + "/java/maven-repository"
	javaMavenWritableContainer     = "/analysis-cache/maven/repository"
	javaMavenSettingsContainer     = "/analysis-cache/maven/settings.xml"
	javaGradleReadOnlyRoot         = "/analysis-cache/gradle/read-only-dependencies"
	javaGradleModulesContainer     = javaGradleReadOnlyRoot + "/modules-2"
	nativeSysrootContainer         = AnalysisDependenciesRoot + "/native/sysroot"
	nativeIncludesContainer        = AnalysisDependenciesRoot + "/native/include"
)

const localAnalysisCachePlaceholder = "{{analysisCache}}"

const (
	GradleDependencySnapshotMarker = ".bobocloud-gradle-dependency-snapshot.json"
	GradleDependencyCurrentFile    = ".current"
	gradleSnapshotMarkerMaxBytes   = 4 << 10
	gradleCurrentMarkerMaxBytes    = 64
	gradleSnapshotFormat           = "bobocloud.gradle-dependency-snapshot/v1"
)

const (
	maxNativeFallbackFlags = 8
	maxNativeFlagBytes     = 512
	maxNativeFlagsBytes    = 2048
)

func extraDependencyPaths(ctx DependencyAdapterContext, role string) []string {
	if ctx.Paths.Extra == nil {
		return nil
	}
	return append([]string(nil), ctx.Paths.Extra[role]...)
}

func existingDirectory(paths ...string) string {
	for _, candidate := range paths {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return ""
}

func existingRealDirectory(candidate string) string {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		return ""
	}
	info, err := os.Lstat(candidate)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ""
	}
	return candidate
}

func appendExistingMount(mounts []DependencyMountSpec, seen map[string]bool, role, host, container string, legacy bool) []DependencyMountSpec {
	host = existingDirectory(host)
	if host == "" {
		return mounts
	}
	key := filepath.Clean(host)
	if seen[key] {
		return mounts
	}
	seen[key] = true
	return append(mounts, DependencyMountSpec{Role: role, HostPath: host, ContainerPath: container, Legacy: legacy})
}

func runtimeVersion(runtimeID string) string {
	_, version, found := strings.Cut(strings.TrimSpace(runtimeID), ":")
	if !found {
		return ""
	}
	return strings.TrimSpace(version)
}

func runtimePathPart(runtimeID string) string {
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

func preferredCacheRoot(ctx DependencyAdapterContext, relative string) string {
	team := ""
	if ctx.OwnerKind == "team" && ctx.Paths.SharedCacheRoot != "" {
		team = filepath.Join(ctx.Paths.SharedCacheRoot, filepath.FromSlash(relative))
	}
	personal := ""
	if ctx.Paths.UserPersistRoot != "" {
		personal = filepath.Join(ctx.Paths.UserPersistRoot, filepath.FromSlash(relative))
	}
	return existingDirectory(team, personal)
}

func localFileRepository(directory string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(directory)}).String()
}

func goModuleProxyDirectory(candidate string) string {
	candidate = existingDirectory(candidate)
	if candidate == "" {
		return ""
	}
	cleaned := filepath.Clean(candidate)
	if filepath.Base(cleaned) == "download" && filepath.Base(filepath.Dir(cleaned)) == "cache" {
		return cleaned
	}
	return existingDirectory(filepath.Join(cleaned, "cache", "download"))
}

type gradleDependencySnapshotMarker struct {
	Format string `json:"format"`
	State  string `json:"state"`
}

// InitializationOptionsForAnalyzer returns server-owned options that must be
// merged into initialize.params.initializationOptions. It is intentionally
// derived rather than stored in LSP settings so it cannot leak through
// workspace/configuration or the public dependency status.
func (v AnalysisDependencyView) InitializationOptionsForAnalyzer(docker bool) map[string]any {
	if !docker || len(v.Mounts) == 0 {
		return nil
	}
	switch normalizeLanguage(v.LanguageID) {
	case "node", "javascript", "typescript":
		return map[string]any{"tsserver": map[string]any{"path": typescriptServerContainer}}
	case "java":
		return map[string]any{"settings": cloneAnyMap(v.DockerLSPSettings)}
	default:
		return nil
	}
}

func validGradleGeneration(generation string) bool {
	if len(generation) != 32 || generation != strings.ToLower(generation) {
		return false
	}
	for _, value := range generation {
		if (value < '0' || value > '9') && (value < 'a' || value > 'f') {
			return false
		}
	}
	return true
}

// GradleDependencyGenerationRoot returns the immutable directory a publisher
// must populate for one lowercase 128-bit hex revision.
func GradleDependencyGenerationRoot(base, runtimeID, generation string) (string, error) {
	base = strings.TrimSpace(base)
	runtimePart := runtimePathPart(runtimeID)
	if base == "" || !filepath.IsAbs(base) || runtimePart == "" || !validGradleGeneration(generation) {
		return "", fmt.Errorf("invalid Gradle dependency generation")
	}
	return filepath.Join(filepath.Clean(base), "gradle", runtimePart, "generations", generation), nil
}

// CompleteGradleDependencySnapshot marks one immutable, quiesced generation
// ready. It deliberately never changes the active .current pointer.
func CompleteGradleDependencySnapshot(generationRoot string) error {
	generationRoot = existingRealDirectory(generationRoot)
	if generationRoot == "" || existingRealDirectory(filepath.Join(generationRoot, "modules-2")) == "" {
		return fmt.Errorf("Gradle dependency snapshot must contain modules-2")
	}
	data, err := json.Marshal(gradleDependencySnapshotMarker{Format: gradleSnapshotFormat, State: "ready"})
	if err != nil {
		return fmt.Errorf("encode Gradle dependency snapshot marker: %w", err)
	}
	if err := safefile.WriteAtomic(generationRoot, GradleDependencySnapshotMarker, data, 0600); err != nil {
		return fmt.Errorf("complete Gradle dependency snapshot: %w", err)
	}
	return nil
}

// ActivateGradleDependencySnapshot atomically advances .current. Existing
// sessions keep their old immutable generation mounted until they stop.
func ActivateGradleDependencySnapshot(base, runtimeID, generation string) error {
	generationRoot, err := GradleDependencyGenerationRoot(base, runtimeID, generation)
	if err != nil {
		return err
	}
	if _, modules := gradleDependencySnapshot(generationRoot); modules == "" {
		return fmt.Errorf("Gradle dependency generation is not ready")
	}
	runtimeRoot := filepath.Dir(filepath.Dir(generationRoot))
	if err := safefile.WriteAtomic(runtimeRoot, GradleDependencyCurrentFile, []byte(generation+"\n"), 0600); err != nil {
		return fmt.Errorf("activate Gradle dependency snapshot: %w", err)
	}
	return nil
}

func currentGradleDependencySnapshot(base, runtimeID string) string {
	runtimeRoot := filepath.Join(base, "gradle", runtimePathPart(runtimeID))
	data, err := safefile.ReadSmallRegular(runtimeRoot, GradleDependencyCurrentFile, gradleCurrentMarkerMaxBytes)
	if err != nil {
		return ""
	}
	generation := strings.TrimSpace(string(data))
	root, err := GradleDependencyGenerationRoot(base, runtimeID, generation)
	if err != nil {
		return ""
	}
	return root
}

func gradleDependencySnapshot(candidates ...string) (string, string) {
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		root := filepath.Clean(candidate)
		if filepath.Base(root) == "modules-2" {
			root = filepath.Dir(root)
		}
		root = existingRealDirectory(root)
		if root == "" {
			continue
		}
		data, err := safefile.ReadSmallRegular(root, GradleDependencySnapshotMarker, gradleSnapshotMarkerMaxBytes)
		if err != nil {
			continue
		}
		var marker gradleDependencySnapshotMarker
		if json.Unmarshal(data, &marker) != nil || marker.Format != gradleSnapshotFormat || marker.State != "ready" {
			continue
		}
		if modules := existingRealDirectory(filepath.Join(root, "modules-2")); modules != "" {
			return root, modules
		}
	}
	return "", ""
}

type pythonDependencyAdapter struct{}

func (pythonDependencyAdapter) Name() string        { return "python" }
func (pythonDependencyAdapter) Languages() []string { return []string{"python"} }

func (pythonDependencyAdapter) Resolve(ctx DependencyAdapterContext) (DependencyAdapterResult, error) {
	mounts := make([]DependencyMountSpec, 0, 3)
	seen := make(map[string]bool)
	if ctx.Paths.UserPersistRoot != "" {
		packages := filepath.Join(ctx.Paths.UserPersistRoot, "pip-packages")
		runtimePart := runtimePathPart(ctx.RuntimeID)
		hasRuntimePackages := false
		if runtimePart != "" && ctx.RuntimeID != "local" {
			specific := existingDirectory(filepath.Join(packages, "runtimes", runtimePart), filepath.Join(packages, runtimePart))
			if specific != "" {
				mounts = appendExistingMount(mounts, seen, DependencyRolePythonPackages, specific, pythonRuntimePackagesContainer, false)
				hasRuntimePackages = true
			}
		}
		for index, extra := range extraDependencyPaths(ctx, DependencyRolePythonPackages) {
			mounts = appendExistingMount(mounts, seen, DependencyRolePythonPackages, extra, fmt.Sprintf("%s/%02d", pythonExtraPackagesRoot, index), false)
		}
		// A scoped tree is built by the exact execution runtime. Do not add the
		// flat compatibility tree after it: native extensions there may target a
		// different Python ABI, and its legacy marker would suppress ready status.
		if !hasRuntimePackages {
			mounts = appendExistingMount(mounts, seen, DependencyRolePythonPackages, packages, pythonLegacyPackagesContainer, true)
		}
	} else {
		for index, extra := range extraDependencyPaths(ctx, DependencyRolePythonPackages) {
			mounts = appendExistingMount(mounts, seen, DependencyRolePythonPackages, extra, fmt.Sprintf("%s/%02d", pythonExtraPackagesRoot, index), false)
		}
	}
	if len(mounts) == 0 {
		return DependencyAdapterResult{}, nil
	}
	localPaths, dockerPaths := make([]string, 0, len(mounts)), make([]string, 0, len(mounts))
	for _, mount := range mounts {
		localPaths = append(localPaths, mount.HostPath)
		dockerPaths = append(dockerPaths, mount.ContainerPath)
	}
	version := runtimeVersion(ctx.RuntimeID)
	localAnalysis := map[string]any{"extraPaths": localPaths, "useLibraryCodeForTypes": true, "autoImportCompletions": true}
	dockerAnalysis := map[string]any{"extraPaths": dockerPaths, "useLibraryCodeForTypes": true, "autoImportCompletions": true}
	localPyright := map[string]any{"extraPaths": localPaths, "useLibraryCodeForTypes": true, "pythonPlatform": "Linux"}
	dockerPyright := map[string]any{"extraPaths": dockerPaths, "useLibraryCodeForTypes": true, "pythonPlatform": "Linux"}
	if version != "" {
		localPyright["pythonVersion"] = version
		dockerPyright["pythonVersion"] = version
	}
	dockerPython := map[string]any{
		"analysis":               dockerAnalysis,
		"pythonPath":             pythonAnalyzerInterpreter,
		"defaultInterpreterPath": pythonAnalyzerInterpreter,
	}
	return DependencyAdapterResult{
		Mounts:           mounts,
		LocalEnvironment: map[string]string{"PYTHONPATH": strings.Join(localPaths, string(os.PathListSeparator))},
		DockerEnvironment: map[string]string{
			"PYTHONPATH":                    strings.Join(dockerPaths, ":"),
			"BOBO_PYRIGHT_DEPENDENCY_PATHS": strings.Join(dockerPaths, ":"),
		},
		LocalLSPSettings:  map[string]any{"python": map[string]any{"analysis": localAnalysis}, "python.analysis": localAnalysis, "pyright": localPyright},
		DockerLSPSettings: map[string]any{"python": dockerPython, "python.analysis": dockerAnalysis, "pyright": dockerPyright},
	}, nil
}

type nodeDependencyAdapter struct{}

func (nodeDependencyAdapter) Name() string { return "node" }
func (nodeDependencyAdapter) Languages() []string {
	return []string{"node", "javascript", "typescript"}
}

func (nodeDependencyAdapter) Resolve(ctx DependencyAdapterContext) (DependencyAdapterResult, error) {
	snapshotBase := ctx.Paths.SnapshotRoot
	candidates := make([]string, 0, 4)
	snapshot := ""
	if snapshotBase != "" && ctx.WorkspaceID != "" {
		snapshot = NodeDependencySnapshot(snapshotBase, ctx.WorkspaceID, ctx.RuntimeID)
	}
	if snapshot != "" {
		candidates = append(candidates, snapshot)
	}
	candidates = append(candidates, extraDependencyPaths(ctx, DependencyRoleNodeModules)...)
	legacy := false
	if ctx.Paths.WorkspaceRoot != "" {
		candidates = append(candidates, filepath.Join(ctx.Paths.WorkspaceRoot, "node_modules"))
	}
	if ctx.Paths.UserPersistRoot != "" {
		global := filepath.Join(ctx.Paths.UserPersistRoot, "npm-global")
		runtimePart := runtimePathPart(ctx.RuntimeID)
		if runtimePart != "" && ctx.RuntimeID != "local" {
			candidates = append(candidates, filepath.Join(global, "runtimes", runtimePart, "lib", "node_modules"))
		}
		candidates = append(candidates, filepath.Join(global, "lib", "node_modules"))
	}
	modules := existingDirectory(candidates...)
	if modules == "" {
		return DependencyAdapterResult{}, nil
	}
	if ctx.Paths.UserPersistRoot != "" && filepath.Clean(modules) == filepath.Clean(filepath.Join(ctx.Paths.UserPersistRoot, "npm-global", "lib", "node_modules")) {
		legacy = true
	}
	managed := snapshot != "" && filepath.Clean(modules) == filepath.Clean(snapshot)
	return DependencyAdapterResult{
		Mounts:           []DependencyMountSpec{{Role: DependencyRoleNodeModules, HostPath: modules, ContainerPath: nodeModulesContainer, Legacy: legacy, Managed: managed}},
		LocalEnvironment: map[string]string{"NODE_PATH": modules}, DockerEnvironment: map[string]string{"NODE_PATH": nodeModulesContainer},
	}, nil
}

type goDependencyAdapter struct{}

func (goDependencyAdapter) Name() string        { return "go" }
func (goDependencyAdapter) Languages() []string { return []string{"go"} }

func (goDependencyAdapter) Resolve(ctx DependencyAdapterContext) (DependencyAdapterResult, error) {
	candidates := extraDependencyPaths(ctx, DependencyRoleGoModules)
	preferred := preferredCacheRoot(ctx, "go/pkg/mod")
	if preferred != "" {
		candidates = append(candidates, preferred)
	}
	modules, proxy := "", ""
	for _, candidate := range candidates {
		if modules == "" {
			modules = existingDirectory(candidate)
		}
		if proxy = goModuleProxyDirectory(candidate); proxy != "" {
			break
		}
	}
	if modules == "" {
		return DependencyAdapterResult{}, nil
	}
	if proxy != "" {
		localProxy := localFileRepository(proxy)
		dockerProxy := "file://" + goModuleProxyContainer
		return DependencyAdapterResult{
			Mounts:            []DependencyMountSpec{{Role: DependencyRoleGoModules, HostPath: proxy, ContainerPath: goModuleProxyContainer}},
			LocalEnvironment:  map[string]string{"GOPROXY": localProxy, "GOSUMDB": "off"},
			DockerEnvironment: map[string]string{"GOPROXY": dockerProxy, "GOSUMDB": "off"},
			LocalLSPSettings:  map[string]any{"gopls": map[string]any{"env": map[string]any{"GOPROXY": localProxy, "GOSUMDB": "off"}}},
			DockerLSPSettings: map[string]any{"gopls": map[string]any{"env": map[string]any{"GOPROXY": dockerProxy, "GOSUMDB": "off"}}},
		}, nil
	}
	// Compatibility for old caches that contain only an expanded module tree.
	// New caches use the file proxy above so the analyzer's GOMODCACHE stays
	// writable and private to its bounded analysis namespace.
	return DependencyAdapterResult{
		Mounts:           []DependencyMountSpec{{Role: DependencyRoleGoModules, HostPath: modules, ContainerPath: goModulesContainer, Legacy: true}},
		LocalEnvironment: map[string]string{"GOMODCACHE": modules}, DockerEnvironment: map[string]string{"GOMODCACHE": goModulesContainer},
		LocalLSPSettings:  map[string]any{"gopls": map[string]any{"env": map[string]any{"GOMODCACHE": modules}}},
		DockerLSPSettings: map[string]any{"gopls": map[string]any{"env": map[string]any{"GOMODCACHE": goModulesContainer}}},
	}, nil
}

type rustDependencyAdapter struct{}

func (rustDependencyAdapter) Name() string        { return "rust" }
func (rustDependencyAdapter) Languages() []string { return []string{"rust"} }

func (rustDependencyAdapter) Resolve(ctx DependencyAdapterContext) (DependencyAdapterResult, error) {
	candidates := extraDependencyPaths(ctx, DependencyRoleRustCargoHome)
	preferred := preferredCacheRoot(ctx, "cargo")
	if preferred != "" {
		candidates = append(candidates, preferred)
	}
	cargoHome := existingDirectory(candidates...)
	if cargoHome == "" {
		return DependencyAdapterResult{}, nil
	}
	seen := make(map[string]bool)
	mounts := make([]DependencyMountSpec, 0, 4)
	mounts = appendExistingMount(mounts, seen, DependencyRoleRustRegistrySrc, filepath.Join(cargoHome, "registry", "src"), rustRegistrySrcContainer, false)
	mounts = appendExistingMount(mounts, seen, DependencyRoleRustRegistryIdx, filepath.Join(cargoHome, "registry", "index"), rustRegistryIndexContainer, false)
	mounts = appendExistingMount(mounts, seen, DependencyRoleRustGitCheckout, filepath.Join(cargoHome, "git", "checkouts"), rustGitCheckoutsContainer, false)
	mounts = appendExistingMount(mounts, seen, DependencyRoleRustGitDB, filepath.Join(cargoHome, "git", "db"), rustGitDBContainer, false)
	if len(mounts) == 0 {
		return DependencyAdapterResult{}, nil
	}
	dockerCargo := map[string]any{"extraEnv": map[string]any{"CARGO_HOME": rustCargoContainer, "CARGO_NET_OFFLINE": "true"}}
	return DependencyAdapterResult{
		Mounts:            mounts,
		DockerEnvironment: map[string]string{"CARGO_NET_OFFLINE": "true"},
		DockerLSPSettings: map[string]any{"rust-analyzer": map[string]any{"cargo": dockerCargo}},
	}, nil
}

type javaDependencyAdapter struct{}

func (javaDependencyAdapter) Name() string        { return "java" }
func (javaDependencyAdapter) Languages() []string { return []string{"java"} }

func (javaDependencyAdapter) Resolve(ctx DependencyAdapterContext) (DependencyAdapterResult, error) {
	mavenCandidates := extraDependencyPaths(ctx, DependencyRoleJavaMaven)
	if preferred := preferredCacheRoot(ctx, "maven"); preferred != "" {
		mavenCandidates = append(mavenCandidates, preferred)
	}
	gradleCandidates := make([]string, 0, 1)
	managedGradleRoot := ""
	if ctx.Paths.SnapshotRoot != "" {
		if current := currentGradleDependencySnapshot(ctx.Paths.SnapshotRoot, ctx.RuntimeID); current != "" {
			gradleCandidates = append(gradleCandidates, current)
			managedGradleRoot = filepath.Clean(current)
		}
	}
	gradleCandidates = append(gradleCandidates, extraDependencyPaths(ctx, DependencyRoleJavaGradle)...)
	maven := existingDirectory(mavenCandidates...)
	gradleRoot, gradleModules := gradleDependencySnapshot(gradleCandidates...)
	if gradleModules == "" {
		// A project-lock namespace stores GRADLE_USER_HOME directly. It is held
		// by the personal-cache read lease, so its modules can be exposed as a
		// read-only source without requiring the independent snapshot marker.
		for _, candidate := range extraDependencyPaths(ctx, DependencyRoleJavaGradle) {
			modules := existingRealDirectory(filepath.Join(candidate, "caches", "modules-2"))
			if modules == "" {
				modules = existingRealDirectory(filepath.Join(candidate, "modules-2"))
			}
			if modules != "" {
				gradleModules = modules
				gradleRoot = filepath.Dir(modules)
				break
			}
		}
	}
	result := DependencyAdapterResult{LocalEnvironment: map[string]string{}, DockerEnvironment: map[string]string{}, LocalLSPSettings: map[string]any{}, DockerLSPSettings: map[string]any{}}
	localJava, dockerJava := map[string]any{}, map[string]any{}
	localImport, dockerImport := map[string]any{}, map[string]any{}
	if maven != "" {
		result.Mounts = append(result.Mounts, DependencyMountSpec{Role: DependencyRoleJavaMaven, HostPath: maven, ContainerPath: javaMavenSourceContainer})
		localRepository := filepath.ToSlash(filepath.Join(localAnalysisCachePlaceholder, "maven", "repository"))
		localSettings := filepath.ToSlash(filepath.Join(localAnalysisCachePlaceholder, "maven", "settings.xml"))
		localOption := "-Dmaven.repo.local=" + localRepository
		dockerOption := "-Dmaven.repo.local=" + javaMavenWritableContainer
		result.LocalEnvironment["JAVA_TOOL_OPTIONS"] = localOption
		result.LocalEnvironment["MAVEN_OPTS"] = localOption
		result.DockerEnvironment["JAVA_TOOL_OPTIONS"] = dockerOption
		result.DockerEnvironment["MAVEN_OPTS"] = dockerOption
		result.DockerEnvironment["BOBO_MAVEN_SOURCE_REPO"] = javaMavenSourceContainer
		localJava["configuration"] = map[string]any{"maven": map[string]any{"userSettings": localSettings}}
		dockerJava["configuration"] = map[string]any{"maven": map[string]any{"userSettings": javaMavenSettingsContainer}}
		// The generated mirror maps every repository to the mounted file source.
		// Maven offline mode would also block that file mirror from populating the
		// session-private writable repository.
		localImport["maven"] = map[string]any{"enabled": true}
		dockerImport["maven"] = map[string]any{"enabled": true}
	}
	if gradleModules != "" {
		managed := managedGradleRoot != "" && filepath.Clean(gradleRoot) == managedGradleRoot
		result.Mounts = append(result.Mounts, DependencyMountSpec{Role: DependencyRoleJavaGradle, HostPath: gradleModules, ContainerPath: javaGradleModulesContainer, Managed: managed})
		result.LocalEnvironment["GRADLE_RO_DEP_CACHE"] = filepath.ToSlash(gradleRoot)
		result.DockerEnvironment["GRADLE_RO_DEP_CACHE"] = javaGradleReadOnlyRoot
		localImport["gradle"] = map[string]any{"user": map[string]any{"home": filepath.ToSlash(filepath.Join(localAnalysisCachePlaceholder, "gradle"))}, "offline": map[string]any{"enabled": true}}
		dockerImport["gradle"] = map[string]any{"user": map[string]any{"home": "/analysis-cache/gradle"}, "offline": map[string]any{"enabled": true}}
	}
	if len(result.Mounts) == 0 {
		return DependencyAdapterResult{}, nil
	}
	if len(localImport) > 0 {
		localJava["import"] = localImport
		dockerJava["import"] = dockerImport
	}
	result.LocalLSPSettings["java"] = localJava
	result.DockerLSPSettings["java"] = dockerJava
	return result, nil
}

type nativeDependencyAdapter struct{}

func (nativeDependencyAdapter) Name() string        { return "native" }
func (nativeDependencyAdapter) Languages() []string { return []string{"c", "cpp", "c++"} }

func (nativeDependencyAdapter) Resolve(ctx DependencyAdapterContext) (DependencyAdapterResult, error) {
	sysrootCandidates := append(extraDependencyPaths(ctx, DependencyRoleNativeSysroot), ctx.Paths.ToolchainRoots...)
	sysroot := existingDirectory(sysrootCandidates...)
	includeCandidates := extraDependencyPaths(ctx, DependencyRoleNativeIncludes)
	include := existingDirectory(includeCandidates...)
	result := DependencyAdapterResult{}
	dockerFlags := make([]string, 0, 2)
	if sysroot != "" {
		result.Mounts = append(result.Mounts, DependencyMountSpec{Role: DependencyRoleNativeSysroot, HostPath: sysroot, ContainerPath: nativeSysrootContainer})
		dockerFlags = append(dockerFlags, "--sysroot="+nativeSysrootContainer)
	}
	if include != "" {
		result.Mounts = append(result.Mounts, DependencyMountSpec{Role: DependencyRoleNativeIncludes, HostPath: include, ContainerPath: nativeIncludesContainer})
		dockerFlags = append(dockerFlags, "-I"+nativeIncludesContainer)
	}
	if len(result.Mounts) == 0 {
		return DependencyAdapterResult{}, nil
	}
	encoded, err := encodeNativeFallbackFlags(dockerFlags)
	if err != nil {
		return DependencyAdapterResult{}, err
	}
	result.DockerEnvironment = map[string]string{"BOBO_CLANGD_FALLBACK_FLAGS_JSON": encoded}
	return result, nil
}

func encodeNativeFallbackFlags(flags []string) (string, error) {
	if len(flags) > maxNativeFallbackFlags {
		return "", fmt.Errorf("too many native fallback flags")
	}
	total := 0
	for _, flag := range flags {
		if flag == "" || len(flag) > maxNativeFlagBytes || strings.ContainsAny(flag, "\x00\r\n") {
			return "", fmt.Errorf("invalid native fallback flag")
		}
		if flag != "--sysroot="+nativeSysrootContainer && flag != "-I"+nativeIncludesContainer {
			return "", fmt.Errorf("native fallback flag is outside the server-issued dependency paths")
		}
		total += len(flag)
		if total > maxNativeFlagsBytes {
			return "", fmt.Errorf("native fallback flags are too large")
		}
	}
	encoded, err := json.Marshal(flags)
	if err != nil {
		return "", fmt.Errorf("encode native fallback flags: %w", err)
	}
	return string(encoded), nil
}

func validateAdapterEnvironment(environment map[string]string) error {
	for key, value := range environment {
		if strings.TrimSpace(key) == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, '\x00') {
			return fmt.Errorf("invalid dependency environment entry")
		}
	}
	return nil
}
