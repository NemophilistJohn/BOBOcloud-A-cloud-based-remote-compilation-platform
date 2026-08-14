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
	classified := classifyEnvironmentPackages([]model.ProjectEnvironmentPackage{{Name: "github.com/google/uuid", Source: "go.mod"}}, []model.ProjectEnvironmentPackage{{Name: "github.com/google/uuid", Version: "v1.6.0", Source: "go-module-cache"}}, false)
	if len(classified.Missing) != 0 || len(classified.Unknown) != 0 {
		t.Fatalf("observed installed dependency should be satisfied: %+v", classified)
	}
	classified = classifyEnvironmentPackages([]model.ProjectEnvironmentPackage{{Name: "example.test/missing", Source: "go.mod"}}, nil, false)
	if len(classified.Missing) != 0 || len(classified.Unknown) != 1 {
		t.Fatalf("untrusted installed state must be unknown, not missing: %+v", classified)
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
