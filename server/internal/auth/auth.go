package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// ============================================================
// auth.go — 认证接口 + API Key 实现
// ============================================================

// ---------- 角色 ----------

const (
	RoleRoot   = "root"   // root 管理员：全部权限，含管理员任免，全系统唯一（由配置种子产生）
	RoleAdmin  = "admin"  // 管理员：邀请码管理 + 普通用户管理 + 全量审计
	RoleMember = "member" // 普通用户：仅自己的工作区与历史
)

// RoleLevel 返回角色等级（越大权限越高），未知角色按普通用户计
func RoleLevel(role string) int {
	switch role {
	case RoleRoot:
		return 3
	case RoleAdmin:
		return 2
	default:
		return 1
	}
}

// User 表示一个已认证的用户
type User struct {
	ID             string    `json:"id"`
	UID            string    `json:"uid"`           // 对外公开且不可变的随机身份 ID；ID 仍是内部存储主键
	Avatar         string    `json:"avatar"`        // 头像预设名或 data:image URL
	Username       string    `json:"username"`      // 登录名（唯一），注册用户的 ID 即用户名
	Email          string    `json:"email"`         // 邮箱（唯一），可作为登录凭证
	Name           string    `json:"name"`          // 显示名称
	PasswordHash   string    `json:"password_hash"` // bcrypt 哈希，API-Key 用户可为空
	Role           string    `json:"role"`          // root / admin / member，空按 member 计
	Disabled       bool      `json:"disabled"`      // 禁用后立即拒绝所有凭证
	APIKey         string    `json:"api_key"`       // 长期编程凭证（rclone/CI 等）
	ContainerLimit int       `json:"container_limit"`
	RateLimit      int       `json:"rate_limit"`    // 请求/分钟
	DiskQuotaMB    int       `json:"disk_quota_mb"` // 磁盘配额（MB），0=不限
	CreatedAt      time.Time `json:"created_at"`
}

// EffectiveRole 返回用户的有效角色（旧数据无角色字段时按 member 计）
func (u *User) EffectiveRole() string {
	if u.Role == "" {
		return RoleMember
	}
	return u.Role
}

// Authenticator 认证器接口
type Authenticator interface {
	Validate(token string) (*User, error)
	CreateToken(user *User) (string, error)
}

// UserStore 用户存储接口
type UserStore interface {
	Get(id string) (*User, error)
	GetByUID(uid string) (*User, error)
	GetByAPIKey(key string) (*User, error)
	GetByUsername(username string) (*User, error)
	GetByEmail(email string) (*User, error)
	Create(user *User) error
	UpdateProfile(id, name, avatar string) (*User, error)
	// Restore re-creates the exact previously stored record. It is used only to
	// compensate a failed multi-store account deletion before its commit point.
	Restore(user *User) error
	Delete(id string) error
	// DeleteWithCleanupMarker atomically removes the account record and creates
	// the durable job used for idempotent post-commit cleanup.
	DeleteWithCleanupMarker(id string) error
	SaveDeletionCleanup(userID string) error
	ListDeletionCleanup() ([]string, error)
	DeleteDeletionCleanup(userID string) error
	List() ([]*User, error)
	SeedUsers(configs []SeedUserConfig) []*User
	SeedDefaultUser(adminAPIKey string) *User
}

// ---------- APIKeyAuth ----------

// APIKeyAuth 基于 API Key 的简单认证
type APIKeyAuth struct {
	store UserStore
}

// NewAPIKeyAuth 创建 API Key 认证器
func NewAPIKeyAuth(store UserStore) *APIKeyAuth {
	return &APIKeyAuth{store: store}
}

// Validate 验证 API Key 并返回用户
func (a *APIKeyAuth) Validate(token string) (*User, error) {
	// 去除 "Bearer " 前缀（如果有）
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimSpace(token)

	user, err := a.store.GetByAPIKey(token)
	if err != nil {
		return nil, fmt.Errorf("invalid API key")
	}
	return user, nil
}

// CreateToken 生成新的 API Key
func (a *APIKeyAuth) CreateToken(user *User) (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "bobo_" + hex.EncodeToString(b), nil
}

// ---------- MemoryUserStore ----------

// MemoryUserStore 是 UserStore 的内存实现
type MemoryUserStore struct {
	deletionCleanup map[string]bool
	mu              sync.Mutex
	users           map[string]*User  // userID → User
	keyIndex        map[string]string // apiKey → userID
	nameIdx         map[string]string // username → userID
	mailIdx         map[string]string // email → userID
	uidIdx          map[string]string // public uid → userID
}

// NewMemoryUserStore 创建内存用户存储
func NewMemoryUserStore() *MemoryUserStore {
	return &MemoryUserStore{
		deletionCleanup: make(map[string]bool),
		users:           make(map[string]*User),
		keyIndex:        make(map[string]string),
		nameIdx:         make(map[string]string),
		mailIdx:         make(map[string]string),
		uidIdx:          make(map[string]string),
	}
}

func cloneUser(user *User) *User {
	if user == nil {
		return nil
	}
	copy := *user
	return &copy
}

// SeedDefaultUser 创建默认管理员用户（auth_enabled 但 users 列表为空时使用）
func (s *MemoryUserStore) SeedDefaultUser(adminAPIKey string) *User {
	if adminAPIKey == "" {
		adminAPIKey = "bobo_admin_default_key"
	}
	user := &User{
		ID:             "default",
		UID:            GeneratePublicUID(),
		Avatar:         "ocean",
		Username:       "default",
		Name:           "Default Admin",
		APIKey:         adminAPIKey,
		Role:           RoleRoot, // 兼容路径下的唯一用户，视为 root
		ContainerLimit: 10,
		RateLimit:      120,
		CreatedAt:      time.Now(),
	}
	s.Create(user)
	return user
}

// SeedUserConfig 是 SeedUsers 的参数类型
type SeedUserConfig struct {
	ID             string
	Name           string
	APIKey         string
	Role           string // 留空则按规则推断：id=="admin" → admin，其余 → member
	ContainerLimit int
	RateLimit      int
	DiskQuotaMB    int
}

func inferSeedRole(id, role string) string {
	if role == RoleRoot || role == RoleAdmin || role == RoleMember {
		return role
	}
	if id == "admin" {
		return RoleAdmin
	}
	return RoleMember
}

// SeedUsers 从配置批量导入用户，返回创建的用户列表。
// 重复 ID 的条目会被更新（覆盖配额和速率限制）。
func (s *MemoryUserStore) SeedUsers(configs []SeedUserConfig) []*User {
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
			if uc.APIKey != "" {
				existing.APIKey = uc.APIKey
			}
			if err := s.Create(existing); err != nil {
				continue
			}
			created = append(created, existing)
			continue
		}
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
			UID:            GeneratePublicUID(),
			Avatar:         DefaultAvatarForID(uc.ID),
			Username:       uc.ID,
			Name:           uc.Name,
			APIKey:         apiKey,
			Role:           inferSeedRole(uc.ID, uc.Role),
			ContainerLimit: quota,
			RateLimit:      rate,
			DiskQuotaMB:    uc.DiskQuotaMB,
			CreatedAt:      time.Now(),
		}
		s.Create(user)
		created = append(created, user)
	}
	return created
}

func (s *MemoryUserStore) Get(id string) (*User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[id]
	if !ok {
		return nil, fmt.Errorf("user not found: %s", id)
	}
	return cloneUser(u), nil
}

func (s *MemoryUserStore) GetByAPIKey(key string) (*User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	userID, ok := s.keyIndex[key]
	if !ok {
		return nil, fmt.Errorf("invalid API key")
	}
	user, ok := s.users[userID]
	if !ok {
		return nil, fmt.Errorf("user not found for key")
	}
	return cloneUser(user), nil
}

func (s *MemoryUserStore) GetByUID(uid string) (*User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.uidIdx[strings.ToLower(uid)]
	if !ok {
		return nil, fmt.Errorf("user not found for uid")
	}
	return cloneUser(s.users[id]), nil
}

func (s *MemoryUserStore) GetByUsername(username string) (*User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.nameIdx[strings.ToLower(username)]
	if !ok {
		return nil, fmt.Errorf("user not found: %s", username)
	}
	return cloneUser(s.users[id]), nil
}

func (s *MemoryUserStore) GetByEmail(email string) (*User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.mailIdx[strings.ToLower(email)]
	if !ok {
		return nil, fmt.Errorf("user not found for email")
	}
	return cloneUser(s.users[id]), nil
}

func (s *MemoryUserStore) Create(user *User) error {
	if user == nil || user.ID == "" {
		return fmt.Errorf("user ID is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deletionCleanup[user.ID] {
		return fmt.Errorf("user deletion cleanup is pending: %s", user.ID)
	}
	if user.APIKey != "" {
		if owner, ok := s.keyIndex[user.APIKey]; ok && owner != user.ID {
			return fmt.Errorf("API key already belongs to another user")
		}
	}
	if user.UID != "" {
		if owner, ok := s.uidIdx[strings.ToLower(user.UID)]; ok && owner != user.ID {
			return fmt.Errorf("UID already belongs to another user")
		}
	}
	if user.Username != "" {
		if owner, ok := s.nameIdx[strings.ToLower(user.Username)]; ok && owner != user.ID {
			return fmt.Errorf("username already exists")
		}
	}
	if user.Email != "" {
		if owner, ok := s.mailIdx[strings.ToLower(user.Email)]; ok && owner != user.ID {
			return fmt.Errorf("email already exists")
		}
	}
	// 清理旧索引（更新场景）
	if old, ok := s.users[user.ID]; ok {
		// Public UID is immutable once assigned. This also protects callers that
		// update a full User object without going through the profile handler.
		if old.UID != "" && user.UID != old.UID {
			return fmt.Errorf("UID cannot be changed")
		}
		if old.APIKey != "" && old.APIKey != user.APIKey {
			delete(s.keyIndex, old.APIKey)
		}
		if old.Username != "" && !strings.EqualFold(old.Username, user.Username) {
			delete(s.nameIdx, strings.ToLower(old.Username))
		}
		if old.Email != "" && !strings.EqualFold(old.Email, user.Email) {
			delete(s.mailIdx, strings.ToLower(old.Email))
		}
		if old.UID != "" && !strings.EqualFold(old.UID, user.UID) {
			delete(s.uidIdx, strings.ToLower(old.UID))
		}
	}
	s.users[user.ID] = cloneUser(user)
	if user.APIKey != "" {
		s.keyIndex[user.APIKey] = user.ID
	}
	if user.Username != "" {
		s.nameIdx[strings.ToLower(user.Username)] = user.ID
	}
	if user.Email != "" {
		s.mailIdx[strings.ToLower(user.Email)] = user.ID
	}
	if user.UID != "" {
		s.uidIdx[strings.ToLower(user.UID)] = user.ID
	}
	return nil
}

// UpdateProfile applies only user-owned fields to the latest stored record.
func (s *MemoryUserStore) UpdateProfile(id, name, avatar string) (*User, error) {
	if id == "" {
		return nil, fmt.Errorf("user ID is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	user, ok := s.users[id]
	if !ok {
		return nil, fmt.Errorf("user not found: %s", id)
	}
	if name != "" {
		user.Name = name
	}
	if avatar != "" {
		user.Avatar = avatar
	}
	return cloneUser(user), nil
}

func (s *MemoryUserStore) Restore(user *User) error {
	if user == nil || user.ID == "" {
		return fmt.Errorf("user ID is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.users[user.ID]; exists {
		return fmt.Errorf("user already exists: %s", user.ID)
	}
	checks := []struct {
		index map[string]string
		key   string
		label string
	}{
		{s.keyIndex, user.APIKey, "API key"},
		{s.nameIdx, strings.ToLower(user.Username), "username"},
		{s.mailIdx, strings.ToLower(user.Email), "email"},
		{s.uidIdx, strings.ToLower(user.UID), "UID"},
	}
	for _, check := range checks {
		if check.key == "" {
			continue
		}
		if owner, exists := check.index[check.key]; exists && owner != user.ID {
			return fmt.Errorf("%s already belongs to another user", check.label)
		}
	}
	s.users[user.ID] = cloneUser(user)
	for _, check := range checks {
		if check.key != "" {
			check.index[check.key] = user.ID
		}
	}
	delete(s.deletionCleanup, user.ID)
	return nil
}

func (s *MemoryUserStore) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[id]
	if !ok {
		return fmt.Errorf("user not found: %s", id)
	}
	if u.APIKey != "" {
		delete(s.keyIndex, u.APIKey)
	}
	if u.Username != "" {
		delete(s.nameIdx, strings.ToLower(u.Username))
	}
	if u.Email != "" {
		delete(s.mailIdx, strings.ToLower(u.Email))
	}
	if u.UID != "" {
		delete(s.uidIdx, strings.ToLower(u.UID))
	}
	delete(s.users, id)
	return nil
}

func (s *MemoryUserStore) DeleteWithCleanupMarker(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[id]
	if !ok {
		return fmt.Errorf("user not found: %s", id)
	}
	if s.deletionCleanup == nil {
		s.deletionCleanup = make(map[string]bool)
	}
	if u.APIKey != "" {
		delete(s.keyIndex, u.APIKey)
	}
	if u.Username != "" {
		delete(s.nameIdx, strings.ToLower(u.Username))
	}
	if u.Email != "" {
		delete(s.mailIdx, strings.ToLower(u.Email))
	}
	if u.UID != "" {
		delete(s.uidIdx, strings.ToLower(u.UID))
	}
	delete(s.users, id)
	s.deletionCleanup[id] = true
	return nil
}

func (s *MemoryUserStore) SaveDeletionCleanup(userID string) error {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return fmt.Errorf("user ID is required")
	}
	s.mu.Lock()
	if s.deletionCleanup == nil {
		s.deletionCleanup = make(map[string]bool)
	}
	s.deletionCleanup[userID] = true
	s.mu.Unlock()
	return nil
}

func (s *MemoryUserStore) ListDeletionCleanup() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]string, 0, len(s.deletionCleanup))
	for userID := range s.deletionCleanup {
		result = append(result, userID)
	}
	sort.Strings(result)
	return result, nil
}

func (s *MemoryUserStore) DeleteDeletionCleanup(userID string) error {
	s.mu.Lock()
	delete(s.deletionCleanup, strings.TrimSpace(userID))
	s.mu.Unlock()
	return nil
}

func (s *MemoryUserStore) List() ([]*User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]*User, 0, len(s.users))
	for _, u := range s.users {
		result = append(result, cloneUser(u))
	}
	return result, nil
}

// ---------- Context Key ----------

type contextKey string

const (
	ContextUserID   contextKey = "userID"
	ContextUserName contextKey = "userName"
	ContextUser     contextKey = "user"
)

// UserIDFromContext 从 context 中提取用户 ID
func UserIDFromContext(ctx context.Context) string {
	if v := ctx.Value(ContextUserID); v != nil {
		return v.(string)
	}
	return "default"
}

// UserFromContext 从 context 中提取完整用户对象（可能为 nil）
func UserFromContext(ctx context.Context) *User {
	if v := ctx.Value(ContextUser); v != nil {
		if u, ok := v.(*User); ok {
			return u
		}
	}
	return nil
}

// RoleFromContext 从 context 中提取用户角色（无则按 member 计）
func RoleFromContext(ctx context.Context) string {
	if u := UserFromContext(ctx); u != nil {
		return u.EffectiveRole()
	}
	return RoleMember
}

// ---------- 辅助函数 ----------

// ConstantTimeCompare 使用恒定时间比较，防止时序攻击
func ConstantTimeCompare(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// GenerateToken 生成 32 字符的十六进制随机 token（保留给 HTTP handler 使用）
func GenerateToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// GenerateUUID 生成 UUID v4 格式字符串
func GenerateUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// GeneratePublicUID returns a compact, non-sequential identity intended for
// display and team invitations. It is separate from the internal primary key
// so existing workspace paths and sessions never need to be migrated.
func GeneratePublicUID() string {
	return "u_" + GenerateToken()[:20]
}

var avatarPresets = []string{"ocean", "forest", "coral", "violet", "graphite", "amber"}

func DefaultAvatarForID(id string) string {
	if id == "" {
		return avatarPresets[0]
	}
	var n uint32
	for i := 0; i < len(id); i++ {
		n = n*33 + uint32(id[i])
	}
	return avatarPresets[int(n)%len(avatarPresets)]
}

// EnsureSocialIdentities performs the backward-compatible migration for users
// created before UID/avatar fields existed. It is safe to call on every start.
func EnsureSocialIdentities(store UserStore) error {
	users, err := store.List()
	if err != nil {
		return err
	}
	for _, user := range users {
		changed := false
		if user.UID == "" {
			for {
				candidate := GeneratePublicUID()
				if _, lookupErr := store.GetByUID(candidate); lookupErr != nil {
					user.UID = candidate
					break
				}
			}
			changed = true
		}
		if user.Avatar == "" {
			user.Avatar = DefaultAvatarForID(user.ID)
			changed = true
		}
		if changed {
			if err := store.Create(user); err != nil {
				return fmt.Errorf("migrate social identity for %s: %w", user.ID, err)
			}
		}
	}
	return nil
}

// ---------- Middleware ----------

// Middleware 是一个 HTTP 认证中间件
// 如果 authEnabled 为 false，注入默认用户并放行
func Middleware(authEnabled bool, authenticator Authenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !authEnabled {
				// 认证未启用时注入默认用户
				ctx := context.WithValue(r.Context(), ContextUserID, "default")
				ctx = context.WithValue(ctx, ContextUserName, "Default User")
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, `{"success":false,"error":"Authorization header required"}`, http.StatusUnauthorized)
				return
			}

			user, err := authenticator.Validate(authHeader)
			if err != nil {
				http.Error(w, `{"success":false,"error":"Invalid API key"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), ContextUserID, user.ID)
			ctx = context.WithValue(ctx, ContextUserName, user.Name)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
