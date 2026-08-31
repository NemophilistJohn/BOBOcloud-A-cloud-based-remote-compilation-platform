package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/nodetoolchain"
	"bobocloud-server/internal/packagecatalog"
	"bobocloud-server/internal/packageops"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/resourcecontrol"
	"bobocloud-server/internal/safefile"
)

const (
	packageCenterContextSchema    = "project-package-center/v1"
	packageChangePlanSchema       = "project-package-change-plan/v1"
	packageChangeActionSchema     = "project-package-change-action/v1"
	packagePlanRetryAfterSeconds  = 1
	packagePlanMaxCatalogChecks   = 16
	packagePlanCatalogConcurrency = 4
)

func packageSourcePolicyDigest(sourceID, installURL string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(sourceID) + "\x00" + strings.TrimSpace(installURL)))
	return hex.EncodeToString(digest[:16])
}

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
	manager, _ := projectPackageManager(environment)
	searchMode := packagecatalog.SearchModeExact
	if environment.Language.ID == "node" {
		searchMode = packagecatalog.SearchModeCatalog
	}
	result := model.ProjectPackageCenterContext{
		Schema: packageCenterContextSchema, Revision: environment.Revision, Workspace: environment.Workspace,
		Language: environment.Language, Runtime: environment.Runtime, Manager: manager, SearchMode: searchMode,
		CatalogTimeoutSeconds:   h.packageCatalogTimeoutSeconds(),
		OperationTimeoutSeconds: h.packageOperationTimeoutSeconds(),
		DefaultManifestPath:     manager.ManifestPath,
		Manifests:               append([]model.ProjectEnvironmentManifest(nil), environment.Manifests...),
		Packages: model.ProjectPackageCenterPackages{
			Declared: append([]model.ProjectEnvironmentPackage(nil), environment.Packages.Declared...),
			Missing:  append([]model.ProjectEnvironmentPackage(nil), environment.Packages.Missing...),
			Unknown:  append([]model.ProjectEnvironmentPackage(nil), environment.Packages.Unknown...),
		},
		Inventory: model.ProjectPackageInventory{
			Status: environment.DependencyCache.InventoryStatus, Detail: environment.DependencyCache.InventoryDetail,
			CheckedAt: environment.DependencyCache.InventoryCheckedAt, CacheID: environment.DependencyCache.CacheID,
			DependencyDigest: environment.DependencyCache.Digest, Generation: environment.DependencyCache.Generation,
		},
	}
	if h.PackageCatalog != nil {
		result.Sources = h.PackageCatalog.Sources(environment.Language.ID)
		result.DefaultSource = h.PackageCatalog.DefaultSource(environment.Language.ID)
	}
	result.Inventory.Exact = projectPackageInventoryExact(environment)
	result.Capabilities = model.ProjectPackageCenterCapabilities{
		Browse: len(result.Sources) > 0, Inspect: true, Mutate: result.CanPlanChanges.Supported,
		ExactInventory: result.Inventory.Exact, Scopes: len(manager.Scopes) > 1,
		Prereleases: true, TransitivePackages: result.Inventory.Exact,
	}
	dependencyManifests := make(map[string]bool)
	for _, manifest := range environment.Manifests {
		if manifest.Kind != "source-imports" {
			dependencyManifests[manifest.Path] = true
		}
	}
	declared := make(map[string][]string)
	for _, item := range environment.Packages.Declared {
		key := packageRelationshipKey(environment.Language.ID, item.Name)
		for _, source := range strings.Split(item.Source, ", ") {
			source = strings.TrimSpace(source)
			if source != "" && dependencyManifests[source] {
				declared[key] = appendUniqueString(declared[key], source)
			}
		}
	}
	for _, item := range environment.Packages.Installed {
		relationship := "unknown"
		declaredIn := declared[packageRelationshipKey(environment.Language.ID, item.Name)]
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
	result.Capabilities.Mutate = result.CanPlanChanges.Supported
	return result
}

func sha256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func packageRelationshipKey(language, name string) string {
	if strings.EqualFold(strings.TrimSpace(language), "python") {
		return normalizePythonPackageName(name)
	}
	return strings.ToLower(strings.TrimSpace(name))
}

func projectPackageManager(environment *model.ProjectEnvironment) (model.ProjectPackageManager, string) {
	if environment == nil {
		return model.ProjectPackageManager{Scopes: []string{}}, "project-environment-unavailable"
	}
	switch environment.Language.ID {
	case "python":
		manifest := defaultEditablePythonManifest(environment.Manifests)
		return model.ProjectPackageManager{
			ID: "pip", Name: "pip", ManifestPath: manifest, DetectedBy: "manifest",
			LockfilePresent: manifest != "", Scopes: []string{"runtime"},
		}, ""
	case "node":
		manager := model.ProjectPackageManager{Name: "npm", ID: "npm", ManifestPath: "package.json", LockfilePath: "package-lock.json", DetectedBy: "default", Scopes: []string{"runtime", "dev", "optional"}}
		packageJSON := false
		workspaceManifest := false
		shrinkwrap := false
		npmLock, pnpmLock := "", ""
		declaredManager := ""
		for _, manifest := range environment.Manifests {
			pathValue := filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(manifest.Path))))
			if manifest.Language != "node" {
				continue
			}
			switch strings.ToLower(filepath.Base(pathValue)) {
			case "package.json":
				if pathValue == "package.json" {
					packageJSON = true
					if manifest.Manager == "npm" || manifest.Manager == "pnpm" {
						declaredManager = manifest.Manager
					}
				}
			case "package-lock.json":
				if pathValue == filepath.Base(pathValue) {
					npmLock = pathValue
				}
			case "npm-shrinkwrap.json":
				if pathValue == "npm-shrinkwrap.json" {
					shrinkwrap = true
				}
			case "pnpm-lock.yaml":
				if pathValue == "pnpm-lock.yaml" {
					pnpmLock = pathValue
				}
			case "yarn.lock", "bun.lock":
				return model.ProjectPackageManager{Scopes: []string{}}, "node-manager-unsupported"
			case "pnpm-workspace.yaml":
				workspaceManifest = true
			}
		}
		if !packageJSON {
			return manager, "node-package-json-required"
		}
		if workspaceManifest {
			return manager, "node-workspaces-unsupported"
		}
		if shrinkwrap {
			return manager, "node-shrinkwrap-unsupported"
		}
		if npmLock != "" && pnpmLock != "" {
			return model.ProjectPackageManager{Scopes: []string{}}, "node-manager-conflict"
		}
		if pnpmLock != "" {
			manager.ID, manager.Name, manager.LockfilePath, manager.DetectedBy, manager.LockfilePresent = "pnpm", "pnpm", pnpmLock, "lockfile", true
		} else if npmLock != "" {
			manager.LockfilePath, manager.DetectedBy, manager.LockfilePresent = npmLock, "lockfile", true
		}
		if declaredManager != "" {
			if manager.LockfilePresent && manager.ID != declaredManager {
				return model.ProjectPackageManager{Scopes: []string{}}, "node-manager-conflict"
			}
			manager.ID, manager.Name, manager.DetectedBy = declaredManager, declaredManager, "packageManager"
			if declaredManager == "pnpm" {
				manager.LockfilePath = "pnpm-lock.yaml"
			}
		}
		return manager, ""
	default:
		return model.ProjectPackageManager{Scopes: []string{}}, "ecosystem-unsupported"
	}
}

func (h *HTTPHandler) packageCatalogTimeoutSeconds() int {
	if h != nil && h.Config != nil && h.Config.PackageCatalogTimeoutSeconds > 0 {
		return h.Config.PackageCatalogTimeoutSeconds
	}
	return 8
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
	case h.PersonalCache == nil:
		capability.Reason = "project-lock-cache-required"
	case h.EnvironmentSetup == nil:
		capability.Reason = "environment-setup-unavailable"
	case environment.Workspace.Kind != "personal":
		capability.Reason = "team-workspace-unsupported"
	case environment.Language.ID != environment.Runtime.Language || (environment.Language.ID != "python" && environment.Language.ID != "node"):
		capability.Reason = "ecosystem-unsupported"
	case environment.Runtime.ID == "" || environment.Runtime.ID == "local":
		capability.Reason = "managed-runtime-required"
	case environment.Language.ID == "node" && h.PackageLockResolver == nil:
		capability.Reason = "package-lock-resolver-unavailable"
	default:
		_, reason := projectPackageManager(environment)
		if reason != "" {
			capability.Reason = reason
		} else {
			capability.Supported = true
		}
	}
	return capability
}

func (h *HTTPHandler) searchPackageCatalog(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.packageCatalogAvailable(w) {
		return
	}
	language, runtimeVersion, runtimeTrust, err := h.packageCatalogRequestRuntime(r.Context(), req)
	if err != nil || (language != "python" && language != "node") {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "A managed package runtime is required for dependency search", ErrorCode: "package_runtime_required"})
		return
	}
	started := time.Now()
	result, err := h.PackageCatalog.Search(r.Context(), packagecatalog.SearchRequest{Ecosystem: language, Query: req.Query, SourceID: req.SourceID, Cursor: req.Cursor, RuntimeVersion: runtimeVersion, RuntimeVersionTrust: runtimeTrust})
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
	if err != nil || (language != "python" && language != "node") {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "A managed package runtime is required for dependency details", ErrorCode: "package_runtime_required"})
		return
	}
	started := time.Now()
	item, err := h.PackageCatalog.Item(r.Context(), packagecatalog.ItemRequest{Ecosystem: language, Name: req.PackageName, SourceID: req.SourceID, RuntimeVersion: runtimeVersion, RuntimeVersionTrust: runtimeTrust})
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
	ecosystem := environment.Language.ID
	source, err := h.PackageCatalog.ResolveSource(ecosystem, req.SourceID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_source_invalid"})
		return
	}
	expectedSourceGroup := map[string]string{"python": "pypi", "node": "npm"}[ecosystem]
	if source.Public.EquivalenceGroup != expectedSourceGroup {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "The selected source is not equivalent to this package ecosystem", ErrorCode: "package_source_not_equivalent"})
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
	resolvedChanges, status, errorCode, err := resolveAndValidatePackagePlanCatalogForEcosystem(
		catalogContext, h.PackageCatalog, ecosystem, source.Public.ID, runtimeVersion, environment.Runtime.ResolvedVersionTrust, req.PackageChanges,
	)
	cancelCatalog()
	if h.Metrics != nil {
		h.Metrics.Observe("package.catalog.plan-validation", time.Since(startedCatalogValidation))
	}
	if err != nil {
		writeJSON(w, status, model.Response{Success: false, Error: err.Error(), ErrorCode: errorCode})
		return
	}
	plan.Supported = true
	plan.Source = source.Public
	manager, _ := projectPackageManager(environment)
	plan.Manager = manager
	if ecosystem == "python" {
		candidates := editablePythonRequirementManifests(environment.Manifests)
		manifestPathHint := selectedEditablePythonManifest(req.PackageManifestPath, candidates)
		allowReinstall := packageCenterReinstallCandidates(environment, manifestPathHint)
		requirementsPlan, planErr := packageops.PlanPythonRequirementsWithOptions(
			resolved.root, req.PackageManifestPath, candidates, resolvedChanges,
			packageops.RequirementsPlanOptions{AllowReinstall: allowReinstall},
		)
		if planErr != nil {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: planErr.Error(), ErrorCode: "package_manifest_change_invalid"})
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
		plan.Manager.ManifestPath = manifestPath
		plan.Changes = requirementsPlan.Changes
		plan.ManifestBindings = []model.ProjectPackageManifestBinding{requirementsPlan.ManifestBinding}
		plan.Reinstall = requirementsPlan.Reinstall
		if !requirementsPlan.Reinstall {
			plan.LocalChanges = []model.ProjectPackageLocalChange{requirementsPlan.LocalChange}
		}
		plan.Warnings = requirementsPlan.Warnings
	} else {
		manifestPath := strings.TrimSpace(req.PackageManifestPath)
		if manifestPath == "" {
			manifestPath = manager.ManifestPath
		}
		if manifestPath != "package.json" {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Node dependency changes currently require the project-root package.json", ErrorCode: "package_manifest_change_invalid"})
			return
		}
		manifestContent, exists, readErr := packageops.ReadNodeDependencySnapshot(resolved.root, manifestPath, "")
		if readErr != nil || !exists {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "The project-root package.json is unavailable", ErrorCode: "package_manifest_change_invalid"})
			return
		}
		manifestPaths := make([]string, 0, len(environment.Manifests))
		for _, manifest := range environment.Manifests {
			if manifest.Language == "node" {
				manifestPaths = append(manifestPaths, manifest.Path)
			}
		}
		nodePlan, planErr := packageops.PlanNodePackageJSON(manifestPath, manifestContent, manifestPaths, resolvedChanges)
		if planErr != nil {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: planErr.Error(), ErrorCode: "package_manifest_change_invalid"})
			return
		}
		managerID := nodePlan.ManagerHint.Manager
		if policyErr := validateNodePNPMDeclaration([]byte(nodePlan.ManifestContent), managerID, h.nodePNPMVersion()); policyErr != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: policyErr.Error(), ErrorCode: "package_manager_policy_mismatch"})
			return
		}
		lockfilePath := "package-lock.json"
		if managerID == "pnpm" {
			lockfilePath = "pnpm-lock.yaml"
		}
		userID := auth.UserIDFromContext(r.Context())
		lockResourceLease, resourceErr := acquireHandlerRuntimeResource(
			r.Context(), h.Resources, resourcecontrol.WorkloadPackage, userID, environmentResourceScope(environment), "package-lock:"+environment.Workspace.ID,
			environment.Runtime.ID, environment.Language.ID, environment.Runtime.Image, true,
		)
		if resourceErr != nil {
			writeResourcePressure(w)
			return
		}
		lockResult, lockErr := func() (PackageLockResolutionResult, error) {
			defer releaseHandlerResource(lockResourceLease)
			lockContext, cancelLock := context.WithTimeout(r.Context(), time.Duration(h.packageOperationTimeoutSeconds())*time.Second)
			defer cancelLock()
			return h.PackageLockResolver(lockContext, PackageLockResolutionRequest{
				UserID: userID, RuntimeID: environment.Runtime.ID, WorkspaceRoot: resolved.root,
				Manager: managerID, ManifestPath: manifestPath, ManifestContent: []byte(nodePlan.ManifestContent),
				LockfilePath: lockfilePath, RegistryURL: source.InstallURL,
			})
		}()
		if lockErr != nil || len(lockResult.Content) == 0 {
			message := "The Node lockfile could not be resolved"
			if lockErr != nil {
				message += ": " + lockErr.Error()
			}
			writeJSON(w, http.StatusBadGateway, model.Response{Success: false, Error: message, ErrorCode: "package_lock_resolution_failed"})
			return
		}
		oldLock, oldLockExists, lockReadErr := packageops.ReadNodeDependencySnapshot(resolved.root, lockfilePath, "")
		if lockReadErr != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: lockReadErr.Error(), ErrorCode: "package_manifest_change_invalid"})
			return
		}
		lockDigest := sha256Hex(lockResult.Content)
		plan.Changes = nodePlan.Changes
		plan.LocalChanges = []model.ProjectPackageLocalChange{nodePlan.LocalChange}
		if !oldLockExists || string(oldLock) != string(lockResult.Content) {
			oldDigest := ""
			if oldLockExists {
				oldDigest = sha256Hex(oldLock)
			}
			plan.LocalChanges = append(plan.LocalChanges, model.ProjectPackageLocalChange{
				Path: lockfilePath, OldExists: oldLockExists, OldSHA256: oldDigest,
				NewContent: string(lockResult.Content), NewSHA256: lockDigest,
				Description: "Update the reproducible Node dependency lockfile",
			})
		}
		plan.ManifestBindings = []model.ProjectPackageManifestBinding{
			nodePlan.ManifestBinding,
			{Path: lockfilePath, SHA256: lockDigest},
		}
		plan.Manager = model.ProjectPackageManager{
			ID: managerID, Name: managerID, ManifestPath: manifestPath, LockfilePath: lockfilePath,
			DetectedBy: nodePlan.ManagerHint.Evidence, LockfilePresent: true, Scopes: []string{"runtime", "dev", "optional"},
		}
		plan.Warnings = nodePlan.Warnings
	}
	for _, change := range plan.Changes {
		if change.Operation == "remove" {
			plan.Warnings = appendUniqueString(plan.Warnings, "removed-package-may-remain-transitive")
		}
	}
	if !plan.Reinstall {
		plan.Steps = append(plan.Steps,
			model.ProjectPackagePlanStep{ID: "write-manifest", Kind: "local-change", Manager: plan.Manager.ID, Description: "Write the reviewed dependency files locally"},
			model.ProjectPackagePlanStep{ID: "sync-manifest", Kind: "sync", Manager: plan.Manager.ID, Description: "Synchronize the exact dependency revision to the server"},
		)
	}
	plan.Steps = append(plan.Steps,
		model.ProjectPackagePlanStep{ID: "resolve-project-environment", Kind: "install", Manager: plan.Manager.ID, Description: "Resolve all declared packages into a new project dependency generation"},
		model.ProjectPackagePlanStep{ID: "verify-project-environment", Kind: "verify", Manager: plan.Manager.ID, Description: "Publish exact package inventory and refresh dependent language services"},
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
	return resolveAndValidatePackagePlanCatalogForEcosystem(ctx, catalog, "python", sourceID, runtimeVersion, runtimeVersionTrust, changes)
}

func resolveAndValidatePackagePlanCatalogForEcosystem(ctx context.Context, catalog packagecatalog.Catalog, ecosystem, sourceID, runtimeVersion, runtimeVersionTrust string, changes []model.ProjectPackageChange) ([]model.ProjectPackageChange, int, string, error) {
	resolved := append([]model.ProjectPackageChange(nil), changes...)
	type catalogCheck struct {
		index            int
		requestedVersion string
	}
	type catalogResult struct {
		item     model.PackageCatalogItem
		err      error
		timedOut bool
	}

	checks := make([]catalogCheck, 0, len(resolved))
	for index := range resolved {
		change := &resolved[index]
		if change.Operation != "add" && change.Operation != "update" && change.Operation != "remove" {
			return nil, http.StatusBadRequest, "invalid_package_operation", fmt.Errorf("unsupported package operation %q", change.Operation)
		}
		if change.Operation == "remove" {
			continue
		}
		checks = append(checks, catalogCheck{index: index, requestedVersion: strings.TrimSpace(change.Version)})
		if len(checks) > packagePlanMaxCatalogChecks {
			return nil, http.StatusBadRequest, "package_catalog_check_limit_exceeded", fmt.Errorf("a package plan can validate at most %d added or updated packages", packagePlanMaxCatalogChecks)
		}
	}

	preferredAuthority := ""
	for batchStart := 0; batchStart < len(checks); batchStart += packagePlanCatalogConcurrency {
		batchEnd := min(batchStart+packagePlanCatalogConcurrency, len(checks))
		batch := checks[batchStart:batchEnd]
		results := make([]catalogResult, len(batch))
		var wait sync.WaitGroup
		wait.Add(len(batch))
		for offset, check := range batch {
			go func(offset int, check catalogCheck, authority string) {
				defer wait.Done()
				change := resolved[check.index]
				item, err := catalog.Item(ctx, packagecatalog.ItemRequest{
					Ecosystem: ecosystem, Name: change.Name, SourceID: sourceID, RuntimeVersion: runtimeVersion, RuntimeVersionTrust: runtimeVersionTrust,
					Version: check.requestedVersion, PreferredCatalogAuthority: authority,
				})
				results[offset] = catalogResult{
					item: item,
					err:  err,
					timedOut: errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) ||
						errors.Is(context.Cause(ctx), context.DeadlineExceeded),
				}
			}(offset, check, preferredAuthority)
		}
		wait.Wait()

		// Network completion order must not change the selected version or
		// which request-order error is returned to the caller.
		for offset, check := range batch {
			change := &resolved[check.index]
			result := results[offset]
			if result.err != nil {
				switch {
				case errors.Is(result.err, packagecatalog.ErrNotFound):
					return nil, http.StatusBadRequest, "package_not_found", fmt.Errorf("package %s does not exist in the official catalog", change.Name)
				case result.timedOut:
					return nil, http.StatusGatewayTimeout, "package_catalog_timeout", fmt.Errorf("package catalog validation timed out")
				default:
					return nil, http.StatusBadGateway, "package_catalog_unavailable", fmt.Errorf("could not validate package %s against the official catalog: %w", change.Name, result.err)
				}
			}
			if result.item.CatalogAuthority != "" {
				preferredAuthority = result.item.CatalogAuthority
			}
			if check.requestedVersion == "" {
				change.Version = strings.TrimSpace(result.item.RecommendedVersion)
				if change.Version == "" {
					return nil, http.StatusConflict, "package_compatible_version_not_found", fmt.Errorf("package %s has no stable release compatible with %s %s", change.Name, ecosystem, runtimeVersion)
				}
			}
			var selected *model.PackageCatalogVersion
			for index := range result.item.Versions {
				if result.item.Versions[index].Version == change.Version {
					selected = &result.item.Versions[index]
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
				return nil, http.StatusConflict, "package_version_incompatible", fmt.Errorf("package %s version %s is incompatible with %s %s", change.Name, change.Version, ecosystem, runtimeVersion)
			}
			if selected.Compatibility != "metadata-compatible" && selected.Compatibility != "assumed-compatible" {
				return nil, http.StatusConflict, "package_version_compatibility_unknown", fmt.Errorf("package %s version %s could not be verified for %s %s", change.Name, change.Version, ecosystem, runtimeVersion)
			}
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

func selectedEditablePythonManifest(requested string, candidates []string) string {
	requested = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(requested))))
	if requested != "." && requested != "" {
		return requested
	}
	normalized := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		candidate = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(candidate))))
		if candidate == "." || candidate == "" {
			continue
		}
		if strings.EqualFold(candidate, "requirements.txt") {
			return candidate
		}
		normalized = append(normalized, candidate)
	}
	if len(normalized) == 1 {
		return normalized[0]
	}
	return ""
}

func packageCenterReinstallCandidates(environment *model.ProjectEnvironment, manifestPath string) map[string]bool {
	result := make(map[string]bool)
	if environment == nil || strings.EqualFold(environment.DependencyCache.InventoryStatus, "busy") || strings.EqualFold(environment.DependencyCache.Status, "busy") {
		return result
	}
	for _, item := range environment.Packages.Missing {
		result[normalizePythonPackageName(item.Name)] = true
	}
	if projectPackageInventoryExact(environment) || environment.DependencyCache.Scope != "project-lock" || strings.TrimSpace(manifestPath) == "" {
		return result
	}
	counts := make(map[string]int)
	for _, item := range projectManifestPackageDeclarations(environment.Packages.Declared, manifestPath) {
		counts[normalizePythonPackageName(item.Name)]++
	}
	for name, count := range counts {
		if name != "" && count == 1 {
			result[name] = true
		}
	}
	return result
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
	manifestSnapshots, err := verifyPackageManifestBindings(resolved.root, stored.Language, stored.Public.ManifestBindings)
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
			if stored.Language == "node" {
				cacheRequest.MaterializationPolicy = h.nodeDependencyMaterializationPolicy()
			}
			cacheRequest.ManifestSnapshot = manifestSnapshots
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
	if stored.Language == "python" {
		if err := validateManagedPythonManifestSet(environment, manifestPath); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_manifest_set_changed", Data: stored.Public})
			return
		}
	} else if manager, reason := projectPackageManager(environment); reason != "" || manager.ID != stored.Public.Manager.ID || manager.ManifestPath != stored.Public.Manager.ManifestPath || manager.LockfilePath != stored.Public.Manager.LockfilePath {
		errorMessage := "Node package manager or dependency files changed after the plan was created"
		if reason != "" {
			errorMessage += ": " + reason
		}
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: errorMessage, ErrorCode: "package_manifest_set_changed", Data: stored.Public})
		return
	}
	if h.EnvironmentSetup == nil || h.PersonalCache == nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Project package installation is unavailable", ErrorCode: "package_service_unavailable"})
		return
	}
	packageResourceLease, resourceErr := acquireHandlerRuntimeResource(
		r.Context(), h.Resources, resourcecontrol.WorkloadPackage, userID, environmentResourceScope(environment), planID,
		environment.Runtime.ID, environment.Language.ID, environment.Runtime.Image, true,
	)
	if resourceErr != nil {
		writeResourcePressure(w)
		return
	}
	packageResourceOwnedByRequest := packageResourceLease != nil
	releasePackageResource := func() {
		releaseHandlerResource(packageResourceLease)
	}
	defer func() {
		if packageResourceOwnedByRequest {
			releasePackageResource()
		}
	}()
	if h.DAP != nil {
		if err := h.DAP.StopUserWorkspace(userID, resolved.folderKey); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_debug_session_active"})
			return
		}
	}
	var packageActivityReleases []func()
	defer func() { runReleaseCallbacksReverse(packageActivityReleases) }()
	if h.Lifecycle != nil {
		activity, leaseErr := h.Lifecycle.AcquireActivity(userID, resolved.folderKey)
		if leaseErr != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error(), ErrorCode: "package_workspace_busy"})
			return
		}
		packageActivityReleases = append(packageActivityReleases, activity.Release)
	}
	timeout := time.Duration(h.packageOperationTimeoutSeconds()) * time.Second
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	ctx, finalizeContainerCleanup := WithDeferredContainerCleanup(ctx)
	var dependencyLease *personalcache.Lease
	var toolchainLease *personalcache.ToolchainLease
	packageCachesFinalized := false
	releasePackageCaches := func() {
		if toolchainLease != nil {
			toolchainLease.Release()
		}
		h.releasePersonalCacheLease(dependencyLease, personalDependencyRefreshScope(userID, resolved.folderKey, environment.Runtime.ID, environment.Language.ID))
	}
	finalizePackageCaches := func(abort bool, released func()) {
		if packageCachesFinalized {
			return
		}
		packageCachesFinalized = true
		if abort && dependencyLease != nil {
			dependencyLease.Abort()
		}
		packageResourceOwnedByRequest = false
		activityReleases := packageActivityReleases
		packageActivityReleases = nil
		finalizeContainerCleanup(func() {
			releasePackageCaches()
			releasePackageResource()
			runReleaseCallbacksReverse(activityReleases)
			if released != nil {
				released()
			}
		})
	}
	// Panics from the executor still unwind through an aborted dependency
	// transaction. The cleanup handoff keeps both mounts retained until a
	// container removal accepted by the executor has completed.
	defer finalizePackageCaches(true, nil)
	if err := h.PackagePlans.BeginCompletionIntent(planID, userID); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Could not persist package operation intent", ErrorCode: "package_completion_persistence_unavailable", Data: stored.Public})
		return
	}
	intentStarted = true
	cacheRequest := h.environmentCacheRequest(r, safeRequest, resolved, environment.Runtime, environment.Language.ID)
	if stored.RuntimeFingerprint != "" {
		cacheRequest.RuntimeFingerprint = stored.RuntimeFingerprint
	}
	if stored.Language == "node" {
		cacheRequest.MaterializationPolicy = h.nodeDependencyMaterializationPolicy()
	}
	cacheRequest.ManifestSnapshot = manifestSnapshots
	cacheRequest.OperationID = planID
	cacheRequest.FreshGeneration = true
	dependencyLease, err = h.PersonalCache.Prepare(ctx, cacheRequest)
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
	managerID := strings.ToLower(strings.TrimSpace(stored.Public.Manager.ID))
	if managerID == "" && stored.Language == "python" {
		managerID = "pip"
	}
	command := ""
	cleanupInstallInput := func() error { return nil }
	switch stored.Language {
	case "python":
		if managerID != "pip" {
			finalizePackageCaches(true, nil)
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "The reviewed Python package manager is invalid", ErrorCode: "package_plan_invalid", Data: stored.Public})
			return
		}
		if err := resetPythonPackageTarget(dependencyLease); err != nil {
			finalizePackageCaches(true, nil)
			writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Could not prepare an empty project package target", ErrorCode: "package_cache_prepare_failed", Data: stored.Public})
			return
		}
		manifestContent, ok := packageManifestSnapshotContent(manifestSnapshots, manifestPath)
		if !ok {
			finalizePackageCaches(true, nil)
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "The reviewed Python dependency manifest is unavailable", ErrorCode: "package_plan_invalid", Data: stored.Public})
			return
		}
		installManifest, cleanup, prepareErr := preparePackageInstallSnapshot(dependencyLease, string(manifestContent))
		if prepareErr != nil {
			finalizePackageCaches(true, nil)
			writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Could not prepare the reviewed package manifest", ErrorCode: "package_cache_prepare_failed", Data: stored.Public})
			return
		}
		cleanupInstallInput = cleanup
		// pip does not create PIP_TARGET for an empty requirements file. Creating it
		// explicitly lets removal of the final dependency publish an exact empty generation.
		command = "mkdir -p \"$PIP_TARGET\" && python3 -m pip --isolated --disable-pip-version-check --no-input --cache-dir \"$PIP_CACHE_DIR\" install --target \"$PIP_TARGET\" --index-url " + shellQuoteEnvironmentPath(stored.InstallURL) + " -r " + shellQuoteEnvironmentPath(installManifest)
	case "node":
		if managerID != "npm" && managerID != "pnpm" {
			finalizePackageCaches(true, nil)
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "The reviewed Node package manager is invalid", ErrorCode: "package_plan_invalid", Data: stored.Public})
			return
		}
		manifestContent, manifestAvailable := packageManifestSnapshotContent(manifestSnapshots, "package.json")
		if !manifestAvailable {
			finalizePackageCaches(true, nil)
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "The reviewed Node package manifest is unavailable", ErrorCode: "package_plan_invalid", Data: stored.Public})
			return
		}
		if policyErr := validateNodePNPMDeclaration(manifestContent, managerID, h.nodePNPMVersion()); policyErr != nil {
			finalizePackageCaches(true, nil)
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: policyErr.Error(), ErrorCode: "package_manager_policy_mismatch", Data: stored.Public})
			return
		}
		if err := prepareNodePackageInstallSnapshot(dependencyLease, managerID, manifestSnapshots); err != nil {
			finalizePackageCaches(true, nil)
			writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Could not prepare the reviewed Node dependency files", ErrorCode: "package_cache_prepare_failed", Data: stored.Public})
			return
		}
		ignoreScripts := h.Config != nil && !h.Config.PackageNodeInstallScripts
		nodeCommand, commandErr := nodePackageInstallCommand(managerID, stored.InstallURL, ignoreScripts, h.nodePNPMVersion())
		if commandErr != nil {
			finalizePackageCaches(true, nil)
			writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "The server Node package-manager policy is invalid", ErrorCode: "package_manager_policy_invalid", Data: stored.Public})
			return
		}
		command = nodeCommand
	default:
		finalizePackageCaches(true, nil)
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "The reviewed package ecosystem is unsupported", ErrorCode: "package_plan_invalid", Data: stored.Public})
		return
	}
	toolchainLease, err = h.PersonalCache.PrepareToolchainCache(ctx, personalcache.ToolchainRequest{
		UserID: userID, RuntimeID: environment.Runtime.ID, RuntimeFingerprint: cacheRequest.RuntimeFingerprint,
		Language: environment.Language.ID, Tool: managerID,
		SourcePolicyDigest: packageSourcePolicyDigest(stored.Public.Source.ID, stored.InstallURL),
		QuotaBytes:         userQuotaBytes(h.UserStore, userID),
	})
	if err != nil || toolchainLease == nil {
		_ = cleanupInstallInput()
		finalizePackageCaches(true, nil)
		message := "Could not prepare the package download cache"
		if err != nil {
			message = err.Error()
		}
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: message, ErrorCode: "package_cache_unavailable", Data: stored.Public})
		return
	}
	ctx = personalcache.ContextWithToolchainLeases(ctx, toolchainLease)
	ctx = WithManagedPackageOperation(ctx)
	started := time.Now()
	stdout, stderr, exitCode, execErr := h.EnvironmentSetup(ctx, userID, environment.Runtime.ID, resolved.root, []string{command})
	cleanupErr := cleanupInstallInput()
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
		finalizePackageCaches(true, nil)
		message := "Package installation failed"
		if execErr != nil {
			message = execErr.Error()
		}
		result := model.ProjectPackageChangeResult{Schema: packageChangeActionSchema, PlanID: planID, Applied: false, ExitCode: exitCode, Stdout: stdout, Stderr: stderr, Message: message}
		writeJSON(w, status, model.Response{Success: false, Error: message, ErrorCode: code, Data: result})
		return
	}
	if _, err := verifyPackageManifestBindings(resolved.root, stored.Language, stored.Public.ManifestBindings); err != nil {
		finalizePackageCaches(true, nil)
		result := model.ProjectPackageChangeResult{Schema: packageChangeActionSchema, PlanID: planID, Applied: false, ExitCode: exitCode, Stdout: stdout, Stderr: stderr, Message: err.Error()}
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), ErrorCode: "package_plan_workspace_changed", Data: result})
		return
	}
	preview := dependencyLease.PreviewPackageInventory()
	previewInstalled := installedEnvironmentInspectionFromManagedInventory(preview, stored.Language)
	directDeclarations := projectManifestPackageDeclarations(environment.Packages.Declared, manifestPath)
	previewPackages := classifyEnvironmentPackages(directDeclarations, previewInstalled.Packages, stored.Language, preview.Exact)
	if preview.State != "ready" || !preview.Exact || len(previewPackages.Missing) > 0 || len(previewPackages.Unknown) > 0 || (len(directDeclarations) == 0 && len(preview.Packages) > 0) {
		finalizePackageCaches(true, nil)
		message := "Package installation completed, but the staged package inventory does not match the reviewed project manifest"
		if preview.State != "ready" && strings.TrimSpace(preview.Detail) != "" {
			message += ": " + preview.Detail
		}
		result := model.ProjectPackageChangeResult{Schema: packageChangeActionSchema, PlanID: planID, Applied: false, ExitCode: exitCode, Stdout: stdout, Stderr: stderr, Message: message}
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: message, ErrorCode: "package_inventory_mismatch", Data: result})
		return
	}
	released := make(chan struct{})
	finalizePackageCaches(false, func() { close(released) })
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

func packageManifestSnapshotContent(snapshots []personalcache.ManifestSnapshot, requestedPath string) ([]byte, bool) {
	requestedPath = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(requestedPath))))
	for _, snapshot := range snapshots {
		pathValue := filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(snapshot.Path))))
		if pathValue == requestedPath {
			return append([]byte(nil), snapshot.Content...), true
		}
	}
	return nil, false
}

func prepareNodePackageInstallSnapshot(lease *personalcache.Lease, manager string, snapshots []personalcache.ManifestSnapshot) error {
	if lease == nil || !lease.Writable() || strings.TrimSpace(lease.HostRoot) == "" {
		return fmt.Errorf("writable dependency generation is required")
	}
	manager = strings.ToLower(strings.TrimSpace(manager))
	lockfile := "package-lock.json"
	if manager == "pnpm" {
		lockfile = "pnpm-lock.yaml"
	} else if manager != "npm" {
		return fmt.Errorf("unsupported Node package manager %q", manager)
	}
	expected := map[string]bool{"package.json": true, lockfile: true}
	if len(snapshots) != len(expected) {
		return fmt.Errorf("Node installation requires package.json and %s", lockfile)
	}
	contents := make(map[string][]byte, len(snapshots))
	for _, snapshot := range snapshots {
		pathValue := filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(snapshot.Path))))
		if !expected[pathValue] || contents[pathValue] != nil || len(snapshot.Content) == 0 {
			return fmt.Errorf("invalid reviewed Node dependency file %q", snapshot.Path)
		}
		contents[pathValue] = append([]byte(nil), snapshot.Content...)
	}
	root := filepath.Clean(lease.HostRoot)
	for _, relative := range []string{"node_modules", "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml"} {
		if err := os.RemoveAll(filepath.Join(root, relative)); err != nil {
			return err
		}
	}
	if err := os.Mkdir(filepath.Join(root, "node_modules"), 0700); err != nil {
		return err
	}
	installManifest, err := nodeInstallManifest(contents["package.json"])
	if err != nil {
		return err
	}
	contents["package.json"] = installManifest
	for _, relative := range []string{"package.json", lockfile} {
		if err := safefile.WriteAtomic(root, relative, contents[relative], 0600); err != nil {
			return err
		}
	}
	return nil
}

// Dependency lifecycle scripts may run when enabled, but project-root scripts
// belong to the source workspace and cannot execute correctly or safely from
// the isolated dependency materialization directory.
func nodeInstallManifest(content []byte) ([]byte, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(content, &document); err != nil || document == nil {
		return nil, fmt.Errorf("reviewed package.json is invalid")
	}
	delete(document, "scripts")
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("prepare isolated package.json: %w", err)
	}
	return append(encoded, '\n'), nil
}

func nodePackageInstallCommand(manager, registryURL string, ignoreScripts bool, pnpmVersion string) (string, error) {
	registry := shellQuoteEnvironmentPath(strings.TrimSpace(registryURL))
	scriptFlag := ""
	if ignoreScripts {
		scriptFlag = " --ignore-scripts"
	}
	if manager == "pnpm" {
		executable, err := nodetoolchain.PNPMExecutable(pnpmVersion)
		if err != nil {
			return "", err
		}
		return "cd /project-deps && " + executable + " install --frozen-lockfile --prod=false --registry=" + registry + " --store-dir \"$PNPM_STORE_DIR\"" + scriptFlag, nil
	}
	if manager != "npm" {
		return "", fmt.Errorf("unsupported Node package manager %q", manager)
	}
	return "cd /project-deps && npm ci --no-audit --no-fund --include=dev --include=optional --workspaces=false --registry=" + registry + scriptFlag, nil
}

func validateNodePNPMDeclaration(content []byte, selectedManager, configuredVersion string) error {
	var document struct {
		PackageManager json.RawMessage `json:"packageManager"`
	}
	if err := json.Unmarshal(content, &document); err != nil {
		return fmt.Errorf("reviewed package.json is invalid")
	}
	if len(document.PackageManager) == 0 || string(document.PackageManager) == "null" {
		return nil
	}
	var declaration string
	if err := json.Unmarshal(document.PackageManager, &declaration); err != nil {
		return fmt.Errorf("package.json field packageManager must be a string")
	}
	name, selector, hasSelector := strings.Cut(strings.TrimSpace(declaration), "@")
	name = strings.ToLower(strings.TrimSpace(name))
	if strings.ToLower(strings.TrimSpace(selectedManager)) != "pnpm" || name != "pnpm" || !hasSelector || strings.TrimSpace(selector) == "" {
		return nil
	}
	declaredVersion := strings.TrimSpace(strings.SplitN(selector, "+", 2)[0])
	normalizedDeclared, declaredErr := nodetoolchain.NormalizePNPMVersion(declaredVersion)
	normalizedConfigured, configuredErr := nodetoolchain.NormalizePNPMVersion(configuredVersion)
	if declaredErr != nil || configuredErr != nil || normalizedDeclared != normalizedConfigured {
		return fmt.Errorf("package.json packageManager %q conflicts with the server pnpm@%s policy", declaration, configuredVersion)
	}
	return nil
}

func (h *HTTPHandler) nodePNPMVersion() string {
	if h != nil && h.Config != nil && strings.TrimSpace(h.Config.PackageNodePNPMVersion) != "" {
		return h.Config.PackageNodePNPMVersion
	}
	return nodetoolchain.DefaultPNPMVersion
}

func (h *HTTPHandler) nodeDependencyMaterializationPolicy() string {
	installScripts := h == nil || h.Config == nil || h.Config.PackageNodeInstallScripts
	return personalcache.NodeDependencyMaterializationPolicy(installScripts, h.nodePNPMVersion())
}

func projectPackageInventoryExact(environment *model.ProjectEnvironment) bool {
	if environment == nil || (environment.Language.ID != "python" && environment.Language.ID != "node") || environment.DependencyCache.InventoryStatus != "ready" || environment.DependencyCache.Status != "hit" {
		return false
	}
	expectedSource := "project-lock-" + environment.Language.ID
	for _, item := range environment.Packages.Installed {
		if item.Trust != "exact" || item.Source != expectedSource || item.Scope != "project-lock" {
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

func verifyPackageManifestBindings(root, language string, bindings []model.ProjectPackageManifestBinding) ([]personalcache.ManifestSnapshot, error) {
	if len(bindings) < 1 || len(bindings) > 8 {
		return nil, fmt.Errorf("package plan must bind between 1 and 8 dependency files")
	}
	seen := make(map[string]bool, len(bindings))
	result := make([]personalcache.ManifestSnapshot, 0, len(bindings))
	for _, binding := range bindings {
		pathValue := filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(binding.Path))))
		key := strings.ToLower(pathValue)
		if pathValue == "." || seen[key] {
			return nil, fmt.Errorf("package plan contains duplicate or invalid dependency bindings")
		}
		seen[key] = true
		var data []byte
		var err error
		if language == "python" {
			data, err = packageops.ReadPythonRequirementsSnapshot(root, pathValue, binding.SHA256)
		} else if language == "node" {
			var exists bool
			data, exists, err = packageops.ReadNodeDependencySnapshot(root, pathValue, binding.SHA256)
			if err == nil && !exists {
				err = fmt.Errorf("Node dependency file is unavailable")
			}
		} else {
			err = fmt.Errorf("unsupported package ecosystem %s", language)
		}
		if err != nil {
			return nil, fmt.Errorf("reviewed package manifest is unavailable: %w", err)
		}
		result = append(result, personalcache.ManifestSnapshot{Path: pathValue, Content: data})
	}
	return result, nil
}

func validateExecutablePackagePlan(plan model.ProjectPackageChangePlan) (string, error) {
	if len(plan.ManifestBindings) < 1 || len(plan.ManifestBindings) > 8 {
		return "", fmt.Errorf("package plan must bind between 1 and 8 dependency files")
	}
	bindings := make(map[string]string, len(plan.ManifestBindings))
	for _, binding := range plan.ManifestBindings {
		pathValue := filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(binding.Path))))
		if pathValue == "." || strings.TrimSpace(binding.SHA256) == "" || bindings[pathValue] != "" {
			return "", fmt.Errorf("package plan contains an invalid dependency binding")
		}
		bindings[pathValue] = binding.SHA256
	}
	manifestPath := filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(plan.Manager.ManifestPath))))
	if manifestPath == "." || bindings[manifestPath] == "" {
		manifestPath = filepath.ToSlash(filepath.Clean(filepath.FromSlash(plan.ManifestBindings[0].Path)))
	}
	if plan.Reinstall {
		if len(plan.LocalChanges) != 0 || len(plan.Changes) != 1 || plan.Changes[0].Operation != "update" {
			return "", fmt.Errorf("reinstall package plan has an invalid change shape")
		}
		return manifestPath, nil
	}
	if len(plan.LocalChanges) < 1 || len(plan.LocalChanges) > 8 {
		return "", fmt.Errorf("package plan contains an invalid dependency change set")
	}
	seenChanges := make(map[string]bool, len(plan.LocalChanges))
	for _, change := range plan.LocalChanges {
		pathValue := filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(change.Path))))
		if seenChanges[pathValue] || bindings[pathValue] == "" || !strings.EqualFold(bindings[pathValue], change.NewSHA256) {
			return "", fmt.Errorf("package plan contains an unbound dependency file change")
		}
		seenChanges[pathValue] = true
	}
	return manifestPath, nil
}
