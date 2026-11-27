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

const sessionLastSeenWriteInterval = 5 * time.Minute

// BoltAuthSessionStore 基于 BoltDB 的登录会话存储
type BoltAuthSessionStore struct {
	trustedOperations
	db *bolt.DB
}

// NewBoltAuthSessionStore 创建 BoltDB 会话存储，自动确保 bucket 存在
func NewBoltAuthSessionStore(db *bolt.DB) *BoltAuthSessionStore {
	err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(authSessionsBucket)
		if err != nil {
			return err
		}
		_, err = tx.CreateBucketIfNotExists(trustedDevicesBucket)
		return err
	})
	if err != nil {
		slog.Error("Failed to create auth_sessions bucket", "error", err)
	}
	s := &BoltAuthSessionStore{db: db}
	s.trustedOperations.transaction = s.trustedTransaction
	return s
}

func (s *BoltAuthSessionStore) Create(userID string, ttl time.Duration) (*AuthSession, error) {
	return s.CreateForDevice(userID, "", "", ttl)
}

func (s *BoltAuthSessionStore) CreateForDevice(userID, name, platform string, ttl time.Duration) (*AuthSession, error) {
	token, err := GenerateSessionToken()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	sess := &AuthSession{
		ID:             GenerateUUID(),
		Token:          token,
		UserID:         userID,
		DeviceName:     name,
		DevicePlatform: platform,
		CreatedAt:      now,
		LastSeenAt:     now,
		ExpiresAt:      now.Add(ttl),
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
		changed := false
		// 滑动续期：剩余不足一半时重置到完整 ttl
		if sess.ExpiresAt.Sub(now) < ttl/2 {
			sess.ExpiresAt = now.Add(ttl)
			changed = true
		}
		if sess.LastSeenAt.IsZero() || now.Sub(sess.LastSeenAt) >= sessionLastSeenWriteInterval {
			sess.LastSeenAt = now
			changed = true
		}
		if changed {
			encoded, err := json.Marshal(&sess)
			if err != nil {
				return err
			}
			if err := b.Put([]byte(token), encoded); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &sess, nil
}

func (s *BoltAuthSessionStore) ListByUser(userID string) ([]*AuthSession, error) {
	items := make([]*AuthSession, 0)
	now := time.Now()
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(authSessionsBucket).ForEach(func(_, value []byte) error {
			var sess AuthSession
			if err := json.Unmarshal(value, &sess); err != nil {
				return nil
			}
			if sess.UserID != userID || !now.Before(sess.ExpiresAt) {
				return nil
			}
			sess.ID = sessionDeviceID(&sess)
			items = append(items, &sess)
			return nil
		})
	})
	return items, err
}

func (s *BoltAuthSessionStore) RevokeDevice(userID, deviceID, currentToken string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(authSessionsBucket)
		var remove [][]byte
		if err := b.ForEach(func(key, value []byte) error {
			var sess AuthSession
			if err := json.Unmarshal(value, &sess); err != nil {
				return nil
			}
			if sess.UserID != userID || sessionDeviceID(&sess) != deviceID {
				return nil
			}
			if string(key) == currentToken {
				return fmt.Errorf("cannot revoke the current device")
			}
			remove = append(remove, append([]byte(nil), key...))
			return nil
		}); err != nil {
			return err
		}
		if len(remove) == 0 {
			return fmt.Errorf("device not found")
		}
		for _, key := range remove {
			if err := b.Delete(key); err != nil {
				return err
			}
		}
		return nil
	})
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
		keepID := ""
		var kept AuthSession
		if raw := b.Get([]byte(keepToken)); raw != nil && json.Unmarshal(raw, &kept) == nil && kept.UserID == userID {
			keepID = kept.TrustedDeviceID
		}
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
		devices := tx.Bucket(trustedDevicesBucket)
		cursor := devices.Cursor()
		for k, v := cursor.First(); k != nil; k, v = cursor.Next() {
			var d TrustedDevice
			if json.Unmarshal(v, &d) != nil {
				return fmt.Errorf("corrupt device authorization")
			}
			if d.UserID == userID && d.ID != keepID {
				if err := cursor.Delete(); err != nil {
					return err
				}
			}
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
