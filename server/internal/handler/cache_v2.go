package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/cachev2"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
)

type cachePackageInventoryDetail struct {
	State       string                           `json:"state"`
	Detail      string                           `json:"detail,omitempty"`
	Exact       bool                             `json:"exact"`
	GeneratedAt time.Time                        `json:"generated_at,omitempty"`
	Revision    string                           `json:"revision,omitempty"`
	Packages    []personalcache.InventoryPackage `json:"packages,omitempty"`
}

func (h *HTTPHandler) handleCacheV2(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if h.PersonalCache == nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Cache inventory is unavailable", ErrorCode: "cache_service_unavailable"})
		return
	}
	userID := auth.UserIDFromContext(r.Context())
	quotaBytes := userQuotaBytes(h.UserStore, userID)
	switch req.Action {
	case "getCacheInventory":
		inventory, err := h.PersonalCache.Catalog(userID, quotaBytes)
		if err != nil {
			writeCacheV2Error(w, err)
			return
		}
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{"cacheInventory": inventory}})
	case "getCacheEntry":
		h.handleGetCacheV2Entry(w, userID, quotaBytes, req)
	case "deleteCacheEntry":
		h.handleDeleteCacheV2Entry(w, r, userID, quotaBytes, req)
	case "clearCacheScope":
		h.handleClearCacheV2Scope(w, r, userID, quotaBytes, req)
	}
}

func (h *HTTPHandler) handleGetCacheV2Entry(w http.ResponseWriter, userID string, quotaBytes int64, req *model.Request) {
	id, err := cachev2.ParseCacheID(strings.TrimSpace(req.CacheID))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "A valid cache ID is required", ErrorCode: "cache_id_invalid"})
		return
	}
	inventory, err := h.PersonalCache.Catalog(userID, quotaBytes)
	if err != nil {
		writeCacheV2Error(w, err)
		return
	}
	entry, found := findCacheV2Entry(inventory, id)
	if !found {
		writeCacheV2Error(w, personalcache.ErrCacheNotFound)
		return
	}
	payload := cacheV2EntryPayload(entry)
	if entry.Category == cachev2.CategoryDependencies {
		verified, inspection, inspectErr := h.PersonalCache.InspectPackagesByID(userID, id, inventory.Revision, quotaBytes)
		if inspectErr != nil && !errors.Is(inspectErr, personalcache.ErrPackageInventoryType) {
			writeCacheV2Error(w, inspectErr)
			return
		}
		payload = cacheV2EntryPayload(verified)
		payload["package_inventory"] = cachePackageInventoryDetail{
			State: inspection.State, Detail: inspection.Detail, Exact: inspection.Exact,
			GeneratedAt: inspection.GeneratedAt, Revision: inspection.Revision, Packages: inspection.Packages,
		}
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{"cacheEntry": payload, "revision": inventory.Revision}})
}

func (h *HTTPHandler) handleDeleteCacheV2Entry(w http.ResponseWriter, r *http.Request, userID string, quotaBytes int64, req *model.Request) {
	id, err := cachev2.ParseCacheID(strings.TrimSpace(req.CacheID))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "A valid cache ID is required", ErrorCode: "cache_id_invalid"})
		return
	}
	result, err := h.PersonalCache.DeleteByID(userID, id, strings.TrimSpace(req.ExpectedRevision), quotaBytes)
	if err != nil {
		writeCacheV2Error(w, err)
		return
	}
	h.afterCacheV2Mutation(r, userID, "deleteCacheEntry", id.String())
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{"result": result}})
}

func (h *HTTPHandler) handleClearCacheV2Scope(w http.ResponseWriter, r *http.Request, userID string, quotaBytes int64, req *model.Request) {
	scope := strings.ToLower(strings.TrimSpace(req.Scope))
	if scope != "owner" && scope != "workspace" && scope != "shared" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Cache scope must be owner, workspace, or shared", ErrorCode: "cache_scope_invalid"})
		return
	}
	workspaceID := strings.TrimSpace(req.WorkspaceID)
	if scope == "workspace" && workspaceID == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "A workspace ID is required", ErrorCode: "cache_workspace_required"})
		return
	}
	var category cachev2.Category
	if value := strings.ToLower(strings.TrimSpace(req.Category)); value != "" && value != "all" {
		category = cachev2.Category(value)
		if !category.Valid() {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Cache category is invalid", ErrorCode: "cache_category_invalid"})
			return
		}
	}
	inventory, err := h.PersonalCache.Catalog(userID, quotaBytes)
	if err != nil {
		writeCacheV2Error(w, err)
		return
	}
	if strings.TrimSpace(req.ExpectedRevision) == "" || inventory.Revision != strings.TrimSpace(req.ExpectedRevision) {
		writeCacheV2Error(w, personalcache.ErrCatalogRevisionMismatch)
		return
	}
	if inventory.ScanTruncated {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "The cache inventory is incomplete; refresh after the scan limit is increased", ErrorCode: "cache_inventory_truncated"})
		return
	}
	ids := make([]cachev2.CacheID, 0, len(inventory.Entries))
	skipped := 0
	for _, entry := range inventory.Entries {
		if category != "" && entry.Category != category {
			continue
		}
		matches := scope == "owner" || scope == "workspace" && entry.WorkspaceID == workspaceID || scope == "shared" && entry.WorkspaceID == ""
		if !matches {
			continue
		}
		if entry.Writing || entry.ActiveReaders > 0 || entry.Category == cachev2.CategoryDependencies && entry.State == cachev2.EntryStateCurrent {
			skipped++
			continue
		}
		ids = append(ids, entry.ID)
	}
	if len(ids) == 0 {
		if skipped > 0 {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "The selected cache only contains active or current project environments", ErrorCode: "cache_scope_protected"})
			return
		}
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{"result": personalcache.CatalogDeleteResult{Revision: inventory.Revision}, "skipped": 0}})
		return
	}
	result, err := h.PersonalCache.ClearByIDs(userID, ids, inventory.Revision, quotaBytes)
	if err != nil {
		writeCacheV2Error(w, err)
		return
	}
	h.afterCacheV2Mutation(r, userID, "clearCacheScope", scope)
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{"result": result, "skipped": skipped}})
}

func cacheV2EntryPayload(entry cachev2.Entry) map[string]any {
	payload := make(map[string]any)
	data, err := json.Marshal(entry)
	if err == nil {
		_ = json.Unmarshal(data, &payload)
	}
	return payload
}

func findCacheV2Entry(inventory cachev2.Inventory, id cachev2.CacheID) (cachev2.Entry, bool) {
	for _, entry := range inventory.Entries {
		if entry.ID == id {
			return entry, true
		}
	}
	return cachev2.Entry{}, false
}

func (h *HTTPHandler) afterCacheV2Mutation(r *http.Request, userID, action, target string) {
	if h.OnPersonalCacheCleared != nil {
		h.OnPersonalCacheCleared()
	}
	h.diskCache.Set(userID, 0, 1)
	h.auditEvent(r, "", "", action, target, "cache-v2", true)
}

func writeCacheV2Error(w http.ResponseWriter, err error) {
	status, code := http.StatusInternalServerError, "cache_operation_failed"
	switch {
	case errors.Is(err, cachev2.ErrInvalidCacheID):
		status, code = http.StatusBadRequest, "cache_id_invalid"
	case errors.Is(err, personalcache.ErrCacheNotFound):
		status, code = http.StatusNotFound, "cache_entry_not_found"
	case errors.Is(err, personalcache.ErrCatalogRevisionMismatch):
		status, code = http.StatusConflict, "cache_revision_changed"
	case errors.Is(err, personalcache.ErrCurrentCacheProtected):
		status, code = http.StatusConflict, "cache_current_environment_protected"
	case errors.Is(err, personalcache.ErrCacheInUse):
		status, code = http.StatusConflict, "cache_in_use"
	case errors.Is(err, personalcache.ErrPackageInventoryType):
		status, code = http.StatusConflict, "cache_package_inventory_unsupported"
	}
	writeJSON(w, status, model.Response{Success: false, Error: err.Error(), ErrorCode: code})
}
