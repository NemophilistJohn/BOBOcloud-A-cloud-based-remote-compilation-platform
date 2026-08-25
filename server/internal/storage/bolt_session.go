package storage

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"bobocloud-server/internal/model"

	bolt "go.etcd.io/bbolt"
)

// ============================================================
// bolt_session.go — BoltDB 实现的 SessionStore
// ============================================================

var sessionsBucket = []byte("sessions")

var errSessionsBucketUnavailable = errors.New("sessions bucket is unavailable")

// BoltSessionStore 基于 BoltDB 的会话存储实现
type BoltSessionStore struct {
	db *bolt.DB
}

// NewBoltSessionStore 创建 BoltDB 会话存储，自动确保 bucket 存在
func NewBoltSessionStore(db *bolt.DB) (*BoltSessionStore, error) {
	if db == nil {
		return nil, errors.New("initialize session store: nil database")
	}
	err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(sessionsBucket)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("initialize session store: %w", err)
	}
	return &BoltSessionStore{db: db}, nil
}

// Create 创建新会话并持久化到 BoltDB
func (s *BoltSessionStore) Create(sess *model.RunSession) (*model.RunSession, error) {
	sess.CreatedAt = time.Now()
	sess.Started = false

	data, err := json.Marshal(sess)
	if err != nil {
		return nil, fmt.Errorf("marshal run session %q: %w", sess.RunID, err)
	}

	err = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(sessionsBucket)
		if b == nil {
			return errSessionsBucketUnavailable
		}
		return b.Put([]byte(sess.RunID), data)
	})
	if err != nil {
		return nil, fmt.Errorf("persist run session %q: %w", sess.RunID, err)
	}

	return sess, nil
}

// Lookup 根据 runID 获取会话，并区分不存在与存储读取失败。
func (s *BoltSessionStore) Lookup(runID string) (*model.RunSession, bool, error) {
	var sess model.RunSession
	found := false

	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(sessionsBucket)
		if b == nil {
			return errSessionsBucketUnavailable
		}
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
		return nil, false, fmt.Errorf("read run session %q: %w", runID, err)
	}

	if !found {
		return nil, false, nil
	}
	return &sess, true, nil
}

// Get returns the legacy two-state view. Lifecycle code must use Lookup so a
// transient Bolt error is never mistaken for an absent session.
func (s *BoltSessionStore) Get(runID string) (*model.RunSession, bool) {
	sess, found, err := s.Lookup(runID)
	if err != nil {
		slog.Error("Failed to read session", "run_id", runID, "error", err)
		return nil, false
	}
	return sess, found
}

// MarkStarted 原子地声明一个待运行会话。
func (s *BoltSessionStore) MarkStarted(runID string) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(sessionsBucket)
		if b == nil {
			return errSessionsBucketUnavailable
		}
		data := b.Get([]byte(runID))
		if data == nil {
			return ErrSessionNotFound
		}

		var sess model.RunSession
		if err := json.Unmarshal(data, &sess); err != nil {
			return err
		}
		if sess.Started {
			return ErrSessionAlreadyStarted
		}

		sess.Started = true
		updated, err := json.Marshal(sess)
		if err != nil {
			return err
		}
		return b.Put([]byte(runID), updated)
	})
	if err != nil {
		if errors.Is(err, ErrSessionNotFound) || errors.Is(err, ErrSessionAlreadyStarted) {
			return err
		}
		return fmt.Errorf("mark run session %q started: %w", runID, err)
	}
	return nil
}

// Delete 删除会话
func (s *BoltSessionStore) Delete(runID string) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(sessionsBucket)
		if b == nil {
			return errSessionsBucketUnavailable
		}
		return b.Delete([]byte(runID))
	})
	if err != nil {
		return fmt.Errorf("delete run session %q: %w", runID, err)
	}
	return nil
}

func (s *BoltSessionStore) DeleteAllProcessSessions() ([]string, error) {
	ids := make([]string, 0)
	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(sessionsBucket)
		if bucket == nil {
			return errSessionsBucketUnavailable
		}
		cursor := bucket.Cursor()
		for key, _ := cursor.First(); key != nil; key, _ = cursor.Next() {
			ids = append(ids, string(append([]byte(nil), key...)))
			if err := cursor.Delete(); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("delete process-bound run sessions: %w", err)
	}
	sort.Strings(ids)
	return ids, nil
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
