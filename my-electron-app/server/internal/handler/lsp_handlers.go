package handler

import (
	"net/http"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/model"
)

func (h *HTTPHandler) handleLSPManagement(w http.ResponseWriter, r *http.Request, req *model.Request) {
	user := auth.UserFromContext(r.Context())
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "Not authenticated"})
		return
	}
	success := func(data any) { writeJSON(w, http.StatusOK, model.Response{Success: true, Data: data}) }
	if req.Action == "getLSPInfo" {
		languages := []string{}
		if h.LSP != nil {
			languages = h.LSP.Languages()
		}
		success(map[string]any{
			"enabled":   h.LSP != nil && h.Config != nil && h.Config.LSPEnabled,
			"modes":     []string{"local", "standard", "full"},
			"languages": languages,
			"limits":    map[string]any{"maxSessions": h.Config.LSPMaxSessions, "maxSessionsPerUser": h.Config.LSPMaxSessionsPerUser, "idleTTLSeconds": h.Config.LSPIdleTTLSeconds, "maxMessageBytes": h.Config.LSPMaxMessageBytes, "bandwidthPerMinuteBytes": h.Config.LSPBandwidthPerMinuteBytes, "cacheQuotaBytes": int64(h.Config.LSPCacheQuotaMB) * 1_000_000, "cacheRetentionDays": h.Config.LSPCacheRetentionDays, "memoryLimit": h.Config.LSPMemoryLimit, "cpuLimit": h.Config.LSPCPULimit},
		})
		return
	}
	if h.LSP == nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Remote LSP is not configured"})
		return
	}
	ownerKind, ownerID := "user", user.ID
	if req.TeamID != "" {
		if h.Collaboration == nil {
			writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Team collaboration is not configured"})
			return
		}
		team, _, _, err := h.Collaboration.GetTeam(user.ID, req.TeamID)
		if err != nil {
			collabError(w, err)
			return
		}
		ownerKind, ownerID = "team", team.ID
		if req.Action == "clearLSPCache" && team.AdminUserID != user.ID {
			collabError(w, errOnlyTeamAdmin{})
			return
		}
	}
	if req.Action == "getLSPCacheInfo" {
		success(h.LSP.CacheInfo(ownerKind, ownerID))
		return
	}
	scope := req.CacheScope
	if scope == "" {
		scope = "all"
	}
	info, err := h.LSP.ClearCache(ownerKind, ownerID, scope, req.ProjectID, req.NamespaceKey)
	if err != nil {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error(), Data: info})
		return
	}
	success(info)
}
