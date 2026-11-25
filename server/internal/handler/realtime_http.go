package handler

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/collab"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/resourcecontrol"
)

func (h *HTTPHandler) snapshotRealtimePersonal(ctx context.Context, user *auth.User, req *model.Request) (any, error) {
	if h.Config == nil || h.Lifecycle == nil {
		return nil, fmt.Errorf("personal workspace storage unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	resources, err := acquireHandlerRuntimeResource(ctx, h.Resources, resourcecontrol.WorkloadPackage, user.ID, projectResourceScope("", req.TeamID, req.ProjectID), "realtime-snapshot:"+auth.GenerateToken(), "", "", "", false)
	if err != nil {
		return nil, err
	}
	defer releaseHandlerResource(resources)
	activity, err := h.Collaboration.AcquireProjectActivity(user.ID, req.TeamID, req.ProjectID)
	if err != nil {
		return nil, err
	}
	defer activity.Release()
	lease, err := h.Lifecycle.BeginUserMutation(user.ID)
	if err != nil {
		return nil, err
	}
	defer lease.Release()
	state, err := h.Collaboration.GetRealtimeSnapshotContext(ctx, user.ID, req.TeamID, req.ProjectID, req.Epoch)
	if err != nil {
		return nil, err
	}
	project, err := h.Collaboration.Store().GetProject(req.ProjectID)
	if err != nil {
		return nil, err
	}
	userDir, err := h.ensureUserDir(user.ID)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(userDir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	digest := sha256.Sum256([]byte(req.TeamID + "\x00" + req.ProjectID + "\x00" + state.Epoch + fmt.Sprint(state.Revision)))
	key := fmt.Sprintf("realtime-%x", digest[:16])
	target := "workspaces/" + key
	result := map[string]any{"projectKey": key, "folderKey": key, "folderName": project.Name, "revision": state.Revision}
	if info, e := root.Lstat(target); e == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("snapshot destination unavailable")
		}
		return result, nil
	} else if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	usage, err := socialDiskUsage(ctx, userDir)
	if err != nil {
		return nil, err
	}
	var size int64
	for _, file := range state.Files {
		size += int64(len(file.Content) + len(file.Data) + 512)
	}
	if h.UserStore != nil {
		current, e := h.UserStore.Get(user.ID)
		if e != nil || current.Disabled {
			return nil, fmt.Errorf("user access changed")
		}
		user = current
	}
	if user.DiskQuotaMB > 0 && usage+size > int64(user.DiskQuotaMB)*1e6 {
		return nil, fmt.Errorf("disk quota exceeded")
	}
	staging, err := os.MkdirTemp(userDir, ".realtime-import-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(staging)
	if err = collab.WriteRealtimeSnapshot(staging, state.Files); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	// Recheck team authorization immediately before publication; a revoked
	// member cannot complete an import after a long quota scan or write.
	if _, err = h.Collaboration.GetRealtimeState(user.ID, req.TeamID, req.ProjectID); err != nil {
		return nil, err
	}
	if err = h.writeWorkspaceDisplayName(user.ID, key, project.Name); err != nil {
		return nil, err
	}
	if err = root.Rename(filepath.Base(staging), target); err != nil {
		_ = h.deleteWorkspaceDisplayName(user.ID, key)
		return nil, err
	}
	if h.diskCache != nil {
		h.diskCache.Set(user.ID, 0, 1)
	}
	return result, nil
}

func (h *HTTPHandler) checkpointRealtime(ctx context.Context, user *auth.User, req *model.Request) (any, error) {
	resources, err := acquireHandlerRuntimeResource(ctx, h.Resources, resourcecontrol.WorkloadPackage, user.ID, projectResourceScope("", req.TeamID, req.ProjectID), "realtime-checkpoint:"+auth.GenerateToken(), "", "", "", false)
	if err != nil {
		return nil, err
	}
	defer releaseHandlerResource(resources)
	activity, err := h.Collaboration.AcquireProjectActivity(user.ID, req.TeamID, req.ProjectID)
	if err != nil {
		return nil, err
	}
	defer activity.Release()
	return h.Collaboration.CheckpointRealtime(ctx, user.ID, req.TeamID, req.ProjectID, req.Epoch, req.CommitMessage)
}

func (h *HTTPHandler) setRealtimeMode(ctx context.Context, user *auth.User, req *model.Request) (collab.RealtimeState, error) {
	if _, err := h.Collaboration.GetRealtimeState(user.ID, req.TeamID, req.ProjectID); err != nil {
		return collab.RealtimeState{}, err
	}
	resources, err := acquireHandlerRuntimeResource(ctx, h.Resources, resourcecontrol.WorkloadPackage, user.ID, projectResourceScope("", req.TeamID, req.ProjectID), "realtime-mode:"+auth.GenerateToken(), "", "", "", false)
	if err != nil {
		return collab.RealtimeState{}, err
	}
	defer releaseHandlerResource(resources)
	return h.Collaboration.SetRealtimeMode(ctx, user.ID, req.TeamID, req.ProjectID, req.Branch, req.Epoch, req.Enabled)
}

func (h *HTTPHandler) getRealtimeSnapshot(ctx context.Context, user *auth.User, req *model.Request) (collab.RealtimeState, error) {
	if _, err := h.Collaboration.GetRealtimeState(user.ID, req.TeamID, req.ProjectID); err != nil {
		return collab.RealtimeState{}, err
	}
	resources, err := acquireHandlerRuntimeResource(ctx, h.Resources, resourcecontrol.WorkloadPackage, user.ID, projectResourceScope("", req.TeamID, req.ProjectID), "realtime-download:"+auth.GenerateToken(), "", "", "", false)
	if err != nil {
		return collab.RealtimeState{}, err
	}
	defer releaseHandlerResource(resources)
	activity, err := h.Collaboration.AcquireProjectActivity(user.ID, req.TeamID, req.ProjectID)
	if err != nil {
		return collab.RealtimeState{}, err
	}
	defer activity.Release()
	return h.Collaboration.GetRealtimeSnapshotContext(ctx, user.ID, req.TeamID, req.ProjectID, req.Epoch)
}
