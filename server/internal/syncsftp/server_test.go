package syncsftp

import (
	"bobocloud-server/internal/serverruntime"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

func TestRuntimeDrainsSFTPBeforeWaitingForServe(t *testing.T) {
	s, err := New(Config{HostKeyPath: filepath.Join(t.TempDir(), "host.key"), Authenticate: func(context.Context, string, string) (string, error) { return "test", nil }, Authorize: func(context.Context, string, string, bool) (RootAccess, error) {
		return RootAccess{}, errors.New("denied")
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	rt := serverruntime.New(context.Background())
	if err = rt.RegisterListener("sftp", s); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	if err = rt.Go("sftp-serve", func(context.Context) { close(started); _ = s.Serve(listener) }); err != nil {
		t.Fatal(err)
	}
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err = rt.Shutdown(ctx); err != nil {
		t.Fatalf("SFTP listener blocked managed-worker shutdown: %v", err)
	}
}

func TestHostKeyPublicIsASingleAuthorizedKeyLine(t *testing.T) {
	server, err := New(Config{
		HostKeyPath:  filepath.Join(t.TempDir(), "host.key"),
		Authenticate: func(context.Context, string, string) (string, error) { return "test", nil },
		Authorize: func(context.Context, string, string, bool) (RootAccess, error) {
			return RootAccess{}, errors.New("denied")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	public := server.HostKeyPublic()
	if strings.ContainsAny(public, "\r\n") {
		t.Fatalf("host key contains a line break: %q", public)
	}
	if _, _, _, _, err := ssh.ParseAuthorizedKey([]byte(public)); err != nil {
		t.Fatalf("host key is not a valid authorized key: %v", err)
	}
}

func TestTransportAndRevocation(t *testing.T) {
	root := t.TempDir()
	key := filepath.Join(t.TempDir(), "hostkey")
	var enabled atomic.Bool
	enabled.Store(true)
	var releases atomic.Int64
	cfg := Config{HostKeyPath: key, Authenticate: func(_ context.Context, u, p string) (string, error) {
		if u != "bobocloud" || p != "ticket" {
			return "", errors.New("bad")
		}
		return p, nil
	}, Authorize: func(_ context.Context, user, p string, write bool) (RootAccess, error) {
		if !enabled.Load() || user != "ticket" || !(p == "/workspace" || strings.HasPrefix(p, "/workspace/")) {
			return RootAccess{}, errors.New("denied")
		}
		rel := strings.TrimPrefix(p, "/workspace")
		rel = strings.TrimPrefix(rel, "/")
		if rel == "" {
			rel = "."
		}
		return RootAccess{Root: root, Relative: filepath.FromSlash(rel), Release: func() { releases.Add(1) }}, nil
	}}
	s, e := New(cfg)
	if e != nil {
		t.Fatal(e)
	}
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	go s.Serve(l)
	t.Cleanup(func() { s.Close() })
	c, e := ssh.Dial("tcp", l.Addr().String(), &ssh.ClientConfig{User: "bobocloud", Auth: []ssh.AuthMethod{ssh.Password("ticket")}, HostKeyCallback: ssh.FixedHostKey(s.signer.PublicKey()), Timeout: 5 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	client, e := sftp.NewClient(c)
	if e != nil {
		t.Fatal(e)
	}
	defer client.Close()
	if _, e = client.Stat("/"); e != nil {
		t.Fatalf("virtual root: %v", e)
	}
	if e = client.Mkdir("/workspace/dir"); e != nil {
		t.Fatal(e)
	}
	f, e := client.Create("/workspace/dir/test.txt")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Write([]byte("hello")); e != nil {
		t.Fatal(e)
	}
	if e = f.Close(); e != nil {
		t.Fatal(e)
	}
	when := time.Unix(1700000000, 0)
	if e = client.Chtimes("/workspace/dir/test.txt", when, when); e != nil {
		t.Fatalf("set modification time: %v", e)
	}
	if e = client.Rename("/workspace/dir/test.txt", "/workspace/dir/renamed.txt"); e != nil {
		t.Fatalf("rename: %v", e)
	}
	if e = client.Rename("/workspace/dir/renamed.txt", "/workspace/dir/test.txt"); e != nil {
		t.Fatalf("rename back: %v", e)
	}
	entries, e := client.ReadDir("/workspace/dir")
	if e != nil || len(entries) != 1 {
		t.Fatalf("directory listing: %v %v", entries, e)
	}
	sess, e := c.NewSession()
	if e != nil {
		t.Fatal(e)
	}
	if e = sess.Run("true"); e == nil {
		t.Fatal("shell execution was accepted")
	}
	_ = sess.Close()
	f, e = client.Open("/workspace/dir/test.txt")
	if e != nil {
		t.Fatal(e)
	}
	buf := make([]byte, 5)
	if _, e = io.ReadFull(f, buf); e != nil || string(buf) != "hello" {
		t.Fatalf("read: %q %v", buf, e)
	}
	if _, e = client.Open("/other/private"); e == nil {
		t.Fatal("cross root accepted")
	}
	if _, e = client.Open("/workspace/.git/config"); e == nil {
		t.Fatal("git path accepted")
	}
	if e = os.Symlink(t.TempDir(), filepath.Join(root, "dir", "redirect")); e == nil {
		if _, e = client.ReadDir("/workspace/dir/redirect"); e == nil {
			t.Fatal("symbolic link accepted")
		}
	}
	enabled.Store(false)
	if _, e = f.ReadAt(buf, 0); e == nil {
		t.Fatal("open handle survived revocation")
	}
	f.Close()
	if _, e = client.Stat("/workspace/dir/test.txt"); e == nil {
		t.Fatal("revoked principal accepted")
	}
	if releases.Load() == 0 {
		t.Fatal("leases were not released")
	}
}
func TestStableHostKey(t *testing.T) {
	p := filepath.Join(t.TempDir(), "hostkey")
	a, e := hostKey(p)
	if e != nil {
		t.Fatal(e)
	}
	b, e := hostKey(p)
	if e != nil {
		t.Fatal(e)
	}
	if ssh.FingerprintSHA256(a.PublicKey()) != ssh.FingerprintSHA256(b.PublicKey()) {
		t.Fatal("host key changed")
	}
}

func TestConnectionLimit(t *testing.T) {
	cfg := Config{HostKeyPath: filepath.Join(t.TempDir(), "key"), MaxConnections: 1,
		Authenticate: func(context.Context, string, string) (string, error) { return "ok", nil },
		Authorize:    func(context.Context, string, string, bool) (RootAccess, error) { return RootAccess{}, denied },
	}
	s, e := New(cfg)
	if e != nil {
		t.Fatal(e)
	}
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	go s.Serve(l)
	defer s.Close()
	first, e := net.Dial("tcp", l.Addr().String())
	if e != nil {
		t.Fatal(e)
	}
	defer first.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		n := len(s.conns)
		s.mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first connection not accepted")
		}
		time.Sleep(time.Millisecond)
	}
	second, e := net.Dial("tcp", l.Addr().String())
	if e != nil {
		t.Fatal(e)
	}
	defer second.Close()
	_ = second.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 256)
	if n, readErr := second.Read(buf); readErr == nil || n > 0 {
		t.Fatalf("excess connection was not closed: n=%d err=%v", n, readErr)
	}
}
