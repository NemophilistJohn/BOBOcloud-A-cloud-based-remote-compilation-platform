package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/lifecycle"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
)

type projectEnvironmentEnvelope struct {
	Success bool            `json:"success"`
	Error   string          `json:"error"`
	Data    json.RawMessage `json:"data"`
}

func newProjectEnvironmentTestHandler(t *testing.T) (*HTTPHandler, string, string) {
	t.Helper()
	root := t.TempDir()
	serverRoot := filepath.Join(root, "workspaces")
	dataRoot := filepath.Join(root, "data")
	if err := os.MkdirAll(serverRoot, 0755); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.ServerRoot = serverRoot
	cfg.DataDir = dataRoot
	handler := NewHTTPHandler(cfg, storage.NewMemorySessionStore(), session.NewChannelManager(), false, nil, nil, nil, nil, nil)
	return handler, serverRoot, dataRoot
}

func callProjectEnvironment(t *testing.T, handler http.Handler, body string) (*httptest.ResponseRecorder, projectEnvironmentEnvelope) {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(recorder, request)
	var envelope projectEnvironmentEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode response: %v\n%s", err, recorder.Body.String())
	}
	return recorder, envelope
}

func writeEnvironmentFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func writePythonDistInfo(t *testing.T, root, name, version string) {
	t.Helper()
	directory := filepath.Join(root, strings.ReplaceAll(name, "-", "_")+"-"+version+".dist-info")
	writeEnvironmentFile(t, filepath.Join(directory, "METADATA"), "Metadata-Version: 2.1\nName: "+name+"\nVersion: "+version+"\n")
	module := strings.NewReplacer("-", "_", ".", "_").Replace(strings.ToLower(name))
	writeEnvironmentFile(t, filepath.Join(root, module, "__init__.py"), "__version__ = '"+version+"'\n")
	distInfo := filepath.Base(directory)
	record := module + "/__init__.py,,\n" + distInfo + "/METADATA,,\n" + distInfo + "/RECORD,,\n"
	writeEnvironmentFile(t, filepath.Join(directory, "RECORD"), record)
}

func TestGetProjectEnvironmentUsesOnlySelectedPythonRuntimeScope(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "requirements.txt"), "numpy==2.1.0\nrequests>=2\n")
	selected := filepath.Join(dataRoot, "users", "default", "persist", "pip-packages", "runtimes", "python-3.10")
	other := filepath.Join(dataRoot, "users", "default", "persist", "pip-packages", "runtimes", "python-3.11")
	writePythonDistInfo(t, selected, "numpy", "2.1.0")
	writePythonDistInfo(t, other, "requests", "2.32.0")

	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"getProjectEnvironment","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
	if recorder.Code != http.StatusOK || !envelope.Success {
		t.Fatalf("status=%d response=%s", recorder.Code, recorder.Body.String())
	}
	var environment model.ProjectEnvironment
	if err := json.Unmarshal(envelope.Data, &environment); err != nil {
		t.Fatal(err)
	}
	if environment.Schema != projectEnvironmentSchema || environment.Runtime.Image != "python:3.10-slim" {
		t.Fatalf("unexpected contract/runtime: %+v", environment)
	}
	if len(environment.Packages.Installed) != 1 || environment.Packages.Installed[0].Name != "numpy" || environment.Packages.Installed[0].Version != "2.1.0" {
		t.Fatalf("selected runtime packages = %+v", environment.Packages.Installed)
	}
	if len(environment.Packages.Missing) != 1 || environment.Packages.Missing[0].Name != "requests" {
		t.Fatalf("missing packages = %+v", environment.Packages.Missing)
	}
	if len(environment.Packages.Unknown) != 0 {
		t.Fatalf("trusted Python scope produced unknown packages: %+v", environment.Packages.Unknown)
	}
	if environment.Consistency.LanguageRuntime.Status != "aligned" || !strings.Contains(environment.Consistency.LanguageRuntime.Detail, "python:3.10") {
		t.Fatalf("language/runtime check lacks status or detail: %+v", environment.Consistency.LanguageRuntime)
	}
	if environment.Consistency.DependencyRuntime.Status != "mismatch" || !strings.Contains(environment.Consistency.DependencyRuntime.Detail, "missing 1") {
		t.Fatalf("dependency/runtime check lacks exact installed truth: %+v", environment.Consistency.DependencyRuntime)
	}
	if environment.Consistency.LSPDependencies.Status != "unavailable" || !strings.Contains(environment.Consistency.LSPDependencies.Detail, "registry") {
		t.Fatalf("LSP dependency check lacks unavailable reason: %+v", environment.Consistency.LSPDependencies)
	}
	if !environment.Actions.Repair.Supported || !environment.Actions.Rebuild.Supported {
		t.Fatalf("Python requirements actions unavailable: %+v", environment.Actions)
	}
}

func TestProjectEnvironmentExactPythonVersionMismatchAndUnknown(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "project-key")
	manifest := filepath.Join(workspace, "requirements.txt")
	installed := filepath.Join(dataRoot, "users", "default", "persist", "pip-packages", "runtimes", "python-3.10")
	writeEnvironmentFile(t, manifest, "numpy>=2.2,<3\n")
	writePythonDistInfo(t, installed, "numpy", "2.1.0")

	_, envelope := callProjectEnvironment(t, handler, `{"action":"getProjectEnvironment","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
	var environment model.ProjectEnvironment
	if err := json.Unmarshal(envelope.Data, &environment); err != nil {
		t.Fatal(err)
	}
	if len(environment.Packages.Missing) != 1 || len(environment.Packages.Unknown) != 0 || environment.Consistency.DependencyRuntime.Status != "mismatch" || !strings.Contains(environment.Packages.Missing[0].Reason, "2.1.0") {
		t.Fatalf("exact version mismatch was not surfaced: %+v", environment)
	}

	writeEnvironmentFile(t, manifest, "numpy^2.2\n")
	_, envelope = callProjectEnvironment(t, handler, `{"action":"getProjectEnvironment","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
	environment = model.ProjectEnvironment{}
	if err := json.Unmarshal(envelope.Data, &environment); err != nil {
		t.Fatal(err)
	}
	if len(environment.Packages.Missing) != 0 || len(environment.Packages.Unknown) != 1 || environment.Consistency.DependencyRuntime.Status != "unknown" || !strings.Contains(environment.Packages.Unknown[0].Reason, "unsupported operator") {
		t.Fatalf("unparseable exact constraint was not downgraded: %+v", environment)
	}
}

func TestProjectEnvironmentUsesOnlyCurrentProjectLockDigest(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "project-key")
	manifest := filepath.Join(workspace, "requirements.txt")
	writeEnvironmentFile(t, manifest, "numpy==2.1.0\n")
	handler.PersonalCache = personalcache.NewManager(dataRoot, personalcache.Options{ReservationBytes: 8})
	handler.DependencyViews = lsp.NewDefaultDependencyRegistry()
	request := personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), WorkspaceName: "Project",
		RuntimeID: "python:3.10", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.10", "python:3.10-slim"), Language: "python", WorkspaceRoot: workspace,
	}
	lease, err := handler.PersonalCache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writePythonDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.1.0")
	lease.Release()

	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"getProjectEnvironment","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
	if recorder.Code != http.StatusOK || !envelope.Success {
		t.Fatalf("status=%d response=%s", recorder.Code, recorder.Body.String())
	}
	var environment model.ProjectEnvironment
	if err := json.Unmarshal(envelope.Data, &environment); err != nil {
		t.Fatal(err)
	}
	if environment.DependencyCache.Status != "hit" || environment.DependencyCache.Scope != "project-lock" || len(environment.Packages.Installed) != 1 {
		t.Fatalf("current digest was not reported as exact cache truth: %+v", environment)
	}
	if environment.Consistency.LSPDependencies.Status != "ready" {
		t.Fatalf("environment status did not resolve the exact project dependency view: %+v", environment.Consistency.LSPDependencies)
	}

	writeEnvironmentFile(t, manifest, "numpy==2.2.0\n")
	_, envelope = callProjectEnvironment(t, handler, `{"action":"getProjectEnvironment","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
	if err := json.Unmarshal(envelope.Data, &environment); err != nil {
		t.Fatal(err)
	}
	if environment.DependencyCache.Status != "miss" || len(environment.Packages.Installed) != 0 || len(environment.Packages.Unknown) != 1 {
		t.Fatalf("stale digest polluted the changed project: %+v", environment)
	}
}

func TestProjectEnvironmentDoesNotCallManifestlessExactInventoryHealthy(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "main.py"), "import numpy\n")
	handler.PersonalCache = personalcache.NewManager(dataRoot, personalcache.Options{ReservationBytes: 8})
	request := personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), WorkspaceName: "Project",
		RuntimeID: "python:3.10", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.10", "python:3.10-slim"), Language: "python", WorkspaceRoot: workspace,
	}
	lease, err := handler.PersonalCache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	writePythonDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.1.0")
	lease.Release()

	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"getProjectEnvironment","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
	if recorder.Code != http.StatusOK || !envelope.Success {
		t.Fatalf("response=%s", recorder.Body.String())
	}
	var environment model.ProjectEnvironment
	if err := json.Unmarshal(envelope.Data, &environment); err != nil {
		t.Fatal(err)
	}
	if environment.DependencyCache.InventoryStatus != "ready" || len(environment.Packages.Installed) != 1 {
		t.Fatalf("exact inventory was not exposed: %+v", environment)
	}
	if environment.Consistency.DependencyRuntime.Status != "unknown" || environment.Consistency.Status == "aligned" || !strings.Contains(environment.Consistency.DependencyRuntime.Detail, "no parseable dependency declarations") {
		t.Fatalf("manifestless project was reported healthy: %+v", environment.Consistency)
	}
}

func TestProjectEnvironmentDowngradesCorruptAndStalePackageInventories(t *testing.T) {
	for _, test := range []struct {
		name       string
		mutate     func(t *testing.T, cacheRoot string)
		wantStatus string
	}{
		{
			name: "missing snapshot",
			mutate: func(t *testing.T, cacheRoot string) {
				if err := os.Remove(filepath.Join(cacheRoot, ".package-inventory.json")); err != nil {
					t.Fatal(err)
				}
			},
			wantStatus: "missing",
		},
		{
			name: "corrupt snapshot",
			mutate: func(t *testing.T, cacheRoot string) {
				writeEnvironmentFile(t, filepath.Join(cacheRoot, ".package-inventory.json"), "{not-json")
			},
			wantStatus: "corrupt",
		},
		{
			name: "incomplete package metadata",
			mutate: func(t *testing.T, cacheRoot string) {
				writeEnvironmentFile(t, filepath.Join(cacheRoot, "python", "numpy-2.1.0.dist-info", "METADATA"), "Name: numpy\n")
			},
			wantStatus: "incomplete",
		},
		{
			name: "package tree changed after snapshot",
			mutate: func(t *testing.T, cacheRoot string) {
				if err := os.RemoveAll(filepath.Join(cacheRoot, "python", "numpy-2.1.0.dist-info")); err != nil {
					t.Fatal(err)
				}
			},
			wantStatus: "incomplete",
		},
		{
			name: "recorded package files disappeared",
			mutate: func(t *testing.T, cacheRoot string) {
				if err := os.RemoveAll(filepath.Join(cacheRoot, "python", "numpy")); err != nil {
					t.Fatal(err)
				}
			},
			wantStatus: "incomplete",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
			workspace := filepath.Join(serverRoot, "project-key")
			writeEnvironmentFile(t, filepath.Join(workspace, "requirements.txt"), "numpy==2.1.0\n")
			handler.PersonalCache = personalcache.NewManager(dataRoot, personalcache.Options{ReservationBytes: 8})
			request := personalcache.Request{
				UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), WorkspaceName: "Project",
				RuntimeID: "python:3.10", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.10", "python:3.10-slim"), Language: "python", WorkspaceRoot: workspace,
			}
			lease, err := handler.PersonalCache.Prepare(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			writePythonDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.1.0")
			cacheRoot := lease.HostRoot
			lease.Release()
			test.mutate(t, cacheRoot)

			_, envelope := callProjectEnvironment(t, handler, `{"action":"getProjectEnvironment","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
			var environment model.ProjectEnvironment
			if err := json.Unmarshal(envelope.Data, &environment); err != nil {
				t.Fatal(err)
			}
			if environment.DependencyCache.InventoryStatus != test.wantStatus || environment.Consistency.DependencyRuntime.Status != "unknown" || environment.Consistency.Status == "aligned" {
				t.Fatalf("invalid inventory was reported healthy: %+v", environment)
			}
		})
	}
}

func TestNodeInstalledInspectionRejectsPartialPackageTrees(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "react"), 0700); err != nil {
		t.Fatal(err)
	}
	if packages, _, exact := inspectNodeInstalled(root); exact || len(packages) != 0 {
		t.Fatalf("partial node_modules was trusted: packages=%+v exact=%v", packages, exact)
	}
	writeEnvironmentFile(t, filepath.Join(root, "react", "package.json"), `{"name":"react","version":"19.0.0"}`)
	packages, _, exact := inspectNodeInstalled(root)
	if !exact || len(packages) != 1 || packages[0].Name != "react" {
		t.Fatalf("complete node_modules was not trusted: packages=%+v exact=%v", packages, exact)
	}
}

func TestProjectEnvironmentDoesNotInspectActiveNodeCacheAsExact(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "package.json"), `{"dependencies":{"react":"^19"}}`)
	handler.PersonalCache = personalcache.NewManager(dataRoot, personalcache.Options{ReservationBytes: 8})
	request := personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), WorkspaceName: "Project",
		RuntimeID: "node:20", RuntimeFingerprint: personalCacheRuntimeFingerprint("node:20", "node:20-slim"), Language: "node", WorkspaceRoot: workspace,
	}
	lease, err := handler.PersonalCache.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	writeEnvironmentFile(t, filepath.Join(lease.HostRoot, "node_modules", "react", "package.json"), `{"name":"react","version":"19.0.0"}`)

	_, envelope := callProjectEnvironment(t, handler, `{"action":"getProjectEnvironment","folderName":"Project","folderKey":"project-key","runtime":"node:20","language":"node"}`)
	var environment model.ProjectEnvironment
	if err := json.Unmarshal(envelope.Data, &environment); err != nil {
		t.Fatal(err)
	}
	if environment.DependencyCache.InventoryStatus != "busy" || environment.Consistency.DependencyRuntime.Status != "unknown" || len(environment.Packages.Installed) != 0 {
		t.Fatalf("active Node cache was trusted: %+v", environment)
	}
}

func TestProjectEnvironmentLSPCheckReportsSourceStatusAndRuntime(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "requirements.txt"), "numpy==2.1.0\n")
	writePythonDistInfo(t, filepath.Join(dataRoot, "users", "default", "persist", "pip-packages", "runtimes", "python-3.10"), "numpy", "2.1.0")
	handler.DependencyViews = lsp.NewDefaultDependencyRegistry()

	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"getProjectEnvironment","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
	if recorder.Code != http.StatusOK || !envelope.Success {
		t.Fatalf("status=%d response=%s", recorder.Code, recorder.Body.String())
	}
	var environment model.ProjectEnvironment
	if err := json.Unmarshal(envelope.Data, &environment); err != nil {
		t.Fatal(err)
	}
	check := environment.Consistency.LSPDependencies
	if check.Status != "ready" || !strings.Contains(check.Detail, "from user") || !strings.Contains(check.Detail, "runtime python:3.10") {
		t.Fatalf("LSP dependency detail = %+v", check)
	}
	if environment.Consistency.Status != "aligned" {
		t.Fatalf("fully known environment should align: %+v", environment.Consistency)
	}
	if environment.Actions.Repair.Supported || environment.Actions.Repair.Reason != "No repairable dependency issues were found" {
		t.Fatalf("no-op repair should be disabled: %+v", environment.Actions.Repair)
	}
	if !environment.Actions.Rebuild.Supported {
		t.Fatalf("explicit rebuild should remain supported: %+v", environment.Actions.Rebuild)
	}
	_, planEnvelope := callProjectEnvironment(t, handler, `{"action":"planProjectEnvironmentRepair","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","environmentAction":"repair"}`)
	var plan model.ProjectEnvironmentRepairPlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if plan.Supported || plan.Reason != "No repairable dependency issues were found" {
		t.Fatalf("no-op repair plan should be disabled: %+v", plan)
	}
}

func TestEnvironmentManifestsCoverNodeGoRustJavaAndUnknownClassification(t *testing.T) {
	root := t.TempDir()
	writeEnvironmentFile(t, filepath.Join(root, "web", "package.json"), `{"dependencies":{"react":"^19.0.0"},"devDependencies":{"vitest":"^3.0.0"}}`)
	writeEnvironmentFile(t, filepath.Join(root, "go.mod"), "module example.test/app\nrequire (\n github.com/google/uuid v1.6.0\n)\n")
	writeEnvironmentFile(t, filepath.Join(root, "native", "Cargo.toml"), "[package]\nname='native'\nversion='0.1.0'\n[dependencies]\nserde = \"1.0\"\n")
	writeEnvironmentFile(t, filepath.Join(root, "java", "pom.xml"), "<project><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.16</version></dependency></dependencies></project>")
	writeEnvironmentFile(t, filepath.Join(root, "java", "build.gradle.kts"), "plugins { java }\n")

	manifests, declared, _, err := inspectEnvironmentManifests(root, "")
	if err != nil {
		t.Fatal(err)
	}
	wantManifests := map[string]bool{"web/package.json": false, "go.mod": false, "native/Cargo.toml": false, "java/pom.xml": false, "java/build.gradle.kts": false}
	for _, manifest := range manifests {
		if _, exists := wantManifests[manifest.Path]; exists {
			wantManifests[manifest.Path] = true
		}
	}
	for path, found := range wantManifests {
		if !found {
			t.Errorf("manifest %s was not recognized: %+v", path, manifests)
		}
	}
	wantPackages := map[string]bool{"react": false, "vitest": false, "github.com/google/uuid": false, "serde": false, "org.slf4j:slf4j-api": false}
	for _, item := range declared {
		if _, exists := wantPackages[item.Name]; exists {
			wantPackages[item.Name] = true
		}
	}
	for name, found := range wantPackages {
		if !found {
			t.Errorf("declared package %s was not parsed: %+v", name, declared)
		}
	}
	classified := classifyEnvironmentPackages([]model.ProjectEnvironmentPackage{{Name: "github.com/google/uuid", Source: "go.mod"}}, []model.ProjectEnvironmentPackage{{Name: "github.com/google/uuid", Version: "v1.6.0", Source: "go-module-cache"}}, "go", false)
	if len(classified.Missing) != 0 || len(classified.Unknown) != 0 {
		t.Fatalf("observed installed dependency should be satisfied: %+v", classified)
	}
	classified = classifyEnvironmentPackages([]model.ProjectEnvironmentPackage{{Name: "example.test/missing", Source: "go.mod"}}, nil, "go", false)
	if len(classified.Missing) != 0 || len(classified.Unknown) != 1 {
		t.Fatalf("untrusted installed state must be unknown, not missing: %+v", classified)
	}
}

func TestClassifyExactPythonVersionConstraints(t *testing.T) {
	tests := []struct {
		name, constraint, installed, outcome string
	}{
		{name: "all comparison operators and compatible release", constraint: ">=1.4,>1.3,<=1.4.5,<1.5,!=1.4.4,~=1.4.0", installed: "1.4.5+cpu", outcome: "matched"},
		{name: "compatible release rejects next feature", constraint: "~=1.4.5", installed: "1.5.0", outcome: "missing"},
		{name: "epoch participates in ordering", constraint: ">=1!2.0,<2!0", installed: "1!9.0", outcome: "matched"},
		{name: "explicit prerelease range", constraint: ">=2.0rc1,<2.0", installed: "2.0rc2", outcome: "matched"},
		{name: "implicit prerelease excluded", constraint: ">=2.0", installed: "2.1rc1", outcome: "missing"},
		{name: "public equality accepts local build", constraint: "==1.0", installed: "1.0+linux.1", outcome: "matched"},
		{name: "local equality compares normalized labels", constraint: "==1.0+linux.1", installed: "1.0+linux-1", outcome: "matched"},
		{name: "unsupported constraint", constraint: "^1.2", installed: "1.2", outcome: "unknown"},
		{name: "wildcard outside supported exact subset", constraint: "==1.2.*", installed: "1.2.3", outcome: "unknown"},
		{name: "unparseable installed version", constraint: ">=1.0", installed: "vendor-release", outcome: "unknown"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			declared := []model.ProjectEnvironmentPackage{{Name: "Example_Package", Constraint: test.constraint, Source: "requirements.txt"}}
			installed := []model.ProjectEnvironmentPackage{{Name: "example-package", Version: test.installed, Source: "exact-inventory", Trust: "exact"}}
			classified := classifyEnvironmentPackages(declared, installed, "python", true)
			switch test.outcome {
			case "matched":
				if len(classified.Missing) != 0 || len(classified.Unknown) != 0 {
					t.Fatalf("constraint should match: %+v", classified)
				}
			case "missing":
				if len(classified.Missing) != 1 || len(classified.Unknown) != 0 || !strings.Contains(classified.Missing[0].Reason, "does not satisfy") {
					t.Fatalf("constraint mismatch was not explained: %+v", classified)
				}
			case "unknown":
				if len(classified.Missing) != 0 || len(classified.Unknown) != 1 || !strings.Contains(classified.Unknown[0].Reason, "verif") {
					t.Fatalf("unverifiable constraint/version was not unknown: %+v", classified)
				}
			}
		})
	}
}

func TestParsePyprojectPreservesCommaSeparatedPythonConstraint(t *testing.T) {
	items, err := parsePyproject([]byte("[project]\ndependencies = [\n  \"requests[socks]>=2,<3\",\n  'numpy~=2.1',\n]\n"), "pyproject.toml")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].Name != "requests" || items[0].Constraint != ">=2,<3" || items[1].Name != "numpy" || items[1].Constraint != "~=2.1" {
		t.Fatalf("PEP 621 dependency strings were split incorrectly: %+v", items)
	}
	if _, err := parsePyproject([]byte("[project]\ndependencies = [\"numpy>=2\", \"requests<3]\n"), "pyproject.toml"); err == nil {
		t.Fatal("unterminated PEP 621 dependency string was accepted")
	}
}

func TestExactPythonVersionUnknownPreventsAlignedEnvironment(t *testing.T) {
	packages := classifyEnvironmentPackages(
		[]model.ProjectEnvironmentPackage{{Name: "numpy", Constraint: "~=not-a-version", Source: "requirements.txt"}},
		[]model.ProjectEnvironmentPackage{{Name: "numpy", Version: "2.1.0", Source: "exact-inventory", Trust: "exact"}},
		"python", true,
	)
	check := projectEnvironmentDependencyRuntimeCheck(model.ProjectEnvironmentRuntime{ID: "python:3.10"}, "python", packages, true, "personal", "ready", "")
	if len(packages.Unknown) != 1 || len(packages.Missing) != 0 || check.Status != "unknown" || !strings.Contains(check.Detail, "cannot verify 1") {
		t.Fatalf("unparseable exact constraint was falsely aligned: packages=%+v check=%+v", packages, check)
	}
}

func TestUntrustedPythonInventoryDoesNotClaimVersionTruth(t *testing.T) {
	classified := classifyEnvironmentPackages(
		[]model.ProjectEnvironmentPackage{{Name: "numpy", Constraint: ">=99", Source: "requirements.txt"}},
		[]model.ProjectEnvironmentPackage{{Name: "numpy", Version: "1.0", Source: "observed", Trust: "observed"}},
		"python", false,
	)
	if len(classified.Missing) != 0 || len(classified.Unknown) != 0 {
		t.Fatalf("observational package presence should not be presented as an exact version mismatch: %+v", classified)
	}
}

func TestProjectEnvironmentPlanAndApplyIgnoreClientCommand(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "requirements.txt"), "numpy==2.1.0\n")
	var received []string
	handler.EnvironmentSetup = func(_ context.Context, _, runtimeID, workspaceRoot string, commands []string) (string, string, int, error) {
		received = append([]string(nil), commands...)
		if runtimeID != "python:3.10" || filepath.Clean(workspaceRoot) != filepath.Clean(workspace) {
			t.Fatalf("executor scope runtime=%s workspace=%s", runtimeID, workspaceRoot)
		}
		writePythonDistInfo(t, filepath.Join(dataRoot, "users", "default", "persist", "pip-packages", "runtimes", "python-3.10"), "numpy", "2.1.0")
		return "installed", "", 0, nil
	}

	_, planEnvelope := callProjectEnvironment(t, handler, `{"action":"planProjectEnvironmentRepair","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","environmentAction":"repair"}`)
	var plan model.ProjectEnvironmentRepairPlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if !plan.Supported || len(plan.Steps) != 1 || plan.Steps[0].Command != "" {
		t.Fatalf("public repair plan = %+v", plan)
	}

	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"applyProjectEnvironmentAction","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","environmentAction":"repair","command":"rm -rf /"}`)
	if recorder.Code != http.StatusOK || !envelope.Success {
		t.Fatalf("apply response: %s", recorder.Body.String())
	}
	if len(received) != 1 || received[0] != "python3 -m pip install -r 'requirements.txt'" {
		t.Fatalf("executor received non-server plan: %#v", received)
	}
	var result model.ProjectEnvironmentActionResult
	if err := json.Unmarshal(envelope.Data, &result); err != nil {
		t.Fatal(err)
	}
	if !result.Applied || result.Environment == nil || len(result.Environment.Packages.Missing) != 0 {
		t.Fatalf("apply did not close verification loop: %+v", result)
	}
}

func TestProjectEnvironmentApplyRejectsStaleRevisionBeforeExecution(t *testing.T) {
	handler, serverRoot, _ := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "requirements.txt"), "numpy==2.1.0\n")
	executed := false
	handler.EnvironmentSetup = func(_ context.Context, _, _, _ string, _ []string) (string, string, int, error) {
		executed = true
		return "", "", 0, nil
	}

	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"applyProjectEnvironmentAction","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","environmentAction":"repair","revision":"stale-revision"}`)
	if recorder.Code != http.StatusConflict || envelope.Success || !strings.Contains(envelope.Error, "changed after") {
		t.Fatalf("stale revision response: %s", recorder.Body.String())
	}
	if executed {
		t.Fatal("stale plan reached the environment executor")
	}
	var current model.ProjectEnvironment
	if err := json.Unmarshal(envelope.Data, &current); err != nil {
		t.Fatal(err)
	}
	if current.Revision == "" || current.Revision == "stale-revision" {
		t.Fatalf("stale response omitted current snapshot: %+v", current)
	}
}

func TestProjectEnvironmentTeamActionsNeverUsePersonalPersistence(t *testing.T) {
	environment := &model.ProjectEnvironment{
		Workspace: model.ProjectEnvironmentWorkspace{Kind: "team", TeamID: "team-a", ProjectID: "project-a"},
		Language:  model.ProjectEnvironmentLanguage{ID: "python"},
		Runtime:   model.ProjectEnvironmentRuntime{ID: "python:3.10", Language: "python", Status: "ready"},
		Manifests: []model.ProjectEnvironmentManifest{{Path: "requirements.txt", Kind: "requirements", Manager: "pip", Language: "python", Parsed: true}},
		Packages: model.ProjectEnvironmentPackages{
			Declared:  []model.ProjectEnvironmentPackage{{Name: "numpy", Source: "requirements.txt"}},
			Missing:   []model.ProjectEnvironmentPackage{{Name: "numpy", Source: "requirements.txt"}},
			Installed: []model.ProjectEnvironmentPackage{}, Unknown: []model.ProjectEnvironmentPackage{},
		},
		Consistency: model.ProjectEnvironmentConsistency{DependencyRuntime: model.ProjectEnvironmentCheck{Status: "unknown"}},
	}
	for _, action := range []string{"repair", "rebuild"} {
		plan := buildProjectEnvironmentPlan(environment, "", action)
		if plan.Supported || !strings.Contains(plan.Reason, "team dependency caches") {
			t.Fatalf("team %s could write personal persistence: %+v", action, plan)
		}
	}
	handler, _, _ := newProjectEnvironmentTestHandler(t)
	actions := handler.projectEnvironmentCapabilities(environment, nil)
	if actions.Repair.Supported || actions.Rebuild.Supported {
		t.Fatalf("team capabilities exposed personal setup: %+v", actions)
	}
}

func TestProjectEnvironmentApplyRequiresExactPythonVerification(t *testing.T) {
	handler, serverRoot, _ := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "requirements.txt"), "numpy==2.1.0\n")
	handler.EnvironmentSetup = func(_ context.Context, _, _, _ string, _ []string) (string, string, int, error) {
		return "installer exited successfully without publishing exact package metadata", "", 0, nil
	}

	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"applyProjectEnvironmentAction","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","environmentAction":"repair"}`)
	if recorder.Code != http.StatusConflict || envelope.Success || !strings.Contains(envelope.Error, "verification") {
		t.Fatalf("untrusted verification response: %s", recorder.Body.String())
	}
	var result model.ProjectEnvironmentActionResult
	if err := json.Unmarshal(envelope.Data, &result); err != nil {
		t.Fatal(err)
	}
	if result.Applied || result.Environment == nil || result.Environment.Consistency.DependencyRuntime.Status != "unknown" || len(result.Environment.Packages.Unknown) != 1 {
		t.Fatalf("untrusted Python state falsely applied: %+v", result)
	}
}

func TestProjectEnvironmentRebuildClearsOnlySelectedRuntime(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "requirements.txt"), "numpy==2.1.0\n")
	selected := filepath.Join(dataRoot, "users", "default", "persist", "pip-packages", "runtimes", "python-3.10")
	other := filepath.Join(dataRoot, "users", "default", "persist", "pip-packages", "runtimes", "python-3.11")
	writePythonDistInfo(t, selected, "old-package", "1.0")
	writePythonDistInfo(t, other, "keep-package", "1.0")
	handler.EnvironmentSetup = func(_ context.Context, _, _, _ string, _ []string) (string, string, int, error) {
		if _, err := os.Stat(selected); !os.IsNotExist(err) {
			t.Fatalf("selected runtime was not reset before setup: %v", err)
		}
		if _, err := os.Stat(other); err != nil {
			t.Fatalf("another runtime was removed: %v", err)
		}
		writePythonDistInfo(t, selected, "numpy", "2.1.0")
		return "rebuilt", "", 0, nil
	}
	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"applyProjectEnvironmentAction","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","environmentAction":"rebuild"}`)
	if recorder.Code != http.StatusOK || !envelope.Success {
		t.Fatalf("rebuild response: %s", recorder.Body.String())
	}
}

func TestProjectEnvironmentApplyHoldsLifecycleLeaseThroughSetup(t *testing.T) {
	t.Run("repair holds workspace activity", func(t *testing.T) {
		handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
		handler.Lifecycle = lifecycle.NewManager()
		workspace := filepath.Join(serverRoot, "project-key")
		writeEnvironmentFile(t, filepath.Join(workspace, "requirements.txt"), "numpy==2.1.0\n")
		handler.EnvironmentSetup = func(_ context.Context, _, _, _ string, _ []string) (string, string, int, error) {
			if lease, err := handler.Lifecycle.BeginWorkspaceMutation("default", "project-key"); err == nil {
				lease.Release()
				t.Fatal("repair released its workspace activity before setup completed")
			}
			writePythonDistInfo(t, filepath.Join(dataRoot, "users", "default", "persist", "pip-packages", "runtimes", "python-3.10"), "numpy", "2.1.0")
			return "installed", "", 0, nil
		}
		recorder, envelope := callProjectEnvironment(t, handler, `{"action":"applyProjectEnvironmentAction","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","environmentAction":"repair"}`)
		if recorder.Code != http.StatusOK || !envelope.Success {
			t.Fatalf("repair response: %s", recorder.Body.String())
		}
		lease, err := handler.Lifecycle.BeginWorkspaceMutation("default", "project-key")
		if err != nil {
			t.Fatalf("repair did not release lifecycle lease: %v", err)
		}
		lease.Release()
	})

	t.Run("rebuild holds user mutation", func(t *testing.T) {
		handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
		handler.Lifecycle = lifecycle.NewManager()
		workspace := filepath.Join(serverRoot, "project-key")
		writeEnvironmentFile(t, filepath.Join(workspace, "requirements.txt"), "numpy==2.1.0\n")
		handler.EnvironmentSetup = func(_ context.Context, _, _, _ string, _ []string) (string, string, int, error) {
			if lease, err := handler.Lifecycle.AcquireActivity("default", "other-project"); err == nil {
				lease.Release()
				t.Fatal("rebuild released its user mutation before setup completed")
			}
			writePythonDistInfo(t, filepath.Join(dataRoot, "users", "default", "persist", "pip-packages", "runtimes", "python-3.10"), "numpy", "2.1.0")
			return "rebuilt", "", 0, nil
		}
		recorder, envelope := callProjectEnvironment(t, handler, `{"action":"applyProjectEnvironmentAction","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","environmentAction":"rebuild"}`)
		if recorder.Code != http.StatusOK || !envelope.Success {
			t.Fatalf("rebuild response: %s", recorder.Body.String())
		}
		lease, err := handler.Lifecycle.AcquireActivity("default", "other-project")
		if err != nil {
			t.Fatalf("rebuild did not release lifecycle lease: %v", err)
		}
		lease.Release()
	})

	t.Run("rebuild stops LSP activity before user mutation", func(t *testing.T) {
		handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
		handler.Lifecycle = lifecycle.NewManager()
		workspace := filepath.Join(serverRoot, "project-key")
		writeEnvironmentFile(t, filepath.Join(workspace, "requirements.txt"), "numpy==2.1.0\n")
		catalog, err := lsp.NewCatalog(lsp.Manifest{Version: 1, Servers: []lsp.ServerSpec{{LanguageID: "python", Command: []string{"pyright-langserver", "--stdio"}}}})
		if err != nil {
			t.Fatal(err)
		}
		starter := &bridgeTestStarter{launches: make(chan lsp.LaunchSpec, 1), inbound: make(chan []byte, 4)}
		manager := lsp.NewManager(catalog, lsp.NewCacheManager(filepath.Join(t.TempDir(), "lsp-cache"), 16, 7), starter, lsp.ManagerOptions{CleanupInterval: time.Hour})
		defer manager.Close()
		handler.LSP = manager
		activity, err := handler.Lifecycle.AcquireActivity("default", "project-key")
		if err != nil {
			t.Fatal(err)
		}
		session, err := manager.Start(lsp.SessionContext{
			UserID: "default", WorkspaceKind: "personal", FolderKey: "project-key", RuntimeID: "python:3.10", RuntimeImage: "python:3.10-slim",
			LanguageID: "python", Mode: lsp.ModeStandard, RemoteRoot: workspace, DependencyStoreRelease: activity.Release,
		})
		if err != nil {
			activity.Release()
			t.Fatal(err)
		}
		handler.EnvironmentSetup = func(_ context.Context, _, _, _ string, _ []string) (string, string, int, error) {
			select {
			case <-session.ResourcesDone():
			default:
				t.Fatal("rebuild entered setup before LSP resources were released")
			}
			if lease, leaseErr := handler.Lifecycle.AcquireActivity("default", "new-project"); leaseErr == nil {
				lease.Release()
				t.Fatal("rebuild did not acquire user mutation after stopping LSP")
			}
			writePythonDistInfo(t, filepath.Join(dataRoot, "users", "default", "persist", "pip-packages", "runtimes", "python-3.10"), "numpy", "2.1.0")
			return "rebuilt", "", 0, nil
		}
		recorder, envelope := callProjectEnvironment(t, handler, `{"action":"applyProjectEnvironmentAction","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","environmentAction":"rebuild"}`)
		if recorder.Code != http.StatusOK || !envelope.Success {
			t.Fatalf("rebuild with active LSP response: %s", recorder.Body.String())
		}
	})
}

func TestProjectEnvironmentActionValidationAndNoFalseSuccess(t *testing.T) {
	handler, serverRoot, _ := newProjectEnvironmentTestHandler(t)
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "package.json"), `{"dependencies":{"react":"^19"}}`)

	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"applyProjectEnvironmentAction","folderName":"Project","folderKey":"project-key","runtime":"node:20","language":"node","environmentAction":"destroy"}`)
	if recorder.Code != http.StatusBadRequest || envelope.Success || !strings.Contains(envelope.Error, "environmentAction") {
		t.Fatalf("invalid action response: %s", recorder.Body.String())
	}
	recorder, envelope = callProjectEnvironment(t, handler, `{"action":"applyProjectEnvironmentAction","folderName":"Project","folderKey":"project-key","runtime":"node:20","language":"node","environmentAction":"repair"}`)
	if recorder.Code != http.StatusConflict || envelope.Success || !strings.Contains(envelope.Error, "currently available only for Python") {
		t.Fatalf("unsupported repair falsely succeeded: %s", recorder.Body.String())
	}
}
