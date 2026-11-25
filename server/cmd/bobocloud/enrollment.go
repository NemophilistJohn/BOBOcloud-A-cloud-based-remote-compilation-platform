package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/enrollment"
	"bobocloud-server/internal/handler"
	"bobocloud-server/internal/serverruntime"
	"bobocloud-server/internal/syncsftp"
)

// Automatic TLS applies to a previously plaintext standalone installation.
// Existing configured certificates/keys are never replaced.
func prepareEnrollmentTLS(cfg *config.Config) error {
	if cfg.TLSEnabled {
		return nil
	}
	host := cfg.PublicHost
	if host == "" {
		host, _ = os.Hostname()
		cfg.PublicHost = host
	}
	dir := filepath.Join(cfg.DataDir, "tls")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	certPath, keyPath := filepath.Join(dir, "server.crt"), filepath.Join(dir, "server.key")
	_, certErr := os.Stat(certPath)
	_, keyErr := os.Stat(keyPath)
	if errors.Is(certErr, os.ErrNotExist) && errors.Is(keyErr, os.ErrNotExist) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return err
		}
		serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
		if err != nil {
			return err
		}
		cert := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: host}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(3, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		if ip := net.ParseIP(host); ip != nil {
			cert.IPAddresses = []net.IP{ip}
		} else {
			cert.DNSNames = []string{host}
		}
		raw, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
		if err != nil {
			return err
		}
		private, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return err
		}
		if err = writePrivateNew(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private})); err != nil {
			return err
		}
		if err = writePrivateNew(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw})); err != nil {
			return err
		}
	} else if certErr != nil || keyErr != nil {
		return errors.New("incomplete TLS bootstrap; refusing to replace existing key material")
	}
	cfg.TLSEnabled = true
	cfg.TLSRequired = true
	cfg.TLSCertFile = certPath
	cfg.TLSKeyFile = keyPath
	return nil
}

func writePrivateNew(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func loadRootSSH(path string) (*enrollment.Credential, error) {
	if path == "" {
		return nil, nil
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 16384 || (runtime.GOOS != "windows" && info.Mode().Perm()&0007 != 0) {
		return nil, errors.New("unsafe root SSH credential file")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c enrollment.Credential
	if err = json.Unmarshal(raw, &c); err != nil {
		return nil, errors.New("invalid root SSH credential file")
	}
	if c.User != "root" || c.Password == "" || c.HostKey == "" || c.Port < 1 || c.Port > 65535 {
		return nil, errors.New("incomplete root SSH credential")
	}
	key, _, options, rest, parseErr := ssh.ParseAuthorizedKey([]byte(c.HostKey))
	if parseErr != nil || len(options) != 0 || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, errors.New("invalid root SSH host key")
	}
	c.HostKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
	c.Mode = "root"
	return &c, nil
}

func configureEnrollment(cfg *config.Config, h *handler.HTTPHandler, store auth.UserStore, sessions auth.AuthSessionStore, rt *serverruntime.Runtime, execDir string) (*syncsftp.Server, error) {
	certBytes, err := os.ReadFile(cfg.TLSCertFile)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(certBytes)
	if block == nil {
		return nil, errors.New("invalid TLS certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, err
	}
	pin := sha256.Sum256(cert.Raw)
	host := cfg.PublicHost
	if host == "" {
		if len(cert.DNSNames) > 0 {
			host = cert.DNSNames[0]
		} else if len(cert.IPAddresses) > 0 {
			host = cert.IPAddresses[0].String()
		}
	}
	if host == "" {
		return nil, errors.New("public_host required for enrollment")
	}
	if strings.ContainsAny(host, "/\\?#@ \r\n") {
		return nil, errors.New("public_host must be a hostname or IP")
	}
	if cfg.SyncSFTPPort < 1 || cfg.SyncSFTPPort > 65535 {
		return nil, errors.New("invalid sync_sftp_port")
	}
	rootSSH, err := loadRootSSH(cfg.RootSSHCredentialFile)
	if err != nil {
		return nil, err
	}
	if rootSSH != nil && rootSSH.Host != host {
		return nil, errors.New("root SSH host must match public_host")
	}
	statePath := filepath.Join(cfg.DataDir, "enrollment", "state.json")
	_, stateErr := os.Lstat(statePath)
	if stateErr != nil && !errors.Is(stateErr, os.ErrNotExist) {
		return nil, stateErr
	}
	firstEnrollmentStartup := errors.Is(stateErr, os.ErrNotExist)
	descriptor := enrollment.Descriptor{Host: host, HTTPPort: cfg.HTTPPort, WSPort: cfg.WSPort, DAPChildWSPort: cfg.DAPChildWSPort, CertificateFingerprints: []string{strings.ToUpper(hex.EncodeToString(pin[:]))}}
	mgr, err := enrollment.NewManager(statePath, descriptor, rootSSH)
	if err != nil {
		return nil, err
	}
	h.Enrollment = mgr
	sftpServer, err := syncsftp.New(syncsftp.Config{HostKeyPath: filepath.Join(cfg.DataDir, "enrollment", "sftp-host.key"), Authenticate: func(ctx context.Context, user, password string) (string, error) {
		if user != "bobocloud" {
			return "", errors.New("invalid sync identity")
		}
		session, err := sessions.Validate(password, cfg.SessionTokenTTL())
		if err != nil {
			return "", err
		}
		account, err := store.Get(session.UserID)
		if err != nil || account.Disabled {
			return "", errors.New("account disabled")
		}
		return password, nil
	}, Authorize: h.AuthorizeSync})
	if err != nil {
		return nil, err
	}
	h.SyncCredential = func(user *auth.User, token string) map[string]any {
		if mgr.ModeForUser(user.ID) == "root" && rootSSH != nil {
			return map[string]any{"mode": "root", "host": rootSSH.Host, "port": rootSSH.Port, "user": rootSSH.User, "password": rootSSH.Password, "hostKey": rootSSH.HostKey}
		}
		return map[string]any{"mode": "restricted", "host": host, "port": cfg.SyncSFTPPort, "user": "bobocloud", "password": token, "hostKey": sftpServer.HostKeyPublic()}
	}
	output := cfg.EnrollmentFile
	if output == "" {
		output = filepath.Join(execDir, "admin-claim.link")
	}
	h.OnRootEnrollmentClaimed = func() error {
		if err := os.Remove(output); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	users, err := store.List()
	if err != nil {
		return nil, err
	}
	var root *auth.User
	for _, u := range users {
		if u.EffectiveRole() == auth.RoleRoot {
			if root != nil {
				return nil, errors.New("multiple root accounts")
			}
			root = u
		}
	}
	if root == nil {
		return nil, errors.New("root account is unavailable")
	}
	if firstEnrollmentStartup || mgr.RootClaimRequired(root.ID) {
		if err := ensureRootClaimFile(mgr, descriptor, root.ID, output, rootSSH != nil); err != nil {
			_ = sftpServer.Close()
			return nil, err
		}
	}
	if err := rt.RegisterStopHook(serverruntime.PhaseServices, "sync-sftp", func(context.Context) error { return sftpServer.Close() }); err != nil {
		_ = sftpServer.Close()
		return nil, err
	}
	return sftpServer, nil
}

// The file is a privileged bearer credential. Reissue stale or missing links
// only while root is unclaimed; never resurrect a claimed administrator.
func ensureRootClaimFile(mgr *enrollment.Manager, descriptor enrollment.Descriptor, rootID, output string, rootSSH bool) error {
	info, err := os.Lstat(output)
	if err == nil {
		if !info.Mode().IsRegular() || info.Size() > 16384 || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
			return errors.New("unsafe root claim file")
		}
		data, readErr := os.ReadFile(output)
		if readErr != nil {
			return readErr
		}
		mode := "restricted"
		if rootSSH {
			mode = "root"
		}
		if validRootClaimLink(mgr, descriptor, rootID, mode, strings.TrimSpace(string(data))) {
			return nil
		}
		if err = os.Remove(output); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	mode := "restricted"
	if rootSSH {
		mode = "root"
	}
	link, _, err := mgr.Create("root", rootID, mode, auth.RoleRoot, 24*time.Hour)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(output), 0700); err != nil {
		return err
	}
	return writePrivateNew(output, []byte(link+"\n"))
}

func validRootClaimLink(mgr *enrollment.Manager, expected enrollment.Descriptor, rootID, mode, link string) bool {
	u, err := url.Parse(link)
	if err != nil || u.Scheme != "bobocloud" || u.Host != "enroll" {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(u.Fragment)
	if err != nil {
		return false
	}
	var payload struct {
		V int `json:"v"`
		enrollment.Descriptor
		Token string `json:"token"`
		Kind  string `json:"kind"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.V != 1 || payload.Kind != "root" || payload.Host != expected.Host || payload.HTTPPort != expected.HTTPPort || payload.WSPort != expected.WSPort || payload.DAPChildWSPort != expected.DAPChildWSPort || len(payload.CertificateFingerprints) != 1 || payload.CertificateFingerprints[0] != expected.CertificateFingerprints[0] {
		return false
	}
	record, err := mgr.Inspect(payload.Token)
	return err == nil && record.Kind == "root" && record.TargetUserID == rootID && record.SyncMode == mode
}
