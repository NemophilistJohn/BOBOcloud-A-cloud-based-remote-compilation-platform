package collab

import "time"

const (
	DefaultBranch = "main"
)

type Team struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	Description        string    `json:"description,omitempty"`
	AdminUserID        string    `json:"admin_user_id"`
	Avatar             string    `json:"avatar"`
	CacheQuotaMB       int       `json:"cache_quota_mb"`
	CacheRetentionDays int       `json:"cache_retention_days"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

type Member struct {
	TeamID   string    `json:"team_id"`
	UserID   string    `json:"user_id"`
	JoinedAt time.Time `json:"joined_at"`
}

type Invite struct {
	Code      string    `json:"code"`
	TeamID    string    `json:"team_id"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	MaxUses   int       `json:"max_uses"`
	UsedCount int       `json:"used_count"`
	Revoked   bool      `json:"revoked"`
}

type Project struct {
	ID            string    `json:"id"`
	TeamID        string    `json:"team_id"`
	Name          string    `json:"name"`
	Description   string    `json:"description,omitempty"`
	DefaultBranch string    `json:"default_branch"`
	CreatedBy     string    `json:"created_by"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type FileLock struct {
	TeamID    string    `json:"team_id"`
	ProjectID string    `json:"project_id"`
	Branch    string    `json:"branch"`
	Path      string    `json:"path"`
	UserID    string    `json:"user_id"`
	UserUID   string    `json:"user_uid"`
	UserName  string    `json:"user_name"`
	LeaseID   string    `json:"lease_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

type BranchInfo struct {
	Name        string    `json:"name"`
	Commit      string    `json:"commit"`
	Subject     string    `json:"subject"`
	Author      string    `json:"author"`
	CommittedAt time.Time `json:"committed_at"`
	IsDefault   bool      `json:"is_default"`
}

type CommitInfo struct {
	ID        string    `json:"id"`
	Parents   []string  `json:"parents"`
	Refs      string    `json:"refs,omitempty"`
	Author    string    `json:"author"`
	AuthorUID string    `json:"author_uid,omitempty"`
	Message   string    `json:"message"`
	CreatedAt time.Time `json:"created_at"`
}

type WorktreeInfo struct {
	TeamID      string   `json:"team_id"`
	ProjectID   string   `json:"project_id"`
	ProjectName string   `json:"project_name"`
	Branch      string   `json:"branch"`
	RemotePath  string   `json:"remote_path"`
	Dirty       bool     `json:"dirty"`
	Conflicts   []string `json:"conflicts,omitempty"`
	Head        string   `json:"head,omitempty"`
}

type DiffInfo struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Stats     string `json:"stats"`
	Patch     string `json:"patch"`
	Truncated bool   `json:"truncated"`
}

type ConflictFile struct {
	Path   string `json:"path"`
	Base   string `json:"base"`
	Ours   string `json:"ours"`
	Theirs string `json:"theirs"`
}

type MemberView struct {
	UserID   string    `json:"user_id"`
	UID      string    `json:"uid"`
	Username string    `json:"username"`
	Name     string    `json:"name"`
	Avatar   string    `json:"avatar"`
	IsAdmin  bool      `json:"is_admin"`
	JoinedAt time.Time `json:"joined_at"`
}

type TeamView struct {
	Team
	IsAdmin      bool `json:"is_admin"`
	MemberCount  int  `json:"member_count"`
	ProjectCount int  `json:"project_count"`
}
