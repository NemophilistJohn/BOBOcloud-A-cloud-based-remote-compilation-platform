package handler

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"net/http"
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

func TestRootEnrollmentRequiresPasswordAndIsOneUse(t *testing.T) {
	password, err := auth.HashPassword("secure-password")
	if err != nil {
		t.Fatal(err)
	}
	users := auth.NewMemoryUserStore()
	if err = users.Create(&auth.User{ID: "root", Username: "root", Role: auth.RoleRoot, PasswordHash: password}); err != nil {
		t.Fatal(err)
	}
	m, err := enrollment.NewManager(filepath.Join(t.TempDir(), "state.json"), enrollment.Descriptor{Host: "example.test", CertificateFingerprints: []string{strings.Repeat("A", 64)}}, &enrollment.Credential{User: "root", Password: "linux-secret"})
	if err != nil {
		t.Fatal(err)
	}
	link, _, err := m.Create("root", "root", "root", "root", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(link, "bobocloud://enroll#"))
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err = json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	cleanups := 0
	h := &HTTPHandler{Config: config.Default(), UserStore: users, AuthSessions: auth.NewMemoryAuthSessionStore(), authEnabled: true, Enrollment: m,
		SyncCredential: func(_ *auth.User, _ string) map[string]any { return map[string]any{"password": "linux-secret"} }, OnRootEnrollmentClaimed: func() error { cleanups++; return nil }}
	login := func(pass, token string, secure bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "https://example.test/", nil)
		if secure {
			r.TLS = &tls.ConnectionState{}
		} else {
			r.TLS = nil
		}
		w := httptest.NewRecorder()
		h.handleLogin(w, r, &model.Request{Identity: "root", Password: pass, EnrollmentToken: token})
		return w
	}
	if got := login("secure-password", "", true); got.Code != 403 {
		t.Fatalf("unclaimed login: %d", got.Code)
	}
	if got := login("wrong", payload.Token, true); got.Code != 401 {
		t.Fatalf("wrong password: %d", got.Code)
	}
	if got := login("secure-password", payload.Token, false); got.Code != 403 {
		t.Fatalf("cleartext claim: %d", got.Code)
	}
	got := login("secure-password", payload.Token, true)
	if got.Code != 200 {
		t.Fatalf("claim: %d %s", got.Code, got.Body.String())
	}
	if !strings.Contains(got.Body.String(), "linux-secret") || cleanups != 1 {
		t.Fatal("claim did not issue credentials and clean up")
	}
	if got = login("secure-password", payload.Token, true); got.Code == 200 {
		t.Fatal("replayed root link accepted")
	}
	if got = login("secure-password", "", true); got.Code != 200 {
		t.Fatalf("normal login: %d", got.Code)
	}
}

func TestFirstRootEnrollmentSetsPasswordWithoutLinkSecret(t *testing.T) {
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root", Username: "root", Role: auth.RoleRoot}
	if err := users.Create(root); err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewMemoryAuthSessionStore()
	m, err := enrollment.NewManager(filepath.Join(t.TempDir(), "state.json"), enrollment.Descriptor{
		Host: "example.test", CertificateFingerprints: []string{strings.Repeat("A", 64)},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	link, _, err := m.Create("root", root.ID, "restricted", auth.RoleRoot, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Token string `json:"token"`
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(link, "bobocloud://enroll#"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	h := &HTTPHandler{Config: config.Default(), UserStore: users, AuthSessions: sessions,
		authEnabled: true, Enrollment: m, OnRootEnrollmentClaimed: func() error { return nil }}
	r := httptest.NewRequest("POST", "https://example.test/", nil)
	r.TLS = &tls.ConnectionState{}
	w := httptest.NewRecorder()
	h.handleLogin(w, r, &model.Request{Password: "new-admin-password", EnrollmentToken: payload.Token,
		DeviceName: "BOBOCLOUD desktop", DevicePlatform: "windows"})
	if w.Code != http.StatusOK {
		t.Fatalf("first admin claim status=%d body=%s", w.Code, w.Body.String())
	}
	stored, err := users.Get(root.ID)
	if err != nil || !auth.CheckPassword(stored.PasswordHash, "new-admin-password") {
		t.Fatalf("new admin password was not saved: err=%v", err)
	}
	var response model.Response
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.Validate(response.Token, config.Default().SessionTokenTTL()); err != nil {
		t.Fatalf("claim did not issue a usable session: %v", err)
	}
	if _, err := m.Inspect(payload.Token); err == nil {
		t.Fatal("claimed administrator link remained valid")
	}
}

func TestDeviceSessionListAndRevocation(t *testing.T) {
	cfg := config.Default()
	users := auth.NewMemoryUserStore()
	user := &auth.User{ID: "member", Username: "member", Role: auth.RoleMember}
	if err := users.Create(user); err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewMemoryAuthSessionStore()
	current, err := sessions.CreateForDevice(user.ID, "BOBOCLOUD desktop", "windows", cfg.SessionTokenTTL())
	if err != nil {
		t.Fatal(err)
	}
	old, err := sessions.CreateForDevice(user.ID, "BOBOCLOUD desktop", "linux", cfg.SessionTokenTTL())
	if err != nil {
		t.Fatal(err)
	}
	m, err := enrollment.NewManager(filepath.Join(t.TempDir(), "state.json"), enrollment.Descriptor{
		Host: "example.test", CertificateFingerprints: []string{strings.Repeat("A", 64)},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := &HTTPHandler{Config: cfg, UserStore: users, AuthSessions: sessions, authEnabled: true, Enrollment: m}
	request := func(action, deviceID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "https://example.test/", nil)
		r.TLS = &tls.ConnectionState{}
		ctx := context.WithValue(r.Context(), auth.ContextUser, user)
		ctx = context.WithValue(ctx, contextKeySessionToken, current.Token)
		r = r.WithContext(ctx)
		w := httptest.NewRecorder()
		h.handleEnrollment(w, r, &model.Request{Action: action, DeviceID: deviceID})
		return w
	}
	list := request("listDevices", "")
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), current.ID) || !strings.Contains(list.Body.String(), old.ID) {
		t.Fatalf("device listing status=%d body=%s", list.Code, list.Body.String())
	}
	if strings.Contains(list.Body.String(), current.Token) || strings.Contains(list.Body.String(), old.Token) {
		t.Fatal("device listing exposed an authentication token")
	}
	if got := request("revokeDevice", current.ID); got.Code != http.StatusConflict {
		t.Fatalf("current device revoke status=%d body=%s", got.Code, got.Body.String())
	}
	if got := request("revokeDevice", old.ID); got.Code != http.StatusOK {
		t.Fatalf("old device revoke status=%d body=%s", got.Code, got.Body.String())
	}
	if _, err := sessions.Validate(old.Token, cfg.SessionTokenTTL()); err == nil {
		t.Fatal("revoked device session remained valid")
	}
	if _, err := sessions.Validate(current.Token, cfg.SessionTokenTTL()); err != nil {
		t.Fatalf("current device session was revoked: %v", err)
	}
}

func TestUnclaimedRootApiKeyCannotBypassAdministratorClaim(t *testing.T) {
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root", Username: "root", Role: auth.RoleRoot, APIKey: "root-api-key"}
	if err := users.Create(root); err != nil {
		t.Fatal(err)
	}
	m, err := enrollment.NewManager(filepath.Join(t.TempDir(), "state.json"), enrollment.Descriptor{
		Host: "example.test", CertificateFingerprints: []string{strings.Repeat("A", 64)},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.Create("root", root.ID, "restricted", auth.RoleRoot, time.Minute); err != nil {
		t.Fatal(err)
	}
	h := &HTTPHandler{UserStore: users, Enrollment: m, authenticator: auth.NewAPIKeyAuth(users)}
	r := httptest.NewRequest("POST", "https://example.test/", nil)
	r.Header.Set("Authorization", "Bearer "+root.APIKey)
	if _, _, err := h.authenticate(r); err == nil || !strings.Contains(err.Error(), "enrollment") {
		t.Fatalf("unclaimed root API key was accepted: %v", err)
	}
}
