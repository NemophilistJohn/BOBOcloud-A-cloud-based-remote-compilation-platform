package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"bobocloud-server/internal/cachev2"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/lifecycle"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/packagecatalog"
	"bobocloud-server/internal/packageops"
	"bobocloud-server/internal/personalcache"
)

type packageCenterCatalogStub struct {
	base   packagecatalog.Catalog
	itemFn func(context.Context, packagecatalog.ItemRequest) (model.PackageCatalogItem, error)
}

func (c *packageCenterCatalogStub) Sources(ecosystem string) []model.PackageCenterSource {
	return c.base.Sources(ecosystem)
}

func (c *packageCenterCatalogStub) DefaultSource(ecosystem string) string {
	return c.base.DefaultSource(ecosystem)
}

func (c *packageCenterCatalogStub) ResolveSource(ecosystem, id string) (packagecatalog.Source, error) {
	return c.base.ResolveSource(ecosystem, id)
}

func (c *packageCenterCatalogStub) Search(context.Context, packagecatalog.SearchRequest) (model.PackageCatalogSearchResult, error) {
	return model.PackageCatalogSearchResult{}, errors.New("search is not used by package center handler tests")
}

func (c *packageCenterCatalogStub) Item(ctx context.Context, request packagecatalog.ItemRequest) (model.PackageCatalogItem, error) {
	return c.itemFn(ctx, request)
}

func configurePackageCenterTestHandler(handler *HTTPHandler, dataRoot string) {
	handler.PersonalCache = newPersonalCacheManagerForTest(dataRoot, personalcache.Options{ScopeMode: "project-lock", ReservationBytes: 8, ReservationFiles: 1})
	base := packagecatalog.NewWithClient(handler.Config.PackageSources, nil, handler.Config.PackageCatalogMaxResponseBytes)
	handler.PackageCatalog = &packageCenterCatalogStub{
		base: base,
		itemFn: func(_ context.Context, request packagecatalog.ItemRequest) (model.PackageCatalogItem, error) {
			return model.PackageCatalogItem{Name: request.Name, Versions: []model.PackageCatalogVersion{
				{Version: "2.1.0", Compatibility: "metadata-compatible"},
				{Version: "2.2.0", Compatibility: "metadata-compatible"},
			}}, nil
		},
	}
}

func TestPackageCenterRelationshipsUseDependencyManifestsNotSourceImports(t *testing.T) {
	handler := &HTTPHandler{}
	environment := &model.ProjectEnvironment{
		Language: model.ProjectEnvironmentLanguage{ID: "python"},
		Manifests: []model.ProjectEnvironmentManifest{
			{Path: "main.py", Kind: "source-imports", Language: "python", Parsed: true},
			{Path: "requirements.txt", Kind: "requirements", Language: "python", Parsed: true},
		},
		Packages: model.ProjectEnvironmentPackages{
			Declared: []model.ProjectEnvironmentPackage{
				{Name: "numpy", Source: "main.py"},
				{Name: "requests", Source: "requirements.txt"},
			},
			Installed: []model.ProjectEnvironmentPackage{
				{Name: "numpy", Version: "2.2.0", Scope: "project-lock", Source: "project-lock-python", Trust: "exact"},
				{Name: "requests", Version: "2.32.0", Scope: "project-lock", Source: "project-lock-python", Trust: "exact"},
			},
		},
		DependencyCache: model.ProjectEnvironmentDependencyCache{Status: "hit", InventoryStatus: "ready"},
	}
	center := handler.projectPackageCenterContext(environment)
	if len(center.Packages.Installed) != 2 || center.Packages.Installed[0].Name != "numpy" || center.Packages.Installed[0].Relationship != "transitive" || center.Packages.Installed[1].Name != "requests" || center.Packages.Installed[1].Relationship != "direct" {
		t.Fatalf("package relationships = %+v", center.Packages.Installed)
	}
}

func TestPackageCenterAutoResolvesExactRuntimeAndCompatiblePackageVersion(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	handler.RuntimeMetadata = RuntimeMetadataProviderFunc(func(_ context.Context, runtimeID, image, configured string) RuntimeMetadata {
		if runtimeID != "python:3.10" || image != "python:3.10-slim" || configured != "3.10" {
			t.Fatalf("runtime probe scope = %s %s %s", runtimeID, image, configured)
		}
		return RuntimeMetadata{ImageID: "sha256:python-31021", Version: "3.10.21", VersionSource: "docker-image-env", VersionTrust: "exact"}
	})
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		return "", "", 0, nil
	}
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "main.py"), "import numpy\n")
	var catalogRequest packagecatalog.ItemRequest
	handler.PackageCatalog.(*packageCenterCatalogStub).itemFn = func(_ context.Context, request packagecatalog.ItemRequest) (model.PackageCatalogItem, error) {
		catalogRequest = request
		return model.PackageCatalogItem{
			Name: "numpy", LatestVersion: "2.5.2", RecommendedVersion: "2.2.6", CatalogAuthority: "pypi.example",
			Versions: []model.PackageCatalogVersion{
				{Version: "2.5.2", Compatibility: "incompatible", RequiresLanguage: ">=3.12"},
				{Version: "2.2.6", Compatibility: "metadata-compatible", RequiresLanguage: ">=3.10"},
			},
		}, nil
	}
	contextRecorder, contextEnvelope := callProjectEnvironment(t, handler, `{"action":"getPackageCenterContext","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
	if contextRecorder.Code != http.StatusOK || !contextEnvelope.Success {
		t.Fatalf("context response: %s", contextRecorder.Body.String())
	}
	var center model.ProjectPackageCenterContext
	if err := json.Unmarshal(contextEnvelope.Data, &center); err != nil {
		t.Fatal(err)
	}
	if center.Runtime.Version != "3.10" || center.Runtime.ResolvedVersion != "3.10.21" || center.Runtime.ResolvedVersionTrust != "exact" || center.DefaultManifestPath != "requirements.txt" {
		t.Fatalf("resolved context = %+v", center)
	}
	planRecorder, planEnvelope := callProjectEnvironment(t, handler, `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","changes":[{"operation":"add","name":"numpy"}]}`)
	if planRecorder.Code != http.StatusOK || !planEnvelope.Success {
		t.Fatalf("automatic plan response: %s", planRecorder.Body.String())
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if plan.RequiresConfirmation || len(plan.Changes) != 1 || plan.Changes[0].Version != "2.2.6" || len(plan.LocalChanges) != 1 || plan.LocalChanges[0].NewContent != "numpy==2.2.6\n" {
		t.Fatalf("automatic compatible plan = %+v", plan)
	}
	if catalogRequest.RuntimeVersion != "3.10.21" || catalogRequest.RuntimeVersionTrust != "exact" || catalogRequest.Version != "" {
		t.Fatalf("catalog request did not use exact runtime/automatic selection: %+v", catalogRequest)
	}
}

func TestPackageCenterFirstContextRevisionRemainsStableForImmediatePlan(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	provider := NewDockerImageRuntimeMetadataProvider(time.Hour, time.Second)
	inspectCalls := 0
	provider.inspect = func(context.Context, string) ([]byte, error) {
		inspectCalls++
		return []byte(`[{"Id":"sha256:python-31021","Config":{"Env":["PYTHON_VERSION=3.10.21"]}}]`), nil
	}
	handler.RuntimeMetadata = provider
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		return "", "", 0, nil
	}
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "main.py"), "import numpy\n")

	contextRecorder, contextEnvelope := callProjectEnvironment(t, handler, `{"action":"getPackageCenterContext","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
	if contextRecorder.Code != http.StatusOK || !contextEnvelope.Success {
		t.Fatalf("first context response: %s", contextRecorder.Body.String())
	}
	var center model.ProjectPackageCenterContext
	if err := json.Unmarshal(contextEnvelope.Data, &center); err != nil {
		t.Fatal(err)
	}
	if center.Revision == "" || center.Language.Source != "editor" || center.Runtime.ResolvedVersion != "3.10.21" || center.Runtime.ResolvedVersionTrust != "exact" {
		t.Fatalf("first context = %+v", center)
	}
	planBody, err := json.Marshal(map[string]any{
		"action": "planProjectPackageChanges", "folderName": "Project", "folderKey": "project-key",
		"runtime": "python:3.10", "language": "python", "revision": center.Revision, "sourceId": "pypi-official",
		"changes": []map[string]string{{"operation": "add", "name": "numpy", "version": "2.1.0"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	planRecorder, planEnvelope := callProjectEnvironment(t, handler, string(planBody))
	if planRecorder.Code != http.StatusOK || !planEnvelope.Success {
		t.Fatalf("immediate plan response: %s", planRecorder.Body.String())
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if plan.Revision != center.Revision || inspectCalls != 1 {
		t.Fatalf("first context drifted before plan: context=%q plan=%q inspect_calls=%d", center.Revision, plan.Revision, inspectCalls)
	}
}

func TestPackageCenterRevisionRejectsChangedLanguageRequestContext(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	provider := NewDockerImageRuntimeMetadataProvider(time.Hour, time.Second)
	inspectCalls := 0
	provider.inspect = func(context.Context, string) ([]byte, error) {
		inspectCalls++
		return []byte(`[{"Id":"sha256:python-31021","Config":{"Env":["PYTHON_VERSION=3.10.21"]}}]`), nil
	}
	handler.RuntimeMetadata = provider
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		return "", "", 0, nil
	}
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "main.py"), "import numpy\n")

	contextRecorder, contextEnvelope := callProjectEnvironment(t, handler, `{"action":"getPackageCenterContext","folderName":"Project","folderKey":"project-key","runtime":"python:3.10"}`)
	if contextRecorder.Code != http.StatusOK || !contextEnvelope.Success {
		t.Fatalf("inferred-language context response: %s", contextRecorder.Body.String())
	}
	var center model.ProjectPackageCenterContext
	if err := json.Unmarshal(contextEnvelope.Data, &center); err != nil {
		t.Fatal(err)
	}
	if center.Language.ID != "python" || center.Language.Source != "runtime" {
		t.Fatalf("inferred language context = %+v", center.Language)
	}
	planBody, err := json.Marshal(map[string]any{
		"action": "planProjectPackageChanges", "folderName": "Project", "folderKey": "project-key",
		"runtime": "python:3.10", "language": "python", "revision": center.Revision, "sourceId": "pypi-official",
		"changes": []map[string]string{{"operation": "add", "name": "numpy", "version": "2.1.0"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	planRecorder, planEnvelope := callProjectEnvironment(t, handler, string(planBody))
	if planRecorder.Code != http.StatusConflict || planEnvelope.Success || planEnvelope.ErrorCode != "package_plan_workspace_changed" {
		t.Fatalf("changed language request context was accepted: status=%d body=%s", planRecorder.Code, planRecorder.Body.String())
	}
	var current model.ProjectEnvironment
	if err := json.Unmarshal(planEnvelope.Data, &current); err != nil {
		t.Fatal(err)
	}
	if current.Language.ID != center.Language.ID || current.Language.Source != "editor" || current.Revision == center.Revision || inspectCalls != 1 {
		t.Fatalf("language-source drift was not isolated: before=%+v after=%+v inspect_calls=%d", center.Language, current.Language, inspectCalls)
	}
}

func TestPackageCenterApplyPanicReleasesPackageCacheLeases(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	handler.Resources = newTestResourceController(t, 1)
	handler.Lifecycle = lifecycle.NewManager()
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		return "", "", 0, nil
	}
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "main.py"), "import numpy\n")

	planRecorder, planEnvelope := callProjectEnvironment(t, handler, `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","changes":[{"operation":"add","name":"numpy","version":"2.1.0"}]}`)
	if planRecorder.Code != http.StatusOK || !planEnvelope.Success {
		t.Fatalf("plan response: %s", planRecorder.Body.String())
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if plan.PlanID == "" || len(plan.LocalChanges) != 1 {
		t.Fatalf("executable plan = %+v", plan)
	}
	writeEnvironmentFile(t, filepath.Join(workspace, plan.LocalChanges[0].Path), plan.LocalChanges[0].NewContent)
	cleanupStarted := make(chan struct{})
	allowCleanup := make(chan struct{})
	cleanupReturned := make(chan struct{})
	handler.EnvironmentSetup = func(ctx context.Context, _ string, _ string, _ string, _ []string) (string, string, int, error) {
		if !RetainResourcesUntilContainerRemoved(ctx, func() {
			close(cleanupStarted)
			<-allowCleanup
			close(cleanupReturned)
		}) {
			panic("container cleanup handoff unavailable")
		}
		panic("package executor panic")
	}
	applyBody, err := json.Marshal(map[string]any{
		"action": "applyProjectPackageChanges", "folderName": "Project", "folderKey": "project-key",
		"runtime": "python:3.10", "language": "python", "sourceId": "pypi-official", "packagePlanId": plan.PlanID,
	})
	if err != nil {
		t.Fatal(err)
	}
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api", strings.NewReader(string(applyBody)))
		request.Header.Set("Content-Type", "application/json")
		handler.ServeHTTP(recorder, request)
	}()
	if recovered == nil {
		t.Fatal("package executor panic did not propagate through the test handler")
	}
	select {
	case <-cleanupStarted:
	case <-time.After(time.Second):
		t.Fatal("container cleanup ownership was not retained before panic unwind")
	}
	if snapshot := handler.Resources.Snapshot(); snapshot.Used.Slots != 1 || len(snapshot.Leases) != 1 {
		t.Fatalf("package panic released resources before container cleanup: %+v", snapshot)
	}
	if mutation, err := handler.Lifecycle.BeginWorkspaceMutation("default", "project-key"); !errors.Is(err, lifecycle.ErrResourcesInUse) {
		if mutation != nil {
			mutation.Release()
		}
		t.Fatalf("package cleanup released workspace activity before container removal: %v", err)
	}
	close(allowCleanup)
	select {
	case <-cleanupReturned:
	case <-time.After(time.Second):
		t.Fatal("container cleanup did not return")
	}
	deadline := time.Now().Add(time.Second)
	for handler.Resources.Snapshot().Used.Slots != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("package panic cleanup leaked resource lease: %+v", handler.Resources.Snapshot())
		}
		time.Sleep(10 * time.Millisecond)
	}
	deadline = time.Now().Add(time.Second)
	for {
		mutation, err := handler.Lifecycle.BeginWorkspaceMutation("default", "project-key")
		if err == nil {
			mutation.Release()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("package cleanup retained workspace activity: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}

	var inventory cachev2.Inventory
	deadline = time.Now().Add(time.Second)
	for {
		inventory, err = handler.PersonalCache.Catalog("default", 0)
		if err != nil {
			t.Fatal(err)
		}
		busy := false
		for _, entry := range inventory.Entries {
			busy = busy || entry.Writing || entry.ActiveReaders != 0
		}
		if !busy {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("panic cleanup did not release cache entries: %+v", inventory.Entries)
		}
		time.Sleep(10 * time.Millisecond)
	}
	var toolchainID cachev2.CacheID
	for _, entry := range inventory.Entries {
		if entry.Writing || entry.ActiveReaders != 0 {
			t.Fatalf("panic left cache entry active: %+v", entry)
		}
		if entry.Category == cachev2.CategoryToolchains {
			toolchainID = entry.ID
		}
	}
	if toolchainID == "" {
		t.Fatalf("panic cleanup removed or hid the reusable toolchain cache: %+v", inventory.Entries)
	}
	deleted, err := handler.PersonalCache.DeleteByID("default", toolchainID, inventory.Revision, 0)
	if err != nil || len(deleted.DeletedIDs) != 1 || deleted.DeletedIDs[0] != toolchainID {
		t.Fatalf("released toolchain cache was not deletable: result=%+v err=%v", deleted, err)
	}

	retryContext, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	retryLease, err := handler.PersonalCache.Prepare(retryContext, personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), WorkspaceName: "Project",
		RuntimeID: "python:3.10", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.10", "python:3.10-slim"),
		Language: "python", WorkspaceRoot: workspace,
		ManifestSnapshot: []personalcache.ManifestSnapshot{{Path: plan.LocalChanges[0].Path, Content: []byte(plan.LocalChanges[0].NewContent)}},
		OperationID:      "retry-after-panic",
	})
	if err != nil || retryLease == nil {
		t.Fatalf("panic left dependency writer locked: lease=%v err=%v", retryLease, err)
	}
	retryLease.Abort()
	retryLease.Release()
}

func TestPackageCenterNewManifestPlanEmitsEmptyOldSHA256(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		return "", "", 0, nil
	}
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "main.py"), "import numpy\n")

	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","changes":[{"operation":"add","name":"numpy","version":"2.1.0"}]}`)
	if recorder.Code != http.StatusOK || !envelope.Success {
		t.Fatalf("plan response: %s", recorder.Body.String())
	}
	var plan struct {
		LocalChanges []map[string]json.RawMessage `json:"localChanges"`
	}
	if err := json.Unmarshal(envelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if len(plan.LocalChanges) != 1 || string(plan.LocalChanges[0]["oldSha256"]) != `""` {
		t.Fatalf("new-manifest plan must emit an explicit empty oldSha256: %s", envelope.Data)
	}
}

func TestPackageCatalogErrorsExposeStableCodes(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{name: "not found", err: packagecatalog.ErrNotFound, wantStatus: http.StatusNotFound, wantCode: "package_not_found"},
		{name: "timeout", err: context.DeadlineExceeded, wantStatus: http.StatusGatewayTimeout, wantCode: "package_catalog_timeout"},
		{name: "invalid request", err: errors.New("invalid package source"), wantStatus: http.StatusBadRequest, wantCode: "package_catalog_request_invalid"},
		{name: "upstream unavailable", err: errors.New("catalog gateway failed"), wantStatus: http.StatusBadGateway, wantCode: "package_catalog_unavailable"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			writePackageCatalogError(recorder, test.err)
			var response model.Response
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if recorder.Code != test.wantStatus || response.Success || response.ErrorCode != test.wantCode {
				t.Fatalf("catalog error = status:%d code:%q body:%s", recorder.Code, response.ErrorCode, recorder.Body.String())
			}
		})
	}
}

func TestPackageCenterRejectsPlanWhenRuntimeImageChangesBeforeApply(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	imageID := "sha256:python-old"
	handler.RuntimeMetadata = RuntimeMetadataProviderFunc(func(context.Context, string, string, string) RuntimeMetadata {
		return RuntimeMetadata{ImageID: imageID, Version: "3.10.21", VersionSource: "docker-image-env", VersionTrust: "exact"}
	})
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		return "", "", 0, nil
	}
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "main.py"), "import numpy\n")

	planRecorder, planEnvelope := callProjectEnvironment(t, handler, `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","changes":[{"operation":"add","name":"numpy","version":"2.1.0"}]}`)
	if planRecorder.Code != http.StatusOK || !planEnvelope.Success {
		t.Fatalf("plan response: %s", planRecorder.Body.String())
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if plan.PlanID == "" {
		t.Fatalf("plan did not create an executable operation: %s", planRecorder.Body.String())
	}
	imageID = "sha256:python-new"
	applyRecorder, applyEnvelope := callProjectEnvironment(t, handler, `{"action":"applyProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","packagePlanId":"`+plan.PlanID+`"}`)
	var failure struct {
		ErrorCode string `json:"errorCode"`
	}
	if err := json.Unmarshal(applyRecorder.Body.Bytes(), &failure); err != nil {
		t.Fatal(err)
	}
	if applyRecorder.Code != http.StatusConflict || applyEnvelope.Success || failure.ErrorCode != "package_plan_runtime_changed" {
		t.Fatalf("runtime drift response: %s", applyRecorder.Body.String())
	}
}

func TestDefaultEditablePythonManifestIsDeterministic(t *testing.T) {
	manifests := []model.ProjectEnvironmentManifest{
		{Path: "z/requirements-dev.txt", Kind: "requirements", Language: "python", Parsed: true},
		{Path: "main.py", Kind: "source-imports", Language: "python", Parsed: true},
		{Path: "a/requirements-prod.txt", Kind: "requirements", Language: "python", Parsed: true},
		{Path: "requirements.lock", Kind: "requirements", Language: "python", Parsed: false},
	}
	if got := defaultEditablePythonManifest(manifests); got != "a/requirements-prod.txt" {
		t.Fatalf("deterministic default manifest = %q", got)
	}
	manifests = append(manifests, model.ProjectEnvironmentManifest{Path: "requirements.txt", Kind: "requirements", Language: "python", Parsed: true})
	if got := defaultEditablePythonManifest(manifests); got != "requirements.txt" {
		t.Fatalf("root requirements was not preferred: %q", got)
	}
}

func TestPackageCenterContextAndAddApplyCloseTheProjectLifecycle(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	completionDirectory := filepath.Join(dataRoot, "package-plans", "completed")
	persistentPlans, err := packageops.NewPersistentStoreWithLimits(time.Minute, time.Hour, packageops.StoreLimits{
		MaxPlans: 16, MaxPlansPerUser: 8, MaxBytes: 2 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: 8 << 10,
	}, completionDirectory)
	if err != nil {
		t.Fatal(err)
	}
	handler.PackagePlans = persistentPlans
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "main.py"), "import numpy\n")
	executed := false
	var received []string
	handler.EnvironmentSetup = func(ctx context.Context, _, runtimeID, workspaceRoot string, commands []string) (string, string, int, error) {
		executed = true
		received = append([]string(nil), commands...)
		if runtimeID != "python:3.10" || filepath.Clean(workspaceRoot) != filepath.Clean(workspace) {
			t.Fatalf("executor scope runtime=%s workspace=%s", runtimeID, workspaceRoot)
		}
		lease := personalcache.LeaseFromContext(ctx)
		if lease == nil || !lease.Writable() {
			t.Fatal("package apply did not use a writable project cache generation")
		}
		if _, statErr := os.Stat(filepath.Join(lease.HostRoot, "python", "orphan")); !os.IsNotExist(statErr) {
			t.Fatalf("staged target was not rebuilt from an empty tree: %v", statErr)
		}
		reviewed, readErr := os.ReadFile(filepath.Join(lease.HostRoot, ".bobocloud-package-input", "requirements.txt"))
		if readErr != nil || string(reviewed) != "numpy==2.1.0\n" {
			t.Fatalf("executor did not receive reviewed immutable requirements: data=%q err=%v", reviewed, readErr)
		}
		writePythonDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.1.0")
		return "installed", "", 0, nil
	}

	contextRecorder, contextEnvelope := callProjectEnvironment(t, handler, `{"action":"getPackageCenterContext","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
	if contextRecorder.Code != http.StatusOK || !contextEnvelope.Success {
		t.Fatalf("context response: %s", contextRecorder.Body.String())
	}
	var center model.ProjectPackageCenterContext
	if err := json.Unmarshal(contextEnvelope.Data, &center); err != nil {
		t.Fatal(err)
	}
	if center.SearchMode != "exact" || center.DefaultSource != "pypi-official" || len(center.Sources) < 2 || !center.CanPlanChanges.Supported || center.CatalogTimeoutSeconds != handler.Config.PackageCatalogTimeoutSeconds || center.OperationTimeoutSeconds != handler.Config.PackageOperationTimeoutSeconds {
		t.Fatalf("package center context = %+v", center)
	}

	planBody := `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-tuna","changes":[{"operation":"add","name":"NumPy","version":"2.1.0"}]}`
	planRecorder, planEnvelope := callProjectEnvironment(t, handler, planBody)
	if planRecorder.Code != http.StatusOK || !planEnvelope.Success {
		t.Fatalf("plan response: %s", planRecorder.Body.String())
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if !plan.Supported || plan.PlanID == "" || len(plan.LocalChanges) != 1 || plan.LocalChanges[0].OldExists || plan.LocalChanges[0].OldSHA256 != "" || plan.LocalChanges[0].NewContent != "numpy==2.1.0\n" {
		t.Fatalf("add plan = %+v", plan)
	}

	applyBody, _ := json.Marshal(map[string]any{
		"action": "applyProjectPackageChanges", "folderName": "Project", "folderKey": "project-key", "runtime": "python:3.10", "language": "python",
		"sourceId": "pypi-tuna", "packagePlanId": plan.PlanID,
	})
	failedRecorder, failedEnvelope := callProjectEnvironment(t, handler, string(applyBody))
	if failedRecorder.Code != http.StatusConflict || failedEnvelope.Success || executed {
		t.Fatalf("unsynchronized plan reached executor: %s", failedRecorder.Body.String())
	}
	writeEnvironmentFile(t, filepath.Join(workspace, plan.LocalChanges[0].Path), plan.LocalChanges[0].NewContent)
	// Seed the exact target digest with a stale package. Apply must clone only as
	// a transaction base, clear the package target, and rebuild the complete
	// manifest instead of retaining packages from the previous generation.
	staleLease, err := handler.PersonalCache.Prepare(t.Context(), personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), WorkspaceName: "Project",
		RuntimeID: "python:3.10", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.10", "python:3.10-slim"), Language: "python", WorkspaceRoot: workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	writePythonDistInfo(t, filepath.Join(staleLease.HostRoot, "python"), "orphan", "9.9.9")
	staleLease.Release()
	if !staleLease.Published() {
		t.Fatal("stale fixture generation was not published")
	}
	recorder, envelope := callProjectEnvironment(t, handler, string(applyBody))
	if recorder.Code != http.StatusOK || !envelope.Success {
		t.Fatalf("apply response: %s", recorder.Body.String())
	}
	if len(received) != 1 || !strings.Contains(received[0], "mkdir -p \"$PIP_TARGET\"") || !strings.Contains(received[0], "pip --isolated") || !strings.Contains(received[0], "--cache-dir \"$PIP_CACHE_DIR\"") || !strings.Contains(received[0], "install --target \"$PIP_TARGET\"") || !strings.Contains(received[0], "--index-url 'https://pypi.tuna.tsinghua.edu.cn/simple/'") || !strings.Contains(received[0], "-r '/project-deps/.bobocloud-package-input/requirements.txt'") {
		t.Fatalf("executor command = %#v", received)
	}
	var result model.ProjectPackageChangeResult
	if err := json.Unmarshal(envelope.Data, &result); err != nil {
		t.Fatal(err)
	}
	if !result.Applied || result.Context == nil || len(result.Context.Packages.Installed) != 1 || result.Context.Packages.Installed[0].Relationship != "direct" {
		t.Fatalf("apply did not return verified project context: %+v", result)
	}
	writeEnvironmentFile(t, filepath.Join(serverRoot, "other-key", "main.py"), "print('other')\n")
	for name, overrides := range map[string]map[string]string{
		"runtime":   {"runtime": "python:3.11"},
		"language":  {"language": "javascript"},
		"source":    {"sourceId": "pypi-official"},
		"workspace": {"folderName": "Other", "folderKey": "other-key"},
	} {
		t.Run("completed replay rejects "+name+" mismatch", func(t *testing.T) {
			payload := map[string]any{
				"action": "applyProjectPackageChanges", "folderName": "Project", "folderKey": "project-key", "runtime": "python:3.10", "language": "python",
				"sourceId": "pypi-tuna", "packagePlanId": plan.PlanID,
			}
			for key, value := range overrides {
				payload[key] = value
			}
			body, marshalErr := json.Marshal(payload)
			if marshalErr != nil {
				t.Fatal(marshalErr)
			}
			mismatchRecorder, mismatchEnvelope := callProjectEnvironment(t, handler, string(body))
			if mismatchRecorder.Code != http.StatusConflict || mismatchEnvelope.Success || !strings.Contains(mismatchRecorder.Body.String(), `"errorCode":"package_plan_binding_mismatch"`) || len(received) != 1 {
				t.Fatalf("completed result crossed %s binding: commands=%d body=%s", name, len(received), mismatchRecorder.Body.String())
			}
		})
	}
	handler.PackagePlans, err = packageops.NewPersistentStoreWithLimits(time.Minute, time.Hour, packageops.StoreLimits{
		MaxPlans: 16, MaxPlansPerUser: 8, MaxBytes: 2 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: 8 << 10,
	}, completionDirectory)
	if err != nil {
		t.Fatal(err)
	}
	// A completed replay is identity-bound, not a stale workspace CAS. Users may
	// legitimately edit the manifest after the original operation succeeded.
	writeEnvironmentFile(t, filepath.Join(workspace, "requirements.txt"), "numpy==2.2.0\n")
	replayRecorder, replayEnvelope := callProjectEnvironment(t, handler, string(applyBody))
	if replayRecorder.Code != http.StatusOK || !replayEnvelope.Success || len(received) != 1 {
		t.Fatalf("completed package plan did not return its retained result: commands=%d body=%s", len(received), replayRecorder.Body.String())
	}
	var replayResult model.ProjectPackageChangeResult
	if err := json.Unmarshal(replayEnvelope.Data, &replayResult); err != nil || !replayResult.Applied || replayResult.PlanID != plan.PlanID {
		t.Fatalf("retained apply result = %+v err=%v", replayResult, err)
	}
}

func TestPackageCenterReinstallsDeclaredMissingPackageWithoutManifestWrite(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	workspace := filepath.Join(serverRoot, "project-key")
	manifest := filepath.Join(workspace, "requirements.txt")
	writeEnvironmentFile(t, manifest, "numpy==2.1.0\n")
	cacheRequest := personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), WorkspaceName: "Project",
		RuntimeID: "python:3.10", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.10", "python:3.10-slim"), Language: "python", WorkspaceRoot: workspace,
	}
	empty, err := handler.PersonalCache.Prepare(t.Context(), cacheRequest)
	if err != nil {
		t.Fatal(err)
	}
	empty.Release()
	if !empty.Published() {
		t.Fatal("empty exact inventory fixture was not published")
	}
	executions := 0
	handler.EnvironmentSetup = func(ctx context.Context, _, _, _ string, _ []string) (string, string, int, error) {
		executions++
		lease := personalcache.LeaseFromContext(ctx)
		if lease == nil || !lease.Writable() {
			t.Fatal("reinstall did not receive a writable generation")
		}
		reviewed, readErr := os.ReadFile(filepath.Join(lease.HostRoot, ".bobocloud-package-input", "requirements.txt"))
		if readErr != nil || string(reviewed) != "numpy==2.1.0\n" {
			t.Fatalf("reinstall snapshot = %q err=%v", reviewed, readErr)
		}
		writePythonDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.1.0")
		return "reinstalled", "", 0, nil
	}

	planBody := `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","changes":[{"operation":"update","name":"numpy","version":"2.1.0"}]}`
	recorder, envelope := callProjectEnvironment(t, handler, planBody)
	if recorder.Code != http.StatusOK || !envelope.Success {
		t.Fatalf("reinstall plan response: %s", recorder.Body.String())
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(envelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if !plan.Supported || !plan.Reinstall || len(plan.LocalChanges) != 0 || len(plan.ManifestBindings) != 1 || len(plan.Changes) != 1 || plan.Changes[0].Operation != "update" {
		t.Fatalf("reinstall plan = %+v", plan)
	}
	applyBody, _ := json.Marshal(map[string]any{
		"action": "applyProjectPackageChanges", "folderName": "Project", "folderKey": "project-key", "runtime": "python:3.10", "language": "python",
		"sourceId": "pypi-official", "packagePlanId": plan.PlanID,
	})
	recorder, envelope = callProjectEnvironment(t, handler, string(applyBody))
	if recorder.Code != http.StatusOK || !envelope.Success || executions != 1 {
		t.Fatalf("reinstall apply: executions=%d body=%s", executions, recorder.Body.String())
	}
	if data, err := os.ReadFile(manifest); err != nil || string(data) != "numpy==2.1.0\n" {
		t.Fatalf("reinstall changed manifest: data=%q err=%v", data, err)
	}

	recorder, envelope = callProjectEnvironment(t, handler, planBody)
	if recorder.Code != http.StatusBadRequest || envelope.Success || executions != 1 || !strings.Contains(envelope.Error, "do not modify") {
		t.Fatalf("installed same-version update was not rejected as a no-op: %s", recorder.Body.String())
	}
}

func TestPackageCenterRehydratesDeclaredPackageWithoutCurrentCache(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	workspace := filepath.Join(serverRoot, "project-key")
	manifest := filepath.Join(workspace, "requirements.txt")
	writeEnvironmentFile(t, manifest, "numpy==2.1.0\n")

	contextRecorder, contextEnvelope := callProjectEnvironment(t, handler, `{"action":"getPackageCenterContext","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
	if contextRecorder.Code != http.StatusOK || !contextEnvelope.Success {
		t.Fatalf("cold context response: %s", contextRecorder.Body.String())
	}
	var center model.ProjectPackageCenterContext
	if err := json.Unmarshal(contextEnvelope.Data, &center); err != nil {
		t.Fatal(err)
	}
	if center.Inventory.Exact || center.Inventory.Status != "missing" || len(center.Packages.Missing) != 0 || len(center.Packages.Unknown) != 1 || center.Packages.Unknown[0].Name != "numpy" {
		t.Fatalf("cold cache must remain unknown environment truth: %+v", center)
	}

	executions := 0
	handler.EnvironmentSetup = func(ctx context.Context, _, _, _ string, _ []string) (string, string, int, error) {
		executions++
		lease := personalcache.LeaseFromContext(ctx)
		if lease == nil || !lease.Writable() {
			t.Fatal("cold rehydrate did not receive a writable generation")
		}
		reviewed, readErr := os.ReadFile(filepath.Join(lease.HostRoot, ".bobocloud-package-input", "requirements.txt"))
		if readErr != nil || string(reviewed) != "numpy==2.1.0\n" {
			t.Fatalf("cold rehydrate snapshot = %q err=%v", reviewed, readErr)
		}
		writePythonDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.1.0")
		return "rehydrated", "", 0, nil
	}

	planBody := `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","changes":[{"operation":"update","name":"numpy","version":"2.1.0"}]}`
	recorder, envelope := callProjectEnvironment(t, handler, planBody)
	if recorder.Code != http.StatusOK || !envelope.Success {
		t.Fatalf("cold rehydrate plan response: %s", recorder.Body.String())
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(envelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if !plan.Supported || !plan.Reinstall || len(plan.LocalChanges) != 0 || len(plan.ManifestBindings) != 1 || len(plan.Changes) != 1 || plan.Changes[0].Operation != "update" {
		t.Fatalf("cold rehydrate plan = %+v", plan)
	}
	applyBody, err := json.Marshal(map[string]any{
		"action": "applyProjectPackageChanges", "folderName": "Project", "folderKey": "project-key", "runtime": "python:3.10", "language": "python",
		"sourceId": "pypi-official", "packagePlanId": plan.PlanID,
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder, envelope = callProjectEnvironment(t, handler, string(applyBody))
	if recorder.Code != http.StatusOK || !envelope.Success || executions != 1 {
		t.Fatalf("cold rehydrate apply: executions=%d body=%s", executions, recorder.Body.String())
	}
	if data, err := os.ReadFile(manifest); err != nil || string(data) != "numpy==2.1.0\n" {
		t.Fatalf("cold rehydrate changed manifest: data=%q err=%v", data, err)
	}

	contextRecorder, contextEnvelope = callProjectEnvironment(t, handler, `{"action":"getPackageCenterContext","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python"}`)
	if contextRecorder.Code != http.StatusOK || !contextEnvelope.Success {
		t.Fatalf("rehydrated context response: %s", contextRecorder.Body.String())
	}
	if err := json.Unmarshal(contextEnvelope.Data, &center); err != nil {
		t.Fatal(err)
	}
	if !center.Inventory.Exact || center.Inventory.Status != "ready" || len(center.Packages.Unknown) != 0 || len(center.Packages.Installed) != 1 || center.Packages.Installed[0].Name != "numpy" {
		t.Fatalf("rehydrated inventory is not authoritative: %+v", center)
	}
}

func TestPackageCenterRehydrateCandidatesRejectBusyAndExactInventory(t *testing.T) {
	base := &model.ProjectEnvironment{
		Language:        model.ProjectEnvironmentLanguage{ID: "python"},
		DependencyCache: model.ProjectEnvironmentDependencyCache{Scope: "project-lock", Status: "miss", InventoryStatus: "missing"},
		Manifests:       []model.ProjectEnvironmentManifest{{Path: "requirements.txt", Kind: "requirements", Language: "python", Parsed: true}},
		Packages:        model.ProjectEnvironmentPackages{Declared: []model.ProjectEnvironmentPackage{{Name: "numpy", Source: "requirements.txt"}}},
	}
	if !packageCenterReinstallCandidates(base, "requirements.txt")["numpy"] {
		t.Fatal("cold direct declaration was not eligible for rehydrate")
	}
	busy := *base
	busy.DependencyCache.InventoryStatus = "busy"
	if packageCenterReinstallCandidates(&busy, "requirements.txt")["numpy"] {
		t.Fatal("busy dependency writer was misclassified as a cold rehydrate")
	}
	exact := *base
	exact.DependencyCache.Status = "hit"
	exact.DependencyCache.InventoryStatus = "ready"
	exact.Packages.Installed = []model.ProjectEnvironmentPackage{{Name: "numpy", Version: "2.1.0", Scope: "project-lock", Source: "project-lock-python", Trust: "exact"}}
	if packageCenterReinstallCandidates(&exact, "requirements.txt")["numpy"] {
		t.Fatal("exact installed package was misclassified as a rehydrate candidate")
	}
}

func TestPackageCenterReconcilesPublishedGenerationAfterRestartWithoutReexecution(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	workspace := filepath.Join(serverRoot, "project-key")
	manifestContent := []byte("numpy==2.1.0\n")
	writeEnvironmentFile(t, filepath.Join(workspace, "requirements.txt"), string(manifestContent))
	hash := sha256.Sum256(manifestContent)
	binding := model.ProjectPackageManifestBinding{Path: "requirements.txt", SHA256: hex.EncodeToString(hash[:])}
	completionDirectory := filepath.Join(dataRoot, "package-plans", "completed")
	limits := packageops.StoreLimits{MaxPlans: 8, MaxPlansPerUser: 4, MaxBytes: 1 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: 8 << 10}
	store, err := packageops.NewPersistentStoreWithLimits(time.Minute, time.Hour, limits, completionDirectory)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := store.Put(packageops.ExecutionPlan{
		Public: model.ProjectPackageChangePlan{Source: model.PackageCenterSource{ID: "pypi-official"}, ManifestBindings: []model.ProjectPackageManifestBinding{binding}},
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), FolderKey: "project-key",
		RuntimeID: "python:3.10", Language: "python", InstallURL: "https://pypi.org/simple/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "default"); err != nil {
		t.Fatal(err)
	}
	if err := store.BeginCompletionIntent(stored.Public.PlanID, "default"); err != nil {
		t.Fatal(err)
	}
	handler.PackagePlans, err = packageops.NewPersistentStoreWithLimits(time.Minute, time.Hour, limits, completionDirectory)
	if err != nil {
		t.Fatal(err)
	}
	executions := 0
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		executions++
		return "", "", 0, nil
	}
	applyBody, _ := json.Marshal(map[string]any{
		"action": "applyProjectPackageChanges", "folderName": "Project", "folderKey": "project-key", "runtime": "python:3.10", "language": "python",
		"sourceId": "pypi-official", "packagePlanId": stored.Public.PlanID,
	})
	recorder, envelope := callProjectEnvironment(t, handler, string(applyBody))
	if recorder.Code != http.StatusConflict || envelope.Success || !strings.Contains(recorder.Body.String(), `"errorCode":"package_plan_reconciliation_required"`) || executions != 0 {
		t.Fatalf("unpublished intent was not held for reconciliation: executions=%d body=%s", executions, recorder.Body.String())
	}

	cacheRequest := personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), WorkspaceName: "Project",
		RuntimeID: "python:3.10", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.10", "python:3.10-slim"), Language: "python", WorkspaceRoot: workspace,
		ManifestSnapshot: []personalcache.ManifestSnapshot{{Path: "requirements.txt", Content: manifestContent}}, OperationID: stored.Public.PlanID,
	}
	lease, err := handler.PersonalCache.Prepare(t.Context(), cacheRequest)
	if err != nil {
		t.Fatal(err)
	}
	writePythonDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.1.0")
	lease.Release()
	if !lease.Published() {
		t.Fatal("operation-bound generation was not published")
	}
	recorder, envelope = callProjectEnvironment(t, handler, string(applyBody))
	if recorder.Code != http.StatusOK || !envelope.Success || executions != 0 {
		t.Fatalf("published intent was not reconciled: executions=%d body=%s", executions, recorder.Body.String())
	}
	var result model.ProjectPackageChangeResult
	if err := json.Unmarshal(envelope.Data, &result); err != nil || !result.Applied || result.PlanID != stored.Public.PlanID {
		t.Fatalf("reconciled result = %+v err=%v", result, err)
	}
}

func TestPackageCenterRejectsAdditionalPythonDependencyManifest(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		return "", "", 0, nil
	}
	workspace := filepath.Join(serverRoot, "project-key")
	writeEnvironmentFile(t, filepath.Join(workspace, "main.py"), "import numpy\n")
	writeEnvironmentFile(t, filepath.Join(workspace, "pyproject.toml"), "[project]\nname = \"demo\"\ndependencies = []\n")

	recorder, envelope := callProjectEnvironment(t, handler, `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","changes":[{"operation":"add","name":"numpy","version":"2.1.0"}]}`)
	if recorder.Code != http.StatusConflict || envelope.Success || envelope.ErrorCode != "package_manifest_set_changed" || !strings.Contains(recorder.Body.String(), "only Python dependency manifest") {
		t.Fatalf("additional dependency manifest was accepted: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestPackageCenterApplyRejectsManifestSetChangedAfterPlan(t *testing.T) {
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
		t.Fatalf("plan response: %s", planRecorder.Body.String())
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	writeEnvironmentFile(t, filepath.Join(workspace, plan.LocalChanges[0].Path), plan.LocalChanges[0].NewContent)
	writeEnvironmentFile(t, filepath.Join(workspace, "pyproject.toml"), "[project]\nname = \"late-manifest\"\ndependencies = []\n")
	applyBody, _ := json.Marshal(map[string]any{
		"action": "applyProjectPackageChanges", "folderName": "Project", "folderKey": "project-key", "runtime": "python:3.10", "language": "python",
		"sourceId": "pypi-official", "packagePlanId": plan.PlanID,
	})
	recorder, envelope := callProjectEnvironment(t, handler, string(applyBody))
	if recorder.Code != http.StatusConflict || envelope.Success || executed || !strings.Contains(recorder.Body.String(), `"errorCode":"package_manifest_set_changed"`) {
		t.Fatalf("late dependency manifest reached executor: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestPackageCenterInUseProvidesRetryContract(t *testing.T) {
	handler, _, _ := newProjectEnvironmentTestHandler(t)
	stored, err := handler.PackagePlans.Put(packageops.ExecutionPlan{UserID: "default"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handler.PackagePlans.Claim(stored.Public.PlanID, "default"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { handler.PackagePlans.Release(stored.Public.PlanID) })
	body, _ := json.Marshal(map[string]any{"action": "applyProjectPackageChanges", "packagePlanId": stored.Public.PlanID})
	recorder, envelope := callProjectEnvironment(t, handler, string(body))
	if recorder.Code != http.StatusConflict || envelope.Success || recorder.Header().Get("Retry-After") != "1" || !strings.Contains(recorder.Body.String(), `"errorCode":"package_plan_in_use"`) {
		t.Fatalf("in-use retry contract: status=%d retry=%q body=%s", recorder.Code, recorder.Header().Get("Retry-After"), recorder.Body.String())
	}
}

func TestPackageOperationErrorsHaveStableCodes(t *testing.T) {
	quotaContext, cancelQuota := context.WithCancelCause(context.Background())
	cancelQuota(personalcache.ErrQuotaExceeded)
	for name, test := range map[string]struct {
		ctx      context.Context
		exitCode int
		err      error
		status   int
		code     string
	}{
		"quota":       {ctx: quotaContext, status: http.StatusInsufficientStorage, code: "package_storage_quota_exceeded"},
		"timeout":     {ctx: context.Background(), err: context.DeadlineExceeded, status: http.StatusGatewayTimeout, code: "package_operation_timeout"},
		"cancelled":   {ctx: context.Background(), err: context.Canceled, status: http.StatusRequestTimeout, code: "package_operation_cancelled"},
		"pip failure": {ctx: context.Background(), exitCode: 1, status: http.StatusConflict, code: "package_install_failed"},
		"executor":    {ctx: context.Background(), err: errors.New("docker unavailable"), status: http.StatusServiceUnavailable, code: "package_executor_unavailable"},
	} {
		t.Run(name, func(t *testing.T) {
			status, code := packageOperationError(test.ctx, test.exitCode, test.err)
			if status != test.status || code != test.code {
				t.Fatalf("status/code = %d/%s, want %d/%s", status, code, test.status, test.code)
			}
		})
	}
}

func TestPackagePlanCatalogValidationRejectsUnsafeSelections(t *testing.T) {
	base := packagecatalog.NewWithClient(configureCatalogSourcesForTest(), nil, 1<<20)
	change := model.ProjectPackageChange{Operation: "add", Name: "numpy", Version: "2.1.0"}
	for name, test := range map[string]struct {
		item       model.PackageCatalogItem
		err        error
		wantStatus int
		wantCode   string
	}{
		"package missing":      {err: packagecatalog.ErrNotFound, wantStatus: http.StatusBadRequest, wantCode: "package_not_found"},
		"version missing":      {item: model.PackageCatalogItem{Name: "numpy", Versions: []model.PackageCatalogVersion{{Version: "1.0.0", Compatibility: "metadata-compatible"}}}, wantStatus: http.StatusBadRequest, wantCode: "package_version_not_found"},
		"version yanked":       {item: model.PackageCatalogItem{Name: "numpy", Versions: []model.PackageCatalogVersion{{Version: "2.1.0", Yanked: true, Compatibility: "metadata-compatible"}}}, wantStatus: http.StatusConflict, wantCode: "package_version_yanked"},
		"version incompatible": {item: model.PackageCatalogItem{Name: "numpy", Versions: []model.PackageCatalogVersion{{Version: "2.1.0", Compatibility: "incompatible"}}}, wantStatus: http.StatusConflict, wantCode: "package_version_incompatible"},
		"version unknown":      {item: model.PackageCatalogItem{Name: "numpy", Versions: []model.PackageCatalogVersion{{Version: "2.1.0", Compatibility: "unknown"}}}, wantStatus: http.StatusConflict, wantCode: "package_version_compatibility_unknown"},
	} {
		t.Run(name, func(t *testing.T) {
			catalog := &packageCenterCatalogStub{base: base, itemFn: func(context.Context, packagecatalog.ItemRequest) (model.PackageCatalogItem, error) {
				return test.item, test.err
			}}
			_, status, code, err := resolveAndValidatePackagePlanCatalog(t.Context(), catalog, "pypi-official", "3.10.21", "exact", []model.ProjectPackageChange{change})
			if err == nil || status != test.wantStatus || code != test.wantCode {
				t.Fatalf("validation = status:%d code:%s err:%v", status, code, err)
			}
		})
	}

	calls := 0
	compatible := &packageCenterCatalogStub{base: base, itemFn: func(context.Context, packagecatalog.ItemRequest) (model.PackageCatalogItem, error) {
		calls++
		return model.PackageCatalogItem{Name: "numpy", Versions: []model.PackageCatalogVersion{{Version: "2.1.0", Compatibility: "assumed-compatible"}}}, nil
	}}
	resolved, status, code, err := resolveAndValidatePackagePlanCatalog(t.Context(), compatible, "pypi-official", "3.10.21", "exact", []model.ProjectPackageChange{change, {Operation: "remove", Name: "old"}})
	if err != nil || status != http.StatusOK || code != "" || calls != 1 || len(resolved) != 2 {
		t.Fatalf("compatible/removed validation = calls:%d status:%d code:%s err:%v", calls, status, code, err)
	}
}

func TestPackagePlanCatalogValidationUsesBoundedConcurrencyAndPreservesOrder(t *testing.T) {
	for _, ecosystem := range []string{"python", "node"} {
		t.Run(ecosystem, func(t *testing.T) {
			base := packagecatalog.NewWithClient(configureCatalogSourcesForTest(), nil, 1<<20)
			names := []string{"alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"}
			gates := make(map[string]chan struct{}, len(names))
			for _, name := range names {
				gates[name] = make(chan struct{})
			}
			started := make(chan string, len(names))
			completed := make(chan string, len(names))
			var active atomic.Int32
			var maxActive atomic.Int32
			var calls atomic.Int32
			catalog := &packageCenterCatalogStub{base: base, itemFn: func(ctx context.Context, request packagecatalog.ItemRequest) (model.PackageCatalogItem, error) {
				calls.Add(1)
				current := active.Add(1)
				defer active.Add(-1)
				for observed := maxActive.Load(); current > observed && !maxActive.CompareAndSwap(observed, current); observed = maxActive.Load() {
				}
				started <- request.Name
				select {
				case <-gates[request.Name]:
				case <-ctx.Done():
					return model.PackageCatalogItem{}, ctx.Err()
				}
				completed <- request.Name
				version := request.Name + "-resolved"
				return model.PackageCatalogItem{
					Name: request.Name, RecommendedVersion: version, CatalogAuthority: ecosystem + ".catalog.example",
					Versions: []model.PackageCatalogVersion{{Version: version, Compatibility: "metadata-compatible"}},
				}, nil
			}}
			changes := []model.ProjectPackageChange{
				{Operation: "add", Name: "alpha"},
				{Operation: "update", Name: "beta"},
				{Operation: "add", Name: "gamma"},
				{Operation: "add", Name: "delta"},
				{Operation: "remove", Name: "removed-without-catalog-query"},
				{Operation: "add", Name: "epsilon"},
				{Operation: "update", Name: "zeta"},
				{Operation: "add", Name: "eta"},
				{Operation: "add", Name: "theta"},
			}
			type validationResult struct {
				changes []model.ProjectPackageChange
				status  int
				code    string
				err     error
			}
			done := make(chan validationResult, 1)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			go func() {
				resolved, status, code, err := resolveAndValidatePackagePlanCatalogForEcosystem(ctx, catalog, ecosystem, "", "20.19.0", "exact", changes)
				done <- validationResult{changes: resolved, status: status, code: code, err: err}
			}()

			released := make(map[string]bool, len(names))
			defer func() {
				for _, name := range names {
					if !released[name] {
						close(gates[name])
					}
				}
			}()
			for batchStart := 0; batchStart < len(names); batchStart += packagePlanCatalogConcurrency {
				batchEnd := min(batchStart+packagePlanCatalogConcurrency, len(names))
				seen := make(map[string]bool, batchEnd-batchStart)
				for range names[batchStart:batchEnd] {
					select {
					case name := <-started:
						seen[name] = true
					case <-ctx.Done():
						t.Fatal("catalog validation did not start the expected batch")
					}
				}
				for _, name := range names[batchStart:batchEnd] {
					if !seen[name] {
						t.Fatalf("catalog batch started unexpected requests: got %v", seen)
					}
				}
				select {
				case unexpected := <-started:
					t.Fatalf("catalog concurrency exceeded %d; started %s before the current batch completed", packagePlanCatalogConcurrency, unexpected)
				default:
				}
				for index := batchEnd - 1; index >= batchStart; index-- {
					name := names[index]
					close(gates[name])
					released[name] = true
					select {
					case completedName := <-completed:
						if completedName != name {
							t.Fatalf("catalog completion order = %s, want %s", completedName, name)
						}
					case <-ctx.Done():
						t.Fatal("catalog request did not complete after release")
					}
				}
			}

			var result validationResult
			select {
			case result = <-done:
			case <-ctx.Done():
				t.Fatal("catalog validation did not finish")
			}
			if result.err != nil || result.status != http.StatusOK || result.code != "" {
				t.Fatalf("catalog validation = status:%d code:%s err:%v", result.status, result.code, result.err)
			}
			if maxActive.Load() != packagePlanCatalogConcurrency || calls.Load() != int32(len(names)) {
				t.Fatalf("catalog calls = %d max concurrency = %d", calls.Load(), maxActive.Load())
			}
			for index, change := range result.changes {
				if change.Name != changes[index].Name || change.Operation != changes[index].Operation {
					t.Fatalf("resolved change %d lost input order: got %+v want %+v", index, change, changes[index])
				}
				if change.Operation != "remove" && change.Version != change.Name+"-resolved" {
					t.Fatalf("resolved change %d received the wrong catalog result: %+v", index, change)
				}
			}
		})
	}
}

func TestPackagePlanCatalogValidationPreservesInputErrorPriority(t *testing.T) {
	base := packagecatalog.NewWithClient(configureCatalogSourcesForTest(), nil, 1<<20)
	secondCompleted := make(chan struct{})
	releaseFirst := make(chan struct{})
	catalog := &packageCenterCatalogStub{base: base, itemFn: func(ctx context.Context, request packagecatalog.ItemRequest) (model.PackageCatalogItem, error) {
		if request.Name == "first-missing" {
			select {
			case <-releaseFirst:
				return model.PackageCatalogItem{}, packagecatalog.ErrNotFound
			case <-ctx.Done():
				return model.PackageCatalogItem{}, ctx.Err()
			}
		}
		close(secondCompleted)
		return model.PackageCatalogItem{}, context.DeadlineExceeded
	}}
	type validationResult struct {
		status int
		code   string
		err    error
	}
	done := make(chan validationResult, 1)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	go func() {
		_, status, code, err := resolveAndValidatePackagePlanCatalogForEcosystem(ctx, catalog, "node", "", "20.19.0", "exact", []model.ProjectPackageChange{
			{Operation: "add", Name: "first-missing", Version: "1.0.0"},
			{Operation: "add", Name: "second-timeout", Version: "1.0.0"},
		})
		done <- validationResult{status: status, code: code, err: err}
	}()
	select {
	case <-secondCompleted:
	case <-ctx.Done():
		t.Fatal("second catalog request did not complete first")
	}
	close(releaseFirst)
	select {
	case result := <-done:
		if result.err == nil || result.status != http.StatusBadRequest || result.code != "package_not_found" {
			t.Fatalf("catalog error priority = status:%d code:%s err:%v", result.status, result.code, result.err)
		}
	case <-ctx.Done():
		t.Fatal("catalog validation did not return")
	}
}

func TestPackagePlanCatalogValidationRejectsMoreThanSixteenChecksBeforeQuery(t *testing.T) {
	base := packagecatalog.NewWithClient(configureCatalogSourcesForTest(), nil, 1<<20)
	var calls atomic.Int32
	catalog := &packageCenterCatalogStub{base: base, itemFn: func(_ context.Context, request packagecatalog.ItemRequest) (model.PackageCatalogItem, error) {
		calls.Add(1)
		return model.PackageCatalogItem{
			Name:     request.Name,
			Versions: []model.PackageCatalogVersion{{Version: request.Version, Compatibility: "metadata-compatible"}},
		}, nil
	}}
	changes := make([]model.ProjectPackageChange, packagePlanMaxCatalogChecks)
	for index := range changes {
		changes[index] = model.ProjectPackageChange{Operation: "add", Name: "package-at-limit", Version: "1.0.0"}
	}
	resolved, status, code, err := resolveAndValidatePackagePlanCatalog(t.Context(), catalog, "pypi-official", "3.10.21", "exact", changes)
	if err != nil || status != http.StatusOK || code != "" || len(resolved) != packagePlanMaxCatalogChecks || calls.Load() != packagePlanMaxCatalogChecks {
		t.Fatalf("catalog check limit acceptance = calls:%d status:%d code:%s err:%v", calls.Load(), status, code, err)
	}

	calls.Store(0)
	changes = append(changes, model.ProjectPackageChange{Operation: "add", Name: "over-limit", Version: "1.0.0"})
	_, status, code, err = resolveAndValidatePackagePlanCatalog(t.Context(), catalog, "pypi-official", "3.10.21", "exact", changes)
	if err == nil || status != http.StatusBadRequest || code != "package_catalog_check_limit_exceeded" || calls.Load() != 0 {
		t.Fatalf("catalog check limit = calls:%d status:%d code:%s err:%v", calls.Load(), status, code, err)
	}
}

func configureCatalogSourcesForTest() []config.PackageSourceConfig {
	return config.Default().PackageSources
}

func TestPackageCenterCapabilityRequiresManagedCacheAndAdvertisesTimeout(t *testing.T) {
	handler, _, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	handler.EnvironmentSetup = func(context.Context, string, string, string, []string) (string, string, int, error) {
		return "", "", 0, nil
	}
	descriptor := handler.serverCapabilities()
	if !descriptor.Capabilities.PackageCenter || descriptor.Limits.PackageOperationTimeoutSeconds != handler.Config.PackageOperationTimeoutSeconds {
		t.Fatalf("package center capability = %+v limits=%+v", descriptor.Capabilities, descriptor.Limits)
	}
	handler.PersonalCache = nil
	if handler.serverCapabilities().Capabilities.PackageCenter {
		t.Fatal("package center was advertised without the managed project cache service")
	}
}

func TestPackageCenterRejectsMismatchedInventoryBeforePublication(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	workspace := filepath.Join(serverRoot, "project-key")
	manifest := filepath.Join(workspace, "requirements.txt")
	writeEnvironmentFile(t, manifest, "numpy==2.1.0\n")
	cacheRequest := personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), WorkspaceName: "Project",
		RuntimeID: "python:3.10", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.10", "python:3.10-slim"), Language: "python", WorkspaceRoot: workspace,
	}
	oldLease, err := handler.PersonalCache.Prepare(t.Context(), cacheRequest)
	if err != nil {
		t.Fatal(err)
	}
	writePythonDistInfo(t, filepath.Join(oldLease.HostRoot, "python"), "numpy", "2.1.0")
	oldGeneration := oldLease.Generation
	oldLease.Release()

	handler.EnvironmentSetup = func(ctx context.Context, _, _, _ string, _ []string) (string, string, int, error) {
		lease := personalcache.LeaseFromContext(ctx)
		if lease == nil || !lease.Writable() {
			t.Fatal("package apply did not receive a writable generation")
		}
		writePythonDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.1.0")
		return "pip exited successfully with the wrong tree", "", 0, nil
	}
	planRecorder, planEnvelope := callProjectEnvironment(t, handler, `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","changes":[{"operation":"update","name":"numpy","version":"2.2.0"}]}`)
	if planRecorder.Code != http.StatusOK || !planEnvelope.Success {
		t.Fatalf("plan response: %s", planRecorder.Body.String())
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	writeEnvironmentFile(t, manifest, plan.LocalChanges[0].NewContent)
	applyBody, _ := json.Marshal(map[string]any{
		"action": "applyProjectPackageChanges", "folderName": "Project", "folderKey": "project-key", "runtime": "python:3.10", "language": "python",
		"sourceId": "pypi-official", "packagePlanId": plan.PlanID,
	})
	recorder, envelope := callProjectEnvironment(t, handler, string(applyBody))
	if recorder.Code != http.StatusConflict || envelope.Success || !strings.Contains(recorder.Body.String(), "does not match") {
		t.Fatalf("mismatched staged inventory was accepted: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	entries := handler.PersonalCache.Inspect("default", 0).Entries
	if len(entries) != 1 || entries[0].Generation != oldGeneration {
		t.Fatalf("mismatched generation replaced last good cache: %+v", entries)
	}
}

func TestPackageCenterFailedInstallKeepsLastGoodGenerationAndPlanRetryable(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	workspace := filepath.Join(serverRoot, "project-key")
	manifest := filepath.Join(workspace, "requirements.txt")
	writeEnvironmentFile(t, manifest, "numpy==2.1.0\n")
	cacheRequest := personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), WorkspaceName: "Project",
		RuntimeID: "python:3.10", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.10", "python:3.10-slim"), Language: "python", WorkspaceRoot: workspace,
	}
	oldLease, err := handler.PersonalCache.Prepare(t.Context(), cacheRequest)
	if err != nil {
		t.Fatal(err)
	}
	writePythonDistInfo(t, filepath.Join(oldLease.HostRoot, "python"), "numpy", "2.1.0")
	oldGeneration := oldLease.Generation
	oldLease.Release()
	if !oldLease.Published() {
		t.Fatal("last good dependency generation was not published")
	}
	attempts := 0
	handler.EnvironmentSetup = func(ctx context.Context, _, _, _ string, _ []string) (string, string, int, error) {
		attempts++
		lease := personalcache.LeaseFromContext(ctx)
		if lease == nil || !lease.Writable() || lease.Generation == oldGeneration {
			t.Fatalf("retry did not use a staged writable generation: %+v", lease)
		}
		writePythonDistInfo(t, filepath.Join(lease.HostRoot, "python"), "numpy", "2.2.0")
		if attempts == 1 {
			return "", "network failed", 1, errors.New("pip install failed")
		}
		return "installed", "", 0, nil
	}

	planRecorder, planEnvelope := callProjectEnvironment(t, handler, `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","changes":[{"operation":"update","name":"numpy","version":"2.2.0"}]}`)
	if planRecorder.Code != http.StatusOK || !planEnvelope.Success {
		t.Fatalf("update plan response: %s", planRecorder.Body.String())
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if !plan.Supported || len(plan.LocalChanges) != 1 {
		t.Fatalf("update plan = %+v response=%s", plan, planRecorder.Body.String())
	}
	writeEnvironmentFile(t, manifest, plan.LocalChanges[0].NewContent)
	applyBody, _ := json.Marshal(map[string]any{
		"action": "applyProjectPackageChanges", "folderName": "Project", "folderKey": "project-key", "runtime": "python:3.10", "language": "python",
		"sourceId": "pypi-official", "packagePlanId": plan.PlanID,
	})
	failedRecorder, failedEnvelope := callProjectEnvironment(t, handler, string(applyBody))
	if failedRecorder.Code != http.StatusConflict || failedEnvelope.Success {
		t.Fatalf("failed install response: %s", failedRecorder.Body.String())
	}
	if info := handler.PersonalCache.Inspect("default", 0); len(info.Entries) != 1 || info.Entries[0].Generation != oldGeneration {
		t.Fatalf("failed staging generation became visible: %+v", info.Entries)
	}
	if _, exists, lookupErr := handler.PersonalCache.Lookup(cacheRequest); lookupErr != nil || exists {
		t.Fatalf("failed digest was published: exists=%v err=%v", exists, lookupErr)
	}

	retryRecorder, retryEnvelope := callProjectEnvironment(t, handler, string(applyBody))
	if retryRecorder.Code != http.StatusOK || !retryEnvelope.Success || attempts != 2 {
		t.Fatalf("released plan could not be retried: attempts=%d body=%s", attempts, retryRecorder.Body.String())
	}
}

func TestPackageCenterRemoveFinalDependencyPublishesEmptyNewDigest(t *testing.T) {
	handler, serverRoot, dataRoot := newProjectEnvironmentTestHandler(t)
	configurePackageCenterTestHandler(handler, dataRoot)
	workspace := filepath.Join(serverRoot, "project-key")
	manifest := filepath.Join(workspace, "requirements.txt")
	writeEnvironmentFile(t, manifest, "numpy==2.1.0\n")
	cacheRequest := personalcache.Request{
		UserID: "default", WorkspaceID: lsp.StableWorkspaceIdentity("default", "", "", "", "project-key"), WorkspaceName: "Project",
		RuntimeID: "python:3.10", RuntimeFingerprint: personalCacheRuntimeFingerprint("python:3.10", "python:3.10-slim"), Language: "python", WorkspaceRoot: workspace,
	}
	oldLease, err := handler.PersonalCache.Prepare(t.Context(), cacheRequest)
	if err != nil {
		t.Fatal(err)
	}
	writePythonDistInfo(t, filepath.Join(oldLease.HostRoot, "python"), "numpy", "2.1.0")
	oldDigest := oldLease.Fingerprint.Digest
	oldLease.Release()
	if !oldLease.Published() {
		t.Fatal("old dependency generation was not published")
	}

	handler.EnvironmentSetup = func(ctx context.Context, _, _, _ string, commands []string) (string, string, int, error) {
		lease := personalcache.LeaseFromContext(ctx)
		if lease == nil || lease.Fingerprint.Digest == oldDigest {
			t.Fatalf("removal reused old dependency digest: lease=%+v", lease)
		}
		if len(commands) != 1 || !strings.Contains(commands[0], "mkdir -p \"$PIP_TARGET\"") {
			t.Fatalf("empty target was not prepared: %#v", commands)
		}
		if err := os.MkdirAll(filepath.Join(lease.HostRoot, "python"), 0700); err != nil {
			t.Fatal(err)
		}
		return "requirements are empty", "", 0, nil
	}
	planRecorder, planEnvelope := callProjectEnvironment(t, handler, `{"action":"planProjectPackageChanges","folderName":"Project","folderKey":"project-key","runtime":"python:3.10","language":"python","sourceId":"pypi-official","changes":[{"operation":"remove","name":"numpy"}]}`)
	if planRecorder.Code != http.StatusOK || !planEnvelope.Success {
		t.Fatalf("remove plan response: %s", planRecorder.Body.String())
	}
	var plan model.ProjectPackageChangePlan
	if err := json.Unmarshal(planEnvelope.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if !plan.Supported || len(plan.LocalChanges) != 1 || plan.LocalChanges[0].NewContent != "" {
		t.Fatalf("remove plan = %+v", plan)
	}
	writeEnvironmentFile(t, manifest, plan.LocalChanges[0].NewContent)
	applyBody, _ := json.Marshal(map[string]any{
		"action": "applyProjectPackageChanges", "folderName": "Project", "folderKey": "project-key", "runtime": "python:3.10", "language": "python",
		"sourceId": "pypi-official", "packagePlanId": plan.PlanID,
	})
	recorder, envelope := callProjectEnvironment(t, handler, string(applyBody))
	if recorder.Code != http.StatusOK || !envelope.Success {
		t.Fatalf("remove apply response: %s", recorder.Body.String())
	}
	newRequest := cacheRequest
	entry, exists, err := handler.PersonalCache.Lookup(newRequest)
	if err != nil || !exists || entry.Digest == oldDigest {
		t.Fatalf("new empty dependency scope = %+v exists=%v err=%v", entry, exists, err)
	}
	inventory := handler.PersonalCache.InspectPackageInventory(newRequest)
	if inventory.State != "ready" || !inventory.Exact || len(inventory.Packages) != 0 {
		t.Fatalf("empty dependency inventory = %+v", inventory)
	}
	info := handler.PersonalCache.Inspect("default", 0)
	if len(info.Entries) != 2 {
		t.Fatalf("old and new digest scopes should coexist until normal LRU: %+v", info.Entries)
	}
}
