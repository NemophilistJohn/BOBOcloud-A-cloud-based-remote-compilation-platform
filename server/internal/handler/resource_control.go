package handler

import (
	"context"
	"net/http"
	"strings"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/resourcecontrol"
	"bobocloud-server/internal/resourcegovernor"
	"bobocloud-server/internal/runtimepolicy"
)

const (
	resourcePressureErrorCode = "resource_pressure"
	resourcePressureMessage   = "Server resource capacity is currently exhausted; retry shortly"
)

func acquireHandlerRuntimeResource(ctx context.Context, controller *resourcecontrol.Controller, workload resourcecontrol.Workload, ownerID, scopeID, workloadID, runtimeID, language, image string, dockerContainer bool) (*resourcecontrol.Lease, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if controller == nil {
		return nil, nil
	}
	minimum := resourcegovernor.Resources{MemoryBytes: runtimepolicy.MinimumMemoryBytes(runtimeID, language, image)}
	if dockerContainer {
		minimum.DockerContainers = 1
	}
	return controller.Acquire(ctx, resourcecontrol.Admission{
		Workload: workload, OwnerID: ownerID, ScopeID: scopeID, WorkloadID: workloadID,
		Minimum: minimum,
	})
}

// tryAcquireHandlerRuntimeResource remains the explicit no-wait helper used by
// focused lifecycle tests and maintenance-style internal callers.
func tryAcquireHandlerRuntimeResource(controller *resourcecontrol.Controller, workload resourcecontrol.Workload, ownerID, workloadID, runtimeID, language, image string) (*resourcecontrol.Lease, error) {
	if controller == nil {
		return nil, nil
	}
	return controller.TryAcquireWithDemand(workload, ownerID, workloadID, resourcegovernor.Resources{
		MemoryBytes: runtimepolicy.MinimumMemoryBytes(runtimeID, language, image),
	})
}

func runSessionResourceScope(session *model.RunSession) string {
	if session == nil {
		return "default"
	}
	key := session.FolderKey
	if key == "" {
		key = session.FolderName
	}
	return projectResourceScope(key, session.TeamID, session.ProjectID)
}

func environmentResourceScope(environment *model.ProjectEnvironment) string {
	if environment == nil {
		return "default"
	}
	workspace := environment.Workspace
	key := workspace.Key
	if key == "" {
		key = workspace.ID
	}
	return projectResourceScope(key, workspace.TeamID, workspace.ProjectID)

}

// projectResourceScope deliberately ignores the operation kind and team branch.
// Every workload for one logical project must share its queue bound; otherwise
// opening a terminal, LSP, DAP, or another branch could bypass project fairness.
func projectResourceScope(personalKey, teamID, projectID string) string {
	if strings.TrimSpace(teamID) != "" {
		return resourceScope("team", teamID, projectID)
	}
	return resourceScope("personal", personalKey)
}

func resourceScope(parts ...string) string {
	return strings.Join(parts, "\x00")
}

func releaseHandlerResource(lease *resourcecontrol.Lease) {
	if lease != nil {
		lease.Release()
	}
}

func writeResourcePressure(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	writeJSON(w, http.StatusServiceUnavailable, model.Response{
		Success: false, Error: resourcePressureMessage, ErrorCode: resourcePressureErrorCode,
	})
}
