package auth

import (
	"fmt"
	"sync"
	"time"
)

// ============================================================
// invite.go — 邀请码（邀请制注册）接口 + 内存实现
// ============================================================

// Invite 是一枚注册邀请码
type Invite struct {
	Code      string    `json:"code"`
	Role      string    `json:"role"`       // 注册后授予的角色：member / admin
	CreatedBy string    `json:"created_by"` // 创建者 userID
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	MaxUses   int       `json:"max_uses"` // 最大使用次数，<=0 视为 1
	UsedCount int       `json:"used_count"`
}

// Usable 检查邀请码当前是否可用
func (i *Invite) Usable() error {
	if time.Now().After(i.ExpiresAt) {
		return fmt.Errorf("invite code expired")
	}
	maxUses := i.MaxUses
	if maxUses <= 0 {
		maxUses = 1
	}
	if i.UsedCount >= maxUses {
		return fmt.Errorf("invite code already used up")
	}
	return nil
}

// InviteStore 邀请码存储接口
type InviteStore interface {
	Create(inv *Invite) error
	Get(code string) (*Invite, error)
	// Consume 原子地校验并消耗一次使用次数；不可用返回 error
	Consume(code string) (*Invite, error)
	List() ([]*Invite, error)
	Delete(code string) error
}

// ---------- MemoryInviteStore ----------

// MemoryInviteStore 是 InviteStore 的内存实现
type MemoryInviteStore struct {
	mu      sync.Mutex
	invites map[string]*Invite
}

// NewMemoryInviteStore 创建内存邀请码存储
func NewMemoryInviteStore() *MemoryInviteStore {
	return &MemoryInviteStore{invites: make(map[string]*Invite)}
}

func (s *MemoryInviteStore) Create(inv *Invite) error {
	s.mu.Lock()
	s.invites[inv.Code] = inv
	s.mu.Unlock()
	return nil
}

func (s *MemoryInviteStore) Get(code string) (*Invite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	inv, ok := s.invites[code]
	if !ok {
		return nil, fmt.Errorf("invite not found")
	}
	return inv, nil
}

func (s *MemoryInviteStore) Consume(code string) (*Invite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	inv, ok := s.invites[code]
	if !ok {
		return nil, fmt.Errorf("invalid invite code")
	}
	if err := inv.Usable(); err != nil {
		return nil, err
	}
	inv.UsedCount++
	return inv, nil
}

func (s *MemoryInviteStore) List() ([]*Invite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]*Invite, 0, len(s.invites))
	for _, inv := range s.invites {
		result = append(result, inv)
	}
	return result, nil
}

func (s *MemoryInviteStore) Delete(code string) error {
	s.mu.Lock()
	delete(s.invites, code)
	s.mu.Unlock()
	return nil
}
