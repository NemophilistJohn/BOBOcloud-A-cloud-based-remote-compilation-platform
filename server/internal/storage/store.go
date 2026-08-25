package storage

import (
	"errors"
	"sort"
	"sync"
	"time"

	"bobocloud-server/internal/model"
)

// ============================================================
// store.go — SessionStore 接口 + 内存实现
// ============================================================

// SessionStore 是运行会话的存储抽象。
type SessionStore interface {
	// Create 持久化一个运行会话；CreatedAt/Started 由实现填充，返回填充后的会话。
	Create(sess *model.RunSession) (*model.RunSession, error)
	// Lookup distinguishes a missing process-bound session from a storage read
	// failure. Lifecycle decisions must use this method instead of Get.
	Lookup(runID string) (*model.RunSession, bool, error)
	// Get is the compatibility view for callers that do not make lifecycle
	// decisions. New control-flow code should use Lookup.
	Get(runID string) (*model.RunSession, bool)
	MarkStarted(runID string) error
	Delete(runID string) error
	// DeleteAllProcessSessions removes handshakes that cannot survive a server
	// restart because their channels and WebSocket ownership are in memory.
	DeleteAllProcessSessions() ([]string, error)
	CleanupExpired(ttl time.Duration) []string
	GetByUser(userID string) []*model.RunSession
	GetActiveCount(userID string) int
}

var (
	// ErrSessionNotFound means the requested run handshake no longer exists.
	ErrSessionNotFound = errors.New("run session not found")
	// ErrSessionAlreadyStarted means a WebSocket already claimed the handshake.
	ErrSessionAlreadyStarted = errors.New("run session already started")
)

// ---------- MemorySessionStore ----------

// MemorySessionStore 是 SessionStore 的内存实现
type MemorySessionStore struct {
	mu       sync.Mutex
	sessions map[string]*model.RunSession
}

// NewMemorySessionStore 创建内存会话存储
func NewMemorySessionStore() *MemorySessionStore {
	return &MemorySessionStore{
		sessions: make(map[string]*model.RunSession),
	}
}

// Create 创建新会话
func (s *MemorySessionStore) Create(sess *model.RunSession) (*model.RunSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess.CreatedAt = time.Now()
	sess.Started = false
	s.sessions[sess.RunID] = sess
	return sess, nil
}

// Lookup 获取会话，并显式保留存储错误维度。
func (s *MemorySessionStore) Lookup(runID string) (*model.RunSession, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[runID]
	return sess, ok, nil
}

// Get 获取会话的兼容视图。
func (s *MemorySessionStore) Get(runID string) (*model.RunSession, bool) {
	sess, ok, _ := s.Lookup(runID)
	return sess, ok
}

// MarkStarted 原子地声明一个待运行会话。
func (s *MemorySessionStore) MarkStarted(runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[runID]
	if !ok {
		return ErrSessionNotFound
	}
	if sess.Started {
		return ErrSessionAlreadyStarted
	}
	sess.Started = true
	return nil
}

// Delete 删除会话
func (s *MemorySessionStore) Delete(runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, runID)
	return nil
}

func (s *MemorySessionStore) DeleteAllProcessSessions() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, 0, len(s.sessions))
	for id := range s.sessions {
		ids = append(ids, id)
	}
	s.sessions = make(map[string]*model.RunSession)
	sort.Strings(ids)
	return ids, nil
}

// CleanupExpired 清理过期会话
func (s *MemorySessionStore) CleanupExpired(ttl time.Duration) []string {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	var expired []string
	for id, sess := range s.sessions {
		if !sess.Started && now.Sub(sess.CreatedAt) > ttl {
			delete(s.sessions, id)
			expired = append(expired, id)
		}
	}
	return expired
}

// GetByUser 返回指定用户的所有会话
func (s *MemorySessionStore) GetByUser(userID string) []*model.RunSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result []*model.RunSession
	for _, sess := range s.sessions {
		if sess.UserID == userID {
			result = append(result, sess)
		}
	}
	return result
}

// GetActiveCount 返回指定用户的活跃会话数
func (s *MemorySessionStore) GetActiveCount(userID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, sess := range s.sessions {
		if sess.UserID == userID {
			count++
		}
	}
	return count
}

// ---------- RunHistoryStore ----------

// RunHistoryStore 是运行历史记录的持久化存储抽象。
type RunHistoryStore interface {
	Save(record *model.RunRecord) error
	ListByUser(userID string, limit int) ([]*model.RunRecord, error)
	Get(userID, runID string) (*model.RunRecord, bool)
	Cleanup(maxRecordsPerUser int, maxAge time.Duration, maxTotal int)
	DeleteByUser(userID string) error
}
