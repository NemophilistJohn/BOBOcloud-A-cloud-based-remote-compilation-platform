package model

import "time"

// ============================================================
// request.go — HTTP API 请求/响应类型
// ============================================================

// Request 是客户端发送的 HTTP JSON 请求体
type Request struct {
	Action            string         `json:"action"`
	FolderName        string         `json:"folderName"`
	FolderKey         string         `json:"folderKey,omitempty"` // 路径哈希，避免同名项目冲突；空则回退 folderName
	FilePath          string         `json:"filePath"`
	RunID             string         `json:"runId"`
	Runtime           string         `json:"runtime,omitempty"`       // 如 "python:3.11"，空则本地 Runner
	SetupCommands     []string       `json:"setupCommands,omitempty"` // 前置命令列表
	CompileArgs       []string       `json:"compileArgs,omitempty"`   // 用户编译参数（如 ["-O2","-std=c++17"]）
	RunArgs           []string       `json:"runArgs,omitempty"`       // 用户程序参数（传给被运行程序）
	BuildTarget       string         `json:"buildTarget,omitempty"`   // 受服务端白名单约束的交叉编译目标
	Command           string         `json:"command,omitempty"`       // terminal 命令
	Language          string         `json:"language,omitempty"`      // project environment language
	Task              *TaskExecution `json:"task,omitempty"`
	EnvironmentAction string         `json:"environmentAction,omitempty"` // repair / rebuild / clearCache
	Revision          string         `json:"revision,omitempty"`          // project environment snapshot revision

	// ── 账户系统字段 ──
	Identity               string `json:"identity,omitempty"`       // login：用户名或邮箱
	Username               string `json:"username,omitempty"`       // register：用户名
	Email                  string `json:"email,omitempty"`          // register：邮箱
	Password               string `json:"password,omitempty"`       // login / register
	OldPassword            string `json:"oldPassword,omitempty"`    // changePassword
	NewPassword            string `json:"newPassword,omitempty"`    // changePassword / resetUserPassword
	InviteCode             string `json:"inviteCode,omitempty"`     // register / revokeInvite
	Role                   string `json:"role,omitempty"`           // createInvite / setUserRole
	UserID                 string `json:"userId,omitempty"`         // 用户管理操作的目标用户
	Disabled               *bool  `json:"disabled,omitempty"`       // setUserDisabled（指针区分未传与 false）
	ContainerLimit         int    `json:"containerLimit,omitempty"` // updateUserQuota
	RateLimit              int    `json:"rateLimit,omitempty"`      // updateUserQuota
	DiskQuotaMB            int    `json:"diskQuotaMB,omitempty"`    // updateUserQuota：磁盘配额
	TotalSize              int64  `json:"totalSize,omitempty"`      // checkFolder：客户端本地文件总大小（字节）
	CachePath              string `json:"cachePath,omitempty"`      // deleteCacheModule：要删除的缓存路径（相对 persist/）
	CachePackageName       string `json:"cachePackageName,omitempty"`
	CachePackageVersion    string `json:"cachePackageVersion,omitempty"`
	CacheGeneration        string `json:"cacheGeneration,omitempty"`
	CacheInventoryRevision string `json:"cacheInventoryRevision,omitempty"`
	MaxUses                int    `json:"maxUses,omitempty"`        // createInvite
	ExpiresInHours         int    `json:"expiresInHours,omitempty"` // createInvite
	Limit                  int    `json:"limit,omitempty"`          // listAuditLog
	Name                   string `json:"name,omitempty"`           // updateProfile / team / project display name
	Description            string `json:"description,omitempty"`
	Avatar                 string `json:"avatar,omitempty"`

	// ── 团队协作字段 ──
	TeamID             string `json:"teamId,omitempty"`
	ProjectID          string `json:"projectId,omitempty"`
	Branch             string `json:"branch,omitempty"`
	SourceBranch       string `json:"sourceBranch,omitempty"`
	TargetBranch       string `json:"targetBranch,omitempty"`
	CommitMessage      string `json:"commitMessage,omitempty"`
	Content            string `json:"content,omitempty"`
	CacheQuotaMB       int    `json:"cacheQuotaMB,omitempty"`
	CacheRetentionDays int    `json:"cacheRetentionDays,omitempty"`
	CacheScope         string `json:"cacheScope,omitempty"`
	NamespaceKey       string `json:"namespaceKey,omitempty"`
	TTLMinutes         int    `json:"ttlMinutes,omitempty"`
	LockLeaseID        string `json:"lockLeaseId,omitempty"`
	Pull               bool   `json:"pull,omitempty"`
	Reset              bool   `json:"reset,omitempty"`
}

// Response 是服务端返回的 HTTP JSON 响应体
type Response struct {
	Success      bool          `json:"success"`
	Error        string        `json:"error,omitempty"`
	ErrorCode    string        `json:"errorCode,omitempty"`
	Details      any           `json:"details,omitempty"`
	Message      string        `json:"message,omitempty"`
	FolderPath   string        `json:"folderPath,omitempty"`
	RunID        string        `json:"runId,omitempty"`
	Token        string        `json:"token,omitempty"` // runCode: 运行令牌；login/register: 会话 token
	WSPath       string        `json:"wsPath,omitempty"`
	Stdout       string        `json:"stdout,omitempty"`
	Stderr       string        `json:"stderr,omitempty"`
	ExitCode     int           `json:"exitCode,omitempty"`
	Runtimes     []RuntimeDef  `json:"runtimes,omitempty"`
	BuildTargets []BuildTarget `json:"buildTargets,omitempty"`
	History      []*RunRecord  `json:"history,omitempty"`

	// ── 账户系统字段 ──
	AuthMode    string        `json:"authMode,omitempty"`    // serverInfo：single / multi
	Version     string        `json:"version,omitempty"`     // serverInfo
	ExpiresAt   *time.Time    `json:"expiresAt,omitempty"`   // login/register：会话过期时间
	User        *UserInfo     `json:"user,omitempty"`        // login/register/whoami
	Users       []*UserInfo   `json:"users,omitempty"`       // listUsers
	InviteCode  string        `json:"inviteCode,omitempty"`  // createInvite
	Invites     []*InviteInfo `json:"invites,omitempty"`     // listInvites
	Events      []*AuditEvent `json:"events,omitempty"`      // listAuditLog
	NewPassword string        `json:"newPassword,omitempty"` // resetUserPassword：一次性返回的新密码

	// ── 项目管理与磁盘配额 ──
	Projects    []ProjectInfo `json:"projects,omitempty"`    // listProjects
	StorageInfo *StorageInfo  `json:"storageInfo,omitempty"` // listProjects / getStorageInfo
	CacheGroups []CacheGroup  `json:"cacheGroups,omitempty"` // listCacheModules
	Data        any           `json:"data,omitempty"`        // 团队协作等模块化接口数据
}

// ProjectInfo 单个服务端项目信息
type ProjectInfo struct {
	Name      string `json:"name"`       // 显示名（目录名）
	Key       string `json:"key"`        // 目录名（folderKey 哈希或旧 folderName）
	SizeBytes int64  `json:"size_bytes"` // 占用空间（字节，精确值）
	Files     int    `json:"files"`      // 文件数
	ModTime   int64  `json:"mod_time"`   // 最后修改时间（Unix 秒）
}

// StorageInfo 用户存储概况
type StorageInfo struct {
	TotalUsedBytes     int64         `json:"total_used_bytes"`
	QuotaBytes         int64         `json:"quota_bytes"`          // 0=不限
	ProjectsTotalBytes int64         `json:"projects_total_bytes"` // 所有项目大小之和
	PersistBytes       int64         `json:"persist_bytes"`        // 构建缓存占用
	Projects           []ProjectInfo `json:"projects"`
}

// CacheGroup 缓存分组（按语言）
type CacheGroup struct {
	Language  string        `json:"language"`   // python / go / rust / java / other
	Label     string        `json:"label"`      // 显示名
	SizeBytes int64         `json:"size_bytes"` // 该分组总大小
	Modules   []CacheModule `json:"modules"`    // 子模块
}

// CacheModule 单个缓存模块
type CacheModule struct {
	Name               string         `json:"name"`       // 模块名（目录名）
	Path               string         `json:"path"`       // 相对 persist 的路径
	SizeBytes          int64          `json:"size_bytes"` // 大小（字节）
	Files              int            `json:"files"`      // 文件数
	Kind               string         `json:"kind,omitempty"`
	Language           string         `json:"language,omitempty"`
	WorkspaceID        string         `json:"workspace_id,omitempty"`
	ProjectName        string         `json:"project_name,omitempty"`
	RuntimeID          string         `json:"runtime_id,omitempty"`
	Digest             string         `json:"digest,omitempty"`
	DigestSource       string         `json:"digest_source,omitempty"`
	LastUsed           int64          `json:"last_used,omitempty"`
	Active             bool           `json:"active,omitempty"`
	Writing            bool           `json:"writing,omitempty"`
	Orphaned           bool           `json:"orphaned,omitempty"`
	Generation         string         `json:"generation,omitempty"`
	InventoryStatus    string         `json:"inventory_status,omitempty"`
	InventoryDetail    string         `json:"inventory_detail,omitempty"`
	InventoryRevision  string         `json:"inventory_revision,omitempty"`
	InventoryExact     bool           `json:"inventory_exact,omitempty"`
	InventoryCheckedAt int64          `json:"inventory_checked_at,omitempty"`
	Packages           []CachePackage `json:"packages,omitempty"`
}

type CachePackage struct {
	Name      string   `json:"name"`
	Version   string   `json:"version"`
	Imports   []string `json:"imports,omitempty"`
	SizeBytes int64    `json:"size_bytes,omitempty"`
	Files     int      `json:"files,omitempty"`
}

// UserInfo 是用户信息的安全视图（不含密码哈希）
type UserInfo struct {
	ID             string    `json:"id"`
	UID            string    `json:"uid"`
	Avatar         string    `json:"avatar"`
	Username       string    `json:"username"`
	Email          string    `json:"email"`
	Name           string    `json:"name"`
	Role           string    `json:"role"`
	Disabled       bool      `json:"disabled"`
	APIKey         string    `json:"api_key,omitempty"` // 仅 whoami（查自己）时返回完整值
	ContainerLimit int       `json:"container_limit"`
	RateLimit      int       `json:"rate_limit"`
	DiskQuotaMB    int       `json:"disk_quota_mb"`
	CreatedAt      time.Time `json:"created_at"`
}

// InviteInfo 是邀请码信息视图
type InviteInfo struct {
	Code      string    `json:"code"`
	Role      string    `json:"role"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	MaxUses   int       `json:"max_uses"`
	UsedCount int       `json:"used_count"`
}

// AuditEvent 是一条审计日志（账户与敏感操作事件）
type AuditEvent struct {
	ID       string    `json:"id"`
	Time     time.Time `json:"time"`
	UserID   string    `json:"user_id"`          // 操作者（注册/登录失败时可能为目标用户名）
	Username string    `json:"username"`         // 操作者显示名
	Action   string    `json:"action"`           // login / register / createInvite / setUserDisabled ...
	Target   string    `json:"target,omitempty"` // 操作目标（如被禁用的用户、被撤销的邀请码）
	Detail   string    `json:"detail,omitempty"` // 附加信息（脱敏）
	IP       string    `json:"ip,omitempty"`
	Success  bool      `json:"success"`
}

// ---------- WebSocket ----------

// WSMessage 是 WebSocket 通信的 JSON 消息体
type WSMessage struct {
	Type       string `json:"type"`
	RunID      string `json:"runId,omitempty"`
	Token      string `json:"token,omitempty"`
	Message    string `json:"message,omitempty"`
	Line       string `json:"line,omitempty"`
	Stage      string `json:"stage,omitempty"`
	Path       string `json:"path,omitempty"`
	FileType   string `json:"fileType,omitempty"`
	ChunkIndex int    `json:"chunkIndex,omitempty"`
	ChunkCount int    `json:"chunkCount,omitempty"`
	Data       string `json:"data,omitempty"`
	Success    bool   `json:"success,omitempty"`
	ReturnCode int    `json:"returncode,omitempty"`
}

// ---------- 会话 ----------

// RunSession 存储一次代码运行请求的元数据
type RunSession struct {
	RunID         string         `json:"run_id"`
	Token         string         `json:"token"`
	FolderName    string         `json:"folder_name"`
	FolderKey     string         `json:"folder_key,omitempty"` // 路径哈希，避免同名项目冲突
	FilePath      string         `json:"file_path"`
	Runtime       string         `json:"runtime"`
	Task          *TaskExecution `json:"task,omitempty"`
	SetupCommands []string       `json:"setup_commands,omitempty"`
	CompileArgs   []string       `json:"compile_args,omitempty"`
	RunArgs       []string       `json:"run_args,omitempty"`
	BuildTarget   string         `json:"build_target,omitempty"`
	CreatedAt     time.Time      `json:"created_at"`
	Started       bool           `json:"started"`
	UserID        string         `json:"user_id"`
	TeamID        string         `json:"team_id,omitempty"`
	ProjectID     string         `json:"project_id,omitempty"`
	Branch        string         `json:"branch,omitempty"`
}

// RunRecord 存储一次已完成的代码运行记录（用于历史查询）
// TaskExecution is a resolved, cloud-portable task DAG. The client resolves
// JSONC and editor variables; the server validates every field before storing
// the plan in a run session.
type TaskExecution struct {
	SchemaVersion int        `json:"schemaVersion"`
	Label         string     `json:"label"`
	Kind          string     `json:"kind"`
	Source        string     `json:"source,omitempty"`
	Steps         []TaskStep `json:"steps"`
}

type TaskStep struct {
	ID        string            `json:"id"`
	Label     string            `json:"label"`
	Kind      string            `json:"kind"`
	Type      string            `json:"type"`
	Argv      []string          `json:"argv"`
	Cwd       string            `json:"cwd,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	DependsOn []string          `json:"dependsOn,omitempty"`
}

type RunRecord struct {
	RunID           string    `json:"run_id"`
	UserID          string    `json:"user_id"`
	FolderName      string    `json:"folder_name"`
	FilePath        string    `json:"file_path"`
	TargetType      string    `json:"target_type,omitempty"`
	TaskLabel       string    `json:"task_label,omitempty"`
	TaskKind        string    `json:"task_kind,omitempty"`
	Runtime         string    `json:"runtime"`
	BuildTarget     string    `json:"build_target,omitempty"`
	Status          string    `json:"status"` // "completed", "failed", "timed_out", "cancelled"
	ExitCode        int       `json:"exit_code"`
	DurationMs      int64     `json:"duration_ms"`
	CreatedAt       time.Time `json:"created_at"`
	OutputSummary   string    `json:"output_summary,omitempty"` // 尾部最多64KB
	OutputTruncated bool      `json:"output_truncated,omitempty"`
}
