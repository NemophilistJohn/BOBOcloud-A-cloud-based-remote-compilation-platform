package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/packagecatalog"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/security"
)

func writeHandlerNodePackage(t *testing.T, nodeModules, relative, name, version string) {
	t.Helper()
	path := filepath.Join(nodeModules, filepath.FromSlash(relative), "package.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	content, err := json.Marshal(map[string]string{"name": name, "version": version})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestNodePackageCenterPlansAndPublishesNPMDependencyGeneration(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	handler.Resources = newTestResourceController(t, 1)
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		return "", "", 0, nil
	}
	handler.PackageCatalog.(*packageCenterCatalogStub).itemFn = func(_ context.Context, request packagecatalog.ItemRequest) (model.PackageCatalogItem, error) {
		if request.Ecosystem != "node" || request.Name != "lodash" || request.Version != "4.17.21" {
			t.Fatalf("Node catalog request = %+v", request)
		}
		return model.PackageCatalogItem{Name: "lodash", Versions: []model.PackageCatalogVersion{{Version: "4.17.21", Compatibility: "metadata-compatible"}}}, nil
	}
	lockResolutionCalls := 0
	handler.PackageLockResolver = func(_ context.Context, request PackageLockResolutionRequest) (PackageLockResolutionResult, error) {
		lockResolutionCalls++
		if snapshot := handler.Resources.Snapshot(); snapshot.Used.Slots != 1 || len(snapshot.Leases) != 1 {
			t.Fatalf("Node lock resolver resource lease = %+v", snapshot)
		}
		if request.Manager != "npm" || request.ManifestPath != "package.json" || request.LockfilePath != "package-lock.json" || request.RegistryURL != "https://registry.npmjs.org/" {
			t.Fatalf("lock resolution request = %+v", request)
		}
		manifest := string(request.ManifestContent)
		if !strings.Contains(manifest, `"left-pad": "1.3.0"`) {
			t.Fatalf("planned package.json lost the existing dependency: %s", request.ManifestContent)
		}
		if strings.Contains(manifest, `"lodash": "4.17.21"`) {
			return PackageLockResolutionResult{LockfilePath: "package-lock.json", Content: []byte("{\n  \"name\": \"demo\",\n  \"lockfileVersion\": 3,\n  \"packages\": {}\n}\n")}, nil
		}
		return PackageLockResolutionResult{LockfilePath: "package-lock.json", Content: []byte("{\n  \"name\": \"demo\",\n  \"lockfileVersion\": 3,\n  \"packages\": {\n    \"\": {\"dependencies\": {\"left-pad\": \"1.3.0\"}},\n    \"node_modules/left-pad\": {\"version\": \"1.3.0\"}\n  }\n}\n")}, nil
	}
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "index.js"), "require('lodash')\n")
	writeEnvironmentFile(t, filepath.Join(workspace, "package.json"), "{\n  \"name\": \"demo\",\n  \"private\": true,\n  \"scripts\": {\"postinstall\": \"node scripts/setup.js\"},\n  \"dependencies\": {\n    \"left-pad\": \"1.3.0\"\n  }\n}\n")
	writeEnvironmentFile(t, filepath.Join(workspace, "examples", "package.json"), "{\n  \"name\": \"unrelated-example\",\n  \"dependencies\": {\"react\": \"19.0.0\"}\n}\n")

	planRecorder, planEnvelope := callProjectEnvironment(t, handler, `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"node:20","language":"node","sourceId":"npm-official","changes":[{"operation":"add","name":"lodash","version":"4.17.21","scope":"runtime"}]}`)
	if planRecorder.Code != http.StatusOK || !planEnvelope.Success {
		t.Fatalf("Node plan response: %s", planRecorder.Body.String())
	}
	if snapshot := handler.Resources.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("Node lock resolver leaked resources after plan: %+v", snapshot)
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if !plan.Supported || plan.Manager.ID != "npm" || plan.Manager.ManifestPath != "package.json" || plan.Manager.LockfilePath != "package-lock.json" || len(plan.LocalChanges) != 2 || len(plan.ManifestBindings) != 2 || len(plan.Steps) != 4 {
		t.Fatalf("Node plan = %+v", plan)
	}
	for _, change := range plan.LocalChanges {
		writeEnvironmentFile(t, filepath.Join(workspace, filepath.FromSlash(change.Path)), change.NewContent)
	}

	handler.EnvironmentSetup = func(ctx context.Context, _, runtimeID, _ string, commands []string) (string, string, int, error) {
		if !IsManagedPackageOperation(ctx) {
			t.Fatal("Node package install did not mark the workspace-copy-free execution path")
		}
		if runtimeID != "node:20" || len(commands) != 1 || !strings.Contains(commands[0], "npm ci") || !strings.Contains(commands[0], "--registry='https://registry.npmjs.org/'") || strings.Contains(commands[0], "--ignore-scripts") {
			t.Fatalf("Node install command = runtime:%s commands:%#v", runtimeID, commands)
		}
		lease := personalcache.LeaseFromContext(ctx)
		if lease == nil || !lease.Writable() {
			t.Fatalf("Node install dependency lease = %+v", lease)
		}
		toolchains := personalcache.ToolchainLeasesFromContext(ctx)
		if len(toolchains) != 1 || toolchains[0].DockerEnv["NPM_CONFIG_CACHE"] == "" {
			t.Fatalf("Node install toolchain leases = %+v", toolchains)
		}
		manifest, err := os.ReadFile(filepath.Join(lease.HostRoot, "package.json"))
		if err != nil || !strings.Contains(string(manifest), `"lodash":"4.17.21"`) || strings.Contains(string(manifest), "postinstall") || strings.Contains(string(manifest), `"scripts"`) {
			t.Fatalf("staged package.json = %s err=%v", manifest, err)
		}
		if _, err := os.Stat(filepath.Join(lease.HostRoot, "package-lock.json")); err != nil {
			t.Fatalf("staged package lock: %v", err)
		}
		writeHandlerNodePackage(t, filepath.Join(lease.HostRoot, "node_modules"), "left-pad", "left-pad", "1.3.0")
		writeHandlerNodePackage(t, filepath.Join(lease.HostRoot, "node_modules"), "lodash", "lodash", "4.17.21")
		return "added 2 packages", "", 0, nil
	}
	applyBody, err := json.Marshal(map[string]any{
		"action": "applyProjectPackageChanges", "folderName": "Project", "folderKey": "project-key",
		"runtime": "node:20", "language": "node", "sourceId": "npm-official", "packagePlanId": plan.PlanID,
	})
	if err != nil {
		t.Fatal(err)
	}
	applyRecorder, applyEnvelope := callProjectEnvironment(t, handler, string(applyBody))
	if applyRecorder.Code != http.StatusOK || !applyEnvelope.Success {
		t.Fatalf("Node apply response: %s", applyRecorder.Body.String())
	}
	var result model.ProjectPackageChangeResult
	if err := json.Unmarshal(applyEnvelope.Data, &result); err != nil || !result.Applied {
		t.Fatalf("Node apply result = %+v err=%v", result, err)
	}
	cacheRequest := personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), WorkspaceName: "Project",
		RuntimeID: "node:20", RuntimeFingerprint: personalCacheRuntimeFingerprint("node:20", "node:20-slim"),
		Language: "node", WorkspaceRoot: workspace,
	}
	inspection := handler.PersonalCache.InspectPackageInventory(cacheRequest)
	if inspection.State != "ready" || !inspection.Exact || len(inspection.Packages) != 2 {
		t.Fatalf("published Node inventory = %+v", inspection)
	}
	view := acquirePersonalProjectDependencyView(handler.PersonalCache, cacheRequest)
	if view.Root == "" || view.Generation == "" || len(view.Extra[lsp.DependencyRoleNodeModules]) != 1 {
		if view.Release != nil {
			view.Release()
		}
		t.Fatalf("published Node generation was not reusable by LSP: %+v", view)
	}
	view.Release()

	removeRecorder, removeEnvelope := callProjectEnvironment(t, handler, `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"node:20","language":"node","sourceId":"npm-official","changes":[{"operation":"remove","name":"lodash","scope":"runtime"}]}`)
	if removeRecorder.Code != http.StatusOK || !removeEnvelope.Success {
		t.Fatalf("Node remove plan response: %s", removeRecorder.Body.String())
	}
	if snapshot := handler.Resources.Snapshot(); snapshot.Used.Slots != 0 || len(snapshot.Leases) != 0 {
		t.Fatalf("Node lock resolver leaked resources after removal plan: %+v", snapshot)
	}
	var removePlan model.ProjectPackageChangePlan
	if err := json.Unmarshal(removeEnvelope.Data, &removePlan); err != nil {
		t.Fatal(err)
	}
	if !removePlan.Supported || len(removePlan.Changes) != 1 || removePlan.Changes[0].Operation != "remove" || removePlan.Changes[0].Name != "lodash" || len(removePlan.LocalChanges) != 2 {
		t.Fatalf("Node remove plan = %+v", removePlan)
	}
	var plannedManifest struct {
		Dependencies map[string]string `json:"dependencies"`
		Scripts      map[string]string `json:"scripts"`
	}
	for _, change := range removePlan.LocalChanges {
		if change.Path == "package.json" {
			if err := json.Unmarshal([]byte(change.NewContent), &plannedManifest); err != nil {
				t.Fatalf("planned removal package.json: %v", err)
			}
		}
		writeEnvironmentFile(t, filepath.Join(workspace, filepath.FromSlash(change.Path)), change.NewContent)
	}
	if _, exists := plannedManifest.Dependencies["lodash"]; exists || plannedManifest.Dependencies["left-pad"] != "1.3.0" || plannedManifest.Scripts["postinstall"] != "node scripts/setup.js" {
		t.Fatalf("Node remove plan damaged unrelated declarations: %+v", plannedManifest)
	}
	if lockResolutionCalls != 2 {
		t.Fatalf("Node add/remove lock resolution calls = %d", lockResolutionCalls)
	}

	handler.EnvironmentSetup = func(ctx context.Context, _, runtimeID, _ string, commands []string) (string, string, int, error) {
		if !IsManagedPackageOperation(ctx) {
			t.Fatal("Node package removal did not mark the workspace-copy-free execution path")
		}
		if runtimeID != "node:20" || len(commands) != 1 || !strings.Contains(commands[0], "npm ci") || !strings.Contains(commands[0], "--registry='https://registry.npmjs.org/'") {
			t.Fatalf("Node removal command = runtime:%s commands:%#v", runtimeID, commands)
		}
		lease := personalcache.LeaseFromContext(ctx)
		if lease == nil || !lease.Writable() {
			t.Fatalf("Node removal dependency lease = %+v", lease)
		}
		manifest, err := os.ReadFile(filepath.Join(lease.HostRoot, "package.json"))
		if err != nil || strings.Contains(string(manifest), `"lodash"`) || !strings.Contains(string(manifest), `"left-pad":"1.3.0"`) || strings.Contains(string(manifest), `"scripts"`) {
			t.Fatalf("staged removal package.json = %s err=%v", manifest, err)
		}
		lockfile, err := os.ReadFile(filepath.Join(lease.HostRoot, "package-lock.json"))
		if err != nil || strings.Contains(string(lockfile), `"lodash"`) || !strings.Contains(string(lockfile), `"node_modules/left-pad"`) {
			t.Fatalf("staged removal package lock = %s err=%v", lockfile, err)
		}
		writeHandlerNodePackage(t, filepath.Join(lease.HostRoot, "node_modules"), "left-pad", "left-pad", "1.3.0")
		return "removed 1 package", "", 0, nil
	}
	removeApplyBody, err := json.Marshal(map[string]any{
		"action": "applyProjectPackageChanges", "folderName": "Project", "folderKey": "project-key",
		"runtime": "node:20", "language": "node", "sourceId": "npm-official", "packagePlanId": removePlan.PlanID,
	})
	if err != nil {
		t.Fatal(err)
	}
	removeApplyRecorder, removeApplyEnvelope := callProjectEnvironment(t, handler, string(removeApplyBody))
	if removeApplyRecorder.Code != http.StatusOK || !removeApplyEnvelope.Success {
		t.Fatalf("Node remove apply response: %s", removeApplyRecorder.Body.String())
	}
	var removeResult model.ProjectPackageChangeResult
	if err := json.Unmarshal(removeApplyEnvelope.Data, &removeResult); err != nil || !removeResult.Applied {
		t.Fatalf("Node remove apply result = %+v err=%v", removeResult, err)
	}
	removedInspection := handler.PersonalCache.InspectPackageInventory(cacheRequest)
	if removedInspection.State != "ready" || !removedInspection.Exact || len(removedInspection.Packages) != 1 || removedInspection.Packages[0].Name != "left-pad" || removedInspection.Packages[0].Version != "1.3.0" {
		t.Fatalf("published Node inventory after removal = %+v", removedInspection)
	}
	manifestAfterRemoval, err := os.ReadFile(filepath.Join(workspace, "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var declarationAfterRemoval struct {
		Dependencies map[string]string `json:"dependencies"`
		Scripts      map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(manifestAfterRemoval, &declarationAfterRemoval); err != nil {
		t.Fatal(err)
	}
	if _, exists := declarationAfterRemoval.Dependencies["lodash"]; exists || declarationAfterRemoval.Dependencies["left-pad"] != "1.3.0" || declarationAfterRemoval.Scripts["postinstall"] != "node scripts/setup.js" {
		t.Fatalf("workspace declarations after Node removal = %+v", declarationAfterRemoval)
	}
	unrelatedManifest, err := os.ReadFile(filepath.Join(workspace, "examples", "package.json"))
	if err != nil || !strings.Contains(string(unrelatedManifest), `"react": "19.0.0"`) {
		t.Fatalf("unrelated nested manifest changed: %s err=%v", unrelatedManifest, err)
	}
}

func TestNodePackageInstallCommandsKeepManagersAndLifecyclePolicyDistinct(t *testing.T) {
	npm, err := nodePackageInstallCommand("npm", "https://registry.npmjs.org/", false, "10.32.1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(npm, "npm ci") || strings.Contains(npm, "--ignore-scripts") || !strings.Contains(npm, "--include=dev") {
		t.Fatalf("npm command = %q", npm)
	}
	pnpm, err := nodePackageInstallCommand("pnpm", "https://registry.npmjs.org/", true, "10.32.1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(pnpm, "corepack pnpm@10.32.1 install") || !strings.Contains(pnpm, "--frozen-lockfile") || !strings.Contains(pnpm, "--ignore-scripts") || !strings.Contains(pnpm, "$PNPM_STORE_DIR") {
		t.Fatalf("pnpm command = %q", pnpm)
	}
	if !security.NewRestrictivePolicy(true).AllowCommand(pnpm) {
		t.Fatalf("production security policy rejected pinned pnpm command %q", pnpm)
	}
	if _, err := nodePackageInstallCommand("pnpm", "https://registry.npmjs.org/", false, "latest"); err == nil {
		t.Fatal("mutable pnpm selector was accepted")
	}
}

func TestNodePNPMDeclarationMustMatchServerPolicy(t *testing.T) {
	for name, testCase := range map[string]struct {
		manifest string
		manager  string
		wantErr  bool
	}{
		"matching exact pin":      {manifest: `{"packageManager":"pnpm@10.32.1"}`, manager: "pnpm"},
		"matching integrity pin":  {manifest: `{"packageManager":"pnpm@10.32.1+sha512.deadbeef"}`, manager: "pnpm"},
		"different pnpm pin":      {manifest: `{"packageManager":"pnpm@10.31.0"}`, manager: "pnpm", wantErr: true},
		"incompatible pnpm major": {manifest: `{"packageManager":"pnpm@11.23.0"}`, manager: "pnpm", wantErr: true},
		"unversioned declaration": {manifest: `{"packageManager":"pnpm"}`, manager: "pnpm"},
		"npm declaration":         {manifest: `{"packageManager":"npm@11.0.0"}`, manager: "npm"},
	} {
		t.Run(name, func(t *testing.T) {
			err := validateNodePNPMDeclaration([]byte(testCase.manifest), testCase.manager, "10.32.1")
			if (err != nil) != testCase.wantErr {
				t.Fatalf("validation error = %v, wantErr=%v", err, testCase.wantErr)
			}
		})
	}
}
