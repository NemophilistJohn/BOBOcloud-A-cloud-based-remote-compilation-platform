package storage

import (
	"encoding/json"
	"log/slog"
	"time"

	"bobocloud-server/internal/model"

	bolt "go.etcd.io/bbolt"
)

// ============================================================
// bolt_session.go — BoltDB 实现的 SessionStore
// ============================================================

var sessionsBucket = []byte("sessions")

// BoltSessionStore 基于 BoltDB 的会话存储实现
type BoltSessionStore struct {
	db *bolt.DB
}

// NewBoltSessionStore 创建 BoltDB 会话存储，自动确保 bucket 存在
func NewBoltSessionStore(db *bolt.DB) *BoltSessionStore {
	err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(sessionsBucket)
		return err
	})
	if err != nil {
		slog.Error("Failed to create sessions bucket", "error", err)
	}
	return &BoltSessionStore{db: db}
}

// Create 创建新会话并持久化到 BoltDB
func (s *BoltSessionStore) Create(sess *model.RunSession) *model.RunSession {
	sess.CreatedAt = time.Now()
	sess.Started = false

	data, err := json.Marshal(sess)
	if err != nil {
		slog.Error("Failed to marshal session", "run_id", sess.RunID, "error", err)
		return sess
	}

	err = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(sessionsBucket)
		return b.Put([]byte(sess.RunID), data)
	})
	if err != nil {
		slog.Error("Failed to persist session", "run_id", sess.RunID, "error", err)
	}

	return sess
}

// Get 根据 runID 获取会话
func (s *BoltSessionStore) Get(runID string) (*model.RunSession, bool) {
	var sess model.RunSession
	found := false

	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(sessionsBucket)
		data := b.Get([]byte(runID))
		if data == nil {
			return nil
		}
		if err := json.Unmarshal(data, &sess); err != nil {
			return err
		}
		found = true
		return nil
	})
	if err != nil {
		slog.Error("Failed to read session", "run_id", runID, "error", err)
		return nil, false
	}

	if !found {
		return nil, false
	}
	return &sess, true
}

// MarkStarted 标记会话已启动。返回 false 表示已启动或不存在。
func (s *BoltSessionStore) MarkStarted(runID string) bool {
	marked := false

	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(sessionsBucket)
		data := b.Get([]byte(runID))
		if data == nil {
			return nil
		}

		var sess model.RunSession
		if err := json.Unmarshal(data, &sess); err != nil {
			return err
		}
		if sess.Started {
			return nil // 已启动
		}

		sess.Started = true
		updated, err := json.Marshal(sess)
		if err != nil {
			return err
		}
		marked = true
		return b.Put([]byte(runID), updated)
	})
	if err != nil {
		slog.Error("Failed to mark session started", "run_id", runID, "error", err)
		return false
	}

	return marked
}

// Delete 删除会话
func (s *BoltSessionStore) Delete(runID string) {
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(sessionsBucket)
		return b.Delete([]byte(runID))
	})
	if err != nil {
		slog.Error("Failed to delete session", "run_id", runID, "error", err)
	}
}

// CleanupExpired 清理超过 TTL 的过期会话
func (s *BoltSessionStore) CleanupExpired(ttl time.Duration) []string {
	now := time.Now()
	var expired []string

	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(sessionsBucket)
		c := b.Cursor()

		for k, v := c.First(); k != nil; k, v = c.Next() {
			var sess model.RunSession
			if err := json.Unmarshal(v, &sess); err != nil {
				continue
			}
			if !sess.Started && now.Sub(sess.CreatedAt) > ttl {
				runID := string(k)
				if err := c.Delete(); err != nil {
					return err
				}
				expired = append(expired, runID)
			}
		}
		return nil
	})
	if err != nil {
		slog.Error("Session cleanup failed", "error", err)
		return nil
	}
	if len(expired) > 0 {
		slog.Info("Expired sessions cleaned", "count", len(expired))
	}
	return expired
}

// GetByUser 返回指定用户的所有活跃会话
func (s *BoltSessionStore) GetByUser(userID string) []*model.RunSession {
	var result []*model.RunSession

	s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(sessionsBucket)
		c := b.Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var sess model.RunSession
			if err := json.Unmarshal(v, &sess); err != nil {
				continue
			}
			if sess.UserID == userID {
				// 复制一份避免闭包问题
				cp := sess
				result = append(result, &cp)
			}
		}
		return nil
	})

	return result
}

// GetActiveCount 返回指定用户的活跃会话数
func (s *BoltSessionStore) GetActiveCount(userID string) int {
	count := 0
	s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(sessionsBucket)
		c := b.Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var sess model.RunSession
			if err := json.Unmarshal(v, &sess); err != nil {
				continue
			}
			if sess.UserID == userID {
				count++
			}
		}
		return nil
	})
	return count
}
