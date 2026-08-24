package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/buildcache"
	"bobocloud-server/internal/collab"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/dap"
	"bobocloud-server/internal/lifecycle"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/metrics"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/packagecatalog"
	"bobocloud-server/internal/packageops"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
)

// ============================================================
// http.go — HTTP API 处理器（端口 3100）
//   Phase 2: 认证中间件 + 工作区隔离 + 限流
// ============================================================

// TerminalExecutor 在指定运行时容器中执行命令
type TerminalExecutor func(ctx context.Context, userID, runtimeID, command string) (stdout, stderr string, exitCode int, err error)

// EnvironmentSetupExecutor executes only server-planned package-manager setup
// commands against a copied project workspace. Commands never come from the
// apply request itself.
type EnvironmentSetupExecutor func(ctx context.Context, userID, runtimeID, workspaceRoot string, commands []string) (stdout, stderr string, exitCode int, err error)

// HTTPHandler 包含所有 HTTP API 处理器及其依赖
type HTTPHandler struct {
	Config           *config.Config
	Sessions         storage.SessionStore
	Channels         *session.ChannelManager
	Terminal         TerminalExecutor
	EnvironmentSetup EnvironmentSetupExecutor
	CompileActivity  storage.CompileActivityStore
	RateLimiter      *RateLimiter // Phase 2: 限流器（按用户）
	LoginLimiter     *RateLimiter // 登录/注册限速（按 IP，防爆破）
	UserStore        auth.UserStore
	AuthSessions     auth.AuthSessionStore   // 登录会话 token（可为 nil = 单机模式）
	Invites          auth.InviteStore        // 邀请码（可为 nil = 单机模式）
	RunHistory       storage.RunHistoryStore // 运行历史查询（可为 nil）
	Audit            storage.AuditStore      // 审计日志（可为 nil）
	Version          string                  // 服务端版本号（serverInfo 返回）
	Collaboration    *collab.Manager         // 团队、Git 工作树与邀请
	BuildCache       *buildcache.Manager     // 团队编译缓存
	LSP              *lsp.Manager            // 远程语言服务器与独立分析缓存
	DAP              *dap.Manager            // 独立远程调试适配器会话
	DependencyViews  *lsp.DependencyRegistry
	Lifecycle        *lifecycle.Manager // 运行/终端与破坏性存储操作的用户级互斥
	PersonalCache    *personalcache.Manager
	PackageCatalog   packagecatalog.Catalog
	PackagePlans     *packageops.Store
	RuntimeMetadata  RuntimeMetadataProvider
	Metrics          *metrics.Registry
	Readiness        ReadinessProbe // 无认证 /readyz 的依赖检查；由 main 在组件装配后注入

	// SetUserLimit 把用户容器配额变更同步到 Docker 池（可为 nil，仅重启生效）
	SetUserLimit func(userID string, limit int)

	// OnUserDeleted runs after the user record is committed as deleted. It is
	// idempotent cleanup for analyzers, containers, and the user's data directory;
	// failures are logged because the account deletion itself cannot be rolled back.
	OnUserDeleted func(userID string) error
	// OnBuildCacheCleared releases idle Docker bind mounts after manual cache deletion.
	OnBuildCacheCleared    func()
	OnPersonalCacheCleared func()

	// 内部状态
	authEnabled    bool // 多人模式开关（config.IsMultiUser()）
	authenticator  auth.Authenticator
	registrationMu sync.Mutex // 串行化“唯一性检查 → 邀请消耗 → 创建用户”
	userDeletionMu sync.Mutex

	// 磁盘占用缓存（60s TTL，避免每次 checkFolder 都 du）
	diskCache *diskUsageCache

	// Readiness probes are unauthenticated. Cache the short-lived dependency
	// result so callers cannot make each request spawn a Docker health process.
	readinessMu        sync.Mutex
	readinessCheckedAt time.Time
	readinessErr       error
}

// NewHTTPHandler 创建 HTTP 处理器
func NewHTTPHandler(
	cfg *config.Config,
	store storage.SessionStore,
	channels *session.ChannelManager,
	authEnabled bool,
	authenticator auth.Authenticator,
	userStore auth.UserStore,
	terminal TerminalExecutor,
	rateLimiter *RateLimiter,
	runHistory storage.RunHistoryStore,
) *HTTPHandler {
	packagePlanTTL := 15 * time.Minute
	packagePlanLimits := packageops.StoreLimits{MaxPlans: 512, MaxPlansPerUser: 32, MaxBytes: 64 << 20, MaxBytesPerUser: 16 << 20, MaxResultBytes: 64 << 10}
	if cfg != nil {
		packagePlanTTL = time.Duration(cfg.PackagePlanTTLSeconds) * time.Second
		packagePlanLimits = packageops.StoreLimits{
			MaxPlans: cfg.PackageOperationMaxPlans, MaxPlansPerUser: cfg.PackageOperationMaxPlansPerUser,
			MaxBytes: cfg.PackagePlanStoreMaxBytes, MaxBytesPerUser: cfg.PackagePlanStoreMaxBytesPerUser, MaxResultBytes: cfg.PackagePlanResultMaxBytes,
		}
	}
	return &HTTPHandler{
		Config:        cfg,
		Sessions:      store,
		Channels:      channels,
		Terminal:      terminal,
		RateLimiter:   rateLimiter,
		UserStore:     userStore,
		RunHistory:    runHistory,
		authEnabled:   authEnabled,
		authenticator: authenticator,
		diskCache:     newDiskUsageCache(),
		PackagePlans:  packageops.NewStoreWithLimits(packagePlanTTL, packagePlanLimits),
	}
}

// ServeHTTP 实现 http.Handler 接口。
// 流程：健康探针 → 方法/解码检查 → 预认证动作（serverInfo/login/register）→ 认证 → 限流 → 路由
func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.handleHealthProbe(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, model.Response{Success: false, Error: "Method not allowed"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	var req model.Request
	if err := decoder.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: fmt.Sprintf("Invalid JSON: %v", err)})
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Request body must contain exactly one JSON object"})
		return
	}

	// ---- 预认证动作（无需登录即可调用）----
	switch req.Action {
	case "serverInfo":
		h.handleServerInfo(w, r)
		return
	case "login":
		h.handleLogin(w, r, &req)
		return
	case "register":
		h.handleRegister(w, r, &req)
		return
	}

	// ---- 认证 ----
	if h.authEnabled {
		user, token, err := h.authenticate(r)
		if err != nil {
			h.auditEvent(r, "", req.Identity, "auth", "", "invalid credential: "+req.Action, false)
			writeJSON(w, http.StatusUnauthorized, model.Response{
				Success: false,
				Error:   err.Error(),
			})
			return
		}
		ctx := context.WithValue(r.Context(), auth.ContextUserID, user.ID)
		ctx = context.WithValue(ctx, auth.ContextUserName, user.Name)
		ctx = context.WithValue(ctx, auth.ContextUser, user)
		// 记住本次使用的 session token（logout 时作废）
		ctx = context.WithValue(ctx, contextKeySessionToken, token)
		r = r.WithContext(ctx)
		slog.Debug("Auth validated", "user_id", user.ID, "role", user.EffectiveRole())
	} else {
		// 单机模式：注入等价于 root 的本地用户（所有管理功能可用）
		defaultUser := &auth.User{
			ID: "default", Username: "default", Name: "Default User", Role: auth.RoleRoot,
		}
		ctx := context.WithValue(r.Context(), auth.ContextUserID, "default")
		ctx = context.WithValue(ctx, auth.ContextUserName, "Default User")
		ctx = context.WithValue(ctx, auth.ContextUser, defaultUser)
		r = r.WithContext(ctx)
	}

	userID := auth.UserIDFromContext(r.Context())
	if h.Lifecycle != nil {
		requestLease, err := h.Lifecycle.AcquireRequest(userID)
		if err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
			return
		}
		defer requestLease.Release()
	}
	if h.authEnabled {
		latestUser, err := h.UserStore.Get(userID)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "Invalid or expired credential"})
			return
		}
		if latestUser.Disabled {
			writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "account disabled"})
			return
		}
		ctx := context.WithValue(r.Context(), auth.ContextUserName, latestUser.Name)
		ctx = context.WithValue(ctx, auth.ContextUser, latestUser)
		r = r.WithContext(ctx)
	}

	// ---- 限流（按用户）----
	userRate := 0
	if user := auth.UserFromContext(r.Context()); user != nil {
		userRate = user.RateLimit
	}
	if h.RateLimiter != nil && !h.RateLimiter.AllowWithRate(userID, userRate) {
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusTooManyRequests, model.Response{
			Success: false,
			Error:   "Rate limit exceeded. Please slow down.",
		})
		slog.Warn("Rate limit hit", "user_id", userID)
		return
	}

	// ---- 路由 ----
	h.routeRequest(w, r, &req)
}

// authenticate 校验请求凭证：先按登录会话 token，再按 API Key。
// 返回用户与本次命中的 session token（API Key 命中时 token 为空串）。
func (h *HTTPHandler) authenticate(r *http.Request) (*auth.User, string, error) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return nil, "", fmt.Errorf("Authorization header required. Use: Bearer <token>")
	}
	token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))

	// 1) 登录会话 token
	if h.AuthSessions != nil {
		if sess, err := h.AuthSessions.Validate(token, h.Config.SessionTokenTTL()); err == nil {
			user, err := h.UserStore.Get(sess.UserID)
			if err == nil {
				if user.Disabled {
					return nil, "", fmt.Errorf("account disabled")
				}
				return user, token, nil
			}
			// 会话存在但用户已被删除 → 作废会话，按无效凭证处理
			h.AuthSessions.Delete(token)
		}
	}

	// 2) API Key（长期编程凭证）
	if h.authenticator != nil {
		if user, err := h.authenticator.Validate(authHeader); err == nil {
			if user.Disabled {
				return nil, "", fmt.Errorf("account disabled")
			}
			return user, "", nil
		}
	}

	return nil, "", fmt.Errorf("Invalid or expired credential")
}

// routeRequest 根据 action 分发请求（已认证）
func (h *HTTPHandler) routeRequest(w http.ResponseWriter, r *http.Request, req *model.Request) {
	userID := auth.UserIDFromContext(r.Context())
	slog.Info("Request",
		"action", req.Action,
		"user_id", userID,
		"folder", req.FolderName,
		"file", req.FilePath,
		"runtime", req.Runtime,
	)

	switch req.Action {
	case "checkFolder":
		h.handleCheckFolder(w, r, req)
	case "runCode":
		h.handleRunCode(w, r, req)
	case "runTask":
		h.handleRunTask(w, r, req)
	case "cancelRun":
		h.handleCancelRun(w, r, req)
	case "deleteFile":
		h.handleDeleteFile(w, r, req)
	case "listRuntimes":
		h.handleListRuntimes(w, req)
	case "listBuildTargets":
		h.handleListBuildTargets(w, req)
	case "checkDocker":
		h.handleCheckDocker(w)
	case "terminal":
		h.handleTerminal(w, r, req)
	case "listRunHistory":
		h.handleListRunHistory(w, r)
	case "getLSPInfo", "getLSPCacheInfo", "clearLSPCache":
		h.handleLSPManagement(w, r, req)
	case "getDAPInfo":
		h.handleDAPInfo(w, r)
	case "getProjectEnvironment", "planProjectEnvironmentRepair", "applyProjectEnvironmentAction":
		h.handleProjectEnvironment(w, r, req)
	case "getPackageCenterContext", "searchPackageCatalog", "getPackageCatalogItem", "planProjectPackageChanges", "applyProjectPackageChanges":
		h.handlePackageCenter(w, r, req)

	// ── 项目管理与磁盘配额 ──
	case "listProjects":
		h.handleListProjects(w, r)
	case "deleteProject":
		h.handleDeleteProject(w, r, req)
	case "getStorageInfo":
		h.handleGetStorageInfo(w, r)
	case "getPerformanceMetrics":
		h.handlePerformanceMetrics(w, r)
	case "listCacheModules":
		h.handleListCacheModules(w, r)
	case "deleteCacheModule":
		h.handleDeleteCacheModule(w, r, req)
	case "deleteCachePackage":
		h.handleDeleteCachePackage(w, r, req)

	// ── 账户系统（登录态）──
	case "whoami":
		h.handleWhoami(w, r)
	case "updateProfile":
		h.handleUpdateProfile(w, r, req)
	case "getCompileActivity":
		h.handleGetCompileActivity(w, r)
	case "findUser":
		h.handleFindUser(w, r, req)
	case "logout":
		h.handleLogout(w, r)
	case "changePassword":
		h.handleChangePassword(w, r, req)
	case "listAuditLog":
		h.handleListAuditLog(w, r, req)

	// ── 用户与邀请管理（admin+ / root）──
	case "createInvite":
		h.handleCreateInvite(w, r, req)
	case "listInvites":
		h.handleListInvites(w, r)
	case "revokeInvite":
		h.handleRevokeInvite(w, r, req)
	case "listUsers":
		h.handleListUsers(w, r)
	case "setUserDisabled":
		h.handleSetUserDisabled(w, r, req)
	case "setUserRole":
		h.handleSetUserRole(w, r, req)
	case "resetUserPassword":
		h.handleResetUserPassword(w, r, req)
	case "updateUserQuota":
		h.handleUpdateUserQuota(w, r, req)
	case "deleteUser":
		h.handleDeleteUser(w, r, req)

	// ── 团队协作、Git 与团队编译缓存 ──
	case "createTeam", "listTeams", "getTeam", "updateTeam", "deleteTeam",
		"createTeamInvite", "listTeamInvites", "revokeTeamInvite", "deleteTeamInvite", "joinTeam", "leaveTeam", "removeTeamMember",
		"createTeamProject", "listTeamProjects", "deleteTeamProject", "prepareTeamProject", "listTeamBranches", "createTeamBranch",
		"teamProjectHistory", "commitTeamChanges", "compareTeamBranches", "mergeTeamBranch",
		"listTeamConflicts", "resolveTeamConflict", "completeTeamMerge",
		"acquireTeamFileLock", "releaseTeamFileLock", "listTeamFileLocks",
		"getTeamCacheInfo", "clearTeamCache":
		h.handleCollaboration(w, r, req)
	default:
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: fmt.Sprintf("Unknown action: %s", req.Action)})
	}
}

// ---------- 工作区路径解析 ----------

// safePath 清理 rel 并确保结果严格位于 root 之下，防止 ".." 路径穿越。
// folderName/filePath 都是用户可控的，必须校验，否则 root 服务端可读写任意路径。
func safePath(root, rel string) (string, error) {
	if rel == "" {
		return "", fmt.Errorf("path is empty")
	}
	if strings.ContainsAny(rel, "\x00") {
		return "", fmt.Errorf("invalid path")
	}
	root = filepath.Clean(root)
	full := filepath.Clean(filepath.Join(root, rel))
	if full == root {
		return "", fmt.Errorf("path must be a subdirectory under the workspace, not the workspace root")
	}
	if !strings.HasPrefix(full, root+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes the workspace: %q", rel)
	}
	return full, nil
}

// resolveWorkspace 返回用户隔离的工作区路径（已校验路径穿越）。
// 优先使用 folderKey（路径哈希，避免同名项目冲突），为空时回退 folderName。
// auth 启用：{DataDir}/users/{userID}/workspaces/{key}
// auth 禁用：{ServerRoot}/{key}（向后兼容）
func (h *HTTPHandler) resolveWorkspace(r *http.Request, folderName, folderKey string) (string, error) {
	userID := auth.UserIDFromContext(r.Context())
	key := folderKey
	if key == "" {
		key = folderName
	}
	var root string
	if h.authEnabled {
		root = filepath.Join(h.Config.DataDir, "users", userID, "workspaces")
	} else {
		root = h.Config.ServerRoot
	}
	return safePath(root, key)
}

// ensureUserDir 确保用户根目录存在
func (h *HTTPHandler) ensureUserDir(userID string) string {
	userDir := filepath.Join(h.Config.DataDir, "users", userID)
	os.MkdirAll(filepath.Join(userDir, "workspaces"), 0755)
	os.MkdirAll(filepath.Join(userDir, "temp"), 0755)
	return userDir
}

// ---------- checkFolder ----------

func (h *HTTPHandler) handleCheckFolder(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if req.FolderName == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "folderName is required"})
		return
	}

	userID := auth.UserIDFromContext(r.Context())
	var folderPath string
	var err error
	if req.TeamID != "" || req.ProjectID != "" {
		if h.Collaboration == nil || req.TeamID == "" || req.ProjectID == "" {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "teamId and projectId are required"})
			return
		}
		folderPath, err = h.Collaboration.ResolveWorktree(r.Context(), userID, req.TeamID, req.ProjectID, req.Branch)
	} else {
		folderPath, err = h.resolveWorkspace(r, req.FolderName, req.FolderKey)
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invalid folderName: " + err.Error()})
		return
	}

	h.ensureUserDir(userID)

	if err := os.MkdirAll(folderPath, 0755); err != nil {
		slog.Error("Failed to create folder", "path", folderPath, "error", err)
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: fmt.Sprintf("Failed to create folder: %v", err)})
		return
	}

	// Display metadata must live outside the mirrored workspace. A sync may
	// legitimately remove arbitrary files inside folderPath.
	if req.TeamID == "" {
		folderKey := strings.TrimSpace(req.FolderKey)
		if folderKey == "" {
			folderKey = strings.TrimSpace(req.FolderName)
		}
		if err := h.writeWorkspaceDisplayName(userID, folderKey, req.FolderName); err != nil {
			slog.Warn("Failed to persist project display name", "user_id", userID, "folder_key", folderKey, "error", err)
		}
	}

	// ── 配额预检 ──
	if req.TotalSize > 0 && req.TeamID == "" {
		user := auth.UserFromContext(r.Context())
		quotaMB := 0
		if user != nil {
			quotaMB = user.DiskQuotaMB
		}
		if quotaMB > 0 {
			usage := h.userDiskUsage(userID)
			projectSize := h.dirSize(folderPath)
			projected := usage - projectSize + req.TotalSize
			if projected > int64(quotaMB)*1e6 {
				writeJSON(w, http.StatusOK, model.Response{
					Success: false,
					Error: fmt.Sprintf("Disk quota exceeded: projected %d MB / quota %d MB",
						projected/1e6, quotaMB),
				})
				return
			}
		}
	}

	slog.Debug("Folder ensured", "user_id", userID, "path", folderPath)
	writeJSON(w, http.StatusOK, model.Response{Success: true, FolderPath: folderPath})
}

// ---------- runCode ----------

func (h *HTTPHandler) handleRunCode(w http.ResponseWriter, r *http.Request, req *model.Request) {
	h.handleRun(w, r, req, false)
}

func (h *HTTPHandler) handleRunTask(w http.ResponseWriter, r *http.Request, req *model.Request) {
	h.handleRun(w, r, req, true)
}

func (h *HTTPHandler) handleRun(w http.ResponseWriter, r *http.Request, req *model.Request, taskMode bool) {
	if req.FolderName == "" || (!taskMode && req.FilePath == "") {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "filePath and folderName are required"})
		return
	}
	if taskMode {
		if req.Runtime == "" {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Project tasks require a Docker runtime"})
			return
		}
		if model.GetRuntimeDef(req.Runtime) == nil {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Unknown task runtime: " + req.Runtime})
			return
		}
		if err := validateTaskExecution(req.Task); err != nil {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invalid task: " + err.Error()})
			return
		}
	}

	// Windows 客户端会发来反斜杠分隔的相对路径（如 src\main.c），
	// 服务端一律按 slash 相对路径处理（safePath / 插件规划都基于此约定）。
	if !taskMode {
		req.FilePath = strings.ReplaceAll(req.FilePath, "\\", "/")
	}

	// 编译/运行参数校验（防滥用：数量与长度上限，拒绝控制字符）
	if err := validateRunArgs(req.CompileArgs); err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invalid compileArgs: " + err.Error()})
		return
	}
	if err := validateRunArgs(req.RunArgs); err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invalid runArgs: " + err.Error()})
		return
	}
	if err := validateRunArgs(req.SetupCommands); err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invalid setupCommands: " + err.Error()})
		return
	}
	if !taskMode && req.BuildTarget != "" {
		language := model.LanguageFromExtension(filepath.Ext(req.FilePath))
		if req.Runtime == "" {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Cross-compilation requires a Docker runtime"})
			return
		}
		if target, ok := model.ResolveBuildTarget(language, req.BuildTarget); !ok || !model.IsCrossBuildTarget(target) && req.BuildTarget != "linux-x86_64" {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Unsupported build target for " + language})
			return
		}
	}

	userID := auth.UserIDFromContext(r.Context())
	rawRunID := req.RunID
	if rawRunID == "" {
		rawRunID = auth.GenerateUUID()
	}
	runID, err := normalizeRunID(rawRunID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error()})
		return
	}
	req.RunID = runID
	if runCancellationRemembered(userID, runID) {
		writeRunCancelledBeforeStart(w)
		return
	}

	var projectPath string
	if req.TeamID != "" || req.ProjectID != "" {
		if h.Collaboration == nil || req.TeamID == "" || req.ProjectID == "" {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "teamId and projectId are required"})
			return
		}
		if req.Branch == "" {
			if project, projectErr := h.Collaboration.Store().GetProject(req.ProjectID); projectErr == nil && project.TeamID == req.TeamID {
				req.Branch = project.DefaultBranch
			}
		}
		projectPath, err = h.Collaboration.ResolveWorktree(r.Context(), userID, req.TeamID, req.ProjectID, req.Branch)
	} else {
		projectPath, err = h.resolveWorkspace(r, req.FolderName, req.FolderKey)
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invalid folderName: " + err.Error()})
		return
	}
	if !taskMode {
		serverFilePath, pathErr := safePath(projectPath, req.FilePath)
		if pathErr != nil {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invalid filePath: " + pathErr.Error()})
			return
		}
		if _, statErr := os.Stat(serverFilePath); os.IsNotExist(statErr) {
			writeJSON(w, http.StatusNotFound, model.Response{
				Success: false,
				Error:   fmt.Sprintf("File not found on server: %s", req.FilePath),
			})
			return
		}
	}

	token := auth.GenerateToken()
	runSessionLifecycleMu.Lock()
	cleanupExpiredRunsLocked(h.Sessions, h.Channels, h.Config.SessionTTLDuration())
	if runCancellationRememberedLocked(userID, runID, time.Now()) {
		runSessionLifecycleMu.Unlock()
		writeRunCancelledBeforeStart(w)
		return
	}
	if _, exists := h.Sessions.Get(runID); exists || h.Channels.GetOrCreate(runID, false) != nil {
		runSessionLifecycleMu.Unlock()
		writeRunIDConflict(w, runID)
		return
	}
	h.Channels.GetOrCreate(runID, true)

	h.Sessions.Create(&model.RunSession{
		RunID:         runID,
		Token:         token,
		FolderName:    req.FolderName,
		FolderKey:     req.FolderKey,
		FilePath:      req.FilePath,
		Runtime:       req.Runtime,
		SetupCommands: req.SetupCommands,
		CompileArgs:   req.CompileArgs,
		RunArgs:       req.RunArgs,
		BuildTarget:   req.BuildTarget,
		Task:          req.Task,
		UserID:        userID,
		TeamID:        req.TeamID,
		ProjectID:     req.ProjectID,
		Branch:        req.Branch,
	})
	if h.CompileActivity != nil {
		if err := h.CompileActivity.Increment(userID, time.Now()); err != nil {
			if channel := h.Channels.GetOrCreate(runID, false); channel != nil {
				channel.Close()
			}
			h.Channels.CleanupRun(runID, h.Sessions)
			runSessionLifecycleMu.Unlock()
			slog.Error("Failed to record compile activity", "user_id", userID, "run_id", runID, "error", err)
			writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Failed to record compile activity; run was not accepted"})
			return
		}
	}
	runSessionLifecycleMu.Unlock()

	slog.Info("Run session created",
		"run_id", runID,
		"user_id", userID,
		"file", req.FilePath,
		"runtime", req.Runtime,
		"compile_args", req.CompileArgs,
		"run_args", req.RunArgs,
		"build_target", req.BuildTarget,
	)

	writeJSON(w, http.StatusOK, model.Response{
		Success: true,
		Message: "Handshake accepted",
		RunID:   runID,
		Token:   token,
		WSPath:  "/ws",
	})
}

// validateRunArgs 校验用户传入的参数列表：作为 argv 元素直接传递（不经 shell），
// 这里只做数量/长度/字符集限制，防止异常输入撑爆命令行或日志。
func validateTaskExecution(task *model.TaskExecution) error {
	const maxTaskPayloadBytes = 512 << 10
	validKinds := map[string]bool{"build": true, "test": true, "run": true, "custom": true}
	if task == nil || task.SchemaVersion != 1 {
		return fmt.Errorf("unsupported or missing task schema")
	}
	if strings.TrimSpace(task.Label) == "" || len(task.Label) > 200 || strings.ContainsAny(task.Label, "\x00\r\n") {
		return fmt.Errorf("task label is required and must be at most 200 bytes")
	}
	if !validKinds[task.Kind] {
		return fmt.Errorf("task kind is invalid")
	}
	if len(task.Source) > 32 || strings.ContainsAny(task.Source, "\x00\r\n") {
		return fmt.Errorf("task source is invalid")
	}
	if len(task.Steps) == 0 || len(task.Steps) > 64 {
		return fmt.Errorf("task must contain between 1 and 64 steps")
	}
	totalPayloadBytes := len(task.Label) + len(task.Kind) + len(task.Source)
	ids := make(map[string]bool, len(task.Steps))
	for _, step := range task.Steps {
		if strings.TrimSpace(step.ID) == "" || len(step.ID) > 128 || strings.ContainsAny(step.ID, "\x00\r\n") {
			return fmt.Errorf("invalid task step id")
		}
		if ids[step.ID] {
			return fmt.Errorf("duplicate task step id: %s", step.ID)
		}
		ids[step.ID] = true
		if strings.TrimSpace(step.Label) == "" || len(step.Label) > 200 || strings.ContainsAny(step.Label, "\x00\r\n") {
			return fmt.Errorf("step %s has an invalid label", step.ID)
		}
		if !validKinds[step.Kind] {
			return fmt.Errorf("step %s has an invalid kind", step.ID)
		}
		if step.Type != "shell" && step.Type != "process" {
			return fmt.Errorf("step %s has unsupported type %q", step.ID, step.Type)
		}
		if len(step.Argv) == 0 || len(step.Argv) > 128 {
			return fmt.Errorf("step %s must contain 1 to 128 argv values", step.ID)
		}
		totalArgBytes := 0
		for _, value := range step.Argv {
			totalArgBytes += len(value)
			if len(value) > 8192 || strings.ContainsRune(value, '\x00') {
				return fmt.Errorf("step %s contains an invalid argv value", step.ID)
			}
		}
		if totalArgBytes > 32768 {
			return fmt.Errorf("step %s command is too large", step.ID)
		}
		totalPayloadBytes += len(step.ID) + len(step.Label) + len(step.Kind) + len(step.Type) + totalArgBytes
		cwd := strings.ReplaceAll(step.Cwd, "\\", "/")
		if len(cwd) > 1024 || strings.ContainsAny(cwd, "\x00\r\n") {
			return fmt.Errorf("step %s cwd is invalid", step.ID)
		}
		cleanCwd := path.Clean(cwd)
		if path.IsAbs(cleanCwd) || cleanCwd == ".." || strings.HasPrefix(cleanCwd, "../") {
			return fmt.Errorf("step %s cwd escapes the workspace", step.ID)
		}
		if len(step.Env) > 128 {
			return fmt.Errorf("step %s defines too many environment variables", step.ID)
		}
		for key, value := range step.Env {
			if !validTaskEnvName(key) || len(value) > 8192 || strings.ContainsRune(value, '\x00') {
				return fmt.Errorf("step %s contains an invalid environment value", step.ID)
			}
			totalPayloadBytes += len(key) + len(value)
		}
		totalPayloadBytes += len(cwd)
		for _, dependency := range step.DependsOn {
			totalPayloadBytes += len(dependency)
		}
		if totalPayloadBytes > maxTaskPayloadBytes {
			return fmt.Errorf("task execution payload is too large")
		}
	}

	indegree := make(map[string]int, len(task.Steps))
	dependents := make(map[string][]string, len(task.Steps))
	for _, step := range task.Steps {
		seen := make(map[string]bool, len(step.DependsOn))
		for _, dependency := range step.DependsOn {
			if !ids[dependency] {
				return fmt.Errorf("step %s depends on unknown step %s", step.ID, dependency)
			}
			if dependency == step.ID || seen[dependency] {
				return fmt.Errorf("step %s has an invalid dependency %s", step.ID, dependency)
			}
			seen[dependency] = true
			indegree[step.ID]++
			dependents[dependency] = append(dependents[dependency], step.ID)
		}
	}
	queue := make([]string, 0, len(task.Steps))
	for id := range ids {
		if indegree[id] == 0 {
			queue = append(queue, id)
		}
	}
	visited := 0
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		visited++
		for _, dependent := range dependents[id] {
			indegree[dependent]--
			if indegree[dependent] == 0 {
				queue = append(queue, dependent)
			}
		}
	}
	if visited != len(task.Steps) {
		return fmt.Errorf("task dependency graph contains a cycle")
	}
	return nil
}

func validTaskEnvName(value string) bool {
	if value == "" {
		return false
	}
	for index, char := range value {
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char == '_' || (index > 0 && char >= '0' && char <= '9') {
			continue
		}
		return false
	}
	return true
}

func validateRunArgs(args []string) error {
	const maxArgs = 64
	const maxArgLen = 512
	if len(args) > maxArgs {
		return fmt.Errorf("too many args (%d > %d)", len(args), maxArgs)
	}
	for _, a := range args {
		if len([]byte(a)) > maxArgLen {
			return fmt.Errorf("arg too long (%d > %d bytes)", len([]byte(a)), maxArgLen)
		}
		if strings.ContainsAny(a, "\x00\r\n") {
			return fmt.Errorf("arg contains invalid control characters")
		}
	}
	return nil
}

// ---------- deleteFile ----------

func (h *HTTPHandler) handleDeleteFile(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if req.FilePath == "" || req.FolderName == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "filePath and folderName are required"})
		return
	}

	folderPath, err := h.resolveWorkspace(r, req.FolderName, req.FolderKey)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invalid folderName: " + err.Error()})
		return
	}
	serverFilePath, err := safePath(folderPath, req.FilePath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invalid filePath: " + err.Error()})
		return
	}
	if _, err := os.Stat(serverFilePath); os.IsNotExist(err) {
		writeJSON(w, http.StatusOK, model.Response{Success: true, Message: fmt.Sprintf("File not found: %s", req.FilePath)})
		return
	}

	if err := os.Remove(serverFilePath); err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: fmt.Sprintf("Failed to delete file: %v", err)})
		return
	}

	slog.Info("File deleted", "path", serverFilePath, "user_id", auth.UserIDFromContext(r.Context()))
	writeJSON(w, http.StatusOK, model.Response{Success: true, Message: fmt.Sprintf("File deleted: %s", req.FilePath)})
}

// ---------- listRuntimes ----------

func (h *HTTPHandler) handleListRuntimes(w http.ResponseWriter, req *model.Request) {
	writeJSON(w, http.StatusOK, model.Response{
		Success:  true,
		Runtimes: model.SupportedRuntimes,
	})
}

// handleListBuildTargets exposes only predeclared targets for C, C++, Rust,
// and Go. The client receives no compiler command or Docker image details.
func (h *HTTPHandler) handleListBuildTargets(w http.ResponseWriter, req *model.Request) {
	targets := model.BuildTargetsForLanguage(req.Language)
	if len(targets) == 0 {
		writeJSON(w, http.StatusOK, model.Response{Success: true})
		return
	}
	// Native remains available without Docker. Cross entries are offered only
	// when the precise versioned image exists locally; this prevents a preset
	// from looking usable on a server whose operator has not deployed it.
	available := make([]model.BuildTarget, 0, len(targets))
	imageAvailability := make(map[string]bool)
	for _, target := range targets {
		if !model.IsCrossBuildTarget(target) {
			available = append(available, target)
			continue
		}
		runtime := model.GetRuntimeDef(req.Runtime)
		if runtime == nil || runtime.Language != req.Language {
			continue
		}
		image := model.CrossBuildImage(*runtime, target)
		ready, checked := imageAvailability[image]
		if !checked {
			ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
			ready = exec.CommandContext(ctx, "docker", "image", "inspect", image).Run() == nil
			cancel()
			imageAvailability[image] = ready
		}
		if ready {
			available = append(available, target)
		}
	}
	writeJSON(w, http.StatusOK, model.Response{
		Success:      true,
		BuildTargets: available,
	})
}

// ---------- checkDocker ----------

func (h *HTTPHandler) handleCheckDocker(w http.ResponseWriter) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 先检查 docker 命令是否存在
	if _, err := exec.LookPath("docker"); err != nil {
		writeJSON(w, http.StatusOK, model.Response{
			Success: false,
			Error:   "Docker is not installed. Run: curl -fsSL https://get.docker.com | sh",
		})
		return
	}

	// 检查 daemon 是否在运行
	infoCmd := exec.CommandContext(ctx, "docker", "info")
	if out, err := infoCmd.CombinedOutput(); err != nil {
		errStr := string(out)
		if strings.Contains(errStr, "Cannot connect") || strings.Contains(errStr, "daemon") {
			writeJSON(w, http.StatusOK, model.Response{
				Success: false,
				Error:   "Docker daemon is not running. Run: systemctl start docker",
			})
		} else {
			writeJSON(w, http.StatusOK, model.Response{
				Success: false,
				Error:   fmt.Sprintf("Docker error: %s", strings.TrimSpace(errStr)),
			})
		}
		return
	}

	// 获取版本
	verCmd := exec.CommandContext(ctx, "docker", "version", "--format", "{{.Server.Version}}")
	verOut, err := verCmd.Output()
	if err != nil {
		writeJSON(w, http.StatusOK, model.Response{
			Success: false,
			Error:   fmt.Sprintf("Docker version check failed: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, model.Response{
		Success: true,
		Message: fmt.Sprintf("Docker %s", strings.TrimSpace(string(verOut))),
	})
}

// ---------- terminal ----------

func (h *HTTPHandler) handleTerminal(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if req.Command == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "command is required"})
		return
	}

	runtimeID := req.Runtime
	if runtimeID == "" {
		runtimeID = "python:3.11"
	}

	rt := model.GetRuntimeDef(runtimeID)
	if rt == nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: fmt.Sprintf("Unknown runtime: %s", runtimeID)})
		return
	}

	if h.Terminal == nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Terminal executor not configured"})
		return
	}

	userID := auth.UserIDFromContext(r.Context())
	if h.Lifecycle != nil && userID != "" {
		activity, leaseErr := h.Lifecycle.AcquireActivity(userID, "")
		if leaseErr != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error()})
			return
		}
		defer activity.Release()
	}
	slog.Info("Terminal", "user_id", userID, "runtime", runtimeID, "command", req.Command)

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(h.Config.DockerTerminalTimeout)*time.Second)
	defer cancel()
	ctx, finalizeContainerCleanup := WithDeferredContainerCleanup(ctx)
	var persistOperation *personalcache.Operation
	defer func() {
		var release func()
		if persistOperation != nil {
			release = persistOperation.Release
		}
		finalizeContainerCleanup(release)
	}()
	var err error
	if h.PersonalCache != nil {
		persistOperation, err = h.PersonalCache.BeginOperation(ctx, userID, userQuotaBytes(h.UserStore, userID))
		if err != nil {
			writeJSON(w, http.StatusInsufficientStorage, model.Response{Success: false, Error: err.Error()})
			return
		}
		if persistOperation != nil {
			ctx = persistOperation.Context()
		}
	}

	stdout, stderr, exitCode, err := h.Terminal(ctx, userID, runtimeID, req.Command)
	if persistOperation != nil && persistOperation.Err() != nil {
		err = persistOperation.Err()
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{
			Success: false,
			Error:   fmt.Sprintf("Command execution failed: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, model.Response{
		Success:  true,
		Stdout:   stdout,
		Stderr:   stderr,
		ExitCode: exitCode,
	})
	if successfulDependencyCommand(exitCode, req.Command) && h.LSP != nil && h.DependencyViews != nil {
		if rt.Language == "java" && dependencyCommandUsesGradle(req.Command) {
			if published, publishErr := publishPersonalGradleDependencySnapshot(h.Config, h.UserStore, userID, runtimeID); publishErr != nil {
				slog.Warn("Failed to publish terminal Gradle dependency snapshot", "user_id", userID, "runtime", runtimeID, "error", publishErr)
			} else if published.Changed {
				slog.Info("Published terminal Gradle dependency snapshot", "user_id", userID, "runtime", runtimeID, "revision", published.Revision, "bytes", published.Size)
			}
		}
		go h.LSP.RefreshDependencyViews(h.DependencyViews, lsp.DependencyRefreshScope{
			UserID: userID, OwnerKind: "user", OwnerID: userID,
			RuntimeID: runtimeID, LanguageID: rt.Language,
		})
	}
}

func successfulDependencyCommand(exitCode int, command string) bool {
	return exitCode == 0 && dependencyCommandLikelyChangesEnvironment(command)
}

func dependencyCommandLikelyChangesEnvironment(command string) bool {
	for _, segment := range dependencyCommandSegments(command) {
		executable, arguments := dependencyCommandInvocation(segment)
		if dependencyInvocationLikelyChangesEnvironment(executable, arguments) {
			return true
		}
	}
	return false
}

func dependencyCommandUsesGradle(command string) bool {
	for _, segment := range dependencyCommandSegments(command) {
		executable, _ := dependencyCommandInvocation(segment)
		if executable == "gradle" || executable == "gradlew" {
			return true
		}
	}
	return false
}

func dependencyCommandSegments(command string) []string {
	normalized := strings.NewReplacer(
		"&&", "\n", "||", "\n", "|", "\n", ";", "\n", "\r", "\n",
	).Replace(command)
	return strings.Split(normalized, "\n")
}

func dependencyCommandInvocation(segment string) (string, []string) {
	tokens := strings.Fields(segment)
	for len(tokens) > 0 {
		token := strings.Trim(tokens[0], "'\"")
		tokens = tokens[1:]
		if token == "" || (strings.Contains(token, "=") && !strings.HasPrefix(token, "=")) {
			continue
		}
		executable := strings.ToLower(filepath.Base(filepath.ToSlash(token)))
		if executable == "sudo" || executable == "env" || executable == "command" || executable == "exec" {
			continue
		}
		arguments := make([]string, 0, len(tokens))
		for _, argument := range tokens {
			arguments = append(arguments, strings.ToLower(strings.Trim(argument, "'\"")))
		}
		return executable, arguments
	}
	return "", nil
}

func dependencyInvocationLikelyChangesEnvironment(executable string, arguments []string) bool {
	hasAction := func(actions ...string) bool {
		if len(arguments) == 0 {
			return false
		}
		for _, action := range actions {
			if arguments[0] == action {
				return true
			}
		}
		return false
	}
	if isPipExecutable(executable) {
		return hasAction("install", "uninstall")
	}
	if isPythonExecutable(executable) {
		return len(arguments) >= 3 && arguments[0] == "-m" && arguments[1] == "pip" &&
			(arguments[2] == "install" || arguments[2] == "uninstall")
	}
	switch executable {
	case "uv":
		return hasAction("add", "remove", "sync") ||
			(len(arguments) >= 2 && arguments[0] == "pip" && (arguments[1] == "install" || arguments[1] == "uninstall"))
	case "poetry", "pdm":
		return hasAction("add", "install", "remove", "sync", "update")
	case "npm":
		return hasAction("ci", "i", "install", "uninstall", "remove", "update")
	case "pnpm", "yarn", "bun":
		return hasAction("add", "install", "remove", "uninstall", "update", "upgrade")
	case "go":
		return hasAction("get") || len(arguments) >= 2 && arguments[0] == "mod" &&
			(arguments[1] == "download" || arguments[1] == "tidy" || arguments[1] == "vendor")
	case "cargo":
		return hasAction("add", "fetch", "remove", "update")
	case "mvn", "mvnw":
		for _, argument := range arguments {
			if argument == "dependency:go-offline" || argument == "dependency:resolve" || argument == "dependency:resolve-plugins" {
				return true
			}
		}
	case "gradle", "gradlew":
		for _, argument := range arguments {
			task := strings.TrimPrefix(argument, "--")
			if argument == "--refresh-dependencies" || task == "dependencies" || task == "dependencyinsight" || task == "buildenvironment" ||
				strings.HasSuffix(task, ":dependencies") || strings.HasSuffix(task, ":dependencyinsight") || strings.HasSuffix(task, ":buildenvironment") {
				return true
			}
		}
	}
	return false
}

func isPipExecutable(executable string) bool {
	if executable == "pip" {
		return true
	}
	if !strings.HasPrefix(executable, "pip") || len(executable) == len("pip") {
		return false
	}
	next := executable[len("pip")]
	return next == '.' || next >= '0' && next <= '9'
}

func isPythonExecutable(executable string) bool {
	if executable == "python" || executable == "py" {
		return true
	}
	if !strings.HasPrefix(executable, "python") || len(executable) == len("python") {
		return false
	}
	next := executable[len("python")]
	return next == '.' || next >= '0' && next <= '9'
}

// ---------- listRunHistory ----------

// handleListRunHistory 返回当前用户最近的运行记录列表
func (h *HTTPHandler) handleListRunHistory(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if h.RunHistory == nil {
		writeJSON(w, http.StatusOK, model.Response{Success: true, Message: "run history not available"})
		return
	}
	limit := h.Config.HistoryMaxPerUser
	if limit <= 0 {
		limit = 200
	}
	records, err := h.RunHistory.ListByUser(userID, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: fmt.Sprintf("Failed to list history: %v", err)})
		return
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, History: records})
}

// ---------- 磁盘占用计算（带缓存） ----------

// diskUsageCache 简单的 TTL 缓存，避免每次 checkFolder 都 du
type diskUsageCache struct {
	mu      sync.Mutex
	entries map[string]diskCacheEntry // key: userID
}

type diskCacheEntry struct {
	size    int64
	expires time.Time
}

func newDiskUsageCache() *diskUsageCache {
	return &diskUsageCache{entries: make(map[string]diskCacheEntry)}
}

func (c *diskUsageCache) Get(userID string) (int64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[userID]
	if !ok || time.Now().After(e.expires) {
		return 0, false
	}
	return e.size, true
}

func (c *diskUsageCache) Set(userID string, size int64, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[userID] = diskCacheEntry{size: size, expires: time.Now().Add(ttl)}
}

// userDiskUsage 返回用户整个目录的磁盘占用（字节），带 60s 缓存
func (h *HTTPHandler) userDiskUsage(userID string) int64 {
	if cached, ok := h.diskCache.Get(userID); ok {
		return cached
	}
	userDir := filepath.Join(h.Config.DataDir, "users", userID)
	size := dirSizeOnDisk(userDir)
	h.diskCache.Set(userID, size, 60*time.Second)
	return size
}

// dirSize 返回目录的磁盘占用（字节），无缓存
func (h *HTTPHandler) dirSize(dirPath string) int64 {
	return dirSizeOnDisk(dirPath)
}

// dirSizeOnDisk 使用 du -sb 计算目录大小；du 不存在时回退到 walk
func dirSizeOnDisk(dirPath string) int64 {
	if _, err := exec.LookPath("du"); err == nil {
		out, err := exec.Command("du", "-sb", dirPath).Output()
		if err == nil && len(out) > 0 {
			// 输出格式: "12345678\t/path"
			parts := strings.SplitN(string(out), "\t", 2)
			if len(parts) > 0 {
				var n int64
				fmt.Sscanf(parts[0], "%d", &n)
				return n
			}
		}
	}
	// 回退：递归遍历
	return walkDirSize(dirPath)
}

// walkDirSize 递归计算目录下所有文件大小之和
func walkDirSize(dirPath string) int64 {
	var total int64
	filepath.Walk(dirPath, func(_ string, info os.FileInfo, err error) error {
		if err != nil || info == nil {
			return nil
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total
}

// dirSizeAndCount 返回目录的磁盘占用（字节）和文件数
func dirSizeAndCount(dirPath string) (int64, int) {
	var size int64
	var count int
	filepath.Walk(dirPath, func(_ string, info os.FileInfo, err error) error {
		if err != nil || info == nil {
			return nil
		}
		if !info.IsDir() {
			size += info.Size()
			count++
		}
		return nil
	})
	return size, count
}

// ---------- listProjects ----------

func (h *HTTPHandler) handleListProjects(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	var wsDir string
	if h.authEnabled {
		wsDir = filepath.Join(h.Config.DataDir, "users", userID, "workspaces")
	} else {
		wsDir = h.Config.ServerRoot
	}

	var projects []model.ProjectInfo
	if entries, err := os.ReadDir(wsDir); err == nil {
		workspaceKeys := make(map[string]bool, len(entries))
		for _, entry := range entries {
			if entry.IsDir() {
				workspaceKeys[entry.Name()] = true
			}
		}
		displayNames := h.loadWorkspaceDisplayNames(userID, workspaceKeys)
		cacheNames := make(map[string]string)
		cacheNameTimes := make(map[string]time.Time)
		if h.PersonalCache != nil {
			for _, cacheEntry := range h.PersonalCache.Inspect(userID, 0).Entries {
				folderKey := personalCacheWorkspaceFolderKey(cacheEntry.WorkspaceID, userID)
				if folderKey == "" || !workspaceKeys[folderKey] || !validWorkspaceDisplayValue(cacheEntry.WorkspaceName) {
					continue
				}
				if previous, ok := cacheNameTimes[folderKey]; !ok || cacheEntry.LastUsed.After(previous) {
					cacheNames[folderKey] = strings.TrimSpace(cacheEntry.WorkspaceName)
					cacheNameTimes[folderKey] = cacheEntry.LastUsed
				}
			}
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			fullPath := filepath.Join(wsDir, entry.Name())
			size, files := dirSizeAndCount(fullPath)
			info, err := entry.Info()
			var modTime int64
			if err == nil {
				modTime = info.ModTime().Unix()
			}
			// Durable metadata is primary. Legacy in-workspace metadata and the
			// dependency cache provide migration fallbacks for existing projects.
			displayName := displayNames[entry.Name()]
			if displayName == "" {
				if data, err := os.ReadFile(filepath.Join(fullPath, ".boboproject")); err == nil {
					n := strings.TrimSpace(string(data))
					if validWorkspaceDisplayValue(n) {
						displayName = n
					}
				}
			}
			if displayName == "" {
				displayName = cacheNames[entry.Name()]
			}
			if displayName == "" {
				displayName = entry.Name()
			}
			if displayName != entry.Name() && displayNames[entry.Name()] == "" {
				if err := h.writeWorkspaceDisplayName(userID, entry.Name(), displayName); err != nil {
					slog.Warn("Failed to migrate project display name", "user_id", userID, "folder_key", entry.Name(), "error", err)
				}
			}
			projects = append(projects, model.ProjectInfo{
				Key:       entry.Name(),
				Name:      displayName,
				SizeBytes: size,
				Files:     files,
				ModTime:   modTime,
			})
		}
	}

	// 附带存储概况
	totalUsed := h.userDiskUsage(userID)
	quotaBytes := int64(0)
	if user := auth.UserFromContext(r.Context()); user != nil {
		quotaBytes = int64(user.DiskQuotaMB) * 1e6
	}
	persistBytes := int64(0)
	if h.authEnabled {
		persistBytes = h.dirSize(filepath.Join(h.Config.DataDir, "users", userID, "persist"))
	}

	// 计算所有项目大小之和
	var projectsTotalBytes int64
	for _, p := range projects {
		projectsTotalBytes += p.SizeBytes
	}

	writeJSON(w, http.StatusOK, model.Response{
		Success: true,
		StorageInfo: &model.StorageInfo{
			TotalUsedBytes:     totalUsed,
			QuotaBytes:         quotaBytes,
			ProjectsTotalBytes: projectsTotalBytes,
			PersistBytes:       persistBytes,
			Projects:           projects,
		},
	})
}

// ---------- deleteProject ----------

func (h *HTTPHandler) handleDeleteProject(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if req.FolderKey == "" && req.FolderName == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "folderKey or folderName is required"})
		return
	}

	folderPath, err := h.resolveWorkspace(r, req.FolderName, req.FolderKey)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invalid folder: " + err.Error()})
		return
	}

	// 安全检查：不允许删除工作区根目录
	var wsRoot string
	if h.authEnabled {
		userID := auth.UserIDFromContext(r.Context())
		wsRoot = filepath.Join(h.Config.DataDir, "users", userID, "workspaces")
	} else {
		wsRoot = h.Config.ServerRoot
	}
	if folderPath == wsRoot {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Cannot delete workspace root"})
		return
	}

	// 检查目录是否存在
	if _, err := os.Stat(folderPath); os.IsNotExist(err) {
		writeJSON(w, http.StatusOK, model.Response{Success: false, Error: "Project not found"})
		return
	}

	userID := auth.UserIDFromContext(r.Context())
	folderKey := req.FolderKey
	if folderKey == "" {
		folderKey = req.FolderName
	}
	if userID != "" {
		if err := h.stopUserWorkspaceServices(userID, folderKey); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
			return
		}
	}
	if h.Lifecycle != nil && userID != "" {
		mutation, leaseErr := h.Lifecycle.BeginWorkspaceMutation(userID, folderKey)
		if leaseErr != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error()})
			return
		}
		defer mutation.Release()
	}
	workspaceID := lsp.StableWorkspaceIdentity(userID, "", "", "", folderKey)
	if h.authEnabled && userID != "" {
		inspection, inspectErr := lsp.InspectPersonalDependencies(h.Config.DataDir, userID)
		if inspectErr != nil {
			writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: inspectErr.Error()})
			return
		}
		if inspection.Exists {
			if err := lsp.DeleteNodeDependencyWorkspace(inspection.Root, workspaceID); err != nil {
				status := http.StatusInternalServerError
				if errors.Is(err, lsp.ErrDependencySnapshotInUse) {
					status = http.StatusConflict
				}
				writeJSON(w, status, model.Response{Success: false, Error: err.Error()})
				return
			}
		}
	}
	if h.PersonalCache != nil && userID != "" {
		if err := h.PersonalCache.DeleteWorkspace(userID, workspaceID); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
			return
		}
		if h.OnPersonalCacheCleared != nil {
			h.OnPersonalCacheCleared()
		}
	}

	if err := os.RemoveAll(folderPath); err != nil {
		slog.Error("Failed to delete project", "path", folderPath, "error", err)
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: fmt.Sprintf("Failed to delete: %v", err)})
		return
	}
	if err := h.deleteWorkspaceDisplayName(userID, folderKey); err != nil {
		slog.Warn("Failed to delete project display metadata", "user_id", userID, "folder_key", folderKey, "error", err)
	}

	// 删除后清除磁盘缓存，使下次查询重新计算
	h.diskCache.Set(userID, 0, 1) // 1s TTL，几乎立即过期

	h.auditEvent(r, "", "", "deleteProject", folderPath, "", true)
	slog.Info("Project deleted", "user_id", userID, "path", folderPath)
	writeJSON(w, http.StatusOK, model.Response{Success: true, Message: "Project deleted"})
}

// ---------- getStorageInfo ----------

func (h *HTTPHandler) handleGetStorageInfo(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	totalUsed := h.userDiskUsage(userID)
	quotaBytes := int64(0)
	if user := auth.UserFromContext(r.Context()); user != nil {
		quotaBytes = int64(user.DiskQuotaMB) * 1e6
	}
	persistBytes := int64(0)
	if h.authEnabled {
		persistBytes = h.dirSize(filepath.Join(h.Config.DataDir, "users", userID, "persist"))
	}

	writeJSON(w, http.StatusOK, model.Response{
		Success: true,
		StorageInfo: &model.StorageInfo{
			TotalUsedBytes: totalUsed,
			QuotaBytes:     quotaBytes,
			PersistBytes:   persistBytes,
		},
	})
}

// ---------- listCacheModules ----------

// 语言显示名
var langLabels = map[string]string{
	"python":   "Python",
	"go":       "Go",
	"rust":     "Rust",
	"java":     "Java",
	"node":     "Node.js",
	"analysis": "Analysis dependencies",
	"other":    "Other",
}

const analysisDependencyCachePath = "@analysis-dependencies"

func (h *HTTPHandler) handleListCacheModules(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	var persistDir string
	if h.authEnabled {
		persistDir = filepath.Join(h.Config.DataDir, "users", userID, "persist")
	} else {
		writeJSON(w, http.StatusOK, model.Response{Success: true, CacheGroups: nil})
		return
	}

	// 按语言分组
	type groupAccum struct {
		lang      string
		modules   []model.CacheModule
		sizeBytes int64
	}
	groups := map[string]*groupAccum{}
	ensureGroup := func(lang string) *groupAccum {
		if g, ok := groups[lang]; ok {
			return g
		}
		g := &groupAccum{lang: lang}
		groups[lang] = g
		return g
	}

	// 顶层目录与语言映射
	topLangMap := map[string]string{
		"pip-cache":    "python",
		"pip-packages": "python",
		"go":           "go",
		"go-cache":     "go",
		"cargo":        "rust",
		"maven":        "java",
		"gradle":       "java",
		"npm-cache":    "node",
		"npm-global":   "node",
	}

	if entries, err := os.ReadDir(persistDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			name := entry.Name()
			if name == "project-dependencies" || name == ".project-dependency-staging" || name == ".project-dependency-retired" {
				continue
			}
			fullPath := filepath.Join(persistDir, name)
			lang := topLangMap[name]
			if lang == "" {
				lang = "other"
			}
			g := ensureGroup(lang)

			// Legacy stores are managed as coherent namespaces. Deleting only a
			// Python import directory leaves dist-info behind, while deleting only
			// a Go/Rust source subtree leaves indexes and archives behind.
			size, files := dirSizeAndCount(fullPath)
			lastUsed := int64(0)
			if info, infoErr := entry.Info(); infoErr == nil {
				lastUsed = info.ModTime().UTC().UnixMilli()
			}
			g.modules = append(g.modules, model.CacheModule{
				Name: name, Path: name, SizeBytes: size, Files: files,
				Kind: "legacy-cache", Language: lang, LastUsed: lastUsed,
			})
			g.sizeBytes += size
		}
	}
	if h.PersonalCache != nil {
		quotaBytes := userQuotaBytes(h.UserStore, userID)
		for _, entry := range h.PersonalCache.Inspect(userID, quotaBytes).Entries {
			language := entry.Language
			if language == "" {
				language = "other"
			}
			name := entry.WorkspaceName
			if name == "" {
				name = "Unattributed project cache"
			}
			module := model.CacheModule{
				Name: name, Path: entry.Path, SizeBytes: entry.SizeBytes, Files: entry.Files,
				Kind: "project-dependency", Language: language, WorkspaceID: entry.WorkspaceID, ProjectName: entry.WorkspaceName,
				RuntimeID: entry.RuntimeID, Digest: entry.Digest, DigestSource: entry.DigestSource,
				LastUsed: entry.LastUsed.UTC().UnixMilli(), Active: entry.Active, Writing: entry.Writing, Orphaned: entry.Orphaned, Generation: entry.Generation,
			}
			if language == "python" && !entry.Orphaned {
				inventoryEntry, inventory, exists, inventoryErr := h.PersonalCache.InspectEntryPackageInventory(userID, entry.Path)
				if inventoryErr != nil {
					module.InventoryStatus = "error"
					module.InventoryDetail = inventoryErr.Error()
				} else if exists {
					module.Generation = inventoryEntry.Generation
					module.InventoryStatus = inventory.State
					module.InventoryDetail = inventory.Detail
					module.InventoryRevision = inventory.Revision
					module.InventoryExact = inventory.Exact
					if !inventory.GeneratedAt.IsZero() {
						module.InventoryCheckedAt = inventory.GeneratedAt.UTC().UnixMilli()
					}
					if inventory.Exact {
						module.Packages = make([]model.CachePackage, 0, len(inventory.Packages))
						for _, item := range inventory.Packages {
							module.Packages = append(module.Packages, model.CachePackage{
								Name: item.Name, Version: item.Version, Imports: append([]string(nil), item.Imports...), SizeBytes: item.SizeBytes, Files: item.Files,
							})
						}
					}
				} else {
					module.InventoryStatus = "missing"
					module.InventoryDetail = "Project dependency cache does not exist"
				}
			} else if !entry.Orphaned {
				switch language {
				case "node", "go", "rust", "java":
					reader, observedEntry, exists, readErr := h.PersonalCache.AcquireEntryInspectionRead(userID, entry.Path)
					if errors.Is(readErr, personalcache.ErrCacheInUse) {
						module.InventoryStatus = "busy"
						module.InventoryDetail = "The package cache is being written and cannot be inspected yet"
					} else if readErr != nil {
						module.InventoryStatus = "error"
						module.InventoryDetail = readErr.Error()
					} else if !exists || reader == nil {
						module.InventoryStatus = "missing"
						module.InventoryDetail = "Project dependency cache does not exist"
					} else {
						observed := inspectInstalledEnvironmentSnapshot(reader.HostRoot, language)
						module.Generation = observedEntry.Generation
						module.InventoryStatus = observed.State
						module.InventoryDetail = observed.Detail
						module.InventoryCheckedAt = observed.CheckedAt
						module.Packages = make([]model.CachePackage, 0, len(observed.Packages))
						for _, item := range observed.Packages {
							module.Packages = append(module.Packages, model.CachePackage{Name: item.Name, Version: item.Version})
						}
						reader.Release()
					}
				default:
					module.InventoryStatus = "unsupported"
					module.InventoryDetail = "Package inventory is not available for this language"
				}
			}
			g := ensureGroup(language)
			g.modules = append(g.modules, module)
			g.sizeBytes += entry.SizeBytes
		}
	}

	// 转为有序切片（按大小降序）
	if inspection, inspectErr := lsp.InspectPersonalDependencies(h.Config.DataDir, userID); inspectErr == nil && inspection.Exists && (inspection.Bytes > 0 || inspection.Entries > 0 || inspection.Truncated) {
		g := ensureGroup("analysis")
		g.modules = append(g.modules, model.CacheModule{
			Name:      "Analysis dependencies",
			Path:      analysisDependencyCachePath,
			SizeBytes: inspection.Bytes,
			Files:     inspection.Entries,
			Kind:      "analysis-dependency",
			Language:  "analysis",
		})
		g.sizeBytes += inspection.Bytes
	}

	var result []model.CacheGroup
	for _, g := range groups {
		sortCacheModules(g.modules)
		label := langLabels[g.lang]
		if label == "" {
			label = g.lang
		}
		result = append(result, model.CacheGroup{
			Language:  g.lang,
			Label:     label,
			SizeBytes: g.sizeBytes,
			Modules:   g.modules,
		})
	}
	sortCacheGroups(result)

	writeJSON(w, http.StatusOK, model.Response{Success: true, CacheGroups: result})
}

func (h *HTTPHandler) handleDeleteCachePackage(w http.ResponseWriter, r *http.Request, req *model.Request) {
	writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Package-level deletion would invalidate the project dependency digest; update the project manifest in Library Center or delete the whole cache generation"})
}

// ---------- deleteCacheModule ----------

func (h *HTTPHandler) handleDeleteCacheModule(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if req.CachePath == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "cachePath is required"})
		return
	}

	userID := auth.UserIDFromContext(r.Context())
	if !h.authEnabled {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Not available in single-user mode"})
		return
	}
	beginMutation := func() (func(), error) {
		if h.Lifecycle == nil {
			return func() {}, nil
		}
		mutation, err := h.Lifecycle.BeginUserMutation(userID)
		if err != nil {
			return nil, err
		}
		return mutation.Release, nil
	}

	if req.CachePath == analysisDependencyCachePath {
		if h.LSP != nil {
			if err := h.LSP.StopUserOwner(userID, "user", userID, ""); err != nil {
				writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
				return
			}
		}
		release, leaseErr := beginMutation()
		if leaseErr != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error()})
			return
		}
		defer release()
		if err := lsp.ClearPersonalDependencies(h.Config.DataDir, userID); err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, lsp.ErrPersonalDependencyStoreInUse) {
				status = http.StatusConflict
			}
			writeJSON(w, status, model.Response{Success: false, Error: err.Error()})
			return
		}
		h.diskCache.Set(userID, 0, 1)
		h.auditEvent(r, "", "", "deleteCacheModule", analysisDependencyCachePath, "", true)
		writeJSON(w, http.StatusOK, model.Response{Success: true, Message: "Cache deleted"})
		return
	}
	if h.PersonalCache != nil && strings.HasPrefix(filepath.ToSlash(req.CachePath), "project-dependencies/") {
		var cacheEntry *personalcache.Entry
		entries := h.PersonalCache.Inspect(userID, userQuotaBytes(h.UserStore, userID)).Entries
		for index := range entries {
			entry := entries[index]
			if filepath.ToSlash(entry.Path) == filepath.ToSlash(req.CachePath) {
				cacheEntry = &entry
				break
			}
		}
		if cacheEntry != nil && cacheEntry.Writing {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: personalcache.ErrCacheInUse.Error()})
			return
		}
		if cacheEntry != nil && cacheEntry.Active {
			folderKey := personalCacheWorkspaceFolderKey(cacheEntry.WorkspaceID, userID)
			var err error
			if folderKey != "" {
				err = h.stopUserWorkspaceServices(userID, folderKey)
			} else {
				err = h.stopUserOwnerServices(userID, "user", userID, "")
			}
			if err != nil {
				writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
				return
			}
		}
		release, leaseErr := beginMutation()
		if leaseErr != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error()})
			return
		}
		defer release()
		if cacheEntry != nil && cacheEntry.Language == "node" {
			if err := h.deletePersonalNodeDependencySnapshots(userID, cacheEntry.WorkspaceID); err != nil {
				writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
				return
			}
		}
		if err := h.PersonalCache.Delete(userID, req.CachePath); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
			return
		}
		if h.OnPersonalCacheCleared != nil {
			h.OnPersonalCacheCleared()
		}
		h.diskCache.Set(userID, 0, 1)
		h.auditEvent(r, "", "", "deleteCacheModule", req.CachePath, "project dependency namespace", true)
		writeJSON(w, http.StatusOK, model.Response{Success: true, Message: "Cache deleted"})
		return
	}

	persistDir := filepath.Join(h.Config.DataDir, "users", userID, "persist")

	target, targetErr := secureCacheTarget(persistDir, req.CachePath)
	if targetErr != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invalid cache path"})
		return
	}

	if _, err := os.Stat(target); err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, http.StatusOK, model.Response{Success: false, Error: "Cache path not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: err.Error()})
		return
	}

	if err := h.stopUserOwnerServices(userID, "user", userID, ""); err != nil {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
		return
	}
	release, leaseErr := beginMutation()
	if leaseErr != nil {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error()})
		return
	}
	defer release()

	if err := os.RemoveAll(target); err != nil {
		slog.Error("Failed to delete cache", "path", target, "error", err)
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: fmt.Sprintf("Failed to delete: %v", err)})
		return
	}

	// 清除磁盘缓存
	h.diskCache.Set(userID, 0, 1)

	h.auditEvent(r, "", "", "deleteCacheModule", target, "", true)
	slog.Info("Cache deleted", "user_id", userID, "path", target)
	writeJSON(w, http.StatusOK, model.Response{Success: true, Message: "Cache deleted"})
}

func personalCacheWorkspaceFolderKey(workspaceID, userID string) string {
	parts := strings.Split(workspaceID, "\x00")
	if len(parts) != 4 || parts[0] != "user" || parts[1] != userID || parts[2] != "folder" {
		return ""
	}
	return strings.TrimSpace(parts[3])
}

func (h *HTTPHandler) stopUserWorkspaceServices(userID, folderKey string) error {
	if h.LSP != nil {
		if err := h.LSP.StopUserWorkspace(userID, folderKey); err != nil {
			return err
		}
	}
	if h.DAP != nil {
		if err := h.DAP.StopUserWorkspace(userID, folderKey); err != nil {
			return err
		}
	}
	return nil
}

func (h *HTTPHandler) stopUserOwnerServices(userID, ownerKind, ownerID, projectID string) error {
	if h.LSP != nil {
		if err := h.LSP.StopUserOwner(userID, ownerKind, ownerID, projectID); err != nil {
			return err
		}
	}
	if h.DAP != nil {
		if err := h.DAP.StopUserOwner(userID, ownerKind, ownerID); err != nil {
			return err
		}
	}
	return nil
}

func (h *HTTPHandler) deletePersonalNodeDependencySnapshots(userID, workspaceID string) error {
	inspection, err := lsp.InspectPersonalDependencies(h.Config.DataDir, userID)
	if err != nil || !inspection.Exists {
		return err
	}
	if err := lsp.DeleteNodeDependencyWorkspace(inspection.Root, workspaceID); err != nil {
		return fmt.Errorf("delete derived Node dependency snapshots: %w", err)
	}
	return nil
}

func secureCacheTarget(root, relative string) (string, error) {
	target, err := safePath(root, relative)
	if err != nil {
		return "", err
	}
	resolvedRoot, err := filepath.EvalSymlinks(filepath.Clean(root))
	if err != nil {
		return "", err
	}
	resolvedTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", err
	}
	resolvedRoot, err = filepath.Abs(resolvedRoot)
	if err != nil {
		return "", err
	}
	resolvedTarget, err = filepath.Abs(resolvedTarget)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(resolvedRoot, resolvedTarget)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("cache target escapes its root")
	}
	lexical, err := filepath.Abs(target)
	samePath := filepath.Clean(lexical) == filepath.Clean(resolvedTarget)
	if runtime.GOOS == "windows" {
		samePath = strings.EqualFold(filepath.Clean(lexical), filepath.Clean(resolvedTarget))
	}
	if err != nil || !samePath {
		return "", fmt.Errorf("cache target contains a link or reparse point")
	}
	return lexical, nil
}

// ---------- 辅助：排序 ----------

func sortCacheModules(mods []model.CacheModule) {
	for i := 1; i < len(mods); i++ {
		for j := i; j > 0 && mods[j].SizeBytes > mods[j-1].SizeBytes; j-- {
			mods[j], mods[j-1] = mods[j-1], mods[j]
		}
	}
}

func sortCacheGroups(groups []model.CacheGroup) {
	for i := 1; i < len(groups); i++ {
		for j := i; j > 0 && groups[j].SizeBytes > groups[j-1].SizeBytes; j-- {
			groups[j], groups[j-1] = groups[j-1], groups[j]
		}
	}
}

// ---------- 辅助 ----------

func writeJSON(w http.ResponseWriter, statusCode int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(data)
}
