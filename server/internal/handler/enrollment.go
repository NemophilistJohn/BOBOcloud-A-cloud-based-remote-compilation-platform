package handler

import (
	"net/http"
	"sort"
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
	requiresPasswordSetup := false
	if record.Kind == "root" {
		user, getErr := h.UserStore.Get(record.TargetUserID)
		requiresPasswordSetup = getErr == nil && user.EffectiveRole() == auth.RoleRoot && user.PasswordHash == ""
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{
		"kind": record.Kind, "syncMode": record.SyncMode, "expiresAt": record.ExpiresAt,
		"targetUserId":          record.TargetUserID,
		"requiresPasswordSetup": requiresPasswordSetup, "version": h.Version,
	}})
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
	case "trustCurrentDevice":
		store := h.trustedStore()
		if session == "" || store == nil {
			writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "accounts.error.authorizationRequired"})
			return
		}
		device, err := store.TrustSession(session, req.DeviceID, req.DeviceSecret)
		if err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{"deviceId": device.ID}})
	case "listDevices":
		if session == "" || h.AuthSessions == nil {
			writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "A user session is required"})
			return
		}
		current, _ := h.AuthSessions.Validate(session, h.Config.SessionTokenTTL())
		if store := h.trustedStore(); store != nil {
			trusted, err := store.ListTrusted(user.ID)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Could not load authorized devices"})
				return
			}
			if len(trusted) > 0 {
				devices := make([]map[string]any, 0, len(trusted))
				for _, d := range trusted {
					devices = append(devices, map[string]any{"id": d.ID, "deviceId": d.ID, "name": d.Name, "platform": d.Platform, "createdAt": d.CreatedAt, "lastSeenAt": d.LastSeenAt, "current": current != nil && current.TrustedDeviceID == d.ID})
				}
				sort.Slice(devices, func(i, j int) bool { return devices[i]["current"] == true && devices[j]["current"] != true })
				writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{"devices": devices}})
				return
			}
		}
		items, err := h.AuthSessions.ListByUser(user.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Could not load authorized devices"})
			return
		}
		sort.Slice(items, func(i, j int) bool {
			if items[i].Token == session {
				return true
			}
			if items[j].Token == session {
				return false
			}
			return items[i].LastSeenAt.After(items[j].LastSeenAt)
		})
		devices := make([]map[string]any, 0, len(items))
		for _, item := range items {
			name := item.DeviceName
			if name == "" {
				name = "BOBOCLOUD desktop"
			}
			devices = append(devices, map[string]any{
				"id": item.ID, "deviceId": item.ID, "name": name,
				"platform": item.DevicePlatform, "createdAt": item.CreatedAt,
				"lastSeenAt": item.LastSeenAt, "expiresAt": item.ExpiresAt,
				"current": item.Token == session,
			})
		}
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{"devices": devices}})
	case "revokeDevice":
		if session == "" || h.AuthSessions == nil {
			writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "A user session is required"})
			return
		}
		if req.DeviceID == "" || len(req.DeviceID) > 128 {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Device ID is required"})
			return
		}
		var revokeErr error
		current, _ := h.AuthSessions.Validate(session, h.Config.SessionTokenTTL())
		if store := h.trustedStore(); store != nil && current != nil && current.TrustedDeviceID != "" {
			revokeErr = store.RevokeTrusted(user.ID, req.DeviceID, current.TrustedDeviceID)
		} else {
			revokeErr = h.AuthSessions.RevokeDevice(user.ID, req.DeviceID, session)
		}
		if revokeErr != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: revokeErr.Error()})
			return
		}
		h.auditEvent(r, user.ID, user.Username, "revokeDevice", req.DeviceID, "", true)
		writeJSON(w, http.StatusOK, model.Response{Success: true})
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
		link, record, err := h.Enrollment.CreateFor(kind, target, mode, role, ttl, user.ID, cleanDeviceLabel(req.Label, 80))
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
