package handler

import (
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/enrollment"
	"bobocloud-server/internal/model"
)

func TestTrustedDeviceLoginCannotBypassRemovedAuthorizationWithPassword(t *testing.T) {
	users := auth.NewMemoryUserStore()
	hash, _ := auth.HashPassword("existing-password")
	if err := users.Create(&auth.User{ID: "user", Username: "user", Role: auth.RoleMember, PasswordHash: hash}); err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewMemoryAuthSessionStore()
	mgr, err := enrollment.NewManager(filepath.Join(t.TempDir(), "enroll.json"), enrollment.Descriptor{Host: "cloud.test", CertificateFingerprints: []string{strings.Repeat("A", 64)}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := &HTTPHandler{Config: config.Default(), UserStore: users, AuthSessions: sessions, Enrollment: mgr, authEnabled: true}
	call := func(req *model.Request, secure bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "https://cloud.test/", nil)
		if secure {
			r.TLS = &tls.ConnectionState{}
		} else {
			r.TLS = nil
		}
		w := httptest.NewRecorder()
		if req.Action == "login" {
			h.handleLogin(w, r, req)
		} else {
			h.handleTrustedDeviceAuth(w, r, req)
		}
		return w
	}
	firstSecret := strings.Repeat("a", 64)
	first := call(&model.Request{Action: "login", Identity: "user", Password: "existing-password", DeviceSecret: firstSecret}, true)
	if first.Code != 200 {
		t.Fatalf("existing installation could not migrate: %s", first.Body.String())
	}
	var result struct {
		Token string `json:"token"`
		Data  struct {
			DeviceID string `json:"deviceId"`
		} `json:"data"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Data.DeviceID == "" {
		t.Fatal("login did not issue device authorization")
	}
	sessions.Delete(result.Token)
	if got := call(&model.Request{Action: "resumeDevice", DeviceID: result.Data.DeviceID, DeviceSecret: firstSecret}, false); got.Code != 403 {
		t.Fatal("unencrypted device secret was accepted")
	}
	if got := call(&model.Request{Action: "forgetDevice", DeviceID: result.Data.DeviceID, DeviceSecret: firstSecret}, true); got.Code != 409 || !strings.Contains(got.Body.String(), "accounts.error.lastDevice") {
		t.Fatalf("last device was not protected: %s", got.Body.String())
	}
	secondSession, _ := sessions.CreateForDevice("user", "Other computer", "Linux", time.Hour)
	secondSecret := strings.Repeat("b", 64)
	if _, err := sessions.TrustSession(secondSession.Token, "", secondSecret); err != nil {
		t.Fatal(err)
	}
	if got := call(&model.Request{Action: "forgetDevice", DeviceID: result.Data.DeviceID, DeviceSecret: firstSecret}, true); got.Code != 200 {
		t.Fatal(got.Body.String())
	}
	if got := call(&model.Request{Action: "resumeDevice", DeviceID: result.Data.DeviceID, DeviceSecret: firstSecret}, true); got.Code != 401 {
		t.Fatal("deleted authorization resumed")
	}
	if got := call(&model.Request{Action: "login", Identity: "user", Password: "existing-password"}, true); got.Code != 403 {
		t.Fatal("password bypassed device enrollment")
	}
	if got := call(&model.Request{Action: "login", Identity: "user", Password: "existing-password", DeviceSecret: firstSecret}, true); got.Code != 403 {
		t.Fatal("fresh secret bypassed device enrollment")
	}
	link, _, err := mgr.Create("device", "user", "restricted", "", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Token string `json:"token"`
	}
	rawLink := strings.TrimPrefix(link, "bobocloud://enroll#")
	// A genuine one-use device link restores access after removal.
	raw, err := base64.RawURLEncoding.DecodeString(rawLink)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	got := call(&model.Request{Action: "login", Identity: "user", Password: "existing-password", EnrollmentToken: doc.Token, DeviceSecret: firstSecret}, true)
	if got.Code != 200 {
		t.Fatalf("valid device link failed: %s", got.Body.String())
	}
}
