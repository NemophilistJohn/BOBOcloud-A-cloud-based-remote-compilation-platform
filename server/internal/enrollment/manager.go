// Package enrollment manages one-use, typed enrollment links. Tokens are never
// stored in the durable database; the URL is delivered only to its creator.
package enrollment

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Descriptor struct {
	Host                    string   `json:"host"`
	HTTPPort                int      `json:"httpPort"`
	WSPort                  int      `json:"wsPort"`
	DAPChildWSPort          int      `json:"dapChildWsPort"`
	CertificateFingerprints []string `json:"certificateFingerprints"`
}

type Credential struct {
	Mode     string `json:"mode"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
	HostKey  string `json:"hostKey"`
}

type Record struct {
	ID           string    `json:"id"`
	Kind         string    `json:"kind"`
	TargetUserID string    `json:"targetUserId,omitempty"`
	SyncMode     string    `json:"syncMode"`
	Role         string    `json:"role,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	ExpiresAt    time.Time `json:"expiresAt"`
	State        string    `json:"state"`
}

type state struct {
	Records     map[string]Record `json:"records"`
	Modes       map[string]string `json:"modes"`
	RootPending string            `json:"rootPending,omitempty"`
}

type Manager struct {
	mu         sync.Mutex
	path       string
	descriptor Descriptor
	rootSSH    *Credential
	state      state
}

func NewManager(path string, descriptor Descriptor, rootSSH *Credential) (*Manager, error) {
	if path == "" {
		return nil, errors.New("enrollment store path is required")
	}
	m := &Manager{path: path, descriptor: descriptor, rootSSH: rootSSH, state: state{Records: map[string]Record{}, Modes: map[string]string{}}}
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 4<<20 || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
			return nil, errors.New("enrollment store is unsafe")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err == nil {
		if len(data) > 4<<20 {
			return nil, errors.New("enrollment store too large")
		}
		if err = json.Unmarshal(data, &m.state); err != nil {
			return nil, fmt.Errorf("decode enrollment store: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if m.state.Records == nil {
		m.state.Records = map[string]Record{}
	}
	if m.state.Modes == nil {
		m.state.Modes = map[string]string{}
	}
	return m, nil
}

func (m *Manager) RootSSH() *Credential {
	if m == nil || m.rootSSH == nil {
		return nil
	}
	c := *m.rootSSH
	return &c
}

func (m *Manager) Descriptor() Descriptor { return m.descriptor }

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (m *Manager) persist() error {
	if err := os.MkdirAll(filepath.Dir(m.path), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(m.state)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(m.path), ".enrollment-*.tmp")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, m.path)
}

func (m *Manager) Create(kind, targetUserID, syncMode, role string, ttl time.Duration) (string, Record, error) {
	if kind != "root" && kind != "register" && kind != "device" {
		return "", Record{}, errors.New("invalid enrollment kind")
	}
	if (kind == "root" || kind == "device") && targetUserID == "" {
		return "", Record{}, errors.New("target account required")
	}
	if syncMode != "root" && syncMode != "restricted" {
		return "", Record{}, errors.New("invalid sync mode")
	}
	if syncMode == "root" && m.RootSSH() == nil {
		return "", Record{}, errors.New("root SSH credential is not configured")
	}
	if ttl <= 0 || ttl > 7*24*time.Hour {
		return "", Record{}, errors.New("invalid enrollment lifetime")
	}
	if m.descriptor.Host == "" || len(m.descriptor.CertificateFingerprints) == 0 {
		return "", Record{}, errors.New("secure enrollment endpoint is not configured")
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", Record{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	id := tokenHash(token)
	now := time.Now().UTC()
	rec := Record{ID: id, Kind: kind, TargetUserID: targetUserID, SyncMode: syncMode, Role: role, CreatedAt: now, ExpiresAt: now.Add(ttl), State: "available"}
	payload := struct {
		V int `json:"v"`
		Descriptor
		Token string `json:"token"`
		Kind  string `json:"kind"`
	}{1, m.descriptor, token, kind}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", Record{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	previousRoot := m.state.RootPending
	invalidated := make(map[string]Record)
	if kind == "root" {
		m.state.RootPending = targetUserID
		for priorID, prior := range m.state.Records {
			if prior.Kind == "root" && prior.State == "available" {
				invalidated[priorID] = prior
				prior.State = "revoked"
				m.state.Records[priorID] = prior
			}
		}
	}
	m.state.Records[id] = rec
	if err = m.persist(); err != nil {
		delete(m.state.Records, id)
		m.state.RootPending = previousRoot
		for priorID, prior := range invalidated {
			m.state.Records[priorID] = prior
		}
		return "", Record{}, err
	}
	return "bobocloud://enroll#" + base64.RawURLEncoding.EncodeToString(data), rec, nil
}

func (m *Manager) Inspect(token string) (Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.inspectLocked(token)
}

func (m *Manager) inspectLocked(token string) (Record, error) {
	if len(token) != 43 {
		return Record{}, errors.New("invalid or expired enrollment")
	}
	rec, ok := m.state.Records[tokenHash(token)]
	if !ok || rec.State != "available" || !time.Now().Before(rec.ExpiresAt) {
		return Record{}, errors.New("invalid or expired enrollment")
	}
	return rec, nil
}

// Claim reserves durably before callback, keeping a crash fail-closed. The
// callback performs the account/session work; routine failure releases the
// reservation. A reservation survives restart and requires reissuing a link.
func (m *Manager) Claim(token, kind, userID string, fn func(Record) error) (Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.inspectLocked(token)
	if err != nil {
		return Record{}, err
	}
	if rec.Kind != kind || userID == "" || (rec.TargetUserID != "" && rec.TargetUserID != userID) {
		return Record{}, errors.New("enrollment does not match account")
	}
	original := rec
	rec.State = "reserved"
	m.state.Records[rec.ID] = rec
	if err = m.persist(); err != nil {
		m.state.Records[rec.ID] = original
		return Record{}, err
	}
	if err = fn(rec); err != nil {
		m.state.Records[rec.ID] = original
		if persistErr := m.persist(); persistErr != nil {
			m.state.Records[rec.ID] = rec
			return Record{}, persistErr
		}
		return Record{}, err
	}
	rec.State = "used"
	m.state.Records[rec.ID] = rec
	previous, hadPrevious := m.state.Modes[userID]
	previousRoot := m.state.RootPending
	if kind == "root" {
		m.state.RootPending = ""
	}
	if kind != "device" {
		m.state.Modes[userID] = rec.SyncMode
	}
	if err = m.persist(); err != nil {
		rec.State = "reserved"
		m.state.Records[rec.ID] = rec
		if hadPrevious {
			m.state.Modes[userID] = previous
		} else {
			delete(m.state.Modes, userID)
		}
		m.state.RootPending = previousRoot
		return Record{}, err
	}
	return rec, nil
}

func (m *Manager) RootClaimRequired(userID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return userID != "" && m.state.RootPending == userID
}

func (m *Manager) ModeForUser(userID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state.Modes[userID] == "root" {
		return "root"
	}
	return "restricted"
}

func (m *Manager) List() []Record {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Record, 0, len(m.state.Records))
	now := time.Now()
	for _, rec := range m.state.Records {
		if rec.State == "available" && !now.Before(rec.ExpiresAt) {
			rec.State = "expired"
		}
		out = append(out, rec)
	}
	return out
}

func (m *Manager) Revoke(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(id) != 64 || strings.Trim(id, "0123456789abcdef") != "" {
		return errors.New("invalid enrollment id")
	}
	old, ok := m.state.Records[id]
	if !ok {
		return errors.New("enrollment not found")
	}
	if old.State != "available" || !time.Now().Before(old.ExpiresAt) {
		return errors.New("enrollment is no longer available")
	}
	original := old
	old.State = "revoked"
	m.state.Records[id] = old
	if err := m.persist(); err != nil {
		m.state.Records[id] = original
		return err
	}
	return nil
}
