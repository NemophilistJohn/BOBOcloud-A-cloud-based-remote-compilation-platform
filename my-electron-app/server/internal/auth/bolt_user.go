package auth

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

// ============================================================
// bolt_user.go — BoltDB 实现的 UserStore
//   buckets:
//     users       userID   → User JSON
//     user_keys   apiKey   → userID
//     user_names  username(小写) → userID
//     user_emails email(小写)    → userID
// ============================================================

var (
	usersBucket               = []byte("users")
	userKeysBucket            = []byte("user_keys")
	userNamesBucket           = []byte("user_names")
	userEmailsBucket          = []byte("user_emails")
	userUIDsBucket            = []byte("user_uids")
	userDeletionCleanupBucket = []byte("user_deletion_cleanup")
)

// BoltUserStore 基于 BoltDB 的用户存储实现
type BoltUserStore struct {
	db *bolt.DB
}

// NewBoltUserStore 创建 BoltDB 用户存储，自动确保 bucket 存在
func NewBoltUserStore(db *bolt.DB) *BoltUserStore {
	err := db.Update(func(tx *bolt.Tx) error {
		for _, bucket := range [][]byte{usersBucket, userKeysBucket, userNamesBucket, userEmailsBucket, userUIDsBucket, userDeletionCleanupBucket} {
			if _, err := tx.CreateBucketIfNotExists(bucket); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		slog.Error("Failed to create user buckets", "error", err)
	}
	return &BoltUserStore{db: db}
}

// Get 根据用户 ID 获取用户
func (s *BoltUserStore) Get(id string) (*User, error) {
	var user User
	found := false

	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(usersBucket)
		data := b.Get([]byte(id))
		if data == nil {
			return nil
		}
		found = true
		return json.Unmarshal(data, &user)
	})
	if err != nil {
		return nil, fmt.Errorf("failed to read user: %w", err)
	}
	if !found {
		return nil, fmt.Errorf("user not found: %s", id)
	}
	return &user, nil
}

// getByIndex 通用的"索引 bucket → userID → 用户"反查
func (s *BoltUserStore) getByIndex(bucket []byte, key string) (*User, error) {
	var userID string
	err := s.db.View(func(tx *bolt.Tx) error {
		data := tx.Bucket(bucket).Get([]byte(strings.ToLower(key)))
		if data == nil {
			return fmt.Errorf("not found")
		}
		userID = string(data)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.Get(userID)
}

// GetByAPIKey 根据 API Key 反查用户
func (s *BoltUserStore) GetByAPIKey(key string) (*User, error) {
	// API Key 大小写敏感，不做 lower 处理
	var userID string
	err := s.db.View(func(tx *bolt.Tx) error {
		data := tx.Bucket(userKeysBucket).Get([]byte(key))
		if data == nil {
			return fmt.Errorf("invalid API key")
		}
		userID = string(data)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.Get(userID)
}

func (s *BoltUserStore) GetByUID(uid string) (*User, error) {
	return s.getByIndex(userUIDsBucket, uid)
}

// GetByUsername 根据用户名反查用户（大小写不敏感）
func (s *BoltUserStore) GetByUsername(username string) (*User, error) {
	return s.getByIndex(userNamesBucket, username)
}

// GetByEmail 根据邮箱反查用户（大小写不敏感）
func (s *BoltUserStore) GetByEmail(email string) (*User, error) {
	return s.getByIndex(userEmailsBucket, email)
}

// Create 创建或更新用户（同时维护 API Key / 用户名 / 邮箱索引）
func (s *BoltUserStore) Create(user *User) error {
	if user == nil || user.ID == "" {
		return fmt.Errorf("user ID is required")
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		if tx.Bucket(userDeletionCleanupBucket).Get([]byte(user.ID)) != nil {
			return fmt.Errorf("user deletion cleanup is pending: %s", user.ID)
		}
		ub := tx.Bucket(usersBucket)
		kb := tx.Bucket(userKeysBucket)
		nb := tx.Bucket(userNamesBucket)
		eb := tx.Bucket(userEmailsBucket)
		ib := tx.Bucket(userUIDsBucket)

		// Enforce index ownership inside the same Bolt write transaction. This
		// protects callers other than registration and prevents concurrent
		// creates from silently stealing another user's login/API-key index.
		checks := []struct {
			bucket *bolt.Bucket
			value  string
			label  string
			lower  bool
		}{
			{kb, user.APIKey, "API key", false},
			{nb, user.Username, "username", true},
			{eb, user.Email, "email", true},
			{ib, user.UID, "UID", true},
		}
		for _, check := range checks {
			if check.value == "" {
				continue
			}
			key := check.value
			if check.lower {
				key = strings.ToLower(key)
			}
			if owner := check.bucket.Get([]byte(key)); owner != nil && string(owner) != user.ID {
				return fmt.Errorf("%s already belongs to another user", check.label)
			}
		}

		// 删除旧索引（如果存在且已变更）
		if oldData := ub.Get([]byte(user.ID)); oldData != nil {
			var oldUser User
			if err := json.Unmarshal(oldData, &oldUser); err == nil {
				if oldUser.UID != "" && oldUser.UID != user.UID {
					return fmt.Errorf("UID cannot be changed")
				}
				if oldUser.APIKey != "" && oldUser.APIKey != user.APIKey {
					kb.Delete([]byte(oldUser.APIKey))
				}
				if oldUser.Username != "" && !strings.EqualFold(oldUser.Username, user.Username) {
					nb.Delete([]byte(strings.ToLower(oldUser.Username)))
				}
				if oldUser.Email != "" && !strings.EqualFold(oldUser.Email, user.Email) {
					eb.Delete([]byte(strings.ToLower(oldUser.Email)))
				}
				if oldUser.UID != "" && !strings.EqualFold(oldUser.UID, user.UID) {
					ib.Delete([]byte(strings.ToLower(oldUser.UID)))
				}
			}
		}

		// 存储用户
		data, err := json.Marshal(user)
		if err != nil {
			return fmt.Errorf("failed to marshal user: %w", err)
		}
		if err := ub.Put([]byte(user.ID), data); err != nil {
			return fmt.Errorf("failed to put user: %w", err)
		}

		// 存储索引
		if user.APIKey != "" {
			if err := kb.Put([]byte(user.APIKey), []byte(user.ID)); err != nil {
				return fmt.Errorf("failed to put api key index: %w", err)
			}
		}
		if user.Username != "" {
			if err := nb.Put([]byte(strings.ToLower(user.Username)), []byte(user.ID)); err != nil {
				return fmt.Errorf("failed to put username index: %w", err)
			}
		}
		if user.Email != "" {
			if err := eb.Put([]byte(strings.ToLower(user.Email)), []byte(user.ID)); err != nil {
				return fmt.Errorf("failed to put email index: %w", err)
			}
		}
		if user.UID != "" {
			if err := ib.Put([]byte(strings.ToLower(user.UID)), []byte(user.ID)); err != nil {
				return fmt.Errorf("failed to put uid index: %w", err)
			}
		}

		return nil
	})
}

// UpdateProfile patches only user-owned fields in one Bolt write transaction.
func (s *BoltUserStore) UpdateProfile(id, name, avatar string) (*User, error) {
	if id == "" {
		return nil, fmt.Errorf("user ID is required")
	}
	var updated User
	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(usersBucket)
		data := bucket.Get([]byte(id))
		if data == nil {
			return fmt.Errorf("user not found: %s", id)
		}
		if err := json.Unmarshal(data, &updated); err != nil {
			return fmt.Errorf("failed to decode user: %w", err)
		}
		if name != "" {
			updated.Name = name
		}
		if avatar != "" {
			updated.Avatar = avatar
		}
		encoded, err := json.Marshal(&updated)
		if err != nil {
			return fmt.Errorf("failed to marshal user: %w", err)
		}
		if err := bucket.Put([]byte(id), encoded); err != nil {
			return fmt.Errorf("failed to put user: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &updated, nil
}

func (s *BoltUserStore) Restore(user *User) error {
	if user == nil || user.ID == "" {
		return fmt.Errorf("user ID is required")
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		ub := tx.Bucket(usersBucket)
		if ub.Get([]byte(user.ID)) != nil {
			return fmt.Errorf("user already exists: %s", user.ID)
		}
		checks := []struct {
			bucket []byte
			key    string
			label  string
		}{
			{userKeysBucket, user.APIKey, "API key"},
			{userNamesBucket, strings.ToLower(user.Username), "username"},
			{userEmailsBucket, strings.ToLower(user.Email), "email"},
			{userUIDsBucket, strings.ToLower(user.UID), "UID"},
		}
		for _, check := range checks {
			if check.key == "" {
				continue
			}
			if owner := tx.Bucket(check.bucket).Get([]byte(check.key)); owner != nil && string(owner) != user.ID {
				return fmt.Errorf("%s already belongs to another user", check.label)
			}
		}
		data, err := json.Marshal(user)
		if err != nil {
			return err
		}
		if err := ub.Put([]byte(user.ID), data); err != nil {
			return err
		}
		for _, check := range checks {
			if check.key != "" {
				if err := tx.Bucket(check.bucket).Put([]byte(check.key), []byte(user.ID)); err != nil {
					return err
				}
			}
		}
		return tx.Bucket(userDeletionCleanupBucket).Delete([]byte(user.ID))
	})
}

// Delete 删除用户及其全部索引（root 专属操作；调用方负责审计）
func (s *BoltUserStore) Delete(id string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		ub := tx.Bucket(usersBucket)
		data := ub.Get([]byte(id))
		if data == nil {
			return fmt.Errorf("user not found: %s", id)
		}
		var user User
		if err := json.Unmarshal(data, &user); err == nil {
			if user.APIKey != "" {
				tx.Bucket(userKeysBucket).Delete([]byte(user.APIKey))
			}
			if user.Username != "" {
				tx.Bucket(userNamesBucket).Delete([]byte(strings.ToLower(user.Username)))
			}
			if user.Email != "" {
				tx.Bucket(userEmailsBucket).Delete([]byte(strings.ToLower(user.Email)))
			}
			if user.UID != "" {
				tx.Bucket(userUIDsBucket).Delete([]byte(strings.ToLower(user.UID)))
			}
		}
		return ub.Delete([]byte(id))
	})
}

func (s *BoltUserStore) DeleteWithCleanupMarker(id string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		ub := tx.Bucket(usersBucket)
		data := ub.Get([]byte(id))
		if data == nil {
			return fmt.Errorf("user not found: %s", id)
		}
		var user User
		if err := json.Unmarshal(data, &user); err != nil {
			return fmt.Errorf("failed to decode user: %w", err)
		}
		indexes := []struct {
			bucket []byte
			key    string
		}{
			{userKeysBucket, user.APIKey},
			{userNamesBucket, strings.ToLower(user.Username)},
			{userEmailsBucket, strings.ToLower(user.Email)},
			{userUIDsBucket, strings.ToLower(user.UID)},
		}
		for _, index := range indexes {
			if index.key != "" {
				if err := tx.Bucket(index.bucket).Delete([]byte(index.key)); err != nil {
					return err
				}
			}
		}
		if err := ub.Delete([]byte(id)); err != nil {
			return err
		}
		return tx.Bucket(userDeletionCleanupBucket).Put([]byte(id), []byte{1})
	})
}

// List 返回所有用户
func (s *BoltUserStore) SaveDeletionCleanup(userID string) error {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return fmt.Errorf("user ID is required")
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(userDeletionCleanupBucket).Put([]byte(userID), []byte{1})
	})
}

func (s *BoltUserStore) ListDeletionCleanup() ([]string, error) {
	var result []string
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(userDeletionCleanupBucket).ForEach(func(key, _ []byte) error {
			result = append(result, string(key))
			return nil
		})
	})
	return result, err
}

func (s *BoltUserStore) DeleteDeletionCleanup(userID string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(userDeletionCleanupBucket).Delete([]byte(strings.TrimSpace(userID)))
	})
}

func (s *BoltUserStore) List() ([]*User, error) {
	var users []*User

	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(usersBucket)
		c := b.Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var user User
			if err := json.Unmarshal(v, &user); err != nil {
				slog.Warn("Skipping corrupt user record", "key", string(k), "error", err)
				continue
			}
			users = append(users, &user)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list users: %w", err)
	}

	return users, nil
}

// SeedDefaultUser 创建默认管理员用户（auth_enabled 但 users 列表为空时使用）
func (s *BoltUserStore) SeedDefaultUser(adminAPIKey string) *User {
	// 检查是否已存在
	if existing, err := s.Get("default"); err == nil {
		slog.Info("Default user already exists in DB, reusing", "id", existing.ID)
		return existing
	}

	if adminAPIKey == "" {
		adminAPIKey = "bobo_admin_default_key"
	}

	user := &User{
		ID:             "default",
		Username:       "default",
		Name:           "Default Admin",
		APIKey:         adminAPIKey,
		Role:           RoleRoot, // 兼容路径下的唯一用户，视为 root
		ContainerLimit: 10,
		RateLimit:      120,
		DiskQuotaMB:    0, // 单机模式不限
		CreatedAt:      time.Now(),
	}
	if err := s.Create(user); err != nil {
		slog.Error("Failed to create default user", "error", err)
	}
	return user
}

// SeedUsers 从配置批量导入用户，返回创建/更新的用户列表。
// 重复 ID 的条目会被更新（覆盖配额和速率限制）。
func (s *BoltUserStore) SeedUsers(configs []SeedUserConfig) []*User {
	var created []*User

	for _, uc := range configs {
		if uc.ID == "" {
			continue
		}

		// 检查是否已存在
		if existing, err := s.Get(uc.ID); err == nil {
			// 更新已存在用户的配置
			existing.ContainerLimit = uc.ContainerLimit
			existing.RateLimit = uc.RateLimit
			existing.DiskQuotaMB = uc.DiskQuotaMB
			existing.Role = inferSeedRole(uc.ID, uc.Role)
			// 如果提供了新的 API Key，更新索引
			if uc.APIKey != "" && uc.APIKey != existing.APIKey {
				existing.APIKey = uc.APIKey
			}
			if err := s.Create(existing); err != nil {
				slog.Error("Failed to update user", "id", uc.ID, "error", err)
				continue
			}
			created = append(created, existing)
			slog.Info("User updated from config", "id", uc.ID, "role", existing.Role)
			continue
		}

		// 创建新用户
		apiKey := uc.APIKey
		if apiKey == "" {
			apiKey = "bobo_" + GenerateToken()[:32]
		}
		quota := uc.ContainerLimit
		if quota <= 0 {
			quota = 5
		}
		rate := uc.RateLimit
		if rate <= 0 {
			rate = 60
		}

		user := &User{
			ID:             uc.ID,
			Username:       uc.ID,
			Name:           uc.Name,
			APIKey:         apiKey,
			Role:           inferSeedRole(uc.ID, uc.Role),
			ContainerLimit: quota,
			RateLimit:      rate,
			DiskQuotaMB:    uc.DiskQuotaMB,
			CreatedAt:      time.Now(),
		}
		if err := s.Create(user); err != nil {
			slog.Error("Failed to create user", "id", uc.ID, "error", err)
			continue
		}
		created = append(created, user)
		slog.Info("User created from config", "id", uc.ID, "role", user.Role)
	}

	return created
}
