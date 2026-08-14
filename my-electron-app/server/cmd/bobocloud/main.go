package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/buildcache"
	"bobocloud-server/internal/collab"
	"bobocloud-server/internal/compiler"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/dap"
	"bobocloud-server/internal/docker"
	"bobocloud-server/internal/files"
	"bobocloud-server/internal/handler"
	"bobocloud-server/internal/lifecycle"
	customlog "bobocloud-server/internal/log"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/runner"
	"bobocloud-server/internal/security"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"

	bolt "go.etcd.io/bbolt"
)

// ServerVersion 服务端版本号（serverInfo/whoami 返回，客户端用于兼容性判断）
const ServerVersion = "2.4.0"

func main() {
	// ──── 1. 加载配置 ────
	execDir, err := os.Getwd()
	if err != nil {
		execDir = "."
	}

	configPath := filepath.Join(execDir, "config.json")
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		if err := config.WriteDefault(configPath); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: Failed to write default config: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "Default config written to %s\n", configPath)
		}
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}

	// 确保 DataDir 和 ServerRoot 为绝对路径（Docker 卷挂载要求绝对路径）
	if !filepath.IsAbs(cfg.DataDir) {
		if abs, err := filepath.Abs(cfg.DataDir); err == nil {
			cfg.DataDir = abs
		}
	}
	if !filepath.IsAbs(cfg.ServerRoot) {
		if abs, err := filepath.Abs(cfg.ServerRoot); err == nil {
			cfg.ServerRoot = abs
		}
	}

	// ──── 2. 初始化日志 ────
	logger := customlog.NewLogger(cfg.LogLevel, cfg.LogFormat)
	slog.SetDefault(logger)
	customlog.L = logger
	slog.Info("BOBOCLOUD Server v2 starting",
		"http_port", cfg.HTTPPort,
		"ws_port", cfg.WSPort,
		"data_dir", cfg.DataDir,
		"auth_enabled", cfg.AuthEnabled,
	)

	// ──── 3. 确保数据目录存在 ────
	os.MkdirAll(cfg.DataDir, 0755)
	os.MkdirAll(filepath.Join(cfg.DataDir, "db"), 0755)
	os.MkdirAll(filepath.Join(cfg.DataDir, "logs"), 0755)
	os.MkdirAll(cfg.ServerRoot, 0755)

	// ──── 4. 加载编译规则 ────
	rulesPath := filepath.Join(execDir, "compile_rules.json")
	if _, err := os.Stat(rulesPath); os.IsNotExist(err) {
		if exePath, err := os.Executable(); err == nil {
			rulesPath = filepath.Join(filepath.Dir(exePath), "compile_rules.json")
		}
	}
	compiler.LoadCompileRules(rulesPath)

	// ──── 5. 初始化核心组件 ────

	// 语言插件注册表（编译/运行计划由插件生成，Docker 与本地模式共用）
	pluginReg := runner.NewPluginRegistry()
	runner.RegisterAllPlugins(pluginReg)
	slog.Info("Language plugins registered", "count", 7)

	// 安全策略：生产环境使用限制性策略（网络按配置放行，命令黑名单防逃逸）
	sec := security.NewRestrictivePolicy(cfg.DockerDefaultNetwork)

	// Channel 管理器
	channelMgr := session.NewChannelManager()

	// ──── 6. BoltDB 持久化（条件启用）───
	var db *bolt.DB
	var sessionStore storage.SessionStore
	var runHistory storage.RunHistoryStore
	var compileActivity storage.CompileActivityStore
	var userStore auth.UserStore
	var authSessions auth.AuthSessionStore
	var invites auth.InviteStore
	var auditStore storage.AuditStore
	var collaborationStore collab.Store
	var lspManager *lsp.Manager
	var dapManager *dap.Manager

	if cfg.DBPath != "" {
		// BoltDB 模式
		var err error
		db, err = bolt.Open(cfg.DBPath, 0600, &bolt.Options{Timeout: 1 * time.Second})
		if err != nil {
			slog.Error("Failed to open BoltDB", "path", cfg.DBPath, "error", err)
			os.Exit(1)
		}
		sessionStore = storage.NewBoltSessionStore(db)
		runHistory = storage.NewBoltRunHistory(db)
		compileActivity = storage.NewBoltCompileActivityStore(db)
		userStore = auth.NewBoltUserStore(db)
		authSessions = auth.NewBoltAuthSessionStore(db)
		invites = auth.NewBoltInviteStore(db)
		auditStore = storage.NewBoltAuditStore(db)
		collaborationStore = collab.NewBoltStore(db)
		slog.Info("BoltDB persistence enabled", "path", cfg.DBPath)
	} else {
		// 内存模式（向后兼容）
		sessionStore = storage.NewMemorySessionStore()
		// runHistory 保持 nil — 内存模式下不保存运行历史
		userStore = auth.NewMemoryUserStore()
		compileActivity = storage.NewMemoryCompileActivityStore()
		authSessions = auth.NewMemoryAuthSessionStore()
		invites = auth.NewMemoryInviteStore()
		collaborationStore = collab.NewMemoryStore()
		slog.Info("BoltDB disabled, using in-memory storage")
	}

	// ──── 8. Docker 容器池 ────
	// queueSize: 最大排队长度，0=禁用排队
	// queueTimeoutSec: 单个请求最大排队秒数
	const queueSize = 50
	const queueTimeoutSec = 60
	dockerPool := docker.NewPool(
		cfg.DockerHotPoolSize,
		cfg.DockerMaxContainers,
		cfg.DockerMaxIdle,
		cfg.DockerMemoryLimit,
		cfg.DockerCPULimit,
		cfg.PoolReplenishDuration(),
		sec,
		queueSize,
		queueTimeoutSec,
		cfg.DockerRegistryMirrors,
		time.Duration(cfg.DockerPullTimeout)*time.Second,
		filepath.Join(cfg.DataDir, "users"),
	)
	dockerPool.SetHardening(cfg.DockerHardening, cfg.DockerReadOnlyRootfs)

	// 清理上次进程异常退出后遗留的孤儿容器
	dockerPool.CleanupOrphanedContainers()

	slog.Info("Docker pool initialized",
		"hot_pool_size", cfg.DockerHotPoolSize,
		"max_total", cfg.DockerMaxContainers,
		"max_idle", cfg.DockerMaxIdle,
		"queue_size", queueSize,
		"queue_timeout_s", queueTimeoutSec,
		"hardening", cfg.DockerHardening,
		"readonly_rootfs", cfg.DockerReadOnlyRootfs,
	)

	// ──── 优雅关闭 ────
	// 收到 SIGINT/SIGTERM：先回收所有容器（避免孤儿泄漏），再关闭 BoltDB，最后退出。
	// 无论是否启用 BoltDB 都注册信号处理（旧版仅 db!=nil 时注册，非 BoltDB 模式无法优雅退出）。
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		slog.Info("Signal received, shutting down", "signal", sig)
		if lspManager != nil {
			lspManager.Close()
		}
		if dapManager != nil {
			dapManager.Close()
		}
		dockerPool.Shutdown()
		if db != nil {
			if err := db.Close(); err != nil {
				slog.Error("Error closing BoltDB", "error", err)
			}
		}
		slog.Info("Shutdown complete, exiting")
		os.Exit(0)
	}()

	// ──── 9. 认证与用户管理 ────
	multiUser := cfg.IsMultiUser()
	authenticator := auth.NewAPIKeyAuth(userStore)

	var createdUsers []*auth.User

	if len(cfg.Users) > 0 {
		// Phase 2: 多用户预配 — 从配置文件批量导入
		seedConfigs := make([]auth.SeedUserConfig, len(cfg.Users))
		for i, uc := range cfg.Users {
			seedConfigs[i] = auth.SeedUserConfig{
				ID:             uc.ID,
				Name:           uc.Name,
				APIKey:         uc.APIKey,
				Role:           uc.Role,
				ContainerLimit: uc.ContainerLimit,
				RateLimit:      uc.RateLimit,
				DiskQuotaMB:    uc.DiskQuotaMB,
			}
		}
		createdUsers = userStore.SeedUsers(seedConfigs)
		slog.Info("Users seeded from config", "count", len(createdUsers))
	} else if !multiUser {
		// 向后兼容：单机模式且无 users 配置时使用 admin_api_key 创建默认用户
		defaultUser := userStore.SeedDefaultUser(cfg.AdminAPIKey)
		// 用配置中的默认值覆盖
		if cfg.DefaultQuota > 0 {
			defaultUser.ContainerLimit = cfg.DefaultQuota
		}
		if cfg.DefaultRateLimit > 0 {
			defaultUser.RateLimit = cfg.DefaultRateLimit
		}
		createdUsers = []*auth.User{defaultUser}
		slog.Info("Default user created", "user_id", defaultUser.ID)
	}

	// 多人模式：确保 root 管理员存在（全系统唯一，由配置/环境变量/自动生成种子）
	if multiUser {
		if rootUser := seedRootUser(cfg, userStore); rootUser != nil {
			createdUsers = append(createdUsers, rootUser)
		}
	}

	// Backfill immutable public UIDs and avatars for accounts created by older
	// versions. Internal IDs remain unchanged because they own workspace paths.
	if err := auth.EnsureSocialIdentities(userStore); err != nil {
		slog.Error("Failed to migrate user social identities", "error", err)
		os.Exit(1)
	}

	teamCache := buildcache.NewManager(filepath.Join(cfg.DataDir, "team-cache"), cfg.TeamCacheDefaultQuotaMB)
	resourceLifecycle := lifecycle.NewManager()
	dependencyViews := lsp.NewDefaultDependencyRegistry()
	if cfg.LSPEnabled {
		lsp.CleanupDockerOrphans()
		lsp.CleanupDependencyMountOrphans(filepath.Join(cfg.DataDir, "lsp-cache", "mounts"))
		manifestPath := lsp.ResolveManifestPath(execDir, cfg.LSPManifestPath)
		catalog, catalogErr := lsp.LoadCatalog(manifestPath)
		if catalogErr != nil {
			slog.Warn("Failed to load LSP manifest; using safe built-in commands", "path", manifestPath, "error", catalogErr)
			catalog = lsp.DefaultCatalog()
		}
		analysisCache := lsp.NewCacheManager(filepath.Join(cfg.DataDir, "lsp-cache"), cfg.LSPCacheQuotaMB, cfg.LSPCacheRetentionDays)
		lspManager = lsp.NewManager(catalog, analysisCache, nil, lsp.ManagerOptions{
			MaxSessions: cfg.LSPMaxSessions, MaxPerUser: cfg.LSPMaxSessionsPerUser,
			IdleTTL:         time.Duration(cfg.LSPIdleTTLSeconds) * time.Second,
			MaxMessageBytes: cfg.LSPMaxMessageBytes,
			MemoryLimit:     cfg.LSPMemoryLimit, CPULimit: cfg.LSPCPULimit,
			DependencyRegistry: dependencyViews,
		})
		slog.Info("Remote LSP initialized", "manifest", manifestPath, "languages", catalog.Languages(), "max_sessions", cfg.LSPMaxSessions, "max_per_user", cfg.LSPMaxSessionsPerUser, "cache_quota_mb", cfg.LSPCacheQuotaMB)
	}
	if cfg.DAPEnabled {
		dap.CleanupDockerOrphans()
		manifestPath := dap.ResolveManifestPath(execDir, cfg.DAPManifestPath)
		catalog, catalogErr := dap.LoadCatalog(manifestPath)
		if catalogErr != nil {
			slog.Error("Remote DAP disabled because its manifest could not be loaded", "path", manifestPath, "error", catalogErr)
		} else {
			dapManager = dap.NewManager(catalog, nil, dap.ManagerOptions{
				MaxSessions: cfg.DAPMaxSessions, MaxPerUser: cfg.DAPMaxSessionsPerUser,
				IdleTTL:         time.Duration(cfg.DAPIdleTTLSeconds) * time.Second,
				MaxSession:      time.Duration(cfg.DAPMaxSessionSeconds) * time.Second,
				MaxMessageBytes: cfg.DAPMaxMessageBytes,
				MemoryLimit:     cfg.DAPMemoryLimit, CPULimit: cfg.DAPCPULimit,
				NetworkEnable: cfg.DAPNetworkEnabled,
			})
			slog.Info("Remote DAP initialized", "manifest", manifestPath, "catalog_version", catalog.Version(), "max_sessions", cfg.DAPMaxSessions, "max_per_user", cfg.DAPMaxSessionsPerUser)
		}
	}
	collaborationManager := collab.NewManager(collaborationStore, userStore, filepath.Join(cfg.DataDir, "teams"))
	if lspManager != nil || dapManager != nil {
		collaborationManager.SetMemberRevokedHook(func(teamID, userID string) error {
			var stopErrors []error
			if lspManager != nil {
				if err := lspManager.StopUserOwner(userID, "team", teamID, ""); err != nil {
					stopErrors = append(stopErrors, fmt.Errorf("stop LSP sessions: %w", err))
				}
			}
			if dapManager != nil {
				if err := dapManager.StopUserOwner(userID, "team", teamID); err != nil {
					stopErrors = append(stopErrors, fmt.Errorf("stop DAP sessions: %w", err))
				}
			}
			return errors.Join(stopErrors...)
		})
	}

	// 同步所有用户的配额到 DockerPool
	for _, u := range createdUsers {
		dockerPool.SetUserLimit(u.ID, u.ContainerLimit)
	}
	slog.Info("Auth initialized",
		"multi_user", multiUser,
		"user_count", len(createdUsers),
	)

	// 异步预热常用镜像（按用户隔离热池：每用户热池容器挂载各自的 /persist 持久化卷）
	// 放在用户预配之后，确保预热知道有哪些用户
	popularImages := []string{
		"python:3.11-slim",
		"python:3.12-slim",
		"openjdk:17-slim",
		"gcc:13",
		"golang:1.23",
	}
	// 预热目标用户：多人模式为所有预配用户；单机模式运行时统一归为 "default" 用户，
	// 只预热 default，避免为不会被使用的用户白白创建容器。
	preWarmUserIDs := make([]string, 0, len(createdUsers))
	if multiUser {
		for _, u := range createdUsers {
			preWarmUserIDs = append(preWarmUserIDs, u.ID)
		}
	} else {
		preWarmUserIDs = append(preWarmUserIDs, "default")
	}
	dockerPool.PreWarmAllForUsers(popularImages, preWarmUserIDs)

	// 打印所有用户的 API Key（方便管理员分发）
	for _, u := range createdUsers {
		slog.Info("User ready",
			"id", u.ID,
			"name", u.Name,
			"api_key", u.APIKey,
			"quota", u.ContainerLimit,
		)
	}

	// ──── 10. 限流器 ────
	var rateLimiter *handler.RateLimiter
	if multiUser && cfg.DefaultRateLimit > 0 {
		rateLimiter = handler.NewRateLimiter(cfg.DefaultRateLimit, cfg.DefaultRateLimit*2)
		slog.Info("Rate limiter enabled", "rate_per_minute", cfg.DefaultRateLimit)
	} else {
		rateLimiter = handler.DisabledLimiter()
		slog.Info("Rate limiter disabled")
	}

	// 登录/注册限速（按 IP，防爆破），多人模式才需要
	var loginLimiter *handler.RateLimiter
	if multiUser && cfg.LoginRateLimit > 0 {
		loginLimiter = handler.NewRateLimiter(cfg.LoginRateLimit, cfg.LoginRateLimit)
		slog.Info("Login rate limiter enabled", "rate_per_minute", cfg.LoginRateLimit)
	}

	// ──── 11. 创建处理器 ────
	httpHandler := handler.NewHTTPHandler(
		cfg,
		sessionStore,
		channelMgr,
		multiUser,
		authenticator,
		userStore,
		makeTerminalExecutor(dockerPool),
		rateLimiter,
		runHistory,
	)
	httpHandler.AuthSessions = authSessions
	httpHandler.Invites = invites
	httpHandler.Audit = auditStore
	httpHandler.CompileActivity = compileActivity
	httpHandler.LoginLimiter = loginLimiter
	httpHandler.Version = ServerVersion
	httpHandler.Collaboration = collaborationManager
	httpHandler.BuildCache = teamCache
	httpHandler.LSP = lspManager
	httpHandler.DAP = dapManager
	httpHandler.DependencyViews = dependencyViews
	httpHandler.Lifecycle = resourceLifecycle
	httpHandler.EnvironmentSetup = makeEnvironmentSetupExecutor(dockerPool, sec)
	httpHandler.OnBuildCacheCleared = dockerPool.InvalidateIdleBuildCacheContainers
	httpHandler.SetUserLimit = func(userID string, limit int) {
		dockerPool.SetUserLimit(userID, limit)
	}
	httpHandler.OnUserDeleted = func(userID string) error {
		var stopErrors []error
		if lspManager != nil {
			if err := lspManager.StopUser(userID); err != nil {
				stopErrors = append(stopErrors, fmt.Errorf("stop LSP sessions: %w", err))
			}
		}
		if dapManager != nil {
			if err := dapManager.StopUser(userID); err != nil {
				stopErrors = append(stopErrors, fmt.Errorf("stop DAP sessions: %w", err))
			}
		}
		if err := errors.Join(stopErrors...); err != nil {
			return err
		}
		if lspManager != nil {
			if _, err := lspManager.ClearCache("user", userID, "all", "", ""); err != nil {
				return err
			}
		}
		// 销毁该用户的所有活跃容器
		dockerPool.DestroyUserContainers(userID)
		// 删除用户数据目录（workspaces + persist + temp）
		userDir := filepath.Join(cfg.DataDir, "users", userID)
		if err := os.RemoveAll(userDir); err != nil {
			slog.Error("Failed to delete user data directory",
				"user_id", userID, "path", userDir, "error", err)
			return fmt.Errorf("delete user data directory: %w", err)
		} else {
			slog.Info("User data directory deleted", "user_id", userID, "path", userDir)
		}
		return nil
	}
	// Cleanup jobs survive process restarts and are retried only after every
	// dependency used by the idempotent cleanup pipeline is wired.
	httpHandler.RetryPendingUserDeletions()

	wsHandler := &handler.WSHandler{
		Config:          cfg,
		Sessions:        sessionStore,
		Channels:        channelMgr,
		DockerPool:      dockerPool,
		Plugins:         pluginReg,
		Security:        sec,
		AuthEnabled:     multiUser,
		RunHistory:      runHistory,
		Authenticator:   authenticator,
		UserStore:       userStore,
		AuthSessions:    authSessions,
		Collaboration:   collaborationManager,
		BuildCache:      teamCache,
		LSP:             lspManager,
		DependencyViews: dependencyViews,
		Lifecycle:       resourceLifecycle,
	}
	dapHandler := &handler.DAPHandler{
		Config: cfg, Manager: dapManager, AuthEnabled: multiUser,
		Authenticator: authenticator, UserStore: userStore, AuthSessions: authSessions,
		Collaboration: collaborationManager, Lifecycle: resourceLifecycle,
	}

	// ──── 12. 后台任务 ────
	// 会话清理
	go cleanupLoop(context.Background(), sessionStore, channelMgr, cfg.SessionCleanupDuration(), cfg.SessionTTLDuration())
	// Activity is compacted independently of run history so inactive accounts
	// cannot retain daily counters beyond the heatmap window indefinitely.
	if err := compileActivity.Cleanup(time.Now()); err != nil {
		slog.Warn("Initial compile activity cleanup failed", "error", err)
	}
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for now := range ticker.C {
			if err := compileActivity.Cleanup(now); err != nil {
				slog.Warn("Compile activity cleanup failed", "error", err)
			}
		}
	}()
	// 运行历史清理（BoltDB 模式，每 5 分钟）
	if runHistory != nil {
		go func() {
			ticker := time.NewTicker(5 * time.Minute)
			defer ticker.Stop()
			slog.Info("Run history cleanup started", "interval", "5m",
				"max_per_user", cfg.HistoryMaxPerUser, "max_age", "7d", "max_total", 10000)
			for range ticker.C {
				runHistory.Cleanup(cfg.HistoryMaxPerUser, 7*24*time.Hour, 10000)
			}
		}()
	}
	go teamCacheCleanupLoop(teamCache, collaborationStore, time.Duration(cfg.TeamCacheCleanupIntervalMin)*time.Minute)
	// 审计日志清理（保留 90 天 / 最多 20000 条，每小时）
	if auditStore != nil {
		go func() {
			ticker := time.NewTicker(time.Hour)
			defer ticker.Stop()
			for range ticker.C {
				auditStore.Cleanup(20000, 90*24*time.Hour)
			}
		}()
	}
	// 登录会话过期清理（每 10 分钟）
	if authSessions != nil {
		go func() {
			ticker := time.NewTicker(10 * time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				authSessions.CleanupExpired()
			}
		}()
	}
	// 限流器旧桶清理（每 5 分钟）
	if rateLimiter != nil {
		go func() {
			ticker := time.NewTicker(5 * time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				rateLimiter.CleanupExpired(10 * time.Minute)
			}
		}()
	}

	// ──── 13. 启动服务 ────
	// WebSocket 服务（端口 3101）
	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/ws", wsHandler.HandleWebSocket)
		mux.HandleFunc("/term", wsHandler.HandleTerminalWebSocket)
		mux.HandleFunc("/lsp", wsHandler.HandleLSPWebSocket)
		mux.HandleFunc("/dap", dapHandler.HandleWebSocket)
		addr := fmt.Sprintf(":%d", cfg.WSPort)
		slog.Info("WebSocket server starting", "addr", addr)
		if err := http.ListenAndServe(addr, mux); err != nil {
			slog.Error("WebSocket server failed", "error", err)
			if db != nil {
				db.Close()
			}
			os.Exit(1)
		}
	}()

	// HTTP API 服务（端口 3100）。LSP 同时复用该已公开端口；独立的
	// WebSocket 端口仍保留 /lsp，兼容旧客户端和内网部署。
	addr := fmt.Sprintf(":%d", cfg.HTTPPort)
	slog.Info("HTTP server starting", "addr", addr)
	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/lsp", wsHandler.HandleLSPWebSocket)
	httpMux.HandleFunc("/dap", dapHandler.HandleWebSocket)
	httpMux.Handle("/", httpHandler)
	if err := http.ListenAndServe(addr, httpMux); err != nil {
		slog.Error("HTTP server failed", "error", err)
		if db != nil {
			db.Close()
		}
		os.Exit(1)
	}
}

// ──── 后台协程 ────

// cleanupLoop 定期清理过期的会话
func cleanupLoop(ctx context.Context, store storage.SessionStore, channels *session.ChannelManager, interval, ttl time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	slog.Info("Session cleanup started", "interval", interval, "ttl", ttl)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			handler.CleanupExpiredRuns(store, channels, ttl)
		}
	}
}

func teamCacheCleanupLoop(cache *buildcache.Manager, store collab.Store, interval time.Duration) {
	if cache == nil || store == nil {
		return
	}
	if interval <= 0 {
		interval = 10 * time.Minute
	}
	run := func() {
		teams, err := store.ListTeams()
		if err != nil {
			slog.Warn("Failed to list teams for cache cleanup", "error", err)
			return
		}
		for _, team := range teams {
			before := cache.Inspect(team.ID, team.CacheQuotaMB)
			cache.CleanScratch(team.ID)
			cache.PruneExpired(team.ID, team.CacheRetentionDays, team.CacheQuotaMB)
			after := cache.Enforce(team.ID, team.CacheQuotaMB)
			if after.TotalBytes < before.TotalBytes {
				slog.Info("Team build cache pruned", "team_id", team.ID, "before_bytes", before.TotalBytes, "after_bytes", after.TotalBytes, "quota_bytes", after.QuotaBytes)
			}
		}
	}
	run()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		run()
	}
}

// seedRootUser 多人模式下确保 root 管理员存在。
// 密码优先级：root_user.password > 环境变量 BOBOCLOUD_ROOT_PASSWORD > 自动生成（打印到日志，仅首次可见）。
// 声明式密码：若 root_user.password 非空，每次启动都确保 root 密码等于该值
// （不存在则创建，存在则覆盖密码哈希）——管理员无需注册即可用配置中的默认密码登录。
// 若 root_user.password 留空，则仅首次启动自动生成随机密码，之后不再覆盖（管理员可自行修改密码）。
func seedRootUser(cfg *config.Config, userStore auth.UserStore) *auth.User {
	users, err := userStore.List()
	if err == nil {
		for _, u := range users {
			if u.EffectiveRole() == auth.RoleRoot {
				// root 已存在。若配置声明了密码，则把密码同步为配置值（声明式 root 密码）。
				if cfg.RootUser.Password != "" {
					hash, hErr := auth.HashPassword(cfg.RootUser.Password)
					if hErr != nil {
						slog.Error("Failed to hash root password from config", "error", hErr)
					} else if hash != u.PasswordHash {
						u.PasswordHash = hash
						if cErr := userStore.Create(u); cErr != nil {
							slog.Error("Failed to sync root password from config", "error", cErr)
						} else {
							slog.Info("Root password synced from config (declarative override)", "username", u.Username)
						}
					}
				}
				slog.Info("Root account already exists", "username", u.Username)
				return nil
			}
		}
	}

	username := cfg.RootUser.Username
	if username == "" {
		username = "root"
	}
	name := cfg.RootUser.Name
	if name == "" {
		name = "Root Admin"
	}
	password := cfg.RootUser.Password
	generated := false
	if password == "" {
		password = auth.GeneratePassword()
		generated = true
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		slog.Error("Failed to hash root password", "error", err)
		return nil
	}

	rootUser := &auth.User{
		ID:             username,
		Username:       username,
		Email:          cfg.RootUser.Email,
		Name:           name,
		PasswordHash:   hash,
		Role:           auth.RoleRoot,
		APIKey:         "bobo_" + auth.GenerateToken(),
		ContainerLimit: 20,
		RateLimit:      300,
		DiskQuotaMB:    0, // root 不限磁盘
		CreatedAt:      time.Now(),
	}
	if err := userStore.Create(rootUser); err != nil {
		slog.Error("Failed to create root user", "error", err)
		return nil
	}

	if generated {
		// 自动生成的密码只在此处出现一次，请立即登录修改
		slog.Info("════════════════════════════════════════════════════════")
		slog.Info(" ROOT ACCOUNT CREATED — save this password NOW:")
		slog.Info("   username: " + username)
		slog.Info("   password: " + password)
		slog.Info(" (change it after first login; it will NOT be shown again)")
		slog.Info("════════════════════════════════════════════════════════")
	} else {
		slog.Info("Root account created from config (declarative password)", "username", username)
	}
	return rootUser
}

// ──── Terminal 桥接 ────

// makeTerminalExecutor 创建终端命令执行器（桥接 DockerPool → HTTP handler）
func makeTerminalExecutor(pool *docker.Pool) handler.TerminalExecutor {
	return func(ctx context.Context, userID, runtimeID, command string) (stdout, stderr string, exitCode int, err error) {
		rt := model.GetRuntimeDef(runtimeID)
		if rt == nil {
			return "", "", 0, fmt.Errorf("unknown runtime: %s", runtimeID)
		}

		// 与 RunPlan 路径一致：自动给 pip install 追加 --target /persist/pip-packages，
		// 使终端安装的包持久化到用户卷，而非随容器释放而丢失。
		command = runner.AutoPersistPip(command)

		containerID, err := pool.AcquireForUser(ctx, userID, rt.DockerImage, nil)
		if err != nil {
			return "", "", 0, fmt.Errorf("failed to acquire container: %w", err)
		}
		defer pool.ReleaseForUser(containerID, userID)

		stdout, stderr, exitCode, err = pool.Exec(ctx, containerID,
			[]string{"sh", "-c", command}, "/workspace")
		return
	}
}

// makeEnvironmentSetupExecutor reuses the runner's Docker pool, persistence
// environment, workspace copy, and command policy. The HTTP request can select
// only a server-generated plan; it cannot supply these commands directly.
func makeEnvironmentSetupExecutor(pool *docker.Pool, policy security.Policy) handler.EnvironmentSetupExecutor {
	return func(ctx context.Context, userID, runtimeID, workspaceRoot string, commands []string) (stdout, stderr string, exitCode int, err error) {
		rt := model.GetRuntimeDef(runtimeID)
		if rt == nil {
			return "", "", 0, fmt.Errorf("unknown runtime: %s", runtimeID)
		}
		if rt.Language != "python" {
			return "", "", 0, fmt.Errorf("controlled environment setup is not available for %s", rt.Language)
		}
		if len(commands) == 0 || len(commands) > 4 {
			return "", "", 0, fmt.Errorf("invalid environment setup plan")
		}
		isolatedRoot, tempErr := os.MkdirTemp("", "environment-setup-")
		if tempErr != nil {
			return "", "", 0, fmt.Errorf("create environment workspace: %w", tempErr)
		}
		defer os.RemoveAll(isolatedRoot)
		if copyErr := files.CopyProjectToTemp(workspaceRoot, isolatedRoot); copyErr != nil {
			return "", "", 0, fmt.Errorf("copy isolated environment workspace: %w", copyErr)
		}
		containerID, err := pool.AcquireForUser(ctx, userID, rt.DockerImage, nil)
		if err != nil {
			return "", "", 0, fmt.Errorf("failed to acquire container: %w", err)
		}
		defer pool.ReleaseForUser(containerID, userID)
		if _, _, _, err := pool.Exec(ctx, containerID, []string{"mkdir", "-p", "/workspace"}, "/"); err != nil {
			return "", "", 0, fmt.Errorf("prepare environment workspace: %w", err)
		}
		copyCommand := exec.CommandContext(ctx, "docker", "cp", filepath.Clean(isolatedRoot)+string(os.PathSeparator)+".", containerID+":/workspace")
		if output, copyErr := copyCommand.CombinedOutput(); copyErr != nil {
			return "", string(output), 0, fmt.Errorf("copy environment workspace: %w", copyErr)
		}
		var stdoutBuilder, stderrBuilder strings.Builder
		for _, command := range commands {
			if !policy.AllowCommand(command) {
				return stdoutBuilder.String(), stderrBuilder.String(), 0, fmt.Errorf("environment setup command was rejected by policy")
			}
			command = policy.FilterCommand(runner.AutoPersistPip(command))
			stepOut, stepErr, code, execErr := pool.Exec(ctx, containerID, []string{"sh", "-c", command}, "/workspace")
			stdoutBuilder.WriteString(stepOut)
			stderrBuilder.WriteString(stepErr)
			if execErr != nil || code != 0 {
				return stdoutBuilder.String(), stderrBuilder.String(), code, execErr
			}
		}
		return stdoutBuilder.String(), stderrBuilder.String(), 0, nil
	}
}
