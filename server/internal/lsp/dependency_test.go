package lsp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func makeDependencyDir(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(path, 0755); err != nil {
		t.Fatal(err)
	}
	return path
}

func makeGradleDependencySnapshot(t *testing.T, base, runtimeID string) string {
	t.Helper()
	generation := strings.Repeat("a", 32)
	root, err := GradleDependencyGenerationRoot(base, runtimeID, generation)
	if err != nil {
		t.Fatal(err)
	}
	root = makeDependencyDir(t, root)
	makeDependencyDir(t, filepath.Join(root, "modules-2"))
	if err := CompleteGradleDependencySnapshot(root); err != nil {
		t.Fatal(err)
	}
	if err := ActivateGradleDependencySnapshot(base, runtimeID, generation); err != nil {
		t.Fatal(err)
	}
	return root
}

func personalDependencyRequest(root, language, runtime string) AnalysisDependencyRequest {
	return AnalysisDependencyRequest{
		OwnerKind: "user", OwnerID: "user-1", UserID: "user-1",
		RuntimeID: runtime, LanguageID: language,
		Paths: AnalysisDependencyPaths{UserPersistRoot: filepath.Join(root, "persist"), AllowedRoots: []string{root}},
	}
}

func TestDefaultDependencyRegistryCoversCompiledLanguages(t *testing.T) {
	registry := NewDefaultDependencyRegistry()
	want := []string{"c", "cpp", "go", "java", "node", "python", "rust"}
	if got := registry.Languages(); !reflect.DeepEqual(got, want) {
		t.Fatalf("languages = %v, want %v", got, want)
	}
}

func TestPythonDependencyViewIgnoresLegacyUserPackages(t *testing.T) {
	root := t.TempDir()
	packages := makeDependencyDir(t, filepath.Join(root, "persist", "pip-packages"))
	makeDependencyDir(t, filepath.Join(packages, "numpy"))
	request := personalDependencyRequest(root, "python", "python:3.10")
	view, err := NewDefaultDependencyRegistry().Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Mounts) != 0 || view.DockerEnvironment["PYTHONPATH"] != "" {
		t.Fatalf("legacy user packages were exposed to LSP: %+v", view)
	}
}

func TestPythonDependencyViewUsesExactProjectGeneration(t *testing.T) {
	root := t.TempDir()
	specific := makeDependencyDir(t, filepath.Join(root, "cache-v2", "python"))
	request := personalDependencyRequest(root, "python", "python:3.10")
	request.Generation = "project-lock:generation-a"
	request.Paths.Extra = map[string][]string{DependencyRolePythonPackages: {specific}}
	view, err := NewDefaultDependencyRegistry().Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Mounts) != 1 {
		t.Fatalf("mounts = %+v, want exact project generation", view.Mounts)
	}
	if got := view.Mounts[0].HostPath; got != specific {
		t.Fatalf("mounted %q, want %q", got, specific)
	}
	if view.Mounts[0].Legacy {
		t.Fatal("project generation was marked legacy")
	}
	wantContainer := pythonExtraPackagesRoot + "/00"
	if got := view.DockerEnvironment["PYTHONPATH"]; got != wantContainer {
		t.Fatalf("project PYTHONPATH = %q, want %q", got, wantContainer)
	}
	if got := view.DockerEnvironment["BOBO_PYRIGHT_DEPENDENCY_PATHS"]; got != wantContainer {
		t.Fatalf("project Pyright overlay = %q, want %q", got, wantContainer)
	}
	if status := view.PublicStatus(true, "user"); status.Status != "ready" || status.Source != "user" {
		t.Fatalf("project package status = %+v, want ready user status", status)
	}
}

func TestDependencyRevisionChangesWithGenerationAndPackageMetadata(t *testing.T) {
	root := t.TempDir()
	packages := makeDependencyDir(t, filepath.Join(root, "persist", "pip-packages"))
	registry := NewDefaultDependencyRegistry()
	request := personalDependencyRequest(root, "python", "python:3.10")
	request.Paths.Extra = map[string][]string{DependencyRolePythonPackages: {packages}}
	request.Generation = "generation-1"
	first, err := registry.Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	request.Generation = "generation-2"
	second, err := registry.Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision == second.Revision {
		t.Fatal("explicit generation did not change dependency revision")
	}
	request.Generation = "generation-1"
	if err := os.WriteFile(filepath.Join(packages, "new-package.pth"), []byte("package"), 0644); err != nil {
		t.Fatal(err)
	}
	third, err := registry.Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision == third.Revision {
		t.Fatal("dependency metadata change did not change revision")
	}
}

func TestDependencyRevisionStabilizesGenerationBoundExtraReaderAnchors(t *testing.T) {
	root := t.TempDir()
	fixedTime := time.Unix(1_700_000_000, 0)
	makeReader := func(name, relative string) (string, string) {
		reader := filepath.Join(root, name)
		packages := makeDependencyDir(t, filepath.Join(reader, relative))
		marker := filepath.Join(packages, "numpy.pth")
		if err := os.WriteFile(marker, []byte("numpy\n"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(marker, fixedTime, fixedTime); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(packages, fixedTime, fixedTime); err != nil {
			t.Fatal(err)
		}
		return reader, packages
	}
	readerOne, packagesOne := makeReader("reader-one", "python")
	readerTwo, packagesTwo := makeReader("reader-two", "python")
	identityRoot := filepath.Join(root, "canonical-generation")
	registry := NewDefaultDependencyRegistry()
	resolve := func(reader, packages, generation, identity string, stable bool) AnalysisDependencyView {
		t.Helper()
		paths := AnalysisDependencyPaths{
			Extra:        map[string][]string{DependencyRolePythonPackages: {packages}},
			AllowedRoots: []string{root},
		}
		if stable {
			paths.ExtraRevision = &AnalysisDependencyExtraRevision{HostRoot: reader, IdentityRoot: identity}
		}
		view, err := registry.Resolve(AnalysisDependencyRequest{
			OwnerKind: "user", OwnerID: "user-a", UserID: "user-a", WorkspaceID: "workspace-a",
			RuntimeID: "python:3.10", LanguageID: "python", Generation: generation, Paths: paths,
		})
		if err != nil {
			t.Fatal(err)
		}
		return view
	}

	first := resolve(readerOne, packagesOne, "generation-a", identityRoot, true)
	second := resolve(readerTwo, packagesTwo, "generation-a", identityRoot, true)
	if first.Revision != second.Revision {
		t.Fatalf("equivalent pinned readers changed revision: first=%q second=%q", first.Revision, second.Revision)
	}
	if len(first.Mounts) != 1 || len(second.Mounts) != 1 || first.Mounts[0].HostPath == second.Mounts[0].HostPath || first.Mounts[0].RevisionIdentity == "" || first.Mounts[0].RevisionIdentity != second.Mounts[0].RevisionIdentity {
		t.Fatalf("pinned reader identity was not separated from mount paths: first=%+v second=%+v", first.Mounts, second.Mounts)
	}

	unmappedFirst := resolve(readerOne, packagesOne, "generation-a", "", false)
	unmappedSecond := resolve(readerTwo, packagesTwo, "generation-a", "", false)
	if unmappedFirst.Revision == unmappedSecond.Revision {
		t.Fatal("ordinary Extra mount paths stopped contributing to the revision")
	}
	nonGenerationFirst := resolve(readerOne, packagesOne, "", "", false)
	nonGenerationSecond := resolve(readerTwo, packagesTwo, "", "", false)
	if nonGenerationFirst.Revision == nonGenerationSecond.Revision {
		t.Fatal("non-generation Extra mount paths stopped contributing to the revision")
	}
	if changed := resolve(readerTwo, packagesTwo, "generation-b", identityRoot, true); changed.Revision == first.Revision {
		t.Fatal("dependency generation change retained the revision")
	}
	if changed := resolve(readerTwo, packagesTwo, "generation-a", filepath.Join(root, "other-canonical-generation"), true); changed.Revision == first.Revision {
		t.Fatal("canonical dependency identity change retained the revision")
	}
	readerThree, packagesThree := makeReader("reader-three", "alternate-python")
	if changed := resolve(readerThree, packagesThree, "generation-a", identityRoot, true); changed.Revision == first.Revision {
		t.Fatal("dependency path within the pinned generation retained the revision")
	}
	if err := os.WriteFile(filepath.Join(packagesTwo, "scipy.pth"), []byte("scipy\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if changed := resolve(readerTwo, packagesTwo, "generation-a", identityRoot, true); changed.Revision == first.Revision {
		t.Fatal("dependency content change retained the revision")
	}
}

func TestDependencyRevisionRejectsExtraIdentityWithoutGeneration(t *testing.T) {
	root := t.TempDir()
	packages := makeDependencyDir(t, filepath.Join(root, "reader", "python"))
	_, err := NewDefaultDependencyRegistry().Resolve(AnalysisDependencyRequest{
		OwnerKind: "user", UserID: "user-a", RuntimeID: "python:3.10", LanguageID: "python",
		Paths: AnalysisDependencyPaths{
			Extra:         map[string][]string{DependencyRolePythonPackages: {packages}},
			ExtraRevision: &AnalysisDependencyExtraRevision{HostRoot: filepath.Dir(packages), IdentityRoot: filepath.Join(root, "canonical")},
			AllowedRoots:  []string{root},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "requires a generation") {
		t.Fatalf("generation-free Extra revision identity error = %v", err)
	}
}

func TestDependencyRevisionIdentityOnlyAppliesToMappedExtraTree(t *testing.T) {
	root := t.TempDir()
	reader := makeDependencyDir(t, filepath.Join(root, "reader"))
	extra := makeDependencyDir(t, filepath.Join(reader, "go", "pkg", "mod"))
	ordinary := makeDependencyDir(t, filepath.Join(root, "ordinary"))
	adapter := testDependencyAdapter{
		name:      "future",
		languages: []string{"future"},
		result: DependencyAdapterResult{Mounts: []DependencyMountSpec{
			{Role: "future.extra", HostPath: filepath.Join(extra, "nested"), ContainerPath: AnalysisDependenciesRoot + "/future/extra"},
			{Role: "future.ordinary", HostPath: ordinary, ContainerPath: AnalysisDependenciesRoot + "/future/ordinary"},
		}},
	}
	makeDependencyDir(t, adapter.result.Mounts[0].HostPath)
	registry, err := NewDependencyRegistry(adapter)
	if err != nil {
		t.Fatal(err)
	}
	identityRoot := filepath.Join(root, "canonical-generation")
	view, err := registry.Resolve(AnalysisDependencyRequest{
		OwnerKind: "user", UserID: "user-a", RuntimeID: "future:1", LanguageID: "future", Generation: "generation-a",
		Paths: AnalysisDependencyPaths{
			Extra:         map[string][]string{"future.extra": {extra}},
			ExtraRevision: &AnalysisDependencyExtraRevision{HostRoot: reader, IdentityRoot: identityRoot},
			AllowedRoots:  []string{root},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Mounts) != 2 {
		t.Fatalf("mounts = %+v", view.Mounts)
	}
	if want := filepath.Join(identityRoot, "go", "pkg", "mod", "nested"); filepath.Clean(view.Mounts[0].RevisionIdentity) != filepath.Clean(want) {
		t.Fatalf("nested Extra revision identity = %q, want %q", view.Mounts[0].RevisionIdentity, want)
	}
	if view.Mounts[1].RevisionIdentity != "" {
		t.Fatalf("ordinary mount acquired an Extra revision identity: %+v", view.Mounts[1])
	}
}

func TestDependencySignatureAlwaysCoversDirectChildren(t *testing.T) {
	root := t.TempDir()
	for index := 0; index < maxDependencyScanEntries+100; index++ {
		makeDependencyDir(t, filepath.Join(root, fmt.Sprintf("package-%04d", index)))
	}
	first := dependencyDirectorySignature(root)
	last := filepath.Join(root, fmt.Sprintf("package-%04d", maxDependencyScanEntries+99))
	if err := os.WriteFile(filepath.Join(last, "metadata.json"), []byte("changed"), 0644); err != nil {
		t.Fatal(err)
	}
	second := dependencyDirectorySignature(root)
	if first == second {
		t.Fatal("a direct child beyond the deep scan budget was not represented")
	}
}

func TestDependencySignatureDoesNotReadOversizedMarker(t *testing.T) {
	root := t.TempDir()
	marker := filepath.Join(root, ".analysis-generation")
	if err := os.WriteFile(marker, bytes.Repeat([]byte{'a'}, int(maxDependencyMarkerBytes)+1), 0644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(marker)
	if err != nil {
		t.Fatal(err)
	}
	first := dependencyDirectorySignature(root)
	if err := os.WriteFile(marker, bytes.Repeat([]byte{'b'}, int(maxDependencyMarkerBytes)+1), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(marker, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	second := dependencyDirectorySignature(root)
	if first != second {
		t.Fatal("oversized dependency marker content was read")
	}
}

func TestDependencySignatureDoesNotFollowMarkerSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(t.TempDir(), "generation")
	if err := os.WriteFile(target, []byte("one!"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, ".analysis-generation")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	first := dependencyDirectorySignature(root)
	if err := os.WriteFile(target, []byte("two!"), 0644); err != nil {
		t.Fatal(err)
	}
	second := dependencyDirectorySignature(root)
	if first != second {
		t.Fatal("dependency marker symlink target was read")
	}
}

type testDependencyAdapter struct {
	name      string
	languages []string
	result    DependencyAdapterResult
}

func (a testDependencyAdapter) Name() string        { return a.name }
func (a testDependencyAdapter) Languages() []string { return a.languages }
func (a testDependencyAdapter) Resolve(DependencyAdapterContext) (DependencyAdapterResult, error) {
	return a.result, nil
}

func TestDependencyRegistryRejectsMountOutsideAllowlist(t *testing.T) {
	allowed, outside := t.TempDir(), t.TempDir()
	adapter := testDependencyAdapter{name: "future", languages: []string{"future"}, result: DependencyAdapterResult{Mounts: []DependencyMountSpec{{Role: "future.packages", HostPath: outside, ContainerPath: AnalysisDependenciesRoot + "/future/packages"}}}}
	registry, err := NewDependencyRegistry(adapter)
	if err != nil {
		t.Fatal(err)
	}
	_, err = registry.Resolve(AnalysisDependencyRequest{OwnerKind: "user", UserID: "u", RuntimeID: "local", LanguageID: "future", Paths: AnalysisDependencyPaths{AllowedRoots: []string{allowed}}})
	if err == nil || !strings.Contains(err.Error(), "outside") {
		t.Fatalf("outside mount error = %v", err)
	}
}

func TestDependencyRegistryRejectsUnsafeContainerTarget(t *testing.T) {
	root := t.TempDir()
	adapter := testDependencyAdapter{name: "future", languages: []string{"future"}, result: DependencyAdapterResult{Mounts: []DependencyMountSpec{{Role: "future.packages", HostPath: root, ContainerPath: "/workspace/dependencies"}}}}
	registry, err := NewDependencyRegistry(adapter)
	if err != nil {
		t.Fatal(err)
	}
	_, err = registry.Resolve(AnalysisDependencyRequest{OwnerKind: "user", UserID: "u", RuntimeID: "local", LanguageID: "future", Paths: AnalysisDependencyPaths{AllowedRoots: []string{root}}})
	if err == nil || !strings.Contains(err.Error(), "fixed analysis dependency paths") {
		t.Fatalf("unsafe target error = %v", err)
	}
}

func TestDependencyRegistryRequiresExplicitAllowlistForMounts(t *testing.T) {
	root := t.TempDir()
	adapter := testDependencyAdapter{name: "future", languages: []string{"future"}, result: DependencyAdapterResult{Mounts: []DependencyMountSpec{{Role: "future.packages", HostPath: root, ContainerPath: AnalysisDependenciesRoot + "/future/packages"}}}}
	registry, _ := NewDependencyRegistry(adapter)
	_, err := registry.Resolve(AnalysisDependencyRequest{OwnerKind: "user", UserID: "u", RuntimeID: "local", LanguageID: "future"})
	if err == nil || !strings.Contains(err.Error(), "allowlist") {
		t.Fatalf("missing allowlist error = %v", err)
	}
}

func TestTeamGoDependencyViewPrefersSharedModuleSources(t *testing.T) {
	root := t.TempDir()
	shared := makeDependencyDir(t, filepath.Join(root, "team-shared"))
	sharedModules := makeDependencyDir(t, filepath.Join(shared, "go", "pkg", "mod"))
	sharedProxy := makeDependencyDir(t, filepath.Join(sharedModules, "cache", "download"))
	personal := makeDependencyDir(t, filepath.Join(root, "persist"))
	makeDependencyDir(t, filepath.Join(personal, "go", "pkg", "mod"))
	view, err := NewDefaultDependencyRegistry().Resolve(AnalysisDependencyRequest{
		OwnerKind: "team", OwnerID: "team-1", UserID: "user-1", RuntimeID: "go:1.23", LanguageID: "go",
		Paths: AnalysisDependencyPaths{SharedCacheRoot: shared, UserPersistRoot: personal, AllowedRoots: []string{root}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Mounts) != 1 || view.Mounts[0].HostPath != sharedProxy || view.Mounts[0].ContainerPath != goModuleProxyContainer {
		t.Fatalf("unexpected Go view: %+v", view)
	}
	if view.DockerEnvironment["GOPROXY"] != "file://"+goModuleProxyContainer || view.DockerEnvironment["GOSUMDB"] != "off" {
		t.Fatalf("Go read-only proxy environment = %+v", view.DockerEnvironment)
	}
	if _, readOnlyModuleCache := view.DockerEnvironment["GOMODCACHE"]; readOnlyModuleCache {
		t.Fatalf("Go writable module cache was replaced by a read-only mount: %+v", view.DockerEnvironment)
	}
}

func TestDependencyAdaptersExposeRuntimeSources(t *testing.T) {
	root := t.TempDir()
	snapshots := makeDependencyDir(t, filepath.Join(root, "snapshots"))
	nodeModules := makeDependencyDir(t, filepath.Join(root, "project-node-modules"))
	cargoHome := makeDependencyDir(t, filepath.Join(root, "cargo"))
	makeDependencyDir(t, filepath.Join(cargoHome, "registry", "src"))
	mavenHome := makeDependencyDir(t, filepath.Join(root, "maven"))
	makeGradleDependencySnapshot(t, snapshots, "java:21")
	sysroot := makeDependencyDir(t, filepath.Join(root, "toolchain"))
	include := makeDependencyDir(t, filepath.Join(root, "include"))
	registry := NewDefaultDependencyRegistry()

	tests := []struct {
		language string
		runtime  string
		paths    AnalysisDependencyPaths
		roles    []string
	}{
		{language: "typescript", runtime: "node:20", paths: AnalysisDependencyPaths{Extra: map[string][]string{DependencyRoleNodeModules: {nodeModules}}, AllowedRoots: []string{root}}, roles: []string{DependencyRoleNodeModules}},
		{language: "rust", runtime: "rust:1.82", paths: AnalysisDependencyPaths{Extra: map[string][]string{DependencyRoleRustCargoHome: {cargoHome}}, AllowedRoots: []string{root}}, roles: []string{DependencyRoleRustRegistrySrc}},
		{language: "java", runtime: "java:21", paths: AnalysisDependencyPaths{Extra: map[string][]string{DependencyRoleJavaMaven: {mavenHome}}, SnapshotRoot: snapshots, AllowedRoots: []string{root}}, roles: []string{DependencyRoleJavaMaven, DependencyRoleJavaGradle}},
		{language: "c++", runtime: "cpp:13", paths: AnalysisDependencyPaths{ToolchainRoots: []string{sysroot}, Extra: map[string][]string{DependencyRoleNativeIncludes: {include}}, AllowedRoots: []string{root}}, roles: []string{DependencyRoleNativeSysroot, DependencyRoleNativeIncludes}},
	}
	for _, test := range tests {
		t.Run(test.language, func(t *testing.T) {
			view, err := registry.Resolve(AnalysisDependencyRequest{OwnerKind: "user", UserID: "user-1", RuntimeID: test.runtime, LanguageID: test.language, Paths: test.paths})
			if err != nil {
				t.Fatal(err)
			}
			var roles []string
			for _, mount := range view.Mounts {
				if !mount.ReadOnly {
					t.Fatalf("writable dependency mount: %+v", mount)
				}
				roles = append(roles, mount.Role)
			}
			if !reflect.DeepEqual(roles, test.roles) {
				t.Fatalf("roles = %v, want %v", roles, test.roles)
			}
		})
	}
}

func TestDependencyAdaptersKeepWritableCachesSeparate(t *testing.T) {
	root := t.TempDir()
	snapshots := makeDependencyDir(t, filepath.Join(root, "snapshots"))
	cargoHome := makeDependencyDir(t, filepath.Join(root, "cargo"))
	makeDependencyDir(t, filepath.Join(cargoHome, "registry", "src"))
	mavenHome := makeDependencyDir(t, filepath.Join(root, "maven"))
	gradleRoot := makeGradleDependencySnapshot(t, snapshots, "java:21")
	gradleModules := filepath.Join(gradleRoot, "modules-2")
	registry := NewDefaultDependencyRegistry()

	rustRequest := personalDependencyRequest(root, "rust", "rust:1.82")
	rustRequest.Paths.Extra = map[string][]string{DependencyRoleRustCargoHome: {cargoHome}}
	rustView, err := registry.Resolve(rustRequest)
	if err != nil {
		t.Fatal(err)
	}
	if _, found := rustView.DockerEnvironment["CARGO_HOME"]; found {
		t.Fatalf("CARGO_HOME was redirected to a read-only dependency root: %+v", rustView.DockerEnvironment)
	}
	if len(rustView.Mounts) != 1 || rustView.Mounts[0].ContainerPath != rustRegistrySrcContainer || !rustView.Mounts[0].ReadOnly {
		t.Fatalf("Rust dependency overlay = %+v", rustView.Mounts)
	}

	javaRequest := personalDependencyRequest(root, "java", "java:21")
	javaRequest.Paths.SnapshotRoot = snapshots
	javaRequest.Paths.Extra = map[string][]string{DependencyRoleJavaMaven: {mavenHome}}
	javaView, err := registry.Resolve(javaRequest)
	if err != nil {
		t.Fatal(err)
	}
	if _, found := javaView.DockerEnvironment["GRADLE_USER_HOME"]; found {
		t.Fatalf("GRADLE_USER_HOME was redirected to a read-only dependency root: %+v", javaView.DockerEnvironment)
	}
	if javaView.DockerEnvironment["GRADLE_RO_DEP_CACHE"] != javaGradleReadOnlyRoot || javaView.LocalEnvironment["GRADLE_RO_DEP_CACHE"] != filepath.ToSlash(gradleRoot) {
		t.Fatalf("Gradle read-only cache missing: %+v", javaView.DockerEnvironment)
	}
	if len(javaView.Mounts) != 2 || javaView.Mounts[1].HostPath != gradleModules || javaView.Mounts[1].ContainerPath != javaGradleModulesContainer {
		t.Fatalf("Gradle dependency content was not mounted at the read-only cache contract: %+v", javaView.Mounts)
	}
	if !javaView.Mounts[1].Managed {
		t.Fatalf("current Gradle generation was not protected by a managed lease: %+v", javaView.Mounts[1])
	}
	if javaView.Mounts[0].ContainerPath != javaMavenSourceContainer || javaView.DockerEnvironment["BOBO_MAVEN_SOURCE_REPO"] != javaMavenSourceContainer {
		t.Fatalf("Maven source repository was not mounted read-only: mounts=%+v env=%+v", javaView.Mounts, javaView.DockerEnvironment)
	}
	mavenOpts := javaView.DockerEnvironment["MAVEN_OPTS"]
	if mavenOpts != "-Dmaven.repo.local="+javaMavenWritableContainer || javaView.DockerEnvironment["JAVA_TOOL_OPTIONS"] != mavenOpts {
		t.Fatalf("Maven repository was not passed to both JVM and Maven import paths: %+v", javaView.DockerEnvironment)
	}
	javaSettings := javaView.DockerLSPSettings["java"].(map[string]any)
	configuration := javaSettings["configuration"].(map[string]any)
	if configuration["maven"].(map[string]any)["userSettings"] != javaMavenSettingsContainer {
		t.Fatalf("JDTLS Maven settings = %+v", javaSettings)
	}
	initialization := javaView.InitializationOptionsForAnalyzer(true)
	initializationSettings, ok := initialization["settings"].(map[string]any)
	if !ok || initializationSettings["java"].(map[string]any)["configuration"].(map[string]any)["maven"].(map[string]any)["userSettings"] != javaMavenSettingsContainer {
		t.Fatalf("JDTLS initialization settings = %+v", initialization)
	}
}

func TestNativeDependencyFlagsAreBoundedServerJSON(t *testing.T) {
	encoded, err := encodeNativeFallbackFlags([]string{"--sysroot=" + nativeSysrootContainer, "-I" + nativeIncludesContainer})
	if err != nil {
		t.Fatal(err)
	}
	if encoded != `["--sysroot=/analysis-deps/native/sysroot","-I/analysis-deps/native/include"]` {
		t.Fatalf("encoded flags = %s", encoded)
	}
	if _, err := encodeNativeFallbackFlags([]string{"-I/workspace/untrusted"}); err == nil {
		t.Fatal("untrusted native include flag was accepted")
	}
	oversized := make([]string, maxNativeFallbackFlags+1)
	for index := range oversized {
		oversized[index] = "-I" + nativeIncludesContainer
	}
	if _, err := encodeNativeFallbackFlags(oversized); err == nil {
		t.Fatal("native fallback flag count was not bounded")
	}
	root := t.TempDir()
	sysroot := makeDependencyDir(t, filepath.Join(root, "sysroot"))
	include := makeDependencyDir(t, filepath.Join(root, "include"))
	view, err := NewDefaultDependencyRegistry().Resolve(AnalysisDependencyRequest{
		OwnerKind: "user", UserID: "u", RuntimeID: "c:13", LanguageID: "cpp",
		Paths: AnalysisDependencyPaths{ToolchainRoots: []string{sysroot}, Extra: map[string][]string{DependencyRoleNativeIncludes: {include}}, AllowedRoots: []string{root}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if view.DockerEnvironment["BOBO_CLANGD_FALLBACK_FLAGS_JSON"] != encoded {
		t.Fatalf("clangd wrapper environment = %+v", view.DockerEnvironment)
	}
}

func TestNativeDependencyViewIsEmptyWithoutProducedToolchainRoots(t *testing.T) {
	root := t.TempDir()
	view, err := NewDefaultDependencyRegistry().Resolve(AnalysisDependencyRequest{
		OwnerKind: "user", OwnerID: "u", UserID: "u", RuntimeID: "cpp:13", LanguageID: "cpp",
		Paths: AnalysisDependencyPaths{AllowedRoots: []string{root}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Mounts) != 0 || len(view.DockerEnvironment) != 0 || view.PublicStatus(true, "runtime").Status != "empty" {
		t.Fatalf("unproduced native dependency view was advertised ready: %+v", view)
	}
}

func TestJavaDependencyViewIgnoresUnseededGradleHome(t *testing.T) {
	root := t.TempDir()
	maven := makeDependencyDir(t, filepath.Join(root, "cache-v2", "maven"))
	gradle := makeDependencyDir(t, filepath.Join(root, "cache-v2", "gradle"))
	request := personalDependencyRequest(root, "java", "java:21")
	request.Paths.Extra = map[string][]string{
		DependencyRoleJavaMaven:  {maven},
		DependencyRoleJavaGradle: {gradle},
	}
	view, err := NewDefaultDependencyRegistry().Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Mounts) != 1 || view.Mounts[0].HostPath != maven || view.Mounts[0].Role != DependencyRoleJavaMaven {
		t.Fatalf("empty Gradle home became an analysis dependency: %+v", view.Mounts)
	}
	if _, exists := view.DockerEnvironment["GRADLE_RO_DEP_CACHE"]; exists {
		t.Fatalf("empty Gradle cache was advertised: %+v", view.DockerEnvironment)
	}
}

func TestJavaDependencyViewRequiresCompletedPrivateGradleSnapshot(t *testing.T) {
	root := t.TempDir()
	persist := makeDependencyDir(t, filepath.Join(root, "persist"))
	activeModules := makeDependencyDir(t, filepath.Join(persist, "gradle", "caches", "modules-2"))
	snapshots := makeDependencyDir(t, filepath.Join(root, "snapshots"))
	generation := strings.Repeat("b", 32)
	incomplete, err := GradleDependencyGenerationRoot(snapshots, "java:21", generation)
	if err != nil {
		t.Fatal(err)
	}
	incomplete = makeDependencyDir(t, incomplete)
	makeDependencyDir(t, filepath.Join(incomplete, "modules-2"))
	if err := os.WriteFile(filepath.Join(incomplete, GradleDependencySnapshotMarker), []byte(`{"format":"bobocloud.gradle-dependency-snapshot/v1","state":"building"}`), 0600); err != nil {
		t.Fatal(err)
	}
	runtimeRoot := filepath.Dir(filepath.Dir(incomplete))
	if err := os.WriteFile(filepath.Join(runtimeRoot, GradleDependencyCurrentFile), []byte(generation+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	request := personalDependencyRequest(root, "java", "java:21")
	request.Paths.SnapshotRoot = snapshots
	view, err := NewDefaultDependencyRegistry().Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	for _, mount := range view.Mounts {
		if mount.HostPath == activeModules || mount.Role == DependencyRoleJavaGradle {
			t.Fatalf("active or incomplete Gradle cache was advertised read-only: %+v", view.Mounts)
		}
	}
	if _, found := view.DockerEnvironment["GRADLE_RO_DEP_CACHE"]; found {
		t.Fatalf("incomplete Gradle snapshot was reported ready: %+v", view.DockerEnvironment)
	}
}

func TestJavaExplicitGradleSnapshotIsNotManagedByCurrentLease(t *testing.T) {
	root := t.TempDir()
	generation := makeDependencyDir(t, filepath.Join(root, "external-generation"))
	makeDependencyDir(t, filepath.Join(generation, "modules-2"))
	if err := CompleteGradleDependencySnapshot(generation); err != nil {
		t.Fatal(err)
	}
	request := personalDependencyRequest(root, "java", "java:21")
	request.Paths.Extra = map[string][]string{DependencyRoleJavaGradle: {generation}}
	view, err := NewDefaultDependencyRegistry().Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Mounts) != 1 || view.Mounts[0].Role != DependencyRoleJavaGradle || view.Mounts[0].Managed {
		t.Fatalf("explicit Gradle source incorrectly claimed a managed generation lease: %+v", view.Mounts)
	}
}

func TestNodeDependencyViewMountsModulesAtWorkspaceResolutionPath(t *testing.T) {
	root := t.TempDir()
	workspace := makeDependencyDir(t, filepath.Join(root, "workspace"))
	modules := makeDependencyDir(t, filepath.Join(workspace, "node_modules"))
	request := personalDependencyRequest(root, "typescript", "node:20")
	request.Paths.WorkspaceRoot = workspace
	view, err := NewDefaultDependencyRegistry().Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Mounts) != 1 || view.Mounts[0].HostPath != modules || view.Mounts[0].ContainerPath != DockerWorkspaceRoot+"/node_modules" {
		t.Fatalf("Node module resolution mount = %+v", view.Mounts)
	}
	options := view.InitializationOptionsForAnalyzer(true)
	tsserver, ok := options["tsserver"].(map[string]any)
	if !ok || tsserver["path"] != typescriptServerContainer {
		t.Fatalf("TypeScript initialization options = %+v", options)
	}
	tsserver["path"] = "mutated"
	if view.InitializationOptionsForAnalyzer(true)["tsserver"].(map[string]any)["path"] != typescriptServerContainer {
		t.Fatal("TypeScript initialization options were not detached")
	}
	if view.InitializationOptionsForAnalyzer(false) != nil {
		t.Fatal("host analyzer received a toolkit-only TypeScript path")
	}
}

func TestNodeDependencyViewPrefersPublishedSnapshot(t *testing.T) {
	root := t.TempDir()
	workspaceID := "personal-folder"
	workspace := makeDependencyDir(t, filepath.Join(root, "workspace"))
	persist := makeDependencyDir(t, filepath.Join(root, "persist"))
	workspaceModules := makeDependencyDir(t, filepath.Join(workspace, "node_modules"))
	sourceModules := makeDependencyDir(t, filepath.Join(root, "source", "node_modules"))
	if err := os.WriteFile(filepath.Join(workspace, "package.json"), []byte(`{"dependencies":{"snapshot-package":"1.0.0"}}`), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceModules, "snapshot-package.js"), []byte("module.exports = 1;"), 0644); err != nil {
		t.Fatal(err)
	}
	published, err := PublishNodeDependencySnapshot(persist, workspaceID, workspace, "node:20", "node:20-slim", sourceModules)
	if err != nil {
		t.Fatal(err)
	}
	request := personalDependencyRequest(root, "typescript", "node:20")
	request.WorkspaceID = workspaceID
	request.Paths.WorkspaceRoot = workspace
	request.Paths.SnapshotRoot = persist
	view, err := NewDefaultDependencyRegistry().Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Mounts) != 1 || view.Mounts[0].HostPath != published.Path || view.Mounts[0].HostPath == workspaceModules || !view.Mounts[0].Managed {
		t.Fatalf("published Node snapshot was not preferred: %+v", view.Mounts)
	}
}

func TestDependencyViewJSONDoesNotExposeHostPaths(t *testing.T) {
	root := t.TempDir()
	packages := makeDependencyDir(t, filepath.Join(root, "cache-v2", "python"))
	request := personalDependencyRequest(root, "python", "python:3.10")
	request.Paths.Extra = map[string][]string{DependencyRolePythonPackages: {packages}}
	view, err := NewDefaultDependencyRegistry().Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), filepath.Base(root)) || strings.Contains(string(encoded), "localEnvironment") || strings.Contains(string(encoded), "localLspSettings") {
		t.Fatalf("dependency JSON exposed a host path: %s", encoded)
	}
}

func TestDependencyViewUsesHostRootWithoutPrefixOrSymlinkEscape(t *testing.T) {
	base := t.TempDir()
	root := makeDependencyDir(t, filepath.Join(base, "shared"))
	nested := makeDependencyDir(t, filepath.Join(root, "go", "pkg", "mod"))
	sibling := makeDependencyDir(t, filepath.Join(base, "shared-other"))
	view := AnalysisDependencyView{Mounts: []AnalysisDependencyMount{{HostPath: nested}}}
	if !view.UsesHostRoot(root) || !view.UsesHostRoot(nested) {
		t.Fatalf("valid dependency root was not detected: root=%q nested=%q", root, nested)
	}
	if view.UsesHostRoot(sibling) || view.UsesHostRoot(filepath.Join(base, "missing")) {
		t.Fatal("sibling prefix or missing root retained a dependency lease")
	}

	outside := makeDependencyDir(t, filepath.Join(base, "outside"))
	link := filepath.Join(root, "linked-outside")
	if err := os.Symlink(outside, link); err == nil {
		symlinkView := AnalysisDependencyView{Mounts: []AnalysisDependencyMount{{HostPath: link}}}
		if symlinkView.UsesHostRoot(root) {
			t.Fatal("a mount symlinked outside the dependency root retained its lease")
		}
	}
}

func TestWorkspaceConfigurationDependencyOwnership(t *testing.T) {
	settings := map[string]any{
		"python": map[string]any{"analysis": map[string]any{"extraPaths": []string{"/analysis-deps/python"}}},
	}
	tests := []struct {
		name    string
		payload string
		owned   bool
	}{
		{name: "dependency only", payload: `{"jsonrpc":"2.0","id":1,"method":"workspace/configuration","params":{"items":[{"section":"python"},{"section":"python.analysis"}]}}`, owned: true},
		{name: "empty items", payload: `{"jsonrpc":"2.0","id":2,"method":"workspace/configuration","params":{"items":[]}}`, owned: true},
		{name: "mixed", payload: `{"jsonrpc":"2.0","id":3,"method":"workspace/configuration","params":{"items":[{"section":"python.analysis"},{"section":"editor.formatOnSave"}]}}`},
		{name: "unknown", payload: `{"jsonrpc":"2.0","id":4,"method":"workspace/configuration","params":{"items":[{"section":"editor"}]}}`},
		{name: "whole configuration", payload: `{"jsonrpc":"2.0","id":5,"method":"workspace/configuration","params":{"items":[{"section":""}]}}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := WorkspaceConfigurationOwnedByDependencySettings([]byte(test.payload), settings); got != test.owned {
				t.Fatalf("ownership = %t, want %t", got, test.owned)
			}
		})
	}
}

func TestWorkspaceConfigurationResolvesNestedSections(t *testing.T) {
	settings := map[string]any{
		"python": map[string]any{
			"analysis": map[string]any{"extraPaths": []string{"/analysis-deps/python/site-packages"}},
		},
	}
	request := []byte(`{"jsonrpc":"2.0","id":7,"method":"workspace/configuration","params":{"items":[{"section":"python"},{"section":"python.analysis"},{"section":"missing"}]}}`)
	response, err := WorkspaceConfigurationResponse(request, settings)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		ID     int   `json:"id"`
		Result []any `json:"result"`
	}
	if err := json.Unmarshal(response, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.ID != 7 || len(decoded.Result) != 3 || decoded.Result[2] != nil {
		t.Fatalf("unexpected configuration response: %s", response)
	}
}

func TestWorkspaceConfigurationProxyDeepMergesDependencyOverrides(t *testing.T) {
	settings := map[string]any{
		"python": map[string]any{
			"analysis": map[string]any{
				"extraPaths":     []string{"/analysis-deps/shared", "/analysis-deps/server"},
				"diagnosticMode": "openFilesOnly",
				"nested":         map[string]any{"server": true, "shared": "server"},
			},
		},
	}
	request := []byte(`{"jsonrpc":"2.0","id":"config-1","method":"workspace/configuration","params":{"items":[{"scopeUri":"bobocloud-lsp:///main.py","section":"python.analysis"},{"section":"formattingOptions"}]}}`)
	proxy, err := NewWorkspaceConfigurationProxy(request, settings)
	if err != nil {
		t.Fatal(err)
	}
	if key, err := WorkspaceConfigurationResponseKey([]byte(`{"jsonrpc":"2.0","id":"config-1","result":[]}`)); err != nil || key != proxy.IDKey() {
		t.Fatalf("response key = %q, err = %v", key, err)
	}
	encodedProxy, err := json.Marshal(proxy)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encodedProxy), "/analysis-deps/") {
		t.Fatalf("proxy serialized private dependency paths: %s", encodedProxy)
	}

	clientResponse := []byte(`{"jsonrpc":"2.0","id":"config-1","result":[{"extraPaths":["/workspace/src","/analysis-deps/shared"],"typeCheckingMode":"basic","diagnosticMode":"workspace","nested":{"user":true,"shared":"user"}},{"tabSize":2,"insertSpaces":true}]}`)
	merged, err := proxy.MergeResponse(clientResponse)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Result []map[string]any `json:"result"`
	}
	if err := json.Unmarshal(merged, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Result) != 2 {
		t.Fatalf("merged result = %s", merged)
	}
	python := decoded.Result[0]
	if !reflect.DeepEqual(python["extraPaths"], []any{"/workspace/src", "/analysis-deps/shared", "/analysis-deps/server"}) {
		t.Fatalf("merged extraPaths = %+v", python["extraPaths"])
	}
	if python["typeCheckingMode"] != "basic" || python["diagnosticMode"] != "openFilesOnly" {
		t.Fatalf("map precedence = %+v", python)
	}
	if !reflect.DeepEqual(python["nested"], map[string]any{"user": true, "server": true, "shared": "server"}) {
		t.Fatalf("nested merge = %+v", python["nested"])
	}
	if !reflect.DeepEqual(decoded.Result[1], map[string]any{"tabSize": float64(2), "insertSpaces": true}) {
		t.Fatalf("unknown formattingOptions changed: %+v", decoded.Result[1])
	}
}

func TestWorkspaceConfigurationProxyRejectsAbnormalResults(t *testing.T) {
	request := []byte(`{"jsonrpc":"2.0","id":41,"method":"workspace/configuration","params":{"items":[{"section":"python.analysis"},{"section":"formattingOptions"}]}}`)
	proxy, err := NewWorkspaceConfigurationProxy(request, map[string]any{
		"python": map[string]any{"analysis": map[string]any{"extraPaths": []string{"/analysis-deps/python"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name     string
		response string
	}{
		{name: "mismatched id", response: `{"jsonrpc":"2.0","id":42,"result":[{},{}]}`},
		{name: "object result", response: `{"jsonrpc":"2.0","id":41,"result":{}}`},
		{name: "null result", response: `{"jsonrpc":"2.0","id":41,"result":null}`},
		{name: "wrong item count", response: `{"jsonrpc":"2.0","id":41,"result":[{}]}`},
		{name: "result and error", response: `{"jsonrpc":"2.0","id":41,"result":[{},{}],"error":{"code":-1,"message":"bad"}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := proxy.MergeResponse([]byte(test.response)); err == nil {
				t.Fatal("abnormal configuration result was accepted")
			}
		})
	}
	errorResponse := []byte(`{"jsonrpc":"2.0","id":41,"error":{"code":-32000,"message":"client unavailable"}}`)
	fallback, err := proxy.MergeResponse(errorResponse)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Result []any `json:"result"`
	}
	if err := json.Unmarshal(fallback, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Result) != 2 || decoded.Result[1] != nil {
		t.Fatalf("client error did not fall back to owned/null items: %s", fallback)
	}
	owned, _ := decoded.Result[0].(map[string]any)
	if !reflect.DeepEqual(owned["extraPaths"], []any{"/analysis-deps/python"}) {
		t.Fatalf("client error dropped dependency override: %s", fallback)
	}
}

func TestWorkspaceConfigurationProxyNormalizesNumericIDs(t *testing.T) {
	for _, test := range []struct {
		requestID  string
		responseID string
	}{
		{requestID: "1e3", responseID: "1000"},
		{requestID: "1.0", responseID: "1"},
	} {
		request := []byte(`{"jsonrpc":"2.0","id":` + test.requestID + `,"method":"workspace/configuration","params":{"items":[{"section":"formattingOptions"}]}}`)
		proxy, err := NewWorkspaceConfigurationProxy(request, nil)
		if err != nil {
			t.Fatal(err)
		}
		response := []byte(`{"jsonrpc":"2.0","id":` + test.responseID + `,"result":[{"tabSize":2}]}`)
		key, err := WorkspaceConfigurationResponseKey(response)
		if err != nil || key != proxy.IDKey() {
			t.Fatalf("numeric IDs %s/%s did not match: key=%q proxy=%q err=%v", test.requestID, test.responseID, key, proxy.IDKey(), err)
		}
		if _, err := proxy.MergeResponse(response); err != nil {
			t.Fatalf("numeric IDs %s/%s did not merge: %v", test.requestID, test.responseID, err)
		}
	}
}

func TestDependencyRequestRejectsCrossOwnerAndRuntimeMismatch(t *testing.T) {
	registry := NewDefaultDependencyRegistry()
	_, err := registry.Resolve(AnalysisDependencyRequest{OwnerKind: "user", OwnerID: "other", UserID: "user", RuntimeID: "python:3.10", LanguageID: "python"})
	if err == nil || !strings.Contains(err.Error(), "match user") {
		t.Fatalf("cross-owner error = %v", err)
	}
	_, err = registry.Resolve(AnalysisDependencyRequest{OwnerKind: "user", UserID: "user", RuntimeID: "node:20", LanguageID: "python"})
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("runtime mismatch error = %v", err)
	}
	if _, err := registry.Resolve(AnalysisDependencyRequest{OwnerKind: "user", UserID: "user", RuntimeID: "c:13", LanguageID: "cpp"}); err != nil {
		t.Fatalf("C and C++ runtime families should interoperate: %v", err)
	}
}

func TestDependencyRegistrySupportsFutureLanguageAdapter(t *testing.T) {
	registry, err := NewDependencyRegistry(testDependencyAdapter{name: "dotnet", languages: []string{"csharp"}})
	if err != nil {
		t.Fatal(err)
	}
	view, err := registry.Resolve(AnalysisDependencyRequest{OwnerKind: "user", UserID: "user", RuntimeID: "local", LanguageID: "csharp"})
	if err != nil {
		t.Fatal(err)
	}
	if view.Metadata.Adapter != "dotnet" || view.Revision == "" {
		t.Fatalf("future adapter view = %+v", view)
	}
}
