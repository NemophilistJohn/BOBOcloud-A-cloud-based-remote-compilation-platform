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
	"bobocloud-server/internal/docker"
	"bobocloud-server/internal/metrics"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/resourcecontrol"
	"bobocloud-server/internal/resourcegovernor"
	"bobocloud-server/internal/runner"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"

	"github.com/gorilla/websocket"
)

func newTestResourceController(t *testing.T, slots int64) *resourcecontrol.Controller {
	t.Helper()
	return newTestResourceControllerWithMetrics(t, slots, nil)
}

func newTestResourceControllerWithMetrics(t *testing.T, slots int64, registry *metrics.Registry) *resourcecontrol.Controller {
	t.Helper()
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{
		Capacity: resourcegovernor.Resources{Slots: slots, DockerContainers: slots},
	})
	if err != nil {
		t.Fatal(err)
	}
	unit := resourcegovernor.Resources{Slots: 1}
	controller, err := resourcecontrol.New(governor, resourcecontrol.Profiles{
		resourcecontrol.WorkloadRun:         unit,
		resourcecontrol.WorkloadTask:        unit,
		resourcecontrol.WorkloadTerminal:    unit,
		resourcecontrol.WorkloadPackage:     unit,
		resourcecontrol.WorkloadLSP:         unit,
		resourcecontrol.WorkloadDAP:         unit,
		resourcecontrol.WorkloadMaintenance: unit,
	}, registry)
	if err != nil {
		t.Fatal(err)
	}
	return controller
}

func TestRuntimeResourceAdmissionMatchesCompilerMemoryFloor(t *testing.T) {
	const profileMemory = int64(512_000_000)
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{Capacity: resourcegovernor.Resources{
		Slots: 2, MemoryBytes: 2_000_000_000,
	}})
	if err != nil {
		t.Fatal(err)
	}
	profiles := make(resourcecontrol.Profiles)
	for workload := resourcecontrol.WorkloadRun; workload <= resourcecontrol.WorkloadMaintenance; workload++ {
		profiles[workload] = resourcegovernor.Resources{Slots: 1, MemoryBytes: profileMemory}
	}
	controller, err := resourcecontrol.New(governor, profiles, nil)
	if err != nil {
		t.Fatal(err)
	}

	javaLease, err := tryAcquireHandlerRuntimeResource(controller, resourcecontrol.WorkloadRun, "alice", "java-run", "java:21", "java", "custom-jdk:21")
	if err != nil {
		t.Fatal(err)
	}
	if got := controller.Snapshot().Used.MemoryBytes; got != 1_000_000_000 {
		t.Fatalf("Java admission memory = %d, want 1000000000", got)
	}
	javaLease.Release()

	pythonLease, err := tryAcquireHandlerRuntimeResource(controller, resourcecontrol.WorkloadRun, "alice", "python-run", "python:3.10", "python", "python:3.10-slim")
	if err != nil {
		t.Fatal(err)
	}
	if got := controller.Snapshot().Used.MemoryBytes; got != profileMemory {
		t.Fatalf("Python admission memory = %d, want %d", got, profileMemory)
	}
	pythonLease.Release()
}

func TestRuntimeResourceAdmissionChargesDockerOnlyWhenUsed(t *testing.T) {
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{Capacity: resourcegovernor.Resources{
		Slots: 2, DockerContainers: 1,
	}})
	if err != nil {
		t.Fatal(err)
	}
	profiles := make(resourcecontrol.Profiles)
	for workload := resourcecontrol.WorkloadRun; workload <= resourcecontrol.WorkloadMaintenance; workload++ {
		profiles[workload] = resourcegovernor.Resources{Slots: 1}
	}
	controller, err := resourcecontrol.New(governor, profiles, nil)
	if err != nil {
		t.Fatal(err)
	}

	dockerLease, err := acquireHandlerRuntimeResource(
		context.Background(), controller, resourcecontrol.WorkloadRun,
		"alice", "project", "docker-run", "python:3.10", "python", "python:3.10-slim", true,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer dockerLease.Release()
	localLease, err := acquireHandlerRuntimeResource(
		context.Background(), controller, resourcecontrol.WorkloadRun,
		"bob", "project", "local-run", "", "python", "", false,
	)
	if err != nil {
		t.Fatalf("local run was blocked by the occupied Docker token: %v", err)
	}
	if used := controller.Snapshot().Used; used.Slots != 2 || used.DockerContainers != 1 {
		t.Fatalf("mixed local/Docker resource usage = %+v", used)
	}
	localLease.Release()
}

func invokeResourceControlledRun(t *testing.T, controller *resourcecontrol.Controller, task bool, sess *model.RunSession) *model.RunResult {
	t.Helper()
	cfg := config.Default()
	cfg.ServerRoot = t.TempDir()
	store := storage.NewMemorySessionStore()
	channels := session.NewChannelManager()
	plugins := runner.NewPluginRegistry()
	runner.RegisterAllPlugins(plugins)
	if _, err := store.Create(sess); err != nil {
		t.Fatal(err)
	}
	channel := channels.GetOrCreate(sess.RunID, true)
	handler := &WSHandler{
		Config: cfg, Sessions: store, Channels: channels, Plugins: plugins, Resources: controller,
	}
	if task {
		return handler.runProjectTask(context.Background(), sess.RunID, sess, channel, nil)
	}
	return handler.runCodeTask(context.Background(), sess.RunID, sess, channel, nil)
}

func TestRunAndTaskResourceAdmissionFollowsPureValidationAndAlwaysReleases(t *testing.T) {
	tests := []struct {
		name       string
		task       bool
		valid      *model.RunSession
		invalid    *model.RunSession
		workloadID string
	}{
		{
			name: "run", valid: &model.RunSession{RunID: "valid-run", UserID: "alice", FilePath: "main.py", Runtime: "python:3.10"},
			invalid: &model.RunSession{RunID: "invalid-run", UserID: "alice", FilePath: "main.unsupported", Runtime: "python:3.10"}, workloadID: "run",
		},
		{
			name: "task", task: true,
			valid:   &model.RunSession{RunID: "valid-task", UserID: "alice", Runtime: "python:3.10", Task: &model.TaskExecution{Label: "test"}},
			invalid: &model.RunSession{RunID: "invalid-task", UserID: "alice", Runtime: "unknown:1", Task: &model.TaskExecution{Label: "test"}}, workloadID: "task",
		},
	}
	for _, test := range tests {
		t.Run(test.name+" invalid request does not reach admission", func(t *testing.T) {
			registry := metrics.New(true, 8)
			controller := newTestResourceControllerWithMetrics(t, 0, registry)
			result := invokeResourceControlledRun(t, controller, test.task, test.invalid)
			if result == nil || result.Success {
				t.Fatalf("invalid request result = %+v", result)
			}
			if admissions := registry.Snapshot().Governance.Admissions; len(admissions) != 0 {
				t.Fatalf("pure validation failure reached resource admission: %+v", admissions)
			}
		})

		t.Run(test.name+" pressure rejects before workspace work", func(t *testing.T) {
			registry := metrics.New(true, 8)
			controller := newTestResourceControllerWithMetrics(t, 0, registry)
			result := invokeResourceControlledRun(t, controller, test.task, test.valid)
			if result == nil || result.Success {
				t.Fatalf("resource-pressure result = %+v", result)
			}
			admissions := registry.Snapshot().Governance.Admissions
			if len(admissions) != 1 || admissions[0].Workload != test.workloadID || admissions[0].Outcome != "rejected" || admissions[0].Count != 1 {
				t.Fatalf("resource-pressure admissions = %+v", admissions)
			}
		})

		t.Run(test.name+" post-admission failure releases", func(t *testing.T) {
			controller := newTestResourceController(t, 1)
			result := invokeResourceControlledRun(t, controller, test.task, test.valid)
			if result == nil || result.Success {
				t.Fatalf("invalid workspace result = %+v", result)
			}
			if snapshot := controller.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
				t.Fatalf("post-admission failure leaked resources: %+v", snapshot)
			}
		})
	}
}

func TestProjectResourceScopeIsSharedAcrossWorkloadsAndBranches(t *testing.T) {
	teamRun := runSessionResourceScope(&model.RunSession{TeamID: "team-1", ProjectID: "project-1", Branch: "feature"})
	teamEnvironment := environmentResourceScope(&model.ProjectEnvironment{Workspace: model.ProjectEnvironmentWorkspace{
		Kind: "team", TeamID: "team-1", ProjectID: "project-1", Branch: "main",
	}})
	teamProtocol := projectResourceScope("", "team-1", "project-1")
	if teamRun != teamEnvironment || teamRun != teamProtocol {
		t.Fatalf("team project scopes diverged: run=%q environment=%q protocol=%q", teamRun, teamEnvironment, teamProtocol)
	}

	personalRun := runSessionResourceScope(&model.RunSession{FolderKey: "folder-key"})
	personalEnvironment := environmentResourceScope(&model.ProjectEnvironment{Workspace: model.ProjectEnvironmentWorkspace{
		Kind: "personal", Key: "folder-key",
	}})
	if personalRun != personalEnvironment || personalRun != projectResourceScope("folder-key", "", "") {
		t.Fatalf("personal project scopes diverged: run=%q environment=%q", personalRun, personalEnvironment)
	}
}

func TestLegacyHTTPTerminalRejectsResourcePressureBeforeExecution(t *testing.T) {
	called := false
	handler := NewHTTPHandler(config.Default(), storage.NewMemorySessionStore(), session.NewChannelManager(), false, nil, nil,
		func(context.Context, string, string, string) (string, string, int, error) {
			called = true
			return "", "", 0, nil
		}, nil, nil)
	handler.Resources = newTestResourceController(t, 0)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api", strings.NewReader(`{"action":"terminal","runtime":"python:3.11","command":"true"}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(recorder, request)
	var response model.Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusServiceUnavailable || response.ErrorCode != resourcePressureErrorCode || recorder.Header().Get("Retry-After") != "1" || called {
		t.Fatalf("terminal pressure response=%d body=%s called=%v", recorder.Code, recorder.Body.String(), called)
	}
}

func TestInteractiveTerminalRejectsResourcePressureBeforeDockerAcquire(t *testing.T) {
	cfg := config.Default()
	cfg.ServerRoot = t.TempDir()
	if err := os.MkdirAll(filepath.Join(cfg.ServerRoot, "project"), 0o755); err != nil {
		t.Fatal(err)
	}
	handler := &WSHandler{Config: cfg, DockerPool: &docker.Pool{}, Resources: newTestResourceController(t, 0)}
	server := httptest.NewServer(http.HandlerFunc(handler.HandleTerminalWebSocket))
	defer server.Close()
	connection, _, err := websocket.DefaultDialer.Dial(terminalWebSocketURL(server.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.WriteJSON(map[string]any{
		"type": "terminal.start", "protocol": terminalProtocolVersion, "runtimeId": "python:3.11",
		"workspace": map[string]any{"kind": "personal", "folderKey": "project"},
	}); err != nil {
		t.Fatal(err)
	}
	message := readTerminalControl(t, connection)
	if message["type"] != "terminal.error" || message["code"] != resourcePressureErrorCode {
		t.Fatalf("interactive terminal pressure response = %#v", message)
	}
}

func TestTerminalCleanupRetryReleasesGovernorLeaseOnlyAfterContainerRemoval(t *testing.T) {
	controller := newTestResourceController(t, 1)
	lease, err := controller.TryAcquire(resourcecontrol.WorkloadTerminal, "alice", "terminal-cleanup")
	if err != nil {
		t.Fatal(err)
	}
	fake := &terminalCleanupDiscardFake{failures: 1}
	retryTerminalContainerCleanup(fake, "container-id", "alice", func() {
		releaseHandlerResource(lease)
	}, func(_ time.Duration) {
		if fake.attempts == 1 && controller.Snapshot().Used.Slots != 1 {
			t.Fatal("terminal resource lease was released while its container was still present")
		}
	})
	if snapshot := controller.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("terminal cleanup leaked resource lease: %+v", snapshot)
	}
}

func TestPackageApplyRejectsResourcePressureBeforeMutation(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	executed := false
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		executed = true
		return "", "", 0, nil
	}
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "main.py"), "import numpy\n")
	planRecorder, planEnvelope := callProjectEnvironment(t, handler, `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","changes":[{"operation":"add","name":"numpy","version":"2.1.0"}]}`)
	if planRecorder.Code != http.StatusOK || !planEnvelope.Success {
		t.Fatalf("package plan response: %s", planRecorder.Body.String())
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	for _, change := range plan.LocalChanges {
		writeEnvironmentFile(t, filepath.Join(workspace, filepath.FromSlash(change.Path)), change.NewContent)
	}
	handler.Resources = newTestResourceController(t, 0)
	applyRecorder, applyEnvelope := callProjectEnvironment(t, handler, `{"action":"applyProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","packagePlanId":"`+plan.PlanID+`"}`)
	if applyRecorder.Code != http.StatusServiceUnavailable || applyEnvelope.ErrorCode != resourcePressureErrorCode || executed {
		t.Fatalf("package pressure response=%d body=%s executed=%v", applyRecorder.Code, applyRecorder.Body.String(), executed)
	}
}

func TestNodeLockResolverRejectsResourcePressureBeforeDockerWork(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		return "", "", 0, nil
	}
	handler.Resources = newTestResourceController(t, 0)
	resolverCalled := false
	handler.PackageLockResolver = func(context.Context, PackageLockResolutionRequest) (PackageLockResolutionResult, error) {
		resolverCalled = true
		return PackageLockResolutionResult{}, nil
	}
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "index.js"), "require('lodash')\n")
	writeEnvironmentFile(t, filepath.Join(workspace, "package.json"), `{"name":"demo","private":true,"dependencies":{}}`)
	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"node:20","language":"node","sourceId":"npm-official","changes":[{"operation":"add","name":"lodash","version":"2.1.0"}]}`)
	if recorder.Code != http.StatusServiceUnavailable || envelope.ErrorCode != resourcePressureErrorCode || resolverCalled {
		t.Fatalf("Node resolver pressure response=%d body=%s resolver_called=%v", recorder.Code, recorder.Body.String(), resolverCalled)
	}
}

func TestEnvironmentSetupRejectsResourcePressureBeforeMutation(t *testing.T) {
	handler, serverRoot, _ := newProjectEnvironmentTestHandler(t)
	handler.Resources = newTestResourceController(t, 0)
	executed := false
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		executed = true
		return "", "", 0, nil
	}
	writeEnvironmentFile(t, filepath.Join(serverRoot, "project-key", "requirements.txt"), "numpy==2.1.0\n")
	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"applyProjectEnvironmentAction","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","environmentAction":"repair"}`)
	if recorder.Code != http.StatusServiceUnavailable || envelope.ErrorCode != resourcePressureErrorCode || executed {
		t.Fatalf("environment pressure response=%d body=%s executed=%v", recorder.Code, recorder.Body.String(), executed)
	}
}

func TestEnvironmentSetupRequiresManagedProjectCacheBeforeAdmission(t *testing.T) {
	handler, serverRoot, _ := newProjectEnvironmentTestHandler(t)
	handler.PersonalCache = nil
	handler.Resources = newTestResourceController(t, 1)
	executed := false
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		executed = true
		return "", "", 0, nil
	}
	writeEnvironmentFile(t, filepath.Join(serverRoot, "project-key", "requirements.txt"), "numpy==2.1.0\n")
	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"applyProjectEnvironmentAction","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","environmentAction":"repair"}`)
	if recorder.Code != http.StatusServiceUnavailable || envelope.ErrorCode != "environment_service_unavailable" || executed {
		t.Fatalf("environment cache requirement response=%d body=%s executed=%v", recorder.Code, recorder.Body.String(), executed)
	}
	if snapshot := handler.Resources.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("environment cache validation reached resource admission: %+v", snapshot)
	}
}
