package handler

import (
	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/model"
	"errors"
	"net/http"
)

func (h *HTTPHandler) trustedStore() auth.TrustedSessionStore {
	store, _ := h.AuthSessions.(auth.TrustedSessionStore)
	return store
}

func (h *HTTPHandler) sessionResponseData(r *http.Request, user *auth.User, sess *auth.AuthSession) map[string]any {
	data := map[string]any{}
	if sync := h.syncCredential(user, sess.Token); r.TLS != nil && h.Enrollment != nil && sync != nil {
		data["syncCredential"] = sync
	}
	if sess.TrustedDeviceID != "" {
		data["deviceId"] = sess.TrustedDeviceID
	}
	return data
}

func (h *HTTPHandler) handleTrustedDeviceAuth(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.enrollmentReady(w, r) {
		return
	}
	store := h.trustedStore()
	if store == nil || req.DeviceID == "" || len(req.DeviceID) > 128 || len(req.DeviceSecret) != 64 {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "accounts.error.authorizationRequired"})
		return
	}
	if h.LoginLimiter != nil && !h.LoginLimiter.Allow("device:"+clientIP(r)) {
		writeJSON(w, http.StatusTooManyRequests, model.Response{Success: false, Error: "accounts.error.rateLimited"})
		return
	}
	if req.Action == "forgetDevice" {
		userID, err := store.ForgetTrusted(req.DeviceID, req.DeviceSecret)
		if err != nil {
			status := http.StatusUnauthorized
			if errors.Is(err, auth.ErrLastDevice) {
				status = http.StatusConflict
			}
			writeJSON(w, status, model.Response{Success: false, Error: err.Error()})
			return
		}
		h.auditEvent(r, userID, "", "forgetDevice", req.DeviceID, "", true)
		writeJSON(w, http.StatusOK, model.Response{Success: true})
		return
	}
	sess, err := store.ResumeTrusted(req.DeviceID, req.DeviceSecret, h.Config.SessionTokenTTL())
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "accounts.error.authorizationRequired"})
		return
	}
	user, err := h.UserStore.Get(sess.UserID)
	if err != nil || user.Disabled || (h.Enrollment != nil && h.Enrollment.RootClaimRequired(sess.UserID)) {
		_ = h.AuthSessions.Delete(sess.Token)
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "accounts.error.unavailable"})
		return
	}
	h.auditEvent(r, user.ID, user.Username, "resumeDevice", sess.TrustedDeviceID, "", true)
	writeJSON(w, http.StatusOK, model.Response{Success: true, Token: sess.Token, ExpiresAt: &sess.ExpiresAt, User: sanitizeUser(user), Data: h.sessionResponseData(r, user, sess)})
}
