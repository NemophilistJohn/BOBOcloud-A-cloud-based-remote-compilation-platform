package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/packagecatalog"
	"bobocloud-server/internal/packageops"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/safefile"
)

const (
	packageCenterContextSchema   = "project-package-center/v1"
	packageChangePlanSchema      = "project-package-change-plan/v1"
	packageChangeActionSchema    = "project-package-change-action/v1"
	packagePlanRetryAfterSeconds = 1
	packagePlanMaxCatalogChecks  = 16
)

func (h *HTTPHandler) handlePackageCenter(w http.ResponseWriter, r *http.Request, req *model.Request) {
	switch req.Action {
	case "getPackageCenterContext":
		environment, _, err := h.inspectProjectEnvironment(r, sanitizedPackageRequest(req))
		if err != nil {
			writeProjectEnvironmentError(w, err)
			return
		}
		context := h.projectPackageCenterContext(environment)
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: context})
	case "searchPackageCatalog":
		h.searchPackageCatalog(w, r, req)
	case "getPackageCatalogItem":
		h.getPackageCatalogItem(w, r, req)
	case "planProjectPackageChanges":
		h.planProjectPackageChanges(w, r, req)
	case "applyProjectPackageChanges":
		h.applyProjectPackageChanges(w, r, req)
	}
}

func sanitizedPackageRequest(req *model.Request) *model.Request {
	copyValue := *req
	copyValue.SetupCommands = nil
	copyValue.Command = ""
	return &copyValue
}

func (h *HTTPHandler) projectPackageCenterContext(environment *model.ProjectEnvironment) model.ProjectPackageCenterContext {
	result := model.ProjectPackageCenterContext{
		Schema: packageCenterContextSchema, Revision: environment.Revision, Workspace: environment.Workspace,
		Language: environment.Language, Runtime: environment.Runtime, SearchMode: packagecatalog.SearchModeExact,
		OperationTimeoutSeconds: h.packageOperationTimeoutSeconds(),
		DefaultManifestPath:     defaultEditablePythonManifest(environment.Manifests),
		Manifests:               append([]model.ProjectEnvironmentManifest(nil), environment.Manifests...),
		Packages: model.ProjectPackageCenterPackages{
			Declared: append([]model.ProjectEnvironmentPackage(nil), environment.Packages.Declared...),
			Missing:  append([]model.ProjectEnvironmentPackage(nil), environment.Packages.Missing...),
			Unknown:  append([]model.ProjectEnvironmentPackage(nil), environment.Packages.Unknown...),
		},
		Inventory: model.ProjectPackageInventory{
			Status: environment.DependencyCache.InventoryStatus, Detail: environment.DependencyCache.InventoryDetail,
			CheckedAt: environment.DependencyCache.InventoryCheckedAt,
		},
	}
	if h.PackageCatalog != nil {
		result.Sources = h.PackageCatalog.Sources(environment.Language.ID)
		result.DefaultSource = h.PackageCatalog.DefaultSource(environment.Language.ID)
	}
	result.Inventory.Exact = projectPackageInventoryExact(environment)
	dependencyManifests := make(map[string]bool)
	for _, manifest := range environment.Manifests {
		if manifest.Kind != "source-imports" {
			dependencyManifests[manifest.Path] = true
		}
	}
	declared := make(map[string][]string)
	for _, item := range environment.Packages.Declared {
		key := normalizePythonPackageName(item.Name)
		for _, source := range strings.Split(item.Source, ", ") {
			source = strings.TrimSpace(source)
			if source != "" && dependencyManifests[source] {
				declared[key] = appendUniqueString(declared[key], source)
			}
		}
	}
	for _, item := range environment.Packages.Installed {
		relationship := "unknown"
		declaredIn := declared[normalizePythonPackageName(item.Name)]
		if len(declaredIn) > 0 {
			relationship = "direct"
		} else if result.Inventory.Exact {
			relationship = "transitive"
		}
		result.Packages.Installed = append(result.Packages.Installed, model.ProjectPackageInstalled{
			Name: item.Name, Version: item.Version, Relationship: relationship, DeclaredIn: declaredIn, Trust: item.Trust,
		})
	}
	result.CanPlanChanges = h.packageCenterPlanCapability(environment)
	return result
}

func (h *HTTPHandler) packageOperationTimeoutSeconds() int {
	if h != nil && h.Config != nil && h.Config.PackageOperationTimeoutSeconds > 0 {
		return h.Config.PackageOperationTimeoutSeconds
	}
	return 10 * 60
}

func appendUniqueString(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func (h *HTTPHandler) packageCenterPlanCapability(environment *model.ProjectEnvironment) model.PackageCenterCapability {
	capability := model.PackageCenterCapability{Supported: false}
	switch {
	case h.Config == nil || !h.Config.PackageCenterEnabled:
		capability.Reason = "package-center-disabled"
	case h.PackageCatalog == nil:
		capability.Reason = "package-catalog-unavailable"
	case h.PersonalCache == nil || h.PersonalCache.ScopeMode() != "project-lock":
		capability.Reason = "project-lock-cache-required"
	case h.EnvironmentSetup == nil:
		capability.Reason = "environment-setup-unavailable"
	case environment.Workspace.Kind != "personal":
		capability.Reason = "team-workspace-unsupported"
	case environment.Language.ID != "python" || environment.Runtime.Language != "python":
		capability.Reason = "ecosystem-unsupported"
	case environment.Runtime.ID == "" || environment.Runtime.ID == "local":
		capability.Reason = "managed-runtime-required"
	default:
		capability.Supported = true
	}
	return capability
}

func (h *HTTPHandler) searchPackageCatalog(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.packageCatalogAvailable(w) {
		return
	}
	language, runtimeVersion, runtimeTrust, err := h.packageCatalogRequestRuntime(r.Context(), req)
	if err != nil || language != "python" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "A managed Python runtime is required for package search", ErrorCode: "package_runtime_required"})
		return
	}
	started := time.Now()
	result, err := h.PackageCatalog.Search(r.Context(), packagecatalog.SearchRequest{Query: req.Query, SourceID: req.SourceID, Cursor: req.Cursor, RuntimeVersion: runtimeVersion, RuntimeVersionTrust: runtimeTrust})
	if h.Metrics != nil {
		h.Metrics.Observe("package.catalog.search", time.Since(started))
	}
	if err != nil {
		writePackageCatalogError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: result})
}

func (h *HTTPHandler) getPackageCatalogItem(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.packageCatalogAvailable(w) {
		return
	}
	language, runtimeVersion, runtimeTrust, err := h.packageCatalogRequestRuntime(r.Context(), req)
	if err != nil || language != "python" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "A managed Python runtime is required for package details", ErrorCode: "package_runtime_required"})
		return
	}
	started := time.Now()
	item, err := h.PackageCatalog.Item(r.Context(), packagecatalog.ItemRequest{Name: req.PackageName, SourceID: req.SourceID, RuntimeVersion: runtimeVersion, RuntimeVersionTrust: runtimeTrust})
	if h.Metrics != nil {
		h.Metrics.Observe("package.catalog.item", time.Since(started))
	}
	if err != nil {
		writePackageCatalogError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: item})
}

func (h *HTTPHandler) packageCatalogAvailable(w http.ResponseWriter) bool {
	if h.Config == nil || !h.Config.PackageCenterEnabled || h.PackageCatalog == nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Package catalog is not configured", ErrorCode: "package_catalog_unavailable"})
		return false
	}
	return true
}

func (h *HTTPHandler) packageCatalogRequestRuntime(ctx context.Context, req *model.Request) (string, string, string, error) {
	runtime := model.GetRuntimeDef(strings.TrimSpace(req.Runtime))
	if runtime == nil {
		return "", "", "", fmt.Errorf("unknown runtime")
	}
	language := canonicalEnvironmentLanguage(req.Language)
	if language == "" {
		language = runtime.Language
	}
	metadata := resolveProjectRuntimeMetadata(ctx, h.RuntimeMetadata, runtime.RuntimeID, runtime.DockerImage, runtime.Version)
	return language, metadata.Version, metadata.VersionTrust, nil
}

func writePackageCatalogError(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	code := "package_catalog_unavailable"
	switch {
	case errors.Is(err, packagecatalog.ErrNotFound):
		status = http.StatusNotFound
		code = "package_not_found"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		status = http.StatusGatewayTimeout
		code = "package_catalog_timeout"
	case strings.Contains(err.Error(), "invalid"), strings.Contains(err.Error(), "unknown"):
		status = http.StatusBadRequest
		code = "package_catalog_request_invalid"
	}
	writeJSON(w, status, model.Response{Success: false, Error: err.Error(), ErrorCode: code})
}

func (h *HTTPHandler) planProjectPackageChanges(w http.ResponseWriter, r *http.Request, req *model.Request) {
	safeRequest := sanitizedPackageRequest(req)
	environment, resolved, err := h.inspectProjectEnvironment(r, safeRequest)
	if err != nil {
		writeProjectEnvironmentError(w, err)
		return
	}
	if expected := strings.TrimSpace(req.Revision); expected != "" && expected != environment.Revision {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Project environment changed after package changes were selected", ErrorCode: "package_plan_workspace_changed", Data: environment})
		return
	}
	plan := model.ProjectPackageChangePlan{
		Schema: packageChangePlanSchema, Revision: environment.Revision, RequiresConfirmation: false,
		Workspace: environment.Workspace, Runtime: environment.Runtime, Language: environment.Language,
		Changes: []model.ProjectPackageChange{}, LocalChanges: []model.ProjectPackageLocalChange{},
		Steps: []model.ProjectPackagePlanStep{}, Warnings: []string{},
	}
	if capability := h.packageCenterPlanCapability(environment); !capability.Supported {
		plan.Reason = capability.Reason
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: plan})
		return
	}
	source, err := h.PackageCatalog.ResolveSource("python", req.SourceID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_source_invalid"})
		return
	}
	if source.Public.EquivalenceGroup != "pypi" {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Only equivalent public PyPI sources are supported", ErrorCode: "package_source_not_equivalent"})
		return
	}
	catalogTimeout := 8 * time.Second
	if h.Config != nil && h.Config.PackageCatalogTimeoutSeconds > 0 {
		catalogTimeout = time.Duration(h.Config.PackageCatalogTimeoutSeconds) * time.Second
	}
	catalogContext, cancelCatalog := context.WithTimeout(r.Context(), catalogTimeout)
	startedCatalogValidation := time.Now()
	runtimeVersion := strings.TrimSpace(environment.Runtime.ResolvedVersion)
	if runtimeVersion == "" {
		runtimeVersion = environment.Runtime.Version
	}
	resolvedChanges, status, errorCode, err := resolveAndValidatePackagePlanCatalog(
		catalogContext, h.PackageCatalog, source.Public.ID, runtimeVersion, environment.Runtime.ResolvedVersionTrust, req.PackageChanges,
	)
	cancelCatalog()
	if h.Metrics != nil {
		h.Metrics.Observe("package.catalog.plan-validation", time.Since(startedCatalogValidation))
	}
	if err != nil {
		writeJSON(w, status, model.Response{Success: false, Error: err.Error(), ErrorCode: errorCode})
		return
	}
	candidates := editablePythonRequirementManifests(environment.Manifests)
	allowReinstall := make(map[string]bool, len(environment.Packages.Missing))
	for _, item := range environment.Packages.Missing {
		allowReinstall[normalizePythonPackageName(item.Name)] = true
	}
	requirementsPlan, err := packageops.PlanPythonRequirementsWithOptions(
		resolved.root, req.PackageManifestPath, candidates, resolvedChanges,
		packageops.RequirementsPlanOptions{AllowReinstall: allowReinstall},
	)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_manifest_change_invalid"})
		return
	}
	manifestPath := requirementsPlan.ManifestBinding.Path
	if err := validateManagedPythonManifestSet(environment, manifestPath); err != nil {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_manifest_set_changed"})
		return
	}
	if err := validateProjectPackageDeclarations(environment, manifestPath, requirementsPlan.Changes); err != nil {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_declaration_conflict"})
		return
	}
	plan.Supported = true
	plan.Source = source.Public
	plan.Changes = requirementsPlan.Changes
	plan.ManifestBindings = []model.ProjectPackageManifestBinding{requirementsPlan.ManifestBinding}
	plan.Reinstall = requirementsPlan.Reinstall
	if !requirementsPlan.Reinstall {
		plan.LocalChanges = []model.ProjectPackageLocalChange{requirementsPlan.LocalChange}
	}
	plan.Warnings = requirementsPlan.Warnings
	for _, change := range plan.Changes {
		if change.Operation == "remove" {
			plan.Warnings = appendUniqueString(plan.Warnings, "removed-package-may-remain-transitive")
		}
	}
	if !requirementsPlan.Reinstall {
		plan.Steps = append(plan.Steps,
			model.ProjectPackagePlanStep{ID: "write-manifest", Kind: "local-change", Manager: "pip", Description: "Write the reviewed requirements change locally"},
			model.ProjectPackagePlanStep{ID: "sync-manifest", Kind: "sync", Manager: "pip", Description: "Synchronize the exact manifest revision to the server"},
		)
	}
	plan.Steps = append(plan.Steps,
		model.ProjectPackagePlanStep{ID: "resolve-python-environment", Kind: "install", Manager: "pip", Description: "Resolve all declared packages into a new project dependency generation"},
		model.ProjectPackagePlanStep{ID: "verify-python-environment", Kind: "verify", Manager: "pip", Description: "Publish exact package inventory and refresh dependent language services"},
	)
	stored, err := h.PackagePlans.Put(packageops.ExecutionPlan{
		Public: plan, UserID: auth.UserIDFromContext(r.Context()), WorkspaceID: environment.Workspace.ID,
		FolderKey: resolved.folderKey, RuntimeID: environment.Runtime.ID,
		RuntimeFingerprint: resolvedRuntimeFingerprint(r.Context(), h.RuntimeMetadata, environment.Runtime.ID, environment.Runtime.Image, environment.Runtime.Version),
		Language:           environment.Language.ID, InstallURL: source.InstallURL,
	})
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, packageops.ErrPlanCapacity) {
			status = http.StatusTooManyRequests
		}
		writeJSON(w, status, model.Response{Success: false, Error: "Could not create a package change plan", ErrorCode: "package_plan_unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: stored.Public})
}

func resolveAndValidatePackagePlanCatalog(ctx context.Context, catalog packagecatalog.Catalog, sourceID, runtimeVersion, runtimeVersionTrust string, changes []model.ProjectPackageChange) ([]model.ProjectPackageChange, int, string, error) {
	resolved := append([]model.ProjectPackageChange(nil), changes...)
	checks := 0
	preferredAuthority := ""
	for index := range resolved {
		change := &resolved[index]
		if change.Operation != "add" && change.Operation != "update" && change.Operation != "remove" {
			return nil, http.StatusBadRequest, "invalid_package_operation", fmt.Errorf("unsupported package operation %q", change.Operation)
		}
		if change.Operation == "remove" {
			continue
		}
		checks++
		if checks > packagePlanMaxCatalogChecks {
			return nil, http.StatusBadRequest, "package_catalog_check_limit_exceeded", fmt.Errorf("a package plan can validate at most %d added or updated packages", packagePlanMaxCatalogChecks)
		}
		requestedVersion := strings.TrimSpace(change.Version)
		item, err := catalog.Item(ctx, packagecatalog.ItemRequest{
			Name: change.Name, SourceID: sourceID, RuntimeVersion: runtimeVersion, RuntimeVersionTrust: runtimeVersionTrust,
			Version: requestedVersion, PreferredCatalogAuthority: preferredAuthority,
		})
		if err != nil {
			switch {
			case errors.Is(err, packagecatalog.ErrNotFound):
				return nil, http.StatusBadRequest, "package_not_found", fmt.Errorf("package %s does not exist in the official catalog", change.Name)
			case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled), errors.Is(context.Cause(ctx), context.DeadlineExceeded):
				return nil, http.StatusGatewayTimeout, "package_catalog_timeout", fmt.Errorf("package catalog validation timed out")
			default:
				return nil, http.StatusBadGateway, "package_catalog_unavailable", fmt.Errorf("could not validate package %s against the official catalog: %w", change.Name, err)
			}
		}
		preferredAuthority = item.CatalogAuthority
		if requestedVersion == "" {
			change.Version = strings.TrimSpace(item.RecommendedVersion)
			if change.Version == "" {
				return nil, http.StatusConflict, "package_compatible_version_not_found", fmt.Errorf("package %s has no stable release compatible with Python %s", change.Name, runtimeVersion)
			}
		}
		var selected *model.PackageCatalogVersion
		for index := range item.Versions {
			if item.Versions[index].Version == change.Version {
				selected = &item.Versions[index]
				break
			}
		}
		if selected == nil {
			return nil, http.StatusBadRequest, "package_version_not_found", fmt.Errorf("package %s version %s does not exist in the official catalog", change.Name, change.Version)
		}
		if selected.Yanked {
			return nil, http.StatusConflict, "package_version_yanked", fmt.Errorf("package %s version %s has been withdrawn from the official catalog", change.Name, change.Version)
		}
		if selected.Compatibility == "incompatible" {
			return nil, http.StatusConflict, "package_version_incompatible", fmt.Errorf("package %s version %s is incompatible with Python %s", change.Name, change.Version, runtimeVersion)
		}
		if selected.Compatibility != "metadata-compatible" && selected.Compatibility != "assumed-compatible" {
			return nil, http.StatusConflict, "package_version_compatibility_unknown", fmt.Errorf("package %s version %s could not be verified for Python %s", change.Name, change.Version, runtimeVersion)
		}
	}
	return resolved, http.StatusOK, "", nil
}

func validateManagedPythonManifestSet(environment *model.ProjectEnvironment, manifestPath string) error {
	if environment == nil {
		return fmt.Errorf("project environment is unavailable")
	}
	manifestPath = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(manifestPath))))
	sourceManifests := make(map[string]bool)
	for _, manifest := range environment.Manifests {
		if manifest.Language != "python" {
			continue
		}
		pathValue := filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(manifest.Path))))
		if manifest.Kind == "source-imports" {
			sourceManifests[pathValue] = true
			continue
		}
		if pathValue != manifestPath || manifest.Kind != "requirements" || !manifest.Parsed {
			return fmt.Errorf("Package Center currently requires %s to be the project's only Python dependency manifest; found %s", manifestPath, manifest.Path)
		}
	}
	for _, item := range environment.Packages.Declared {
		for _, source := range strings.Split(item.Source, ", ") {
			source = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(source))))
			if sourceManifests[source] {
				continue
			}
			if source != manifestPath {
				return fmt.Errorf("package %s is also declared outside %s", item.Name, manifestPath)
			}
		}
	}
	return nil
}

func editablePythonRequirementManifests(manifests []model.ProjectEnvironmentManifest) []string {
	result := []string{}
	for _, manifest := range manifests {
		if manifest.Language == "python" && manifest.Kind == "requirements" && manifest.Parsed {
			result = append(result, manifest.Path)
		}
	}
	return result
}

func defaultEditablePythonManifest(manifests []model.ProjectEnvironmentManifest) string {
	candidates := editablePythonRequirementManifests(manifests)
	for index := range candidates {
		candidates[index] = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(candidates[index]))))
		if strings.EqualFold(candidates[index], "requirements.txt") {
			return candidates[index]
		}
	}
	if len(candidates) == 0 {
		return "requirements.txt"
	}
	sort.Strings(candidates)
	return candidates[0]
}

func validateProjectPackageDeclarations(environment *model.ProjectEnvironment, manifestPath string, changes []model.ProjectPackageChange) error {
	manifestSet := make(map[string]bool)
	for _, manifest := range environment.Manifests {
		if manifest.Language == "python" && manifest.Kind == "requirements" {
			manifestSet[manifest.Path] = true
		}
	}
	for _, change := range changes {
		declarations := []string{}
		for _, item := range environment.Packages.Declared {
			if normalizePythonPackageName(item.Name) != normalizePythonPackageName(change.Name) {
				continue
			}
			for _, source := range strings.Split(item.Source, ", ") {
				if manifestSet[source] {
					declarations = appendUniqueString(declarations, source)
				}
			}
		}
		switch change.Operation {
		case "add":
			if len(declarations) > 0 {
				return fmt.Errorf("package %s is already declared; use update instead", change.Name)
			}
		case "update", "remove":
			if len(declarations) != 1 || declarations[0] != manifestPath {
				return fmt.Errorf("package %s must have one direct declaration in %s", change.Name, manifestPath)
			}
		}
	}
	return nil
}

func (h *HTTPHandler) applyProjectPackageChanges(w http.ResponseWriter, r *http.Request, req *model.Request) {
	userID := auth.UserIDFromContext(r.Context())
	planID := strings.TrimSpace(req.PackagePlanID)
	stored, retainedResult, err := h.PackagePlans.ClaimOrCompleted(planID, userID)
	reconciliationRequired := errors.Is(err, packageops.ErrPlanReconciliation)
	if err != nil && !reconciliationRequired {
		code := "package_plan_unavailable"
		if errors.Is(err, packageops.ErrPlanInUse) {
			code = "package_plan_in_use"
			w.Header().Set("Retry-After", fmt.Sprintf("%d", packagePlanRetryAfterSeconds))
		}
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), ErrorCode: code})
		return
	}
	intentStarted := false
	operationPublished := false
	if retainedResult == nil && !reconciliationRequired {
		defer func() {
			if intentStarted && !operationPublished {
				if cancelErr := h.PackagePlans.CancelCompletionIntent(planID, userID); cancelErr != nil {
					slog.Error("Could not cancel failed package completion intent", "plan_id", planID, "user_id", userID, "error", cancelErr)
				}
			}
			h.PackagePlans.Release(planID)
		}()
	}
	if strings.TrimSpace(req.Runtime) != stored.RuntimeID || canonicalEnvironmentLanguage(req.Language) != stored.Language {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Package plan runtime or language no longer matches the request", ErrorCode: "package_plan_binding_mismatch"})
		return
	}
	if strings.TrimSpace(req.SourceID) != stored.Public.Source.ID {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Package source changed after the plan was created", ErrorCode: "package_plan_binding_mismatch"})
		return
	}
	safeRequest := sanitizedPackageRequest(req)
	resolved, err := h.resolveProjectEnvironment(r, safeRequest)
	if err != nil {
		writeProjectEnvironmentError(w, err)
		return
	}
	if resolved.workspace.ID != stored.WorkspaceID || resolved.folderKey != stored.FolderKey || resolved.workspace.Kind != "personal" {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Package plan belongs to a different project workspace", ErrorCode: "package_plan_binding_mismatch"})
		return
	}
	if retainedResult == nil && !reconciliationRequired && stored.RuntimeFingerprint != "" {
		runtime := model.GetRuntimeDef(stored.RuntimeID)
		if runtime == nil || resolvedRuntimeFingerprintFresh(r.Context(), h.RuntimeMetadata, runtime.RuntimeID, runtime.DockerImage, runtime.Version) != stored.RuntimeFingerprint {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Project runtime image changed after the package plan was created", ErrorCode: "package_plan_runtime_changed"})
			return
		}
	}
	if retainedResult != nil {
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: retainedResult})
		return
	}
	manifestContent, err := verifyPackageManifestBindings(resolved.root, stored.Public.ManifestBindings)
	if err != nil {
		if reconciliationRequired {
			writePackagePlanReconciliationRequired(w, planID)
		} else {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_plan_workspace_changed", Data: stored.Public})
		}
		return
	}
	if reconciliationRequired {
		environment, _, inspectErr := h.inspectProjectEnvironment(r, safeRequest)
		if inspectErr == nil && h.PersonalCache != nil && environment != nil {
			cacheRequest := h.environmentCacheRequest(r, safeRequest, resolved, environment.Runtime, environment.Language.ID)
			if stored.RuntimeFingerprint != "" {
				cacheRequest.RuntimeFingerprint = stored.RuntimeFingerprint
			}
			cacheRequest.ManifestSnapshot = []personalcache.ManifestSnapshot{{Path: stored.Public.ManifestBindings[0].Path, Content: manifestContent}}
			published, reconcileErr := h.PersonalCache.PublishedOperation(cacheRequest, planID)
			if reconcileErr == nil && published {
				if markErr := h.PackagePlans.MarkCompleted(planID, userID); markErr == nil {
					result := model.ProjectPackageChangeResult{Schema: packageChangeActionSchema, PlanID: planID, Applied: true, Message: "Project packages updated"}
					writeJSON(w, http.StatusOK, model.Response{Success: true, Data: result})
					return
				}
			}
		}
		writePackagePlanReconciliationRequired(w, planID)
		return
	}
	manifestPath, err := validateExecutablePackagePlan(stored.Public)
	if err != nil {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_plan_invalid"})
		return
	}
	environment, _, err := h.inspectProjectEnvironment(r, safeRequest)
	if err != nil {
		writeProjectEnvironmentError(w, err)
		return
	}
	if environment.Runtime.ID != stored.RuntimeID || environment.Language.ID != stored.Language {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Project runtime changed after the package plan was created", ErrorCode: "package_plan_binding_mismatch"})
		return
	}
	if err := validateManagedPythonManifestSet(environment, manifestPath); err != nil {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_manifest_set_changed", Data: stored.Public})
		return
	}
	if h.EnvironmentSetup == nil || h.PersonalCache == nil || h.PersonalCache.ScopeMode() != "project-lock" {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Project package installation is unavailable", ErrorCode: "package_service_unavailable"})
		return
	}
	if h.DAP != nil {
		if err := h.DAP.StopUserWorkspace(userID, resolved.folderKey); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_debug_session_active"})
			return
		}
	}
	if h.Lifecycle != nil {
		activity, leaseErr := h.Lifecycle.AcquireActivity(userID, resolved.folderKey)
		if leaseErr != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error(), ErrorCode: "package_workspace_busy"})
			return
		}
		defer activity.Release()
	}
	timeout := time.Duration(h.packageOperationTimeoutSeconds()) * time.Second
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	ctx, finalizeContainerCleanup := WithDeferredContainerCleanup(ctx)
	if err := h.PackagePlans.BeginCompletionIntent(planID, userID); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Could not persist package operation intent", ErrorCode: "package_completion_persistence_unavailable", Data: stored.Public})
		return
	}
	intentStarted = true
	cacheRequest := h.environmentCacheRequest(r, safeRequest, resolved, environment.Runtime, environment.Language.ID)
	if stored.RuntimeFingerprint != "" {
		cacheRequest.RuntimeFingerprint = stored.RuntimeFingerprint
	}
	cacheRequest.ManifestSnapshot = []personalcache.ManifestSnapshot{{
		Path: manifestPath, Content: manifestContent,
	}}
	cacheRequest.OperationID = planID
	dependencyLease, err := h.PersonalCache.Prepare(ctx, cacheRequest)
	if err != nil {
		status, code := packageOperationError(ctx, 0, err)
		writeJSON(w, status, model.Response{Success: false, Error: err.Error(), ErrorCode: code, Data: stored.Public})
		return
	}
	if dependencyLease == nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Project dependency cache did not provide a writable generation", ErrorCode: "package_cache_unavailable"})
		return
	}
	guard := dependencyLease.StartGuard(ctx)
	if guard != nil {
		ctx = guard.Context
	}
	ctx = personalcache.WithLease(ctx, dependencyLease)
	if err := resetPythonPackageTarget(dependencyLease); err != nil {
		dependencyLease.Abort()
		finalizeContainerCleanup(func() {
			h.releasePersonalCacheLease(dependencyLease, personalDependencyRefreshScope(userID, resolved.folderKey, environment.Runtime.ID, environment.Language.ID))
		})
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Could not prepare an empty project package target", ErrorCode: "package_cache_prepare_failed", Data: stored.Public})
		return
	}
	installManifest, cleanupInstallManifest, err := preparePackageInstallSnapshot(dependencyLease, string(manifestContent))
	if err != nil {
		dependencyLease.Abort()
		finalizeContainerCleanup(func() {
			h.releasePersonalCacheLease(dependencyLease, personalDependencyRefreshScope(userID, resolved.folderKey, environment.Runtime.ID, environment.Language.ID))
		})
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Could not prepare the reviewed package manifest", ErrorCode: "package_cache_prepare_failed", Data: stored.Public})
		return
	}
	// pip does not create PIP_TARGET for an empty requirements file. Creating it
	// explicitly is what lets removing the final direct dependency publish a
	// valid, exact, empty generation instead of retaining packages from the old
	// digest.
	command := "mkdir -p \"$PIP_TARGET\" && python3 -m pip --isolated --disable-pip-version-check --no-input --cache-dir /persist/pip-cache install --target \"$PIP_TARGET\" --index-url " + shellQuoteEnvironmentPath(stored.InstallURL) + " -r " + shellQuoteEnvironmentPath(installManifest)
	started := time.Now()
	stdout, stderr, exitCode, execErr := h.EnvironmentSetup(ctx, userID, environment.Runtime.ID, resolved.root, []string{command})
	cleanupErr := cleanupInstallManifest()
	if h.Metrics != nil {
		h.Metrics.Observe("package.operation.apply", time.Since(started))
		h.Metrics.Observe("dependency.resolve", time.Since(started))
	}
	if guard != nil && guard.Err() != nil {
		execErr = guard.Err()
	}
	if cleanupErr != nil && execErr == nil {
		execErr = cleanupErr
	}
	if execErr != nil || exitCode != 0 {
		status, code := packageOperationError(ctx, exitCode, execErr)
		dependencyLease.Abort()
		finalizeContainerCleanup(func() {
			h.releasePersonalCacheLease(dependencyLease, personalDependencyRefreshScope(userID, resolved.folderKey, environment.Runtime.ID, environment.Language.ID))
		})
		message := "Package installation failed"
		if execErr != nil {
			message = execErr.Error()
		}
		result := model.ProjectPackageChangeResult{Schema: packageChangeActionSchema, PlanID: planID, Applied: false, ExitCode: exitCode, Stdout: stdout, Stderr: stderr, Message: message}
		writeJSON(w, status, model.Response{Success: false, Error: message, ErrorCode: code, Data: result})
		return
	}
	if _, err := verifyPackageManifestBindings(resolved.root, stored.Public.ManifestBindings); err != nil {
		dependencyLease.Abort()
		finalizeContainerCleanup(func() {
			h.releasePersonalCacheLease(dependencyLease, personalDependencyRefreshScope(userID, resolved.folderKey, environment.Runtime.ID, environment.Language.ID))
		})
		result := model.ProjectPackageChangeResult{Schema: packageChangeActionSchema, PlanID: planID, Applied: false, ExitCode: exitCode, Stdout: stdout, Stderr: stderr, Message: err.Error()}
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_plan_workspace_changed", Data: result})
		return
	}
	preview := dependencyLease.PreviewPackageInventory()
	previewInstalled := installedEnvironmentInspectionFromPythonInventory(preview)
	directDeclarations := projectManifestPackageDeclarations(environment.Packages.Declared, manifestPath)
	previewPackages := classifyEnvironmentPackages(directDeclarations, previewInstalled.Packages, "python", preview.Exact)
	if preview.State != "ready" || !preview.Exact || len(previewPackages.Missing) > 0 || len(previewPackages.Unknown) > 0 || (len(directDeclarations) == 0 && len(preview.Packages) > 0) {
		dependencyLease.Abort()
		finalizeContainerCleanup(func() {
			h.releasePersonalCacheLease(dependencyLease, personalDependencyRefreshScope(userID, resolved.folderKey, environment.Runtime.ID, environment.Language.ID))
		})
		message := "Package installation completed, but the staged package inventory does not match the reviewed project manifest"
		if preview.State != "ready" && strings.TrimSpace(preview.Detail) != "" {
			message += ": " + preview.Detail
		}
		result := model.ProjectPackageChangeResult{Schema: packageChangeActionSchema, PlanID: planID, Applied: false, ExitCode: exitCode, Stdout: stdout, Stderr: stderr, Message: message}
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: message, ErrorCode: "package_inventory_mismatch", Data: result})
		return
	}
	released := make(chan struct{})
	finalizeContainerCleanup(func() {
		h.releasePersonalCacheLease(dependencyLease, personalDependencyRefreshScope(userID, resolved.folderKey, environment.Runtime.ID, environment.Language.ID))
		close(released)
	})
	<-released
	operationPublished = dependencyLease.Published()
	if !dependencyLease.Published() {
		message := "The verified project dependency generation could not be published"
		result := model.ProjectPackageChangeResult{Schema: packageChangeActionSchema, PlanID: planID, Applied: false, ExitCode: exitCode, Stdout: stdout, Stderr: stderr, Message: message}
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: message, ErrorCode: "package_cache_publish_failed", Data: result})
		return
	}
	updated, _, inspectErr := h.inspectProjectEnvironment(r, safeRequest)
	result := model.ProjectPackageChangeResult{
		Schema: packageChangeActionSchema, PlanID: planID, Applied: true, ExitCode: exitCode,
		Stdout: stdout, Stderr: stderr, Message: "Project packages updated",
	}
	if inspectErr == nil && projectPackageApplyVerified(updated) {
		context := h.projectPackageCenterContext(updated)
		result.Environment = updated
		result.Context = &context
	}
	retained := model.ProjectPackageChangeResult{
		Schema: result.Schema, PlanID: planID, Applied: true, ExitCode: result.ExitCode, Message: result.Message,
	}
	if err := h.PackagePlans.CompleteWithResult(planID, userID, retained); err != nil {
		// Publication is already irreversible. Do not reopen the plan and run
		// Docker a second time merely because response retention failed.
		if markerErr := h.PackagePlans.MarkCompleted(planID, userID); markerErr != nil {
			slog.Error("Could not retain package apply completion marker", "plan_id", planID, "user_id", userID, "result_error", err, "marker_error", markerErr)
		} else {
			slog.Warn("Retained minimal package apply completion marker", "plan_id", planID, "user_id", userID, "result_error", err)
		}
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: result})
}

func writePackagePlanReconciliationRequired(w http.ResponseWriter, planID string) {
	w.Header().Set("Retry-After", fmt.Sprintf("%d", packagePlanRetryAfterSeconds))
	result := model.ProjectPackageChangeResult{Schema: packageChangeActionSchema, PlanID: planID, Applied: false, ReconciliationRequired: true, Message: "Package operation completion is being reconciled"}
	writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: result.Message, ErrorCode: "package_plan_reconciliation_required", Data: result})
}

func packageOperationError(ctx context.Context, exitCode int, err error) (int, string) {
	contextCause := error(nil)
	if ctx != nil {
		contextCause = context.Cause(ctx)
	}
	switch {
	case errors.Is(err, personalcache.ErrQuotaExceeded), errors.Is(contextCause, personalcache.ErrQuotaExceeded):
		return http.StatusInsufficientStorage, "package_storage_quota_exceeded"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(contextCause, context.DeadlineExceeded):
		return http.StatusGatewayTimeout, "package_operation_timeout"
	case errors.Is(err, context.Canceled), errors.Is(contextCause, context.Canceled):
		return http.StatusRequestTimeout, "package_operation_cancelled"
	case exitCode != 0:
		return http.StatusConflict, "package_install_failed"
	case err != nil:
		return http.StatusServiceUnavailable, "package_executor_unavailable"
	default:
		return http.StatusConflict, "package_install_failed"
	}
}

func resetPythonPackageTarget(lease *personalcache.Lease) error {
	if lease == nil || !lease.Writable() || strings.TrimSpace(lease.HostRoot) == "" {
		return fmt.Errorf("writable dependency generation is required")
	}
	root := filepath.Clean(lease.HostRoot)
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("dependency generation root is not a real directory")
	}
	target := filepath.Join(root, "python")
	if err := os.RemoveAll(target); err != nil {
		return err
	}
	return os.Mkdir(target, 0700)
}

func projectManifestPackageDeclarations(declared []model.ProjectEnvironmentPackage, manifestPath string) []model.ProjectEnvironmentPackage {
	result := make([]model.ProjectEnvironmentPackage, 0, len(declared))
	manifestPath = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(manifestPath))))
	for _, item := range declared {
		for _, source := range strings.Split(item.Source, ", ") {
			source = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(source))))
			if source == manifestPath {
				result = append(result, item)
				break
			}
		}
	}
	return result
}

func preparePackageInstallSnapshot(lease *personalcache.Lease, content string) (string, func() error, error) {
	if lease == nil || !lease.Writable() || strings.TrimSpace(lease.HostRoot) == "" {
		return "", nil, fmt.Errorf("writable dependency generation is required")
	}
	inputRoot := filepath.Join(filepath.Clean(lease.HostRoot), ".bobocloud-package-input")
	if err := os.RemoveAll(inputRoot); err != nil {
		return "", nil, err
	}
	if err := os.Mkdir(inputRoot, 0700); err != nil {
		return "", nil, err
	}
	if err := safefile.WriteAtomic(inputRoot, "requirements.txt", []byte(content), 0600); err != nil {
		_ = os.RemoveAll(inputRoot)
		return "", nil, err
	}
	cleanup := func() error { return os.RemoveAll(inputRoot) }
	return "/project-deps/.bobocloud-package-input/requirements.txt", cleanup, nil
}

func projectPackageInventoryExact(environment *model.ProjectEnvironment) bool {
	if environment == nil || environment.Language.ID != "python" || environment.DependencyCache.InventoryStatus != "ready" || environment.DependencyCache.Status != "hit" {
		return false
	}
	for _, item := range environment.Packages.Installed {
		if item.Trust != "exact" || item.Source != "project-lock-python" || item.Scope != "project-lock" {
			return false
		}
	}
	return true
}

func projectPackageApplyVerified(environment *model.ProjectEnvironment) bool {
	if environment == nil || len(environment.Packages.Missing) > 0 || len(environment.Packages.Unknown) > 0 || !projectPackageInventoryExact(environment) {
		return false
	}
	if len(environment.Packages.Declared) == 0 {
		return len(environment.Packages.Installed) == 0
	}
	return environment.Consistency.DependencyRuntime.Status == "aligned"
}

func verifyPackageManifestBindings(root string, bindings []model.ProjectPackageManifestBinding) ([]byte, error) {
	if len(bindings) != 1 {
		return nil, fmt.Errorf("package plan must bind exactly one requirements manifest")
	}
	data, err := packageops.ReadPythonRequirementsSnapshot(root, bindings[0].Path, bindings[0].SHA256)
	if err != nil {
		return nil, fmt.Errorf("reviewed package manifest is unavailable: %w", err)
	}
	return data, nil
}

func validateExecutablePackagePlan(plan model.ProjectPackageChangePlan) (string, error) {
	if len(plan.ManifestBindings) != 1 {
		return "", fmt.Errorf("package plan must bind exactly one requirements manifest")
	}
	binding := plan.ManifestBindings[0]
	if plan.Reinstall {
		if len(plan.LocalChanges) != 0 || len(plan.Changes) != 1 || plan.Changes[0].Operation != "update" {
			return "", fmt.Errorf("reinstall package plan has an invalid change shape")
		}
		return binding.Path, nil
	}
	if len(plan.LocalChanges) != 1 || plan.LocalChanges[0].Path != binding.Path || plan.LocalChanges[0].NewSHA256 != binding.SHA256 {
		return "", fmt.Errorf("package plan does not contain exactly one bound manifest change")
	}
	return binding.Path, nil
}
