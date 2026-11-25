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
