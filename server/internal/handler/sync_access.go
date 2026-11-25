package handler

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/syncsftp"
)

// AuthorizeSync is the authority for every SFTP operation and open-handle I/O,
// not just the HTTP preparation request. Team membership and mode are live.
func (h *HTTPHandler) AuthorizeSync(ctx context.Context, principal, absolute string, write bool) (syncsftp.RootAccess, error) {
	if h.Config == nil || h.AuthSessions == nil || h.UserStore == nil {
		return syncsftp.RootAccess{}, fmt.Errorf("sync authentication unavailable")
	}
	session, err := h.AuthSessions.Validate(principal, h.Config.SessionTokenTTL())
	if err != nil {
		return syncsftp.RootAccess{}, fmt.Errorf("sync session revoked")
	}
	user, err := h.UserStore.Get(session.UserID)
	if err != nil || user.Disabled {
		return syncsftp.RootAccess{}, fmt.Errorf("sync account disabled")
	}
	absolute = filepath.Clean(absolute)
	if !filepath.IsAbs(absolute) {
		return syncsftp.RootAccess{}, fmt.Errorf("absolute sync path required")
	}
	for _, part := range strings.Split(filepath.ToSlash(absolute), "/") {
		if strings.EqualFold(part, ".git") {
			return syncsftp.RootAccess{}, fmt.Errorf("repository metadata is not synchronized")
		}
	}
	userRoot, err := auth.UserDataRoot(h.Config.DataDir, user.ID)
	if err != nil {
		return syncsftp.RootAccess{}, err
	}
	root := filepath.Join(userRoot, "workspaces")
	rel, err := filepath.Rel(root, absolute)
	release := func() {}
	if err != nil || !filepath.IsLocal(rel) {
		if h.Collaboration == nil {
			return syncsftp.RootAccess{}, fmt.Errorf("sync path denied")
		}
		root, release, err = h.Collaboration.AcquireSyncRoot(user.ID, absolute)
		if err != nil {
			return syncsftp.RootAccess{}, err
		}
		rel, err = filepath.Rel(root, absolute)
		if err != nil || !filepath.IsLocal(rel) {
			release()
			return syncsftp.RootAccess{}, fmt.Errorf("sync path denied")
		}
	}
	// Account deletion and workspace lifecycle use the same active-user boundary.
	if h.Lifecycle != nil {
		lease, leaseErr := h.Lifecycle.AcquireRequest(user.ID)
		if leaseErr != nil {
			release()
			return syncsftp.RootAccess{}, leaseErr
		}
		previous := release
		release = func() { lease.Release(); previous() }
	}
	if err := ctx.Err(); err != nil {
		release()
		return syncsftp.RootAccess{}, err
	}
	return syncsftp.RootAccess{Root: root, Relative: rel, Release: release}, nil
}
