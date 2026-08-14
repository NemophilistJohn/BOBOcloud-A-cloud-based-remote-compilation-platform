package auth

import (
	"encoding/json"
	"fmt"
	"log/slog"

	bolt "go.etcd.io/bbolt"
)

// ============================================================
// bolt_invite.go — BoltDB 实现的 InviteStore
// ============================================================

var invitesBucket = []byte("invites")

// BoltInviteStore 基于 BoltDB 的邀请码存储
type BoltInviteStore struct {
	db *bolt.DB
}

// NewBoltInviteStore 创建 BoltDB 邀请码存储，自动确保 bucket 存在
func NewBoltInviteStore(db *bolt.DB) *BoltInviteStore {
	err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(invitesBucket)
		return err
	})
	if err != nil {
		slog.Error("Failed to create invites bucket", "error", err)
	}
	return &BoltInviteStore{db: db}
}

func (s *BoltInviteStore) Create(inv *Invite) error {
	data, err := json.Marshal(inv)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(invitesBucket).Put([]byte(inv.Code), data)
	})
}

func (s *BoltInviteStore) Get(code string) (*Invite, error) {
	var inv Invite
	found := false
	err := s.db.View(func(tx *bolt.Tx) error {
		data := tx.Bucket(invitesBucket).Get([]byte(code))
		if data == nil {
			return nil
		}
		found = true
		return json.Unmarshal(data, &inv)
	})
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("invite not found")
	}
	return &inv, nil
}

// Consume 在单个 Bolt 事务内校验并递增使用次数，防止并发消耗同一邀请码
func (s *BoltInviteStore) Consume(code string) (*Invite, error) {
	var inv Invite
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(invitesBucket)
		data := b.Get([]byte(code))
		if data == nil {
			return fmt.Errorf("invalid invite code")
		}
		if err := json.Unmarshal(data, &inv); err != nil {
			return fmt.Errorf("corrupt invite record")
		}
		if err := inv.Usable(); err != nil {
			return err
		}
		inv.UsedCount++
		newData, err := json.Marshal(&inv)
		if err != nil {
			return err
		}
		return b.Put([]byte(code), newData)
	})
	if err != nil {
		return nil, err
	}
	return &inv, nil
}

func (s *BoltInviteStore) List() ([]*Invite, error) {
	var result []*Invite
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(invitesBucket).Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var inv Invite
			if err := json.Unmarshal(v, &inv); err != nil {
				continue
			}
			result = append(result, &inv)
		}
		return nil
	})
	return result, err
}

func (s *BoltInviteStore) Delete(code string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(invitesBucket).Delete([]byte(code))
	})
}
