package handler

import (
	"bobocloud-server/internal/syncsftp"
	"context"
	"errors"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/lifecycle"
)

func TestAuthorizeSyncPersonalAndRevocation(t *testing.T) {
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	users := auth.NewMemoryUserStore()
	alice := &auth.User{ID: "sync-alice", Username: "sync-alice", Role: auth.RoleMember}
	bob := &auth.User{ID: "sync-bob", Username: "sync-bob", Role: auth.RoleMember}
	for _, u := range []*auth.User{alice, bob} {
		if e := users.Create(u); e != nil {
			t.Fatal(e)
		}
	}
	sessions := auth.NewMemoryAuthSessionStore()
	as, e := sessions.Create(alice.ID, cfg.SessionTokenTTL())
	if e != nil {
		t.Fatal(e)
	}
	bs, e := sessions.Create(bob.ID, cfg.SessionTokenTTL())
	if e != nil {
		t.Fatal(e)
	}
	h := &HTTPHandler{Config: cfg, UserStore: users, AuthSessions: sessions, Lifecycle: lifecycle.NewManager()}
	aliceRoot, e := auth.UserDataRoot(cfg.DataDir, alice.ID)
	if e != nil {
		t.Fatal(e)
	}
	bobRoot, e := auth.UserDataRoot(cfg.DataDir, bob.ID)
	if e != nil {
		t.Fatal(e)
	}
	own := filepath.Join(aliceRoot, "workspaces", "proj", "main.go")
	foreign := filepath.Join(bobRoot, "workspaces", "proj", "main.go")
	allow := func(token, p string, want bool) {
		t.Helper()
		a, e := h.AuthorizeSync(context.Background(), token, p, true)
		if e == nil {
			a.Release()
		}
		if (e == nil) != want {
			t.Fatalf("path=%s allowed=%v err=%v", p, want, e)
		}
	}
	allow(as.Token, own, true)
	allow(bs.Token, own, false)
	allow(as.Token, foreign, false)
	allow(as.Token, filepath.Join(aliceRoot, "workspaces", "proj", ".git", "config"), false)
	allow(as.Token, filepath.Join(cfg.DataDir, "db", "bobocloud.db"), false)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if a, e := h.AuthorizeSync(cancelled, as.Token, own, false); e == nil {
		a.Release()
		t.Fatal("cancelled request accepted")
	}
	if _, e = users.MutateExisting(alice.ID, func(u *auth.User) error { u.Disabled = true; return nil }); e != nil {
		t.Fatal(e)
	}
	allow(as.Token, own, false)
	if _, e = users.MutateExisting(alice.ID, func(u *auth.User) error { u.Disabled = false; return nil }); e != nil {
		t.Fatal(e)
	}
	allow(as.Token, own, true)
	sessions.Delete(as.Token)
	allow(as.Token, own, false)
	if _, e := (&HTTPHandler{}).AuthorizeSync(context.Background(), "x", own, false); e == nil {
		t.Fatal("missing config accepted")
	}
}

func TestAuthorizeSyncRevokesOpenedSFTPHandle(t *testing.T) {
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	users := auth.NewMemoryUserStore()
	user := &auth.User{ID: "device-user", Username: "device-user", Role: auth.RoleMember}
	if e := users.Create(user); e != nil {
		t.Fatal(e)
	}
	sessions := auth.NewMemoryAuthSessionStore()
	session, e := sessions.Create(user.ID, cfg.SessionTokenTTL())
	if e != nil {
		t.Fatal(e)
	}
	h := &HTTPHandler{Config: cfg, UserStore: users, AuthSessions: sessions, Lifecycle: lifecycle.NewManager()}
	root, e := auth.UserDataRoot(cfg.DataDir, user.ID)
	if e != nil {
		t.Fatal(e)
	}
	workspace := filepath.Join(root, "workspaces", "proj")
	if e = os.MkdirAll(workspace, 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(workspace, "f.txt"), []byte("abc"), 0600); e != nil {
		t.Fatal(e)
	}
	server, e := syncsftp.New(syncsftp.Config{HostKeyPath: filepath.Join(t.TempDir(), "hostkey"), Authenticate: func(_ context.Context, _, password string) (string, error) {
		if password != session.Token {
			return "", errors.New("bad")
		}
		return password, nil
	}, Authorize: func(ctx context.Context, principal, p string, write bool) (syncsftp.RootAccess, error) {
		if !strings.HasPrefix(p, "/project/") {
			return syncsftp.RootAccess{}, errors.New("bad")
		}
		return h.AuthorizeSync(ctx, principal, filepath.Join(workspace, filepath.FromSlash(strings.TrimPrefix(p, "/project/"))), write)
	}})
	if e != nil {
		t.Fatal(e)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	go server.Serve(listener)
	defer server.Close()
	key, _, _, _, e := ssh.ParseAuthorizedKey([]byte(server.HostKeyPublic()))
	if e != nil {
		t.Fatal(e)
	}
	sshClient, e := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: "bobocloud", Auth: []ssh.AuthMethod{ssh.Password(session.Token)}, HostKeyCallback: ssh.FixedHostKey(key), Timeout: 5 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	defer sshClient.Close()
	client, e := sftp.NewClient(sshClient)
	if e != nil {
		t.Fatal(e)
	}
	defer client.Close()
	file, e := client.Open("/project/f.txt")
	if e != nil {
		t.Fatal(e)
	}
	defer file.Close()
	b := make([]byte, 1)
	if _, e = file.ReadAt(b, 0); e != nil {
		t.Fatal(e)
	}
	if _, e = users.MutateExisting(user.ID, func(u *auth.User) error { u.Disabled = true; return nil }); e != nil {
		t.Fatal(e)
	}
	if _, e = file.ReadAt(b, 0); e == nil {
		t.Fatal("disabled account retained open handle")
	}
	if _, e = users.MutateExisting(user.ID, func(u *auth.User) error { u.Disabled = false; return nil }); e != nil {
		t.Fatal(e)
	}
	if _, e = file.ReadAt(b, 0); e != nil {
		t.Fatal(e)
	}
	sessions.Delete(session.Token)
	if _, e = file.ReadAt(b, 0); e == nil {
		t.Fatal("revoked session retained open handle")
	}
}
