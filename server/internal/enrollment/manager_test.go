package enrollment

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newTestManager(t *testing.T) (*Manager, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.json")
	m, err := NewManager(path, Descriptor{Host: "example.test", HTTPPort: 3100, WSPort: 3101, DAPChildWSPort: 3102, CertificateFingerprints: []string{strings.Repeat("A", 64)}}, &Credential{User: "root", Password: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	return m, path
}

func tokenFromLink(t *testing.T, link string) string {
	t.Helper()
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(link, "bobocloud://enroll#"))
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err = json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Token
}

func TestClaimIsSingleUseAcrossConcurrentRequestsAndRestart(t *testing.T) {
	m, path := newTestManager(t)
	link, _, err := m.Create("device", "u1", "restricted", "", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := tokenFromLink(t, link)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), token) || strings.Contains(string(data), "secret") {
		t.Fatal("store contains token or SSH secret")
	}
	var successes atomic.Int32
	var calls atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := m.Claim(token, "device", "u1", func(Record) error { calls.Add(1); return nil })
			if err == nil {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 || calls.Load() != 1 {
		t.Fatalf("successes=%d callbacks=%d", successes.Load(), calls.Load())
	}
	restarted, err := NewManager(path, m.Descriptor(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = restarted.Inspect(token); err == nil {
		t.Fatal("used token accepted after restart")
	}
}

func TestClaimRejectsWrongAccountAndKindAndRollsBackRoutineFailure(t *testing.T) {
	m, _ := newTestManager(t)
	link, _, err := m.Create("device", "u1", "restricted", "", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := tokenFromLink(t, link)
	callback := func(Record) error { t.Fatal("unexpected callback"); return nil }
	if _, err = m.Claim(token, "root", "u1", callback); err == nil {
		t.Fatal("wrong kind accepted")
	}
	if _, err = m.Claim(token, "device", "u2", callback); err == nil {
		t.Fatal("wrong account accepted")
	}
	if _, err = m.Claim(token, "device", "u1", func(Record) error { return os.ErrPermission }); err == nil {
		t.Fatal("callback failure accepted")
	}
	if _, err = m.Inspect(token); err != nil {
		t.Fatalf("failed claim consumed token: %v", err)
	}
}

func TestRootClaimAndModeSurviveRestart(t *testing.T) {
	m, path := newTestManager(t)
	link, _, err := m.Create("root", "root-id", "root", "root", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !m.RootClaimRequired("root-id") {
		t.Fatal("root claim not required")
	}
	if _, err = m.Claim(tokenFromLink(t, link), "root", "root-id", func(Record) error { return nil }); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewManager(path, m.Descriptor(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if restarted.RootClaimRequired("root-id") || restarted.ModeForUser("root-id") != "root" {
		t.Fatal("root claim did not persist")
	}
}
