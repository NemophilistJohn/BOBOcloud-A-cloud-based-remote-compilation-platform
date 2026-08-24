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
	if !projectLockDependencyLanguage(language) {
		return nil, nil
	}
	folderKey := strings.TrimSpace(sess.FolderKey)
	if folderKey == "" {
		folderKey = strings.TrimSpace(sess.FolderName)
	}
	workspaceID := lsp.StableWorkspaceIdentity(sess.UserID, "", "", "", folderKey)
	request := personalcache.Request{
		UserID: sess.UserID, WorkspaceID: workspaceID, WorkspaceName: sess.FolderName,
		RuntimeID: runtime.RuntimeID, RuntimeFingerprint: resolvedRuntimeFingerprint(ctx, h.RuntimeMetadata, runtime.RuntimeID, runtime.DockerImage, runtime.Version), Language: language, WorkspaceRoot: workspaceRoot,
		SetupCommands: sess.SetupCommands, QuotaBytes: userQuotaBytes(h.UserStore, sess.UserID),
	}
	if !projectDependencyWriteRequired(language, sess.SetupCommands) {
		return h.PersonalCache.PrepareReadOnly(ctx, request)
	}
	return h.PersonalCache.Prepare(ctx, request)
}

// Python and Node execution only read an already-installed dependency tree.
// Go, Rust, and Java compilers can populate their module/build caches during
// ordinary compilation, so those runtimes retain a writable generation.
func projectDependencyWriteRequired(language string, setupCommands []string) bool {
	for _, command := range setupCommands {
		if strings.TrimSpace(command) != "" {
			return true
		}
	}
	switch canonicalRuntimeLanguage(language) {
	case "python", "node":
		return false
	default:
		return true
	}
}

func (h *HTTPHandler) environmentCacheRequest(r *http.Request, req *model.Request, resolved environmentResolved, runtime model.ProjectEnvironmentRuntime, language string) personalcache.Request {
	userID := auth.UserIDFromContext(r.Context())
	return personalcache.Request{
		UserID: userID, WorkspaceID: resolved.workspace.ID, WorkspaceName: resolved.workspace.Name,
		RuntimeID: runtime.ID, RuntimeFingerprint: resolvedRuntimeFingerprint(r.Context(), h.RuntimeMetadata, runtime.ID, runtime.Image, runtime.Version), Language: language, WorkspaceRoot: resolved.root,
		SetupCommands: req.SetupCommands, QuotaBytes: userQuotaBytes(h.UserStore, userID),
	}
}

func personalCacheRuntimeFingerprint(runtimeID, image string, imageID ...string) string {
	resolvedImageID := ""
	if len(imageID) > 0 {
		resolvedImageID = imageID[0]
	}
	return strings.TrimSpace(runtimeID) + "\x00" + strings.TrimSpace(image) + "\x00" + strings.TrimSpace(resolvedImageID)
}

func (h *WSHandler) releasePersonalCacheLease(lease *personalcache.Lease, scope lsp.DependencyRefreshScope) {
	if lease == nil {
		return
	}
	lease.Release()
	if lease.Published() && h != nil && h.LSP != nil {
		h.LSP.RestartDependencyViews(scope)
	}
}

func (h *HTTPHandler) releasePersonalCacheLease(lease *personalcache.Lease, scope lsp.DependencyRefreshScope) {
	if lease == nil {
		return
	}
	lease.Release()
	if lease.Published() && h != nil && h.LSP != nil {
		h.LSP.RestartDependencyViews(scope)
	}
}

func personalDependencyRefreshScope(userID, folderKey, runtimeID, languageID string) lsp.DependencyRefreshScope {
	return lsp.DependencyRefreshScope{
		UserID: userID, OwnerKind: "user", OwnerID: userID,
		FolderKey: strings.TrimSpace(folderKey), RuntimeID: strings.TrimSpace(runtimeID), LanguageID: strings.TrimSpace(languageID),
	}
}

func personalCacheLeaseError(lease *personalcache.Lease, parent context.Context) error {
	if lease == nil {
		return nil
	}
	guard := lease.StartGuard(parent)
	if guard == nil {
		return nil
	}
	return guard.Err()
}
