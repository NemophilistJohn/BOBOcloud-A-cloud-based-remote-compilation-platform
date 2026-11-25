// Package syncsftp provides an SFTP-only transport whose authorization is owned
// by the cloud server. It never grants shell or SSH forwarding access.
package syncsftp

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"

	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type RootAccess struct {
	Root     string
	Relative string
	Release  func()
}
type Config struct {
	HostKeyPath    string
	Authenticate   func(context.Context, string, string) (string, error)
	Authorize      func(context.Context, string, string, bool) (RootAccess, error)
	MaxConnections int
}
type Server struct {
	cfg       Config
	ssh       *ssh.ServerConfig
	signer    ssh.Signer
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	listeners map[net.Listener]struct{}
	conns     map[net.Conn]struct{}
	wg        sync.WaitGroup
	closed    bool
}

func New(cfg Config) (*Server, error) {
	if cfg.Authenticate == nil || cfg.Authorize == nil || cfg.HostKeyPath == "" {
		return nil, errors.New("SFTP configuration incomplete")
	}
	if cfg.MaxConnections == 0 {
		cfg.MaxConnections = 128
	}
	if cfg.MaxConnections < 1 || cfg.MaxConnections > 4096 {
		return nil, errors.New("invalid SFTP connection limit")
	}
	signer, err := hostKey(cfg.HostKeyPath)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{cfg: cfg, signer: signer, ctx: ctx, cancel: cancel, listeners: make(map[net.Listener]struct{}), conns: make(map[net.Conn]struct{})}
	s.ssh = &ssh.ServerConfig{MaxAuthTries: 3, PasswordCallback: func(conn ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
		user, err := cfg.Authenticate(ctx, conn.User(), string(password))
		if err != nil || user == "" {
			return nil, errors.New("authentication failed")
		}
		return &ssh.Permissions{Extensions: map[string]string{"user": user}}, nil
	}}
	s.ssh.AddHostKey(signer)
	return s, nil
}
func hostKey(path string) (ssh.Signer, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("host key path must be absolute")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		_, priv, e := ed25519.GenerateKey(rand.Reader)
		if e != nil {
			return nil, e
		}
		raw, e := x509.MarshalPKCS8PrivateKey(priv)
		if e != nil {
			return nil, e
		}
		b = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw})
		f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if errors.Is(e, os.ErrExist) {
			b, e = os.ReadFile(path)
		} else if e == nil {
			_, e = f.Write(b)
			if e == nil {
				e = f.Sync()
			}
			if closeErr := f.Close(); e == nil {
				e = closeErr
			}
			if e != nil {
				_ = os.Remove(path)
			}
		}
		if e != nil {
			return nil, e
		}
	} else if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return nil, errors.New("insecure SFTP host key file")
	}
	return ssh.ParsePrivateKey(b)
}
func (s *Server) HostKeyFingerprint() string { return ssh.FingerprintSHA256(s.signer.PublicKey()) }
func (s *Server) HostKeyPublic() string {
	return string(ssh.MarshalAuthorizedKey(s.signer.PublicKey()))
}
func (s *Server) Serve(l net.Listener) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return net.ErrClosed
	}
	s.listeners[l] = struct{}{}
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.listeners, l); s.mu.Unlock() }()
	for {
		c, err := l.Accept()
		if err != nil {
			if s.ctx.Err() != nil {
				return nil
			}
			return err
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			_ = c.Close()
			return nil
		}
		if len(s.conns) >= s.cfg.MaxConnections {
			s.mu.Unlock()
			_ = c.Close()
			continue
		}
		s.conns[c] = struct{}{}
		s.wg.Add(1)
		s.mu.Unlock()
		go s.serveConn(c)
	}
}
func (s *Server) serveConn(raw net.Conn) {
	defer func() { _ = raw.Close(); s.mu.Lock(); delete(s.conns, raw); s.mu.Unlock(); s.wg.Done() }()
	_ = raw.SetDeadline(time.Now().Add(20 * time.Second))
	conn, chans, reqs, err := ssh.NewServerConn(raw, s.ssh)
	if err != nil {
		return
	}
	_ = raw.SetDeadline(time.Time{})
	defer conn.Close()
	go ssh.DiscardRequests(reqs)
	channels := make(chan struct{}, 8)
	for ch := range chans {
		if ch.ChannelType() != "session" {
			_ = ch.Reject(ssh.Prohibited, "SFTP only")
			continue
		}
		select {
		case channels <- struct{}{}:
		default:
			_ = ch.Reject(ssh.ResourceShortage, "too many SFTP channels")
			continue
		}
		channel, requests, err := ch.Accept()
		if err != nil {
			<-channels
			continue
		}
		s.wg.Add(1)
		go func() {
			defer func() { <-channels }()
			defer s.wg.Done()
			defer channel.Close()
			for req := range requests {
				var subsystem struct{ Name string }
				if req.Type != "subsystem" || ssh.Unmarshal(req.Payload, &subsystem) != nil || subsystem.Name != "sftp" {
					_ = req.Reply(false, nil)
					continue
				}
				_ = req.Reply(true, nil)
				h := &handler{s: s, user: conn.Permissions.Extensions["user"]}
				rs := sftp.NewRequestServer(channel, sftp.Handlers{FileGet: h, FilePut: h, FileCmd: h, FileList: h})
				_ = rs.Serve()
				_ = rs.Close()
				return
			}
		}()
	}
}
func (s *Server) Close() error {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		s.cancel()
		for l := range s.listeners {
			_ = l.Close()
		}
		for c := range s.conns {
			_ = c.Close()
		}
	}
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}
