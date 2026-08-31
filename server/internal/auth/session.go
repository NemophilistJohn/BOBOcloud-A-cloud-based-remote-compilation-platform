package auth

import (
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// ============================================================
// session.go — 登录会话 token（短期凭证）接口 + 内存实现
//   与 API Key（长期编程凭证）互补：
//   - 登录 UI 使用 session token，带过期时间，可一键作废
//   - rclone / CI 等使用 API Key，长期有效
// ============================================================

// AuthSession 是一条已签发的登录会话
type AuthSession struct {
	Token     string    `json:"token"`
	UserID    string    `json:"user_id"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

// AuthSessionStore 会话 token 存储接口
type AuthSessionStore interface {
	// Create 为用户签发新 token（ttl 为有效期）
	Create(userID string, ttl time.Duration) (*AuthSession, error)
	// Validate 校验 token：过期/不存在返回 error；
	// 剩余有效期不足一半时滑动续期到完整 ttl（活跃用户不会掉线）
	Validate(token string, ttl time.Duration) (*AuthSession, error)
	// Delete 作废单个 token（登出）
	Delete(token string) error
	// DeleteByUser 作废某用户的全部 token（禁用/删除时强制下线）
	DeleteByUser(userID string) error
	// DeleteByUserExcept 作废某用户除 keepToken 外的全部 token（改密后其它设备下线）
	DeleteByUserExcept(userID, keepToken string) error
	// CleanupExpired 清理过期 token
	CleanupExpired()
}

// GenerateSessionToken 生成 session token（带前缀便于识别）
func GenerateSessionToken() (string, error) {
	b, err := randomBytes(24)
	if err != nil {
		return "", err
	}
	return "bobsess_" + hex.EncodeToString(b), nil
}

// ---------- MemoryAuthSessionStore ----------

// MemoryAuthSessionStore 是 AuthSessionStore 的内存实现
type MemoryAuthSessionStore struct {
	mu       sync.Mutex
	sessions map[string]*AuthSession
}

// NewMemoryAuthSessionStore 创建内存会话存储
func NewMemoryAuthSessionStore() *MemoryAuthSessionStore {
	return &MemoryAuthSessionStore{sessions: make(map[string]*AuthSession)}
}

func (s *MemoryAuthSessionStore) Create(userID string, ttl time.Duration) (*AuthSession, error) {
	token, err := GenerateSessionToken()
	if err != nil {
		return nil, err
	}
	sess := &AuthSession{
		Token:     token,
		UserID:    userID,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(ttl),
	}
	s.mu.Lock()
	s.sessions[sess.Token] = sess
	s.mu.Unlock()
	return sess, nil
}

func (s *MemoryAuthSessionStore) Validate(token string, ttl time.Duration) (*AuthSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[token]
	if !ok {
		return nil, fmt.Errorf("invalid session token")
	}
	now := time.Now()
	if now.After(sess.ExpiresAt) {
		delete(s.sessions, token)
		return nil, fmt.Errorf("session expired")
	}
	// 滑动续期：剩余不足一半时重置到完整 ttl
	if sess.ExpiresAt.Sub(now) < ttl/2 {
		sess.ExpiresAt = now.Add(ttl)
	}
	return sess, nil
}

func (s *MemoryAuthSessionStore) Delete(token string) error {
	s.mu.Lock()
	delete(s.sessions, token)
	s.mu.Unlock()
	return nil
}

func (s *MemoryAuthSessionStore) DeleteByUser(userID string) error {
	s.mu.Lock()
	for t, sess := range s.sessions {
		if sess.UserID == userID {
			delete(s.sessions, t)
		}
	}
	s.mu.Unlock()
	return nil
}

func (s *MemoryAuthSessionStore) DeleteByUserExcept(userID, keepToken string) error {
	s.mu.Lock()
	for t, sess := range s.sessions {
		if sess.UserID == userID && t != keepToken {
			delete(s.sessions, t)
		}
	}
	s.mu.Unlock()
	return nil
}

func (s *MemoryAuthSessionStore) CleanupExpired() {
	now := time.Now()
	s.mu.Lock()
	for t, sess := range s.sessions {
		if now.After(sess.ExpiresAt) {
			delete(s.sessions, t)
		}
	}
	s.mu.Unlock()
}
