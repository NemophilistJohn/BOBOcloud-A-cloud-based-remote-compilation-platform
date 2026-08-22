package handler

import (
	"context"
	"net/http"
	"strings"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
)

func userQuotaBytes(store auth.UserStore, userID string) int64 {
	if store == nil || strings.TrimSpace(userID) == "" {
		return 0
	}
	user, err := store.Get(userID)
	if err != nil || user.DiskQuotaMB <= 0 {
		return 0
	}
	return int64(user.DiskQuotaMB) * 1_000_000
}

func (h *WSHandler) prepareRunPersonalCache(ctx context.Context, sess *model.RunSession, runtime model.RuntimeDef, language, workspaceRoot string) (*personalcache.Lease, error) {
	if h == nil || h.PersonalCache == nil || sess == nil || sess.TeamID != "" {
		return nil, nil
	}
	folderKey := strings.TrimSpace(sess.FolderKey)
	if folderKey == "" {
		folderKey = strings.TrimSpace(sess.FolderName)
	}
	workspaceID := lsp.StableWorkspaceIdentity(sess.UserID, "", "", "", folderKey)
	return h.PersonalCache.Prepare(ctx, personalcache.Request{
		UserID: sess.UserID, WorkspaceID: workspaceID, WorkspaceName: sess.FolderName,
		RuntimeID: runtime.RuntimeID, RuntimeFingerprint: personalCacheRuntimeFingerprint(runtime.RuntimeID, runtime.DockerImage), Language: language, WorkspaceRoot: workspaceRoot,
		SetupCommands: sess.SetupCommands, QuotaBytes: userQuotaBytes(h.UserStore, sess.UserID),
	})
}

func (h *HTTPHandler) environmentCacheRequest(r *http.Request, req *model.Request, resolved environmentResolved, runtime model.ProjectEnvironmentRuntime, language string) personalcache.Request {
	userID := auth.UserIDFromContext(r.Context())
	return personalcache.Request{
		UserID: userID, WorkspaceID: resolved.workspace.ID, WorkspaceName: resolved.workspace.Name,
		RuntimeID: runtime.ID, RuntimeFingerprint: personalCacheRuntimeFingerprint(runtime.ID, runtime.Image), Language: language, WorkspaceRoot: resolved.root,
		SetupCommands: req.SetupCommands, QuotaBytes: userQuotaBytes(h.UserStore, userID),
	}
}

func personalCacheRuntimeFingerprint(runtimeID, image string) string {
	return strings.TrimSpace(runtimeID) + "\x00" + strings.TrimSpace(image)
}
