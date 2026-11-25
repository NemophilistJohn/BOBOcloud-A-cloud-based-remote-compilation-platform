package main

import (
	"bobocloud-server/internal/enrollment"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/handler"
	"bobocloud-server/internal/serverruntime"
)

func testRootSSHKey(t *testing.T) string {
	t.Helper()
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
}

func TestPrepareEnrollmentTLSCreatesAndPreservesIdentity(t *testing.T) {
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	cfg.PublicHost = "127.0.0.1"
	if e := prepareEnrollmentTLS(cfg); e != nil {
		t.Fatal(e)
	}
	cert, e := os.ReadFile(cfg.TLSCertFile)
	if e != nil {
		t.Fatal(e)
	}
	key, e := os.ReadFile(cfg.TLSKeyFile)
	if e != nil {
		t.Fatal(e)
	}
	pair, e := tls.X509KeyPair(cert, key)
	if e != nil {
		t.Fatal(e)
	}
	parsed, e := x509.ParseCertificate(pair.Certificate[0])
	if e != nil {
		t.Fatal(e)
	}
	if e = parsed.VerifyHostname(cfg.PublicHost); e != nil {
		t.Fatal(e)
	}
	next := config.Default()
	next.DataDir = cfg.DataDir
	next.PublicHost = cfg.PublicHost
	if e = prepareEnrollmentTLS(next); e != nil {
		t.Fatal(e)
	}
	cert2, _ := os.ReadFile(next.TLSCertFile)
	key2, _ := os.ReadFile(next.TLSKeyFile)
	if string(cert) != string(cert2) || string(key) != string(key2) {
		t.Fatal("existing identity replaced")
	}
}
func TestPrepareEnrollmentTLSRejectsPartialState(t *testing.T) {
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	cfg.PublicHost = "127.0.0.1"
	dir := filepath.Join(cfg.DataDir, "tls")
	if e := os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	p := filepath.Join(dir, "server.key")
	if e := os.WriteFile(p, []byte("do not replace"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := prepareEnrollmentTLS(cfg); e == nil {
		t.Fatal("partial identity accepted")
	}
	b, e := os.ReadFile(p)
	if e != nil || string(b) != "do not replace" {
		t.Fatalf("partial identity changed: %v", e)
	}
}
func TestLoadRootSSHFileSafety(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "root.json")
	body := `{"user":"root","password":"sensitive-password","host":"127.0.0.1","port":22,"hostKey":"` + testRootSSHKey(t) + `"}`
	if e := os.WriteFile(p, []byte(body), 0600); e != nil {
		t.Fatal(e)
	}
	c, e := loadRootSSH(p)
	if e != nil || c.Mode != "root" {
		t.Fatalf("credential: %v", e)
	}
	if runtime.GOOS != "windows" {
		if e = os.Chmod(p, 0604); e != nil {
			t.Fatal(e)
		}
		if _, e = loadRootSSH(p); e == nil {
			t.Fatal("world-readable credential accepted")
		}
		if e = os.Chmod(p, 0600); e != nil {
			t.Fatal(e)
		}
	}
	link := filepath.Join(dir, "link")
	if e = os.Symlink(p, link); e == nil {
		if _, e = loadRootSSH(link); e == nil {
			t.Fatal("symlink accepted")
		}
	}
	if e = os.WriteFile(p, []byte(`{"user":"root","password":"sensitive-password","host":"127.0.0.1","port":22,"hostKey":"not-a-key"}`), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = loadRootSSH(p); e == nil {
		t.Fatal("invalid SSH host key accepted")
	}
}
func TestConfigureEnrollmentFirstUpgradeClaimAndNoResurrection(t *testing.T) {
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	cfg.PublicHost = "127.0.0.1"
	cfg.EnrollmentFile = filepath.Join(cfg.DataDir, "claim.link")
	if e := prepareEnrollmentTLS(cfg); e != nil {
		t.Fatal(e)
	}
	cred := filepath.Join(cfg.DataDir, "root-ssh.json")
	if e := os.WriteFile(cred, []byte(`{"user":"root","password":"linux-secret","host":"127.0.0.1","port":22,"hostKey":"`+testRootSSHKey(t)+`"}`), 0600); e != nil {
		t.Fatal(e)
	}
	cfg.RootSSHCredentialFile = cred
	users := auth.NewMemoryUserStore()
	passwordHash, e := auth.HashPassword("existing-password")
	if e != nil {
		t.Fatal(e)
	}
	root := &auth.User{ID: "root-existing", Username: "root-existing", Role: auth.RoleRoot, PasswordHash: passwordHash}
	if e = users.Create(root); e != nil {
		t.Fatal(e)
	}
	sessions := auth.NewMemoryAuthSessionStore()
	start := func() (*handler.HTTPHandler, func()) {
		t.Helper()
		h := &handler.HTTPHandler{Config: cfg, UserStore: users, AuthSessions: sessions}
		s, e := configureEnrollment(cfg, h, users, sessions, serverruntime.New(context.Background()), cfg.DataDir)
		if e != nil {
			t.Fatal(e)
		}
		return h, func() { s.Close() }
	}
	h, stop := start()
	data, e := os.ReadFile(cfg.EnrollmentFile)
	if e != nil {
		t.Fatal(e)
	}
	if !h.Enrollment.RootClaimRequired(root.ID) {
		t.Fatal("root not pending")
	}
	link := strings.TrimSpace(string(data))
	u, e := url.Parse(link)
	if e != nil {
		t.Fatal(e)
	}
	payload, e := base64.RawURLEncoding.DecodeString(u.Fragment)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(payload), "linux-secret") || strings.Contains(string(payload), "existing-password") {
		t.Fatal("link leaked password")
	}
	var doc struct {
		Token string `json:"token"`
	}
	if e = json.Unmarshal(payload, &doc); e != nil {
		t.Fatal(e)
	}
	info, e := os.Stat(cfg.EnrollmentFile)
	if e != nil {
		t.Fatal(e)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		t.Fatal("claim file permissions too broad")
	}
	before, _ := users.Get(root.ID)
	if !auth.CheckPassword(before.PasswordHash, "existing-password") {
		t.Fatal("existing password changed")
	}
	stop()
	h, stop = start()
	same, e := os.ReadFile(cfg.EnrollmentFile)
	if e != nil || string(same) != string(data) {
		t.Fatal("valid claim regenerated")
	}
	stop()
	statePath := filepath.Join(cfg.DataDir, "enrollment", "state.json")
	stateBytes, e := os.ReadFile(statePath)
	if e != nil {
		t.Fatal(e)
	}
	var saved struct {
		Records     map[string]enrollment.Record `json:"records"`
		Modes       map[string]string            `json:"modes"`
		RootPending string                       `json:"rootPending"`
	}
	if e = json.Unmarshal(stateBytes, &saved); e != nil {
		t.Fatal(e)
	}
	for id, record := range saved.Records {
		if record.Kind == "root" && record.State == "available" {
			record.ExpiresAt = time.Now().Add(-time.Hour)
			saved.Records[id] = record
		}
	}
	stateBytes, e = json.Marshal(saved)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(statePath, stateBytes, 0600); e != nil {
		t.Fatal(e)
	}
	h, stop = start()
	expiredReplacement, e := os.ReadFile(cfg.EnrollmentFile)
	if e != nil || string(expiredReplacement) == string(data) {
		t.Fatal("expired claim was not rotated")
	}
	stop()
	if e = os.WriteFile(cfg.EnrollmentFile, []byte("stale"), 0600); e != nil {
		t.Fatal(e)
	}
	h, stop = start()
	fresh, e := os.ReadFile(cfg.EnrollmentFile)
	if e != nil || string(fresh) == "stale" {
		t.Fatal("stale claim not rotated")
	}
	parsed, e := url.Parse(strings.TrimSpace(string(fresh)))
	if e != nil {
		t.Fatal(e)
	}
	decoded, e := base64.RawURLEncoding.DecodeString(parsed.Fragment)
	if e != nil {
		t.Fatal(e)
	}
	if e = json.Unmarshal(decoded, &doc); e != nil {
		t.Fatal(e)
	}
	if _, e = h.Enrollment.Claim(doc.Token, "root", root.ID, func(_ enrollment.Record) error { return nil }); e != nil {
		t.Fatal(e)
	}
	if e = h.OnRootEnrollmentClaimed(); e != nil {
		t.Fatal(e)
	}
	stop()
	h, stop = start()
	defer stop()
	if h.Enrollment.RootClaimRequired(root.ID) {
		t.Fatal("used claim reopened")
	}
	if _, e = os.Stat(cfg.EnrollmentFile); !os.IsNotExist(e) {
		t.Fatalf("claim file regenerated: %v", e)
	}

}
