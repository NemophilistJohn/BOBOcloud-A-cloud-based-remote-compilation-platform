package auth

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	bolt "go.etcd.io/bbolt"
)

// ============================================================
// bolt_session.go — BoltDB 实现的 AuthSessionStore
// ============================================================

var authSessionsBucket = []byte("auth_sessions")

// BoltAuthSessionStore 基于 BoltDB 的登录会话存储
type BoltAuthSessionStore struct {
	db *bolt.DB
}

// NewBoltAuthSessionStore 创建 BoltDB 会话存储，自动确保 bucket 存在
func NewBoltAuthSessionStore(db *bolt.DB) *BoltAuthSessionStore {
	err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(authSessionsBucket)
		return err
	})
	if err != nil {
		slog.Error("Failed to create auth_sessions bucket", "error", err)
	}
	return &BoltAuthSessionStore{db: db}
}

func (s *BoltAuthSessionStore) Create(userID string, ttl time.Duration) (*AuthSession, error) {
	sess := &AuthSession{
		Token:     GenerateSessionToken(),
		UserID:    userID,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(ttl),
	}
	data, err := json.Marshal(sess)
	if err != nil {
		return nil, err
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(authSessionsBucket).Put([]byte(sess.Token), data)
	})
	if err != nil {
		return nil, fmt.Errorf("failed to save session: %w", err)
	}
	return sess, nil
}

func (s *BoltAuthSessionStore) Validate(token string, ttl time.Duration) (*AuthSession, error) {
	var sess AuthSession
	now := time.Now()

	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(authSessionsBucket)
		data := b.Get([]byte(token))
		if data == nil {
			return fmt.Errorf("invalid session token")
		}
		if err := json.Unmarshal(data, &sess); err != nil {
			return fmt.Errorf("corrupt session record")
		}
		if now.After(sess.ExpiresAt) {
			b.Delete([]byte(token))
			return fmt.Errorf("session expired")
		}
		// 滑动续期：剩余不足一半时重置到完整 ttl
		if sess.ExpiresAt.Sub(now) < ttl/2 {
			sess.ExpiresAt = now.Add(ttl)
			if data, err := json.Marshal(&sess); err == nil {
				b.Put([]byte(token), data)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &sess, nil
}

func (s *BoltAuthSessionStore) Delete(token string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(authSessionsBucket).Delete([]byte(token))
	})
}

func (s *BoltAuthSessionStore) DeleteByUser(userID string) error {
	return s.deleteByUser(userID, "")
}

func (s *BoltAuthSessionStore) DeleteByUserExcept(userID, keepToken string) error {
	return s.deleteByUser(userID, keepToken)
}

func (s *BoltAuthSessionStore) deleteByUser(userID, keepToken string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(authSessionsBucket)
		var keys [][]byte
		c := b.Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			if keepToken != "" && string(k) == keepToken {
				continue
			}
			var sess AuthSession
			if err := json.Unmarshal(v, &sess); err != nil {
				keys = append(keys, k) // 无法解析的一并清理
				continue
			}
			if sess.UserID == userID {
				keys = append(keys, k)
			}
		}
		for _, k := range keys {
			b.Delete(k)
		}
		return nil
	})
}

func (s *BoltAuthSessionStore) CleanupExpired() {
	now := time.Now()
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(authSessionsBucket)
		var keys [][]byte
		c := b.Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var sess AuthSession
			if err := json.Unmarshal(v, &sess); err != nil || now.After(sess.ExpiresAt) {
				keys = append(keys, k)
			}
		}
		for _, k := range keys {
			b.Delete(k)
		}
		return nil
	})
	if err != nil {
		slog.Error("Failed to cleanup auth sessions", "error", err)
	}
}
