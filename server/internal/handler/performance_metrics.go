package handler

import (
	"net/http"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/model"
)

func (h *HTTPHandler) handlePerformanceMetrics(w http.ResponseWriter, r *http.Request) {
	if h.requireRole(w, r, auth.RoleLevel(auth.RoleAdmin)) == nil {
		return
	}
	if h.Metrics == nil || !h.Metrics.Enabled() {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Performance metrics are disabled"})
		return
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: h.Metrics.Snapshot()})
}
