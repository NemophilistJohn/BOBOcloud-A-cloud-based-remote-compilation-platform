package storage

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"sort"
	"time"

	"bobocloud-server/internal/model"

	bolt "go.etcd.io/bbolt"
)

// ============================================================
// bolt_history.go — BoltDB 实现的 RunHistoryStore
// ============================================================

var runHistoryBucket = []byte("run_history")

// BoltRunHistory 基于 BoltDB 的运行历史存储
type BoltRunHistory struct {
	db *bolt.DB
}

// NewBoltRunHistory 创建运行历史存储，自动确保 bucket 存在
func NewBoltRunHistory(db *bolt.DB) *BoltRunHistory {
	err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(runHistoryBucket)
		return err
	})
	if err != nil {
		slog.Error("Failed to create run_history bucket", "error", err)
	}
	return &BoltRunHistory{db: db}
}

// makeKey 生成 userID:runID 格式的复合键（支持前缀扫描）
func makeHistoryKey(userID, runID string) []byte {
	return []byte(userID + ":" + runID)
}

// Save 保存一条运行记录
func (h *BoltRunHistory) Save(record *model.RunRecord) error {
	key := makeHistoryKey(record.UserID, record.RunID)
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}

	return h.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(runHistoryBucket)
		return b.Put(key, data)
	})
}

// ListByUser 返回指定用户最近的 N 条运行记录（按时间倒序）
func (h *BoltRunHistory) ListByUser(userID string, limit int) ([]*model.RunRecord, error) {
	prefix := []byte(userID + ":")
	var records []*model.RunRecord

	err := h.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(runHistoryBucket)
		c := b.Cursor()

		// Seek 到前缀位置，向前扫描收集所有匹配项
		for k, v := c.Seek(prefix); k != nil && bytes.HasPrefix(k, prefix); k, v = c.Next() {
			var rec model.RunRecord
			if err := json.Unmarshal(v, &rec); err != nil {
				continue
			}
			records = append(records, &rec)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// 按时间倒序排列
	sort.Slice(records, func(i, j int) bool {
		return records[i].CreatedAt.After(records[j].CreatedAt)
	})

	// 截断到 limit
	if limit > 0 && len(records) > limit {
		records = records[:limit]
	}

	return records, nil
}

// Get 获取单条运行记录
func (h *BoltRunHistory) Get(userID, runID string) (*model.RunRecord, bool) {
	key := makeHistoryKey(userID, runID)
	var rec model.RunRecord

	err := h.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(runHistoryBucket)
		data := b.Get(key)
		if data == nil {
			return nil
		}
		return json.Unmarshal(data, &rec)
	})
	if err != nil {
		slog.Error("Failed to read run history", "user_id", userID, "run_id", runID, "error", err)
		return nil, false
	}

	// rec 的零值 RunID 表明未找到
	if rec.RunID == "" {
		return nil, false
	}
	return &rec, true
}

// DeleteByUser 删除指定用户的所有运行历史记录
func (h *BoltRunHistory) DeleteByUser(userID string) error {
	prefix := []byte(userID + ":")
	deleted := 0

	err := h.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(runHistoryBucket)
		c := b.Cursor()

		var keys [][]byte
		for k, _ := c.Seek(prefix); k != nil && bytes.HasPrefix(k, prefix); k, _ = c.Next() {
			keys = append(keys, k)
		}
		for _, k := range keys {
			b.Delete(k)
			deleted++
		}
		return nil
	})
	if err != nil {
		slog.Error("Failed to delete user history", "user_id", userID, "error", err)
		return err
	}
	slog.Info("User run history deleted", "user_id", userID, "count", deleted)
	return nil
}

// Cleanup 清理运行历史：过期 → 每用户超限 → 全局超限
// maxRecordsPerUser: 每用户最多保留条数
// maxAge: 超过此时间的记录删除
// maxTotal: 全局最多保留总条数
func (h *BoltRunHistory) Cleanup(maxRecordsPerUser int, maxAge time.Duration, maxTotal int) {
	now := time.Now()
	deletedAge := 0
	deletedPerUser := 0
	deletedGlobal := 0

	err := h.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(runHistoryBucket)

		// ── 第一步：删除过期记录 ──
		{
			var expiredKeys [][]byte
			c := b.Cursor()
			for k, v := c.First(); k != nil; k, v = c.Next() {
				var rec model.RunRecord
				if err := json.Unmarshal(v, &rec); err != nil {
					expiredKeys = append(expiredKeys, k) // 无法解析也清理
					continue
				}
				if now.Sub(rec.CreatedAt) > maxAge {
					expiredKeys = append(expiredKeys, k)
				}
			}
			for _, k := range expiredKeys {
				b.Delete(k)
			}
			deletedAge = len(expiredKeys)
		}

		// ── 第二步：每用户超限清理（保留最新的 N 条）──
		userRecords := make(map[string][]struct {
			key       []byte
			createdAt time.Time
		})

		c := b.Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var rec model.RunRecord
			if err := json.Unmarshal(v, &rec); err != nil {
				continue
			}
			userRecords[rec.UserID] = append(userRecords[rec.UserID], struct {
				key       []byte
				createdAt time.Time
			}{k, rec.CreatedAt})
		}

		for userID, entries := range userRecords {
			if len(entries) <= maxRecordsPerUser {
				continue
			}
			// 按时间倒序，保留前 maxRecordsPerUser 条
			sort.Slice(entries, func(i, j int) bool {
				return entries[i].createdAt.After(entries[j].createdAt)
			})
			for _, e := range entries[maxRecordsPerUser:] {
				b.Delete(e.key)
				deletedPerUser++
			}
			_ = userID // 消除未使用变量警告
		}

		// ── 第三步：全局超限清理（保留最新的记录）──
		var allEntries []struct {
			key       []byte
			createdAt time.Time
		}
		c = b.Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var rec model.RunRecord
			if err := json.Unmarshal(v, &rec); err != nil {
				continue
			}
			allEntries = append(allEntries, struct {
				key       []byte
				createdAt time.Time
			}{k, rec.CreatedAt})
		}

		if len(allEntries) > maxTotal {
			// 按时间倒序，保留最新的 maxTotal 条
			sort.Slice(allEntries, func(i, j int) bool {
				return allEntries[i].createdAt.After(allEntries[j].createdAt)
			})
			for _, e := range allEntries[maxTotal:] {
				b.Delete(e.key)
				deletedGlobal++
			}
		}

		return nil
	})

	if err != nil {
		slog.Error("Run history cleanup failed", "error", err)
		return
	}

	total := deletedAge + deletedPerUser + deletedGlobal
	if total > 0 {
		slog.Info("Run history cleaned",
			"total", total,
			"age_expired", deletedAge,
			"per_user_excess", deletedPerUser,
			"global_excess", deletedGlobal,
		)
	}
}
