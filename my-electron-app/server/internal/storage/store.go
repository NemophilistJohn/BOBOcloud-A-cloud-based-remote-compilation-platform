package storage

import (
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
	Create(sess *model.RunSession) *model.RunSession
	Get(runID string) (*model.RunSession, bool)
	MarkStarted(runID string) bool
	Delete(runID string)
	CleanupExpired(ttl time.Duration) []string
	GetByUser(userID string) []*model.RunSession
	GetActiveCount(userID string) int
}

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
func (s *MemorySessionStore) Create(sess *model.RunSession) *model.RunSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess.CreatedAt = time.Now()
	sess.Started = false
	s.sessions[sess.RunID] = sess
	return sess
}

// Get 获取会话
func (s *MemorySessionStore) Get(runID string) (*model.RunSession, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[runID]
	return sess, ok
}

// MarkStarted 标记会话已启动，返回 false 表示已启动或不存在
func (s *MemorySessionStore) MarkStarted(runID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[runID]
	if !ok || sess.Started {
		return false
	}
	sess.Started = true
	return true
}

// Delete 删除会话
func (s *MemorySessionStore) Delete(runID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, runID)
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
