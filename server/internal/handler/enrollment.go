package handler

import (
	"net/http"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/model"
)

func (h *HTTPHandler) enrollmentReady(w http.ResponseWriter, r *http.Request) bool {
	if h.Enrollment == nil || !h.authEnabled {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Enrollment is unavailable"})
		return false
	}
	if r.TLS == nil {
		writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Enrollment requires TLS"})
		return false
	}
	return true
}

func (h *HTTPHandler) handleInspectEnrollment(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.enrollmentReady(w, r) {
		return
	}
	if h.LoginLimiter != nil && !h.LoginLimiter.Allow("enrollment:"+clientIP(r)) {
		writeJSON(w, http.StatusTooManyRequests, model.Response{Success: false, Error: "Too many attempts"})
		return
	}
	record, err := h.Enrollment.Inspect(req.EnrollmentToken)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invalid or expired enrollment"})
		return
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{"kind": record.Kind, "syncMode": record.SyncMode, "expiresAt": record.ExpiresAt, "version": h.Version}})
}

func (h *HTTPHandler) syncCredential(user *auth.User, session string) any {
	if h.SyncCredential == nil || user == nil || session == "" {
		return nil
	}
	return h.SyncCredential(user, session)
}

func (h *HTTPHandler) syncResponse(r *http.Request, user *auth.User, session string) any {
	if r.TLS == nil || h.Enrollment == nil {
		return nil
	}
	credential := h.syncCredential(user, session)
	if credential == nil {
		return nil
	}
	return map[string]any{"syncCredential": credential}
}

func (h *HTTPHandler) handleEnrollment(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.enrollmentReady(w, r) {
		return
	}
	user := auth.UserFromContext(r.Context())
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "Not authenticated"})
		return
	}
	session, _ := r.Context().Value(contextKeySessionToken).(string)
	switch req.Action {
	case "getSyncCredential":
		credential := h.syncCredential(user, session)
		if credential == nil {
			writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "A user session and synchronization credential are required"})
			return
		}
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{"syncCredential": credential}})
	case "createEnrollment", "createDeviceEnrollment":
		kind, target, mode, role := "register", "", req.SyncMode, req.Role
		if req.Action == "createDeviceEnrollment" {
			if session == "" {
				writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "A user session is required"})
				return
			}
			kind, target, mode, role = "device", user.ID, h.Enrollment.ModeForUser(user.ID), ""
		} else {
			if h.requireRole(w, r, auth.RoleLevel(auth.RoleAdmin)) == nil {
				return
			}
			if mode == "" {
				mode = "restricted"
			}
			if role != auth.RoleAdmin {
				role = auth.RoleMember
			}
			if (mode == "root" || role == auth.RoleAdmin) && user.EffectiveRole() != auth.RoleRoot {
				writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Only root may grant this access"})
				return
			}
		}
		ttl := 30 * time.Minute
		if req.ExpiresInHours > 0 && req.ExpiresInHours <= 24 {
			ttl = time.Duration(req.ExpiresInHours) * time.Hour
		}
		link, record, err := h.Enrollment.Create(kind, target, mode, role, ttl)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error()})
			return
		}
		h.auditEvent(r, user.ID, user.Username, "createEnrollment", record.ID, "kind="+kind, true)
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{"link": link, "id": record.ID, "expiresAt": record.ExpiresAt}})
	case "listEnrollments":
		if h.requireRole(w, r, auth.RoleLevel(auth.RoleAdmin)) == nil {
			return
		}
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{"enrollments": h.Enrollment.List()}})
	case "revokeEnrollment":
		if h.requireRole(w, r, auth.RoleLevel(auth.RoleAdmin)) == nil {
			return
		}
		if err := h.Enrollment.Revoke(req.EnrollmentID); err != nil {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error()})
			return
		}
		h.auditEvent(r, user.ID, user.Username, "revokeEnrollment", req.EnrollmentID, "", true)
		writeJSON(w, http.StatusOK, model.Response{Success: true})
	}
}
