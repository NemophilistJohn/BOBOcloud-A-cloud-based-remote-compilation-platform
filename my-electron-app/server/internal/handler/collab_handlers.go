package handler

import (
	"errors"
	"net/http"
	"strings"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/collab"
	"bobocloud-server/internal/model"
)

func collabError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	msg := err.Error()
	response := model.Response{Success: false, Error: msg}
	var operationErr *collab.OperationError
	if errors.As(err, &operationErr) {
		response.Error = operationErr.Message
		response.ErrorCode = operationErr.Code
		response.Details = operationErr.Details
		switch operationErr.Code {
		case collab.ErrorCodePushConflict, collab.ErrorCodeMergeConflict, collab.ErrorCodeNoChanges, collab.ErrorCodeLockHeld, collab.ErrorCodeLockStale:
			status = http.StatusConflict
		case collab.ErrorCodePushFailed:
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, response)
		return
	}
	if strings.Contains(msg, "not a member") || strings.Contains(msg, "only the team administrator") || strings.Contains(msg, "lock owner") {
		status = http.StatusForbidden
	} else if strings.Contains(msg, "not found") || strings.Contains(msg, "does not exist") {
		status = http.StatusNotFound
	} else if strings.Contains(msg, "being edited") || strings.Contains(msg, "currently in use") || strings.Contains(msg, "uncommitted changes") || strings.Contains(msg, "push was rejected") || strings.Contains(msg, "conflict") {
		status = http.StatusConflict
	}
	writeJSON(w, status, response)
}

func (h *HTTPHandler) handleCollaboration(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if h.Collaboration == nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Team collaboration is not configured"})
		return
	}
	user := auth.UserFromContext(r.Context())
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "Not authenticated"})
		return
	}
	ctx := r.Context()
	success := func(data any) { writeJSON(w, http.StatusOK, model.Response{Success: true, Data: data}) }

	switch req.Action {
	case "createTeam":
		quota := req.CacheQuotaMB
		if quota <= 0 && h.Config != nil {
			quota = h.Config.TeamCacheDefaultQuotaMB
		}
		team, err := h.Collaboration.CreateTeam(user.ID, req.Name, req.Description, quota)
		if err != nil {
			collabError(w, err)
			return
		}
		success(team)
	case "listTeams":
		teams, err := h.Collaboration.ListTeams(user.ID)
		if err != nil {
			collabError(w, err)
			return
		}
		success(teams)
	case "getTeam":
		team, members, projects, err := h.Collaboration.GetTeam(user.ID, req.TeamID)
		if err != nil {
			collabError(w, err)
			return
		}
		success(map[string]any{"team": team, "members": members, "projects": projects})
	case "updateTeam":
		team, err := h.Collaboration.UpdateTeam(user.ID, req.TeamID, req.Name, req.Description, req.CacheQuotaMB, req.CacheRetentionDays)
		if err != nil {
			collabError(w, err)
			return
		}
		success(team)
	case "deleteTeam":
		team, err := h.Collaboration.Store().GetTeam(req.TeamID)
		if err != nil {
			collabError(w, err)
			return
		}
		if team.AdminUserID != user.ID {
			collabError(w, errOnlyTeamAdmin{})
			return
		}
		if err := h.Collaboration.DeleteTeamTransaction(user.ID, req.TeamID, func() error {
			if h.LSP != nil {
				if err := h.LSP.StopOwner("team", req.TeamID, ""); err != nil {
					return err
				}
			}
			if h.BuildCache != nil {
				if err := h.BuildCache.Clear(req.TeamID, "all", "", ""); err != nil {
					return err
				}
			}
			if h.LSP != nil {
				if _, err := h.LSP.ClearCache("team", req.TeamID, "all", "", ""); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			collabError(w, err)
			return
		}
		success(map[string]bool{"deleted": true})
	case "createTeamInvite":
		invite, err := h.Collaboration.CreateInvite(user.ID, req.TeamID, req.ExpiresInHours, req.MaxUses)
		if err != nil {
			collabError(w, err)
			return
		}
		success(invite)
	case "listTeamInvites":
		invites, err := h.Collaboration.ListInvites(user.ID, req.TeamID)
		if err != nil {
			collabError(w, err)
			return
		}
		success(invites)
	case "revokeTeamInvite":
		if err := h.Collaboration.RevokeInvite(user.ID, req.TeamID, req.InviteCode); err != nil {
			collabError(w, err)
			return
		}
		success(map[string]bool{"revoked": true})
	case "deleteTeamInvite":
		if err := h.Collaboration.DeleteInvite(user.ID, req.TeamID, req.InviteCode); err != nil {
			collabError(w, err)
			return
		}
		success(map[string]bool{"deleted": true})
	case "joinTeam":
		team, err := h.Collaboration.JoinTeam(user.ID, req.InviteCode)
		if err != nil {
			collabError(w, err)
			return
		}
		success(team)
	case "leaveTeam":
		if err := h.Collaboration.LeaveTeam(user.ID, req.TeamID); err != nil {
			collabError(w, err)
			return
		}
		success(map[string]bool{"left": true})
	case "removeTeamMember":
		if err := h.Collaboration.RemoveMember(user.ID, req.TeamID, req.UserID); err != nil {
			collabError(w, err)
			return
		}
		success(map[string]bool{"removed": true})
	case "createTeamProject":
		project, err := h.Collaboration.CreateProject(ctx, user.ID, req.TeamID, req.Name, req.Description)
		if err != nil {
			collabError(w, err)
			return
		}
		success(project)
	case "listTeamProjects":
		projects, err := h.Collaboration.ListProjects(user.ID, req.TeamID)
		if err != nil {
			collabError(w, err)
			return
		}
		success(projects)
	case "deleteTeamProject":
		team, err := h.Collaboration.Store().GetTeam(req.TeamID)
		if err != nil {
			collabError(w, err)
			return
		}
		if team.AdminUserID != user.ID {
			collabError(w, errOnlyTeamAdmin{})
			return
		}
		if err := h.Collaboration.DeleteProjectTransaction(user.ID, req.TeamID, req.ProjectID, func() error {
			if h.LSP != nil {
				if err := h.LSP.StopOwner("team", req.TeamID, req.ProjectID); err != nil {
					return err
				}
			}
			if h.BuildCache != nil {
				if err := h.BuildCache.Clear(req.TeamID, "project", req.ProjectID, ""); err != nil {
					return err
				}
			}
			if h.LSP != nil {
				if _, err := h.LSP.ClearCache("team", req.TeamID, "project", req.ProjectID, ""); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			collabError(w, err)
			return
		}
		success(map[string]bool{"deleted": true})
	case "prepareTeamProject":
		var info any
		var err error
		if req.Reset {
			info, err = h.Collaboration.ResetWorktree(ctx, user.ID, req.TeamID, req.ProjectID, req.Branch)
		} else {
			info, err = h.Collaboration.EnsureWorktree(ctx, user.ID, req.TeamID, req.ProjectID, req.Branch, req.Pull)
		}
		if err != nil {
			collabError(w, err)
			return
		}
		success(info)
	case "listTeamBranches":
		branches, err := h.Collaboration.ListBranches(ctx, user.ID, req.TeamID, req.ProjectID)
		if err != nil {
			collabError(w, err)
			return
		}
		success(branches)
	case "createTeamBranch":
		if err := h.Collaboration.CreateBranch(ctx, user.ID, req.TeamID, req.ProjectID, req.Branch, req.SourceBranch); err != nil {
			collabError(w, err)
			return
		}
		success(map[string]string{"branch": req.Branch})
	case "teamProjectHistory":
		history, err := h.Collaboration.History(ctx, user.ID, req.TeamID, req.ProjectID, req.Limit)
		if err != nil {
			collabError(w, err)
			return
		}
		success(history)
	case "commitTeamChanges":
		commit, err := h.Collaboration.Commit(ctx, user, req.TeamID, req.ProjectID, req.Branch, req.CommitMessage)
		if err != nil {
			collabError(w, err)
			return
		}
		success(commit)
	case "compareTeamBranches":
		diff, err := h.Collaboration.Compare(ctx, user.ID, req.TeamID, req.ProjectID, req.SourceBranch, req.TargetBranch)
		if err != nil {
			collabError(w, err)
			return
		}
		success(diff)
	case "mergeTeamBranch":
		info, err := h.Collaboration.Merge(ctx, user, req.TeamID, req.ProjectID, req.SourceBranch, req.TargetBranch)
		if err != nil {
			collabError(w, err)
			return
		}
		success(info)
	case "listTeamConflicts":
		files, err := h.Collaboration.ConflictFiles(ctx, user.ID, req.TeamID, req.ProjectID, req.Branch)
		if err != nil {
			collabError(w, err)
			return
		}
		success(files)
	case "resolveTeamConflict":
		if err := h.Collaboration.ResolveConflict(ctx, user.ID, req.TeamID, req.ProjectID, req.Branch, req.FilePath, req.Content); err != nil {
			collabError(w, err)
			return
		}
		success(map[string]string{"resolved": req.FilePath})
	case "completeTeamMerge":
		commit, err := h.Collaboration.CompleteMerge(ctx, user, req.TeamID, req.ProjectID, req.Branch, req.CommitMessage)
		if err != nil {
			collabError(w, err)
			return
		}
		success(commit)
	case "acquireTeamFileLock":
		lock, err := h.Collaboration.AcquireLock(user, req.TeamID, req.ProjectID, req.Branch, req.FilePath, req.LockLeaseID, req.TTLMinutes)
		if err != nil {
			collabError(w, err)
			return
		}
		success(lock)
	case "releaseTeamFileLock":
		if err := h.Collaboration.ReleaseLock(user.ID, req.TeamID, req.ProjectID, req.Branch, req.FilePath, req.LockLeaseID); err != nil {
			collabError(w, err)
			return
		}
		success(map[string]bool{"released": true})
	case "listTeamFileLocks":
		locks, err := h.Collaboration.ListLocks(user.ID, req.TeamID, req.ProjectID)
		if err != nil {
			collabError(w, err)
			return
		}
		success(locks)
	case "getTeamCacheInfo":
		team, _, _, err := h.Collaboration.GetTeam(user.ID, req.TeamID)
		if err != nil {
			collabError(w, err)
			return
		}
		if h.BuildCache == nil {
			success(nil)
			return
		}
		success(h.BuildCache.Inspect(team.ID, team.CacheQuotaMB))
	case "clearTeamCache":
		team, err := h.Collaboration.Store().GetTeam(req.TeamID)
		if err != nil {
			collabError(w, err)
			return
		}
		if team.AdminUserID != user.ID {
			collabError(w, errOnlyTeamAdmin{})
			return
		}
		if h.BuildCache == nil {
			success(nil)
			return
		}
		if err := h.BuildCache.Clear(req.TeamID, req.CacheScope, req.ProjectID, req.NamespaceKey); err != nil {
			collabError(w, err)
			return
		}
		if h.OnBuildCacheCleared != nil {
			h.OnBuildCacheCleared()
		}
		success(h.BuildCache.Inspect(team.ID, team.CacheQuotaMB))
	}
}

type errOnlyTeamAdmin struct{}

func (errOnlyTeamAdmin) Error() string { return "only the team administrator can perform this action" }
