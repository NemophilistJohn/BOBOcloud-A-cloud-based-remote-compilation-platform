package storage

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"bobocloud-server/internal/model"

	bolt "go.etcd.io/bbolt"
)

// ============================================================
// bolt_audit.go — BoltDB 实现的审计日志存储
//   key 设计：UTC时间戳前缀（字典序=时间序）+ 随机 ID，天然按时间排序
// ============================================================

var auditBucket = []byte("audit_log")

// AuditStore 审计日志存储接口
type AuditStore interface {
	Save(e *model.AuditEvent) error
	// List 返回最近的审计事件（时间倒序）；userID 为空返回全部用户
	List(userID string, limit int) ([]*model.AuditEvent, error)
	// Cleanup 清理：超过 maxAge 的记录删除，总数超过 maxTotal 时裁剪最旧的
	Cleanup(maxTotal int, maxAge time.Duration)
}

// BoltAuditStore 基于 BoltDB 的审计日志存储
type BoltAuditStore struct {
	db *bolt.DB
}

// NewBoltAuditStore 创建审计存储，自动确保 bucket 存在
func NewBoltAuditStore(db *bolt.DB) *BoltAuditStore {
	err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(auditBucket)
		return err
	})
	if err != nil {
		slog.Error("Failed to create audit_log bucket", "error", err)
	}
	return &BoltAuditStore{db: db}
}

// makeAuditKey 生成时间序 key："20260719T153045.123456789_<id>"
func makeAuditKey(t time.Time, id string) []byte {
	return []byte(t.UTC().Format("20060102T150405.000000000") + "_" + id)
}

func (s *BoltAuditStore) Save(e *model.AuditEvent) error {
	if e.ID == "" {
		return fmt.Errorf("audit event ID is empty")
	}
	if e.Time.IsZero() {
		e.Time = time.Now()
	}
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(auditBucket).Put(makeAuditKey(e.Time, e.ID), data)
	})
}

func (s *BoltAuditStore) List(userID string, limit int) ([]*model.AuditEvent, error) {
	if limit <= 0 {
		limit = 200
	}
	var events []*model.AuditEvent

	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(auditBucket).Cursor()
		// key 按时间字典序排列，反向遍历即时间倒序
		for k, v := c.Last(); k != nil && len(events) < limit; k, v = c.Prev() {
			var e model.AuditEvent
			if err := json.Unmarshal(v, &e); err != nil {
				continue
			}
			if userID != "" && e.UserID != userID {
				continue
			}
			events = append(events, &e)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return events, nil
}

func (s *BoltAuditStore) Cleanup(maxTotal int, maxAge time.Duration) {
	now := time.Now()
	deleted := 0

	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(auditBucket)
		c := b.Cursor()

		// 第一步：删除过期记录（正序 = 最旧在前）
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var e model.AuditEvent
			if err := json.Unmarshal(v, &e); err != nil || now.Sub(e.Time) > maxAge {
				c.Delete()
				deleted++
			}
		}

		// 第二步：总数超限，从最旧的开始裁
		if maxTotal > 0 {
			count := b.Stats().KeyN
			for k, _ := c.First(); k != nil && count > maxTotal; k, _ = c.First() {
				c.Delete()
				count--
				deleted++
			}
		}
		return nil
	})
	if err != nil {
		slog.Error("Audit log cleanup failed", "error", err)
		return
	}
	if deleted > 0 {
		slog.Info("Audit log cleaned", "deleted", deleted)
	}
}
