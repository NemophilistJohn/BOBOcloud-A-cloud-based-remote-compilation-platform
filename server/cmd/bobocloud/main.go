package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
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
	"bobocloud-server/internal/hostresource"
	"bobocloud-server/internal/lifecycle"
	customlog "bobocloud-server/internal/log"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/metrics"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/nodetoolchain"
	"bobocloud-server/internal/packagecatalog"
	"bobocloud-server/internal/packageops"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/resourcecontrol"
	"bobocloud-server/internal/rootbootstrap"
	"bobocloud-server/internal/runner"
	"bobocloud-server/internal/safefile"
	"bobocloud-server/internal/security"
	"bobocloud-server/internal/serverruntime"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"

	bolt "go.etcd.io/bbolt"
)

// ServerVersion 服务端版本号（serverInfo/whoami 返回，客户端用于兼容性判断）
const ServerVersion = "2.5.0"

type dependencyRecoverySteps struct {
	cleanupManagedContainers func(context.Context) error
	cleanupLSPContainers     func(context.Context) error
	cleanupLSPMounts         func(context.Context, string) error
	cleanupDAPContainers     func(context.Context) error
	cleanupDAPMounts         func(context.Context, string) error
	recoverTransactions      func(context.Context) error
}

type userContainerDestroyer interface {
	DestroyUserContainers(string) error
}

type userContainerContextDestroyer interface {
	DestroyUserContainersContext(context.Context, string) error
}

type runtimeShutdowner interface {
	Shutdown(context.Context) error
}

const (
	shutdownRetryInitialDelay = 20 * time.Millisecond
	shutdownRetryMaximumDelay = 250 * time.Millisecond
)

// finishRuntimeShutdown keeps advancing retryable stopSteps within one caller
// grace period. Runtime.Shutdown may return at an intermediate phase checkpoint
// to preserve dependency ordering even though the caller still has time left.
func finishRuntimeShutdown(ctx context.Context, runtime runtimeShutdowner, initialDelay time.Duration) error {
	if runtime == nil {
		return errors.New("server runtime is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if initialDelay <= 0 {
		initialDelay = shutdownRetryInitialDelay
	}
	if initialDelay > shutdownRetryMaximumDelay {
		initialDelay = shutdownRetryMaximumDelay
	}
	delay := initialDelay
	var firstErr error
	var lastErr error
	attempts := 0
	for {
		attempts++
		lastErr = runtime.Shutdown(ctx)
		if lastErr == nil {
			return nil
		}
		if firstErr == nil {
			firstErr = lastErr
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return fmt.Errorf("server shutdown incomplete after %d attempts: %w", attempts, errors.Join(firstErr, lastErr, ctxErr))
		}
		// A non-cancellable context gives ordinary permanent errors no natural
		// upper bound. Preserve the one-attempt behavior for such callers.
		if ctx.Done() == nil {
			return lastErr
		}

		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return fmt.Errorf("server shutdown incomplete after %d attempts: %w", attempts, errors.Join(firstErr, lastErr, ctx.Err()))
		}
		if delay < shutdownRetryMaximumDelay {
			delay *= 2
			if delay > shutdownRetryMaximumDelay {
				delay = shutdownRetryMaximumDelay
			}
		}
	}
}

func removeUserDataAfterContainerCleanup(destroyer userContainerDestroyer, userID, dataDir string) error {
	return removeUserDataAfterContainerCleanupContext(context.Background(), destroyer, userID, dataDir)
}

func removeUserDataAfterContainerCleanupContext(ctx context.Context, destroyer userContainerDestroyer, userID, dataDir string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	userDir, err := auth.UserDataRoot(dataDir, userID)
	if err != nil {
		return fmt.Errorf("resolve user data directory: %w", err)
	}
	var destroyErr error
	if contextual, ok := destroyer.(userContainerContextDestroyer); ok {
		destroyErr = contextual.DestroyUserContainersContext(ctx, userID)
	} else {
		destroyErr = destroyer.DestroyUserContainers(userID)
	}
	if destroyErr != nil {
		return fmt.Errorf("destroy user containers before deleting data: %w", destroyErr)
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("delete user data directory: %w", err)
	}
	if err := os.RemoveAll(userDir); err != nil {
		return fmt.Errorf("delete user data directory: %w", err)
	}
	return nil
}

// recoverDependencyRuntimeState is intentionally independent of feature
// enablement. A previous binary may have left analyzer/debugger containers or
// mount anchors behind even when the current configuration disables them.
func recoverDependencyRuntimeState(ctx context.Context, dataDir string, steps dependencyRecoverySteps) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := steps.cleanupManagedContainers(ctx); err != nil {
		return fmt.Errorf("cleanup managed Docker containers: %w", err)
	}
	if err := steps.cleanupLSPContainers(ctx); err != nil {
		return fmt.Errorf("cleanup Docker LSP containers: %w", err)
	}
	if err := steps.cleanupDAPContainers(ctx); err != nil {
		return fmt.Errorf("cleanup Docker DAP containers: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := steps.cleanupLSPMounts(ctx, filepath.Join(dataDir, "lsp-cache", "mounts")); err != nil {
		return fmt.Errorf("cleanup LSP dependency projections: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := steps.cleanupDAPMounts(ctx, filepath.Join(dataDir, "dap-cache", "mounts")); err != nil {
		return fmt.Errorf("cleanup DAP dependency projections: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := steps.recoverTransactions(ctx); err != nil {
		return fmt.Errorf("recover personal dependency transactions: %w", err)
	}
	return ctx.Err()
}

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
	if cfg.TLSEnabled {
		if !filepath.IsAbs(cfg.TLSCertFile) {
			cfg.TLSCertFile = filepath.Join(execDir, cfg.TLSCertFile)
		}
		if !filepath.IsAbs(cfg.TLSKeyFile) {
			cfg.TLSKeyFile = filepath.Join(execDir, cfg.TLSKeyFile)
		}
		if _, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile); err != nil {
			fmt.Fprintf(os.Stderr, "Failed to load TLS certificate: %v\n", err)
			os.Exit(1)
		}
	}

	// ──── 2. 初始化日志 ────
	logger := customlog.NewLogger(cfg.LogLevel, cfg.LogFormat)
	slog.SetDefault(logger)
	customlog.L = logger
	signalCtx, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	serverRuntime := serverruntime.New(signalCtx)
	shutdownStartupAndExit := func(cause error) {
		serverRuntime.BeginDrain(cause)
		stopSignals()
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.ShutdownGracePeriod())
		shutdownErr := finishRuntimeShutdown(shutdownCtx, serverRuntime, shutdownRetryInitialDelay)
		cancelShutdown()
		if shutdownErr != nil {
			slog.Error("Startup shutdown did not complete", "error", shutdownErr, "grace_period", cfg.ShutdownGracePeriod())
		}
		os.Exit(1)
	}
	slog.Info("BOBOCLOUD Server v2 starting",
		"http_port", cfg.HTTPPort,
		"ws_port", cfg.WSPort,
		"dap_child_ws_port", cfg.DAPChildWSPort,
		"tls_enabled", cfg.TLSEnabled,
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
			shutdownStartupAndExit(err)
			return
		}
		boltSessionStore, err := storage.NewBoltSessionStore(db)
		if err != nil {
			_ = db.Close()
			slog.Error("Failed to initialize run session persistence", "error", err)
			shutdownStartupAndExit(err)
			return
		}
		sessionStore = boltSessionStore
		runHistory = storage.NewBoltRunHistory(db)
		compileActivity = storage.NewBoltCompileActivityStore(db)
		userStore = auth.NewBoltUserStore(db)
		authSessions = auth.NewBoltAuthSessionStore(db)
		invites = auth.NewBoltInviteStore(db)
		auditStore = storage.NewBoltAuditStore(db)
		collaborationStore = collab.NewBoltStore(db)
		slog.Info("BoltDB persistence enabled", "path", cfg.DBPath)
		if err := serverRuntime.RegisterStopHook(serverruntime.PhaseStorage, "bolt-database", func(context.Context) error {
			return db.Close()
		}); err != nil {
			_ = db.Close()
			slog.Error("Failed to register database shutdown", "error", err)
			shutdownStartupAndExit(err)
			return
		}
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
	staleRunIDs, err := sessionStore.DeleteAllProcessSessions()
	if err != nil {
		slog.Error("Failed to recover process-bound run sessions", "error", err)
		shutdownStartupAndExit(err)
		return
	}
	if len(staleRunIDs) > 0 {
		slog.Warn("Recovered stale run sessions from a previous process", "count", len(staleRunIDs))
	}
	if err := serverRuntime.RegisterStopHook(serverruntime.PhaseServices, "run-session-store", func(ctx context.Context) error {
		ids, err := sessionStore.DeleteAllProcessSessions()
		if err != nil {
			return err
		}
		for _, runID := range ids {
			if channel := channelMgr.GetOrCreate(runID, false); channel != nil {
				channel.Close()
				channelMgr.RemoveIfCurrent(runID, channel)
			}
		}
		return nil
	}); err != nil {
		slog.Error("Failed to register run session shutdown", "error", err)
		shutdownStartupAndExit(err)
		return
	}

	// ──── 8. Docker 容器池 ────
	performanceMetrics := metrics.New(cfg.PerformanceMetricsEnabled, cfg.PerformanceMetricsWindow)
	detectedResources := hostresource.Detect(cfg.DataDir)
	resourceController, resourceBuildInfo, err := resourcecontrol.Build(cfg, detectedResources, performanceMetrics)
	if err != nil {
		slog.Error("Failed to initialize resource governance", "error", err)
		shutdownStartupAndExit(err)
		return
	}
	if resourceController != nil {
		node := resourceBuildInfo.Node
		slog.Info("Resource governance initialized",
			"mode", resourceBuildInfo.Mode,
			"slots", node.Capacity.Slots,
			"docker_containers", node.Capacity.DockerContainers,
			"cpu_millicores", node.Capacity.CPUMillicores,
			"memory_bytes", node.Capacity.MemoryBytes,
			"pids", node.Capacity.PIDs,
			"ephemeral_bytes", node.Capacity.EphemeralBytes,
			"inodes", node.Capacity.Inodes,
			"cpu_origin", detectedResources.CPUOrigin,
			"memory_origin", detectedResources.MemoryOrigin,
			"storage_origin", detectedResources.StorageOrigin,
			"fair_queue", resourceController.QueueEnabled(),
		)
		stopResourceDrain := context.AfterFunc(serverRuntime.Context(), func() {
			resourceController.BeginDrain(context.Cause(serverRuntime.Context()))
		})
		if err := serverRuntime.RegisterStopHook(serverruntime.PhaseServices, "resource-admission", func(context.Context) error {
			stopResourceDrain()
			resourceController.Close()
			return nil
		}); err != nil {
			stopResourceDrain()
			resourceController.Close()
			slog.Error("Failed to register resource admission shutdown", "error", err)
			shutdownStartupAndExit(err)
			return
		}
	} else {
		slog.Info("Resource governance disabled", "mode", resourceBuildInfo.Mode)
	}
	runner.SetOutputRetentionLimit(cfg.RunOutputRetainedBytes)
	dockerQueueSize := cfg.DockerQueueSize
	dockerQueueOwner := "docker_pool"
	if resourceController != nil && resourceController.QueueEnabled() {
		// Docker capacity is represented by the docker_containers resource.
		// Keeping the legacy FIFO enabled would queue a request twice while it
		// already owns a global resource lease.
		dockerQueueSize = 0
		dockerQueueOwner = "resource_governance"
	}
	dockerPool := docker.NewPool(
		cfg.DockerHotPoolSize,
		cfg.DockerMaxContainers,
		cfg.DockerMaxIdle,
		cfg.DockerMemoryLimit,
		cfg.DockerCPULimit,
		cfg.PoolReplenishDuration(),
		sec,
		dockerQueueSize,
		cfg.DockerQueueTimeoutSeconds,
		cfg.DockerRegistryMirrors,
		time.Duration(cfg.DockerPullTimeout)*time.Second,
		filepath.Join(cfg.DataDir, "users"),
	)
	dockerPool.SetHardening(cfg.DockerHardening, cfg.DockerReadOnlyRootfs)
	dockerPool.SetResetStrategy(cfg.DockerContainerResetStrategy)
	dockerPool.SetMetrics(performanceMetrics)
	dockerPool.SetOutputRetentionLimit(cfg.RunOutputRetainedBytes)
	if err := serverRuntime.RegisterStopHook(serverruntime.PhaseResources, "docker-pool", func(ctx context.Context) error {
		return dockerPool.ShutdownContext(ctx)
	}); err != nil {
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.ShutdownGracePeriod())
		_ = dockerPool.ShutdownContext(shutdownCtx)
		cancelShutdown()
		slog.Error("Failed to register Docker shutdown", "error", err)
		shutdownStartupAndExit(err)
		return
	}
	personalCache := personalcache.NewManager(cfg.DataDir, personalcache.Options{
		ReservationBytes:          int64(cfg.PersonalPersistReservationMB) * 1_000_000,
		MaxFiles:                  cfg.PersonalPersistMaxFiles,
		ReservationFiles:          cfg.PersonalPersistReservationFiles,
		MaxGenerations:            cfg.PersonalCacheMaxGenerations,
		ScanInterval:              cfg.PersonalPersistScanInterval(),
		Retention:                 cfg.PersonalPersistRetention(),
		NodeMaterializationPolicy: personalcache.NodeDependencyMaterializationPolicy(cfg.PackageNodeInstallScripts, cfg.PackageNodePNPMVersion),
		Metrics:                   performanceMetrics,
		OnEvicted:                 dockerPool.InvalidateIdleBuildCacheContainers,
		OnGenerationChanged:       dockerPool.InvalidateIdlePersonalDependencyContainers,
	})
	// Recovery can rename or delete transaction directories. It is safe only
	// after every old writer/reader container is confirmed absent and every
	// analyzer/debugger projection is confirmed unmounted.
	if err := recoverDependencyRuntimeState(serverRuntime.Context(), cfg.DataDir, dependencyRecoverySteps{
		cleanupManagedContainers: dockerPool.CleanupOrphanedContainersContext,
		cleanupLSPContainers:     lsp.CleanupDockerOrphansContext,
		cleanupLSPMounts:         lsp.CleanupDependencyMountOrphansContext,
		cleanupDAPContainers:     dap.CleanupDockerOrphansContext,
		cleanupDAPMounts:         dap.CleanupDependencyMountOrphansContext,
		recoverTransactions:      personalCache.RecoverOrphanedTransactionsContext,
	}); err != nil {
		slog.Error("Cannot safely recover personal dependency transactions", "error", err)
		shutdownStartupAndExit(err)
		return
	}

	slog.Info("Docker pool initialized",
		"hot_pool_size", cfg.DockerHotPoolSize,
		"max_total", cfg.DockerMaxContainers,
		"max_idle", cfg.DockerMaxIdle,
		"queue_size", dockerQueueSize,
		"queue_owner", dockerQueueOwner,
		"queue_timeout_s", cfg.DockerQueueTimeoutSeconds,
		"hardening", cfg.DockerHardening,
		"readonly_rootfs", cfg.DockerReadOnlyRootfs,
		"reset_strategy", cfg.DockerContainerResetStrategy,
	)

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
		// Persist configured defaults rather than changing only the startup copy.
		// This keeps account APIs and Docker admission on the same source of truth.
		if cfg.DefaultQuota > 0 || cfg.DefaultRateLimit > 0 {
			updatedDefault, updateErr := userStore.MutateExisting(defaultUser.ID, func(latest *auth.User) error {
				if cfg.DefaultQuota > 0 {
					latest.ContainerLimit = cfg.DefaultQuota
				}
				if cfg.DefaultRateLimit > 0 {
					latest.RateLimit = cfg.DefaultRateLimit
				}
				return nil
			})
			if updateErr != nil {
				slog.Error("Failed to persist default user limits", "error", updateErr)
				shutdownStartupAndExit(updateErr)
				return
			}
			defaultUser = updatedDefault
		}
		createdUsers = []*auth.User{defaultUser}
		slog.Info("Default user created", "user_id", defaultUser.ID)
	}

	// 多人模式：确保 root 管理员存在（全系统唯一，由配置/环境变量/自动生成种子）
	if multiUser {
		rootUser, seedErr := seedRootUser(cfg, userStore)
		if seedErr != nil {
			slog.Error("Failed to initialize root account", "error", seedErr)
			shutdownStartupAndExit(seedErr)
			return
		}
		if rootUser != nil {
			createdUsers = append(createdUsers, rootUser)
		}
	}

	// Backfill immutable public UIDs and avatars for accounts created by older
	// versions. Internal IDs remain unchanged because they own workspace paths.
	if err := auth.EnsureSocialIdentities(userStore); err != nil {
		slog.Error("Failed to migrate user social identities", "error", err)
		shutdownStartupAndExit(err)
		return
	}

	teamCache := buildcache.NewManager(teamCacheV2Root(cfg.DataDir), cfg.TeamCacheDefaultQuotaMB)
	resourceLifecycle := lifecycle.NewManager()
	dependencyViews := lsp.NewDefaultDependencyRegistry()
	if cfg.LSPEnabled {
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
			ResourceController: resourceController,
		})
		if err := serverRuntime.RegisterStopHook(serverruntime.PhaseServices, "lsp-manager", func(ctx context.Context) error {
			return lspManager.CloseContext(ctx)
		}); err != nil {
			lspManager.Close()
			slog.Error("Failed to register LSP shutdown", "error", err)
			shutdownStartupAndExit(err)
			return
		}
		slog.Info("Remote LSP initialized", "manifest", manifestPath, "languages", catalog.Languages(), "max_sessions", cfg.LSPMaxSessions, "max_per_user", cfg.LSPMaxSessionsPerUser, "cache_quota_mb", cfg.LSPCacheQuotaMB)
	}
	if cfg.DAPEnabled {
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
				NetworkEnable:      cfg.DAPNetworkEnabled,
				ResourceController: resourceController,
			})
			if err := serverRuntime.RegisterStopHook(serverruntime.PhaseServices, "dap-manager", func(ctx context.Context) error {
				return dapManager.CloseContext(ctx)
			}); err != nil {
				dapManager.Close()
				slog.Error("Failed to register DAP shutdown", "error", err)
				shutdownStartupAndExit(err)
				return
			}
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

	// Persistent users, not just accounts touched by this startup's seed config,
	// are the runtime quota source of truth after every process restart.
	currentUsers, err := synchronizeUserContainerLimits(userStore, dockerPool.SetUserLimit)
	if err != nil {
		slog.Error("Failed to initialize user container limits", "error", err)
		shutdownStartupAndExit(err)
		return
	}
	slog.Info("Auth initialized",
		"multi_user", multiUser,
		"user_count", len(currentUsers),
	)

	// cache-v2 mounts are bound to an exact project/toolchain identity, so the
	// old generic per-user prewarm path cannot construct a reusable container.
	slog.Info("Generic user hot-pool prewarming disabled for cache-v2 project mounts; exact-context idle reuse remains enabled")

	// Startup logs are retained by systemd/journald. Never put reusable
	// credentials in them; administrators distribute API keys through the
	// authenticated account flow instead.
	for _, u := range currentUsers {
		slog.Info("User ready",
			"id", u.ID,
			"name", u.Name,
			"api_key_configured", u.APIKey != "",
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
		loginLimiter = handler.NewRateLimiterWithCapacity(cfg.LoginRateLimit, cfg.LoginRateLimit, 4096)
		slog.Info("Login rate limiter enabled", "rate_per_minute", cfg.LoginRateLimit)
	}

	// Mutable runtime tags are resolved to immutable image identities once and
	// shared by run, terminal, LSP, DAP, and package-center cache requests.
	runtimeMetadata := handler.NewDockerImageRuntimeMetadataProvider(
		time.Duration(cfg.PackageRuntimeMetadataTTLSeconds)*time.Second,
		time.Duration(cfg.PackageRuntimeProbeTimeoutSeconds)*time.Second,
	)

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
	httpHandler.PersonalCache = personalCache
	httpHandler.RuntimeMetadata = runtimeMetadata
	httpHandler.Resources = resourceController
	packagePlans, planStoreErr := packageops.NewPersistentStoreWithLimits(
		time.Duration(cfg.PackagePlanTTLSeconds)*time.Second,
		time.Duration(cfg.PackagePlanCompletedTTLSeconds)*time.Second,
		packageops.StoreLimits{
			MaxPlans: cfg.PackageOperationMaxPlans, MaxPlansPerUser: cfg.PackageOperationMaxPlansPerUser,
			MaxBytes: cfg.PackagePlanStoreMaxBytes, MaxBytesPerUser: cfg.PackagePlanStoreMaxBytesPerUser,
			MaxResultBytes: cfg.PackagePlanResultMaxBytes,
		},
		filepath.Join(cfg.DataDir, "package-plans", "completed"),
	)
	if planStoreErr != nil {
		slog.Error("Failed to initialize package operation persistence", "error", planStoreErr)
		shutdownStartupAndExit(planStoreErr)
		return
	}
	httpHandler.PackagePlans = packagePlans
	if cfg.PackageCenterEnabled {
		httpHandler.PackageCatalog = packagecatalog.NewWithDefaults(
			cfg.PackageSources,
			cfg.PackageDefaultSources,
			time.Duration(cfg.PackageCatalogTimeoutSeconds)*time.Second,
			cfg.PackageCatalogMaxResponseBytes,
		)
	}
	httpHandler.Metrics = performanceMetrics
	httpHandler.Readiness = serverReadinessProbe(db, dockerPool, cfg, lspManager, dapManager)
	httpHandler.Accepting = serverRuntime.IsAccepting
	httpHandler.AcquireWork = serverRuntime.Acquire
	httpHandler.EnvironmentSetup = makeEnvironmentSetupExecutor(dockerPool, sec, files.ProjectCopyLimits{
		MaxFiles: cfg.WorkspaceCopyMaxFiles, MaxTotalBytes: cfg.WorkspaceCopyMaxTotalBytes,
		MaxPathBytes: cfg.WorkspaceCopyMaxPathBytes,
	})
	httpHandler.PackageLockResolver = makePackageLockResolver(dockerPool, sec, cfg.PackageNodePNPMVersion)
	httpHandler.OnBuildCacheCleared = dockerPool.InvalidateIdleBuildCacheContainers
	httpHandler.OnPersonalCacheCleared = dockerPool.InvalidateIdleBuildCacheContainers
	httpHandler.SetUserLimit = func(userID string, limit int) {
		dockerPool.SetUserLimit(userID, limit)
	}
	cleanupDeletedUserResources := func(ctx context.Context, userID string) error {
		if ctx == nil {
			ctx = context.Background()
		}
		userDir, identityErr := auth.UserDataRoot(cfg.DataDir, userID)
		if identityErr != nil {
			return fmt.Errorf("reject unsafe user cleanup identity: %w", identityErr)
		}
		var stopErrors []error
		if lspManager != nil {
			if err := lspManager.StopUserContext(ctx, userID); err != nil {
				stopErrors = append(stopErrors, fmt.Errorf("stop LSP sessions: %w", err))
			}
		}
		if dapManager != nil {
			if err := dapManager.StopUserContext(ctx, userID); err != nil {
				stopErrors = append(stopErrors, fmt.Errorf("stop DAP sessions: %w", err))
			}
		}
		if err := errors.Join(stopErrors...); err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if lspManager != nil {
			if _, err := lspManager.ClearCache("user", userID, "all", "", ""); err != nil {
				return err
			}
		}
		if err := dap.CleanupUserDownloadCacheContext(ctx, cfg.DataDir, userID); err != nil {
			return fmt.Errorf("delete DAP download cache: %w", err)
		}
		// Docker must confirm every user-owned container is absent before the
		// bind-mounted directory can be removed. A cleanup error remains in the
		// durable deletion queue and is retried without losing ownership state.
		if err := removeUserDataAfterContainerCleanupContext(ctx, dockerPool, userID, cfg.DataDir); err != nil {
			slog.Error("Failed to delete user data directory",
				"user_id", userID, "path", userDir, "error", err)
			return err
		} else {
			slog.Info("User data directory deleted", "user_id", userID, "path", userDir)
		}
		if err := httpHandler.PackagePlans.DeleteUser(userID); err != nil {
			return fmt.Errorf("delete package operation records: %w", err)
		}
		return nil
	}
	httpHandler.OnUserDeletedContext = cleanupDeletedUserResources
	httpHandler.OnUserDeleted = func(userID string) error {
		return cleanupDeletedUserResources(context.Background(), userID)
	}
	// Cleanup jobs survive process restarts and are retried only after every
	// dependency used by the idempotent cleanup pipeline is wired.
	if err := httpHandler.RetryPendingUserDeletionsContext(serverRuntime.Context()); err != nil {
		slog.Error("Pending user deletion recovery interrupted", "error", err)
		shutdownStartupAndExit(err)
		return
	}

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
		PersonalCache:   personalCache,
		RuntimeMetadata: runtimeMetadata,
		Metrics:         performanceMetrics,
		Resources:       resourceController,
		Accepting:       serverRuntime.IsAccepting,
		AcquireWork:     serverRuntime.Acquire,
	}
	dapHandler := &handler.DAPHandler{
		Config: cfg, Manager: dapManager, AuthEnabled: multiUser,
		Authenticator: authenticator, UserStore: userStore, AuthSessions: authSessions,
		Collaboration: collaborationManager, Lifecycle: resourceLifecycle, ChildTickets: dap.NewChildTicketBroker(),
		PersonalCache: personalCache, RuntimeMetadata: runtimeMetadata, Resources: resourceController,
		Accepting: serverRuntime.IsAccepting, AcquireWork: serverRuntime.Acquire,
	}

	// ──── 12. 后台任务 ────
	startManaged := func(name string, task func(context.Context)) {
		if err := serverRuntime.Go(name, task); err != nil {
			slog.Error("Failed to register managed server task", "task", name, "error", err)
			shutdownStartupAndExit(err)
		}
	}
	// 会话清理
	startManaged("session-cleanup", func(ctx context.Context) {
		cleanupLoop(ctx, sessionStore, channelMgr, cfg.SessionCleanupDuration(), cfg.SessionTTLDuration())
	})
	startManaged("user-deletion-cleanup", func(ctx context.Context) {
		httpHandler.RunPendingUserDeletionCleanup(ctx, cfg.UserDeletionCleanupRetryInterval())
	})
	// Activity is compacted independently of run history so inactive accounts
	// cannot retain daily counters beyond the heatmap window indefinitely.
	runMaintenance(resourceController, "compile-activity-initial", func() {
		if err := compileActivity.Cleanup(time.Now()); err != nil {
			slog.Warn("Initial compile activity cleanup failed", "error", err)
		}
	})
	startManaged("compile-activity-cleanup", func(ctx context.Context) {
		periodicLoop(ctx, 24*time.Hour, func() {
			runMaintenance(resourceController, "compile-activity-cleanup", func() {
				if err := compileActivity.Cleanup(time.Now()); err != nil {
					slog.Warn("Compile activity cleanup failed", "error", err)
				}
			})
		})
	})
	// 运行历史清理（BoltDB 模式，每 5 分钟）
	if runHistory != nil {
		startManaged("run-history-cleanup", func(ctx context.Context) {
			slog.Info("Run history cleanup started", "interval", "5m",
				"max_per_user", cfg.HistoryMaxPerUser, "max_age", "7d", "max_total", 10000)
			periodicLoop(ctx, 5*time.Minute, func() {
				runMaintenance(resourceController, "run-history-cleanup", func() {
					runHistory.Cleanup(cfg.HistoryMaxPerUser, 7*24*time.Hour, 10000)
				})
			})
		})
	}
	startManaged("team-cache-cleanup", func(ctx context.Context) {
		teamCacheCleanupLoop(ctx, teamCache, collaborationStore, time.Duration(cfg.TeamCacheCleanupIntervalMin)*time.Minute, resourceController)
	})
	startManaged("personal-cache-cleanup", func(ctx context.Context) {
		periodicLoop(ctx, time.Duration(cfg.PersonalPersistCleanupIntervalMin)*time.Minute, func() {
			runMaintenance(resourceController, "personal-cache-cleanup", func() {
				users, err := userStore.List()
				if err != nil {
					slog.Warn("Personal cache cleanup could not list users", "error", err)
					return
				}
				for _, user := range users {
					personalCache.Enforce(user.ID, int64(user.DiskQuotaMB)*1_000_000)
				}
			})
		})
	})
	// 审计日志清理（保留 90 天 / 最多 20000 条，每小时）
	if auditStore != nil {
		startManaged("audit-cleanup", func(ctx context.Context) {
			periodicLoop(ctx, time.Hour, func() {
				runMaintenance(resourceController, "audit-cleanup", func() {
					auditStore.Cleanup(20000, 90*24*time.Hour)
				})
			})
		})
	}
	// 登录会话过期清理（每 10 分钟）
	if authSessions != nil {
		startManaged("auth-session-cleanup", func(ctx context.Context) {
			periodicLoop(ctx, 10*time.Minute, func() {
				authSessions.CleanupExpired()
			})
		})
	}
	// 限流器旧桶清理（每 5 分钟）
	if rateLimiter != nil || loginLimiter != nil {
		startManaged("rate-limit-cleanup", func(ctx context.Context) {
			periodicLoop(ctx, 5*time.Minute, func() {
				if rateLimiter != nil {
					rateLimiter.CleanupExpired(10 * time.Minute)
				}
				if loginLimiter != nil {
					loginLimiter.CleanupExpired(10 * time.Minute)
				}
			})
		})
	}

	// ──── 13. 启动服务 ────
	// DAP child sessions (currently js-debug) have their own broker port. The
	// port exposes only TLS WebSocket controls; Docker adapter ports remain on
	// host loopback and are ticket-bound in the handler.
	dapChildMux := http.NewServeMux()
	dapChildMux.HandleFunc("/dap-child", dapHandler.HandleChildWebSocket)
	dapChildAddr := fmt.Sprintf(":%d", cfg.DAPChildWSPort)
	dapChildServer := newBOBOHTTPServer(dapChildAddr, dapChildMux, cfg, serverRuntime.Context())

	// WebSocket 服务（端口 3101）
	wsMux := http.NewServeMux()
	wsMux.HandleFunc("/ws", wsHandler.HandleWebSocket)
	wsMux.HandleFunc("/terminal", wsHandler.HandleTerminalWebSocket)
	// Compatibility alias for pre-streaming internal clients. New clients use
	// /terminal and the terminal.* protocol exclusively.
	wsMux.HandleFunc("/term", wsHandler.HandleTerminalWebSocket)
	wsMux.HandleFunc("/lsp", wsHandler.HandleLSPWebSocket)
	wsMux.HandleFunc("/dap", dapHandler.HandleWebSocket)
	wsAddr := fmt.Sprintf(":%d", cfg.WSPort)
	wsServer := newBOBOHTTPServer(wsAddr, wsMux, cfg, serverRuntime.Context())

	// HTTP API 服务（端口 3100）。LSP 同时复用该已公开端口；独立的
	// WebSocket 端口仍保留 /lsp，兼容旧客户端和内网部署。
	addr := fmt.Sprintf(":%d", cfg.HTTPPort)
	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/lsp", wsHandler.HandleLSPWebSocket)
	httpMux.HandleFunc("/dap", dapHandler.HandleWebSocket)
	httpMux.Handle("/", httpHandler)
	httpServer := newBOBOHTTPServer(addr, httpMux, cfg, serverRuntime.Context())

	for name, listener := range map[string]*http.Server{
		"http-api": httpServer, "websocket": wsServer, "dap-child": dapChildServer,
	} {
		if err := serverRuntime.RegisterListener(name, listener); err != nil {
			slog.Error("Failed to register server listener", "listener", name, "error", err)
			shutdownStartupAndExit(err)
			return
		}
	}

	listenerErrors := make(chan error, 3)
	startListener := func(name string, listener *http.Server) {
		startManaged("listener-"+name, func(context.Context) {
			if err := serveBOBOHTTP(listener, cfg); err != nil && !errors.Is(err, http.ErrServerClosed) {
				select {
				case listenerErrors <- fmt.Errorf("%s listener: %w", name, err):
				default:
				}
			}
		})
	}
	slog.Info("DAP child WebSocket server starting", "addr", dapChildAddr, "tls", cfg.TLSEnabled)
	startListener("dap-child", dapChildServer)
	slog.Info("WebSocket server starting", "addr", wsAddr, "tls", cfg.TLSEnabled)
	startListener("websocket", wsServer)
	slog.Info("HTTP server starting", "addr", addr, "tls", cfg.TLSEnabled)
	startListener("http-api", httpServer)

	var shutdownCause error
	listenerFailed := false
	select {
	case <-signalCtx.Done():
		shutdownCause = fmt.Errorf("received termination signal: %w", context.Cause(signalCtx))
		slog.Info("Signal received, beginning graceful shutdown")
	case listenerErr := <-listenerErrors:
		shutdownCause = listenerErr
		listenerFailed = true
		slog.Error("Server listener failed, beginning coordinated shutdown", "error", listenerErr)
	}
	serverRuntime.BeginDrain(shutdownCause)
	stopSignals()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.ShutdownGracePeriod())
	shutdownErr := finishRuntimeShutdown(shutdownCtx, serverRuntime, shutdownRetryInitialDelay)
	cancelShutdown()
	if shutdownErr != nil {
		slog.Error("Graceful shutdown did not complete", "error", shutdownErr, "grace_period", cfg.ShutdownGracePeriod())
		listenerFailed = true
	} else {
		slog.Info("Shutdown complete")
	}
	if listenerFailed {
		os.Exit(1)
	}
}

func synchronizeUserContainerLimits(store auth.UserStore, setLimit func(string, int)) ([]*auth.User, error) {
	if store == nil || setLimit == nil {
		return nil, errors.New("user store and container limit setter are required")
	}
	users, err := store.List()
	if err != nil {
		return nil, fmt.Errorf("list users for container limits: %w", err)
	}
	for _, user := range users {
		if user == nil || strings.TrimSpace(user.ID) == "" {
			continue
		}
		setLimit(user.ID, user.ContainerLimit)
	}
	return users, nil
}

func newBOBOHTTPServer(addr string, handler http.Handler, cfg *config.Config, baseContext context.Context) *http.Server {
	if cfg == nil {
		cfg = config.Default()
	}
	if baseContext == nil {
		baseContext = context.Background()
	}
	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: cfg.HTTPReadHeaderTimeout(),
		IdleTimeout:       cfg.HTTPIdleTimeout(),
		MaxHeaderBytes:    cfg.HTTPMaxHeaderBytes,
	}
	server.BaseContext = func(net.Listener) context.Context { return baseContext }
	return server
}

// serveBOBOHTTP is shared only by the server listeners. TLS is transport
// security, not an application-level encryption scheme: HTTP and all WebSocket
// upgrades on a configured listener are protected by the same TLS 1.3 policy.
func serveBOBOHTTP(server *http.Server, cfg *config.Config) error {
	if cfg != nil && cfg.TLSEnabled {
		server.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS13}
		return server.ListenAndServeTLS(cfg.TLSCertFile, cfg.TLSKeyFile)
	}
	return server.ListenAndServe()
}

// serverReadinessProbe confirms the startup dependencies needed for cloud
// compilation without creating containers or disclosing infrastructure errors.
func serverReadinessProbe(db *bolt.DB, dockerPool *docker.Pool, cfg *config.Config, lspManager *lsp.Manager, dapManager *dap.Manager) handler.ReadinessProbe {
	return func(ctx context.Context) error {
		if cfg == nil {
			return errors.New("server configuration is unavailable")
		}
		if cfg.LSPEnabled && lspManager == nil {
			return errors.New("LSP manager is unavailable")
		}
		if cfg.DAPEnabled && dapManager == nil {
			return errors.New("DAP manager is unavailable")
		}
		if db != nil {
			if err := db.View(func(*bolt.Tx) error { return nil }); err != nil {
				return fmt.Errorf("check persistent store: %w", err)
			}
		}
		if err := dockerPool.CheckReady(ctx); err != nil {
			return err
		}
		return nil
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
			if _, err := handler.CleanupExpiredRuns(store, channels, ttl); err != nil {
				slog.Error("Session cleanup failed", "error", err)
			}
		}
	}
}

func periodicLoop(ctx context.Context, interval time.Duration, run func()) {
	if interval <= 0 || run == nil {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}

// runMaintenance gives correctness-neutral background work the lowest
// admission priority: it never waits and simply skips a cycle while
// interactive workloads consume the node budget.
func runMaintenance(controller *resourcecontrol.Controller, workloadID string, run func()) bool {
	if run == nil {
		return false
	}
	if controller == nil {
		run()
		return true
	}
	lease, err := controller.TryAcquire(resourcecontrol.WorkloadMaintenance, "system", workloadID)
	if err != nil {
		return false
	}
	defer lease.Release()
	run()
	return true
}

func teamCacheV2Root(dataDir string) string {
	return filepath.Join(dataDir, "cache-v2", "teams")
}

func teamCacheCleanupLoop(ctx context.Context, cache *buildcache.Manager, store collab.Store, interval time.Duration, resources *resourcecontrol.Controller) {
	if cache == nil || store == nil {
		return
	}
	if interval <= 0 {
		interval = 10 * time.Minute
	}
	run := func() {
		runMaintenance(resources, "team-cache-cleanup", func() {
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
		})
	}
	run()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}

// seedRootUser keeps composition compatibility while rootbootstrap owns the
// credential file and account initialization transaction.
func seedRootUser(cfg *config.Config, userStore auth.UserStore) (*auth.User, error) {
	return rootbootstrap.Ensure(cfg, userStore)
}

// ──── Terminal 桥接 ────

// makeTerminalExecutor 创建终端命令执行器（桥接 DockerPool → HTTP handler）
func makeTerminalExecutor(pool *docker.Pool) handler.TerminalExecutor {
	return func(ctx context.Context, userID, runtimeID, command string) (stdout, stderr string, exitCode int, err error) {
		rt := model.GetRuntimeDef(runtimeID)
		if rt == nil {
			return "", "", 0, fmt.Errorf("unknown runtime: %s", runtimeID)
		}

		// 与 RunPlan 路径一致：由容器环境中的 PIP_TARGET 选择项目摘要目录。
		command = runner.AutoPersistPip(command)

		dependencyLease := personalcache.LeaseFromContext(ctx)
		toolchainLeases := personalcache.ToolchainLeasesFromContext(ctx)
		cacheKeys := make([]string, 0, 1+len(toolchainLeases))
		cacheMounts := make(map[string]string)
		cacheEnvironment := make(map[string]string)
		if dependencyLease != nil {
			cacheKeys = append(cacheKeys, dependencyLease.ContainerKey)
			for host, target := range dependencyLease.DockerMounts {
				cacheMounts[host] = target
			}
			for key, value := range dependencyLease.DockerEnv {
				cacheEnvironment[key] = value
			}
		}
		for _, toolchainLease := range toolchainLeases {
			if toolchainLease == nil {
				continue
			}
			cacheKeys = append(cacheKeys, toolchainLease.ContainerKey)
			for host, target := range toolchainLease.DockerMounts {
				cacheMounts[host] = target
			}
			for key, value := range toolchainLease.DockerEnv {
				cacheEnvironment[key] = value
			}
		}
		var containerID string
		if len(cacheKeys) > 0 {
			containerID, err = pool.AcquireForUserRuntimeWithContext(ctx, userID, rt.RuntimeID, rt.DockerImage, strings.Join(cacheKeys, "+"), cacheMounts, cacheEnvironment, nil)
		} else {
			containerID, err = pool.AcquireForUserRuntime(ctx, userID, rt.RuntimeID, rt.DockerImage, nil)
		}
		if err != nil {
			return "", "", 0, fmt.Errorf("failed to acquire container: %w", err)
		}
		writableCacheLease := dependencyLease != nil && dependencyLease.Writable() || len(toolchainLeases) > 0
		defer func() {
			if writableCacheLease || errors.Is(context.Cause(ctx), personalcache.ErrQuotaExceeded) {
				if cleanupErr := pool.DiscardForUserAndWait(containerID, userID); cleanupErr != nil {
					retainContainerResourcesUntilRemoved(ctx, pool, containerID, userID)
					err = errors.Join(err, fmt.Errorf("destroy terminal container: %w", cleanupErr))
					exitCode = 1
				}
			} else {
				releaseContainerResourcesWhenSafe(ctx, pool, containerID, userID)
			}
		}()

		stdout, stderr, exitCode, err = pool.Exec(ctx, containerID,
			[]string{"sh", "-c", command}, "/workspace")
		return
	}
}

// makeEnvironmentSetupExecutor reuses the runner's Docker pool, persistence
// environment, workspace copy, and command policy. The HTTP request can select
// only a server-generated plan; it cannot supply these commands directly.
func makeEnvironmentSetupExecutor(pool *docker.Pool, policy security.Policy, copyLimits files.ProjectCopyLimits) handler.EnvironmentSetupExecutor {
	return func(ctx context.Context, userID, runtimeID, workspaceRoot string, commands []string) (stdout, stderr string, exitCode int, err error) {
		rt := model.GetRuntimeDef(runtimeID)
		if rt == nil {
			return "", "", 0, fmt.Errorf("unknown runtime: %s", runtimeID)
		}
		if rt.Language != "python" && rt.Language != "node" {
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
		if !handler.IsManagedPackageOperation(ctx) {
			if copyErr := files.CopyProjectToTemp(ctx, workspaceRoot, isolatedRoot, copyLimits); copyErr != nil {
				return "", "", 0, fmt.Errorf("copy isolated environment workspace: %w", copyErr)
			}
		}
		dependencyLease := personalcache.LeaseFromContext(ctx)
		toolchainLeases := personalcache.ToolchainLeasesFromContext(ctx)
		cacheKeys := make([]string, 0, 1+len(toolchainLeases))
		cacheMounts := make(map[string]string)
		cacheEnvironment := make(map[string]string)
		if dependencyLease != nil {
			cacheKeys = append(cacheKeys, dependencyLease.ContainerKey)
			for host, target := range dependencyLease.DockerMounts {
				cacheMounts[host] = target
			}
			for key, value := range dependencyLease.DockerEnv {
				cacheEnvironment[key] = value
			}
		}
		for _, toolchainLease := range toolchainLeases {
			if toolchainLease == nil {
				continue
			}
			cacheKeys = append(cacheKeys, toolchainLease.ContainerKey)
			for host, target := range toolchainLease.DockerMounts {
				cacheMounts[host] = target
			}
			for key, value := range toolchainLease.DockerEnv {
				cacheEnvironment[key] = value
			}
		}
		var containerID string
		if len(cacheKeys) > 0 {
			containerID, err = pool.AcquireForUserRuntimeWithContext(ctx, userID, rt.RuntimeID, rt.DockerImage, strings.Join(cacheKeys, "+"), cacheMounts, cacheEnvironment, nil)
		} else {
			containerID, err = pool.AcquireForUserRuntime(ctx, userID, rt.RuntimeID, rt.DockerImage, nil)
		}
		if err != nil {
			return "", "", 0, fmt.Errorf("failed to acquire container: %w", err)
		}
		writableCacheLease := dependencyLease != nil && dependencyLease.Writable() || len(toolchainLeases) > 0
		defer func() {
			if writableCacheLease || errors.Is(context.Cause(ctx), personalcache.ErrQuotaExceeded) {
				if cleanupErr := pool.DiscardForUserAndWait(containerID, userID); cleanupErr != nil {
					retainContainerResourcesUntilRemoved(ctx, pool, containerID, userID)
					err = errors.Join(err, fmt.Errorf("destroy environment setup container: %w", cleanupErr))
					exitCode = 1
				}
			} else {
				releaseContainerResourcesWhenSafe(ctx, pool, containerID, userID)
			}
		}()
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

func shellQuotePackageValue(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func makePackageLockResolver(pool *docker.Pool, policy security.Policy, pnpmVersion string) handler.PackageLockResolver {
	pnpmExecutable, pnpmExecutableErr := nodetoolchain.PNPMExecutable(pnpmVersion)
	return func(ctx context.Context, request handler.PackageLockResolutionRequest) (result handler.PackageLockResolutionResult, err error) {
		runtime := model.GetRuntimeDef(strings.TrimSpace(request.RuntimeID))
		if runtime == nil || runtime.Language != "node" {
			return result, fmt.Errorf("a managed Node runtime is required for lockfile resolution")
		}
		manager := strings.ToLower(strings.TrimSpace(request.Manager))
		if manager != "npm" && manager != "pnpm" {
			return result, fmt.Errorf("unsupported Node package manager: %s", manager)
		}
		manifestPath := filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(request.ManifestPath))))
		lockfilePath := filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(request.LockfilePath))))
		if manifestPath != "package.json" || (manager == "npm" && lockfilePath != "package-lock.json") || (manager == "pnpm" && lockfilePath != "pnpm-lock.yaml") {
			return result, fmt.Errorf("managed Node lockfile resolution currently requires a project-root manifest")
		}
		if len(request.ManifestContent) == 0 || len(request.ManifestContent) > 8<<20 {
			return result, fmt.Errorf("Node package manifest exceeds the resolution limit")
		}

		isolatedRoot, tempErr := os.MkdirTemp("", "package-lock-resolution-")
		if tempErr != nil {
			return result, fmt.Errorf("create lockfile workspace: %w", tempErr)
		}
		defer os.RemoveAll(isolatedRoot)
		if writeErr := safefile.WriteAtomic(isolatedRoot, "package.json", request.ManifestContent, 0600); writeErr != nil {
			return result, fmt.Errorf("stage planned package.json: %w", writeErr)
		}
		if existingLock, readErr := safefile.ReadSmallRegular(request.WorkspaceRoot, filepath.Base(lockfilePath), 8<<20); readErr == nil {
			if writeErr := safefile.WriteAtomic(isolatedRoot, filepath.Base(lockfilePath), existingLock, 0600); writeErr != nil {
				return result, fmt.Errorf("stage existing Node lockfile: %w", writeErr)
			}
		} else if !errors.Is(readErr, os.ErrNotExist) {
			return result, fmt.Errorf("read existing Node lockfile: %w", readErr)
		}

		containerID, acquireErr := pool.AcquireForUserRuntime(ctx, request.UserID, runtime.RuntimeID, runtime.DockerImage, nil)
		if acquireErr != nil {
			return result, fmt.Errorf("acquire lockfile container: %w", acquireErr)
		}
		defer pool.ReleaseForUser(containerID, request.UserID)
		if _, _, _, prepareErr := pool.Exec(ctx, containerID, []string{"mkdir", "-p", "/workspace"}, "/"); prepareErr != nil {
			return result, fmt.Errorf("prepare lockfile container: %w", prepareErr)
		}
		copyCommand := exec.CommandContext(ctx, "docker", "cp", filepath.Clean(isolatedRoot)+string(os.PathSeparator)+".", containerID+":/workspace")
		if output, copyErr := copyCommand.CombinedOutput(); copyErr != nil {
			return result, fmt.Errorf("copy lockfile workspace into container: %w: %s", copyErr, strings.TrimSpace(string(output)))
		}

		registry := shellQuotePackageValue(strings.TrimSpace(request.RegistryURL))
		command := "npm install --package-lock-only --ignore-scripts --no-audit --no-fund --workspaces=false --registry=" + registry
		if manager == "pnpm" {
			if pnpmExecutableErr != nil {
				return result, fmt.Errorf("invalid server pnpm policy: %w", pnpmExecutableErr)
			}
			command = pnpmExecutable + " install --lockfile-only --frozen-lockfile=false --ignore-scripts --registry=" + registry
		}
		if !policy.AllowCommand(command) {
			return result, fmt.Errorf("lockfile resolution command was rejected by policy")
		}
		stdout, stderr, exitCode, execErr := pool.Exec(ctx, containerID, []string{"sh", "-c", policy.FilterCommand(command)}, "/workspace")
		result.Stdout, result.Stderr = stdout, stderr
		if execErr != nil || exitCode != 0 {
			if execErr == nil {
				execErr = fmt.Errorf("%s lockfile resolution exited with code %d", manager, exitCode)
			}
			return result, execErr
		}

		outputRoot := filepath.Join(isolatedRoot, ".bobocloud-lock-output")
		if mkdirErr := os.Mkdir(outputRoot, 0700); mkdirErr != nil {
			return result, fmt.Errorf("prepare lockfile output: %w", mkdirErr)
		}
		outputPath := filepath.Join(outputRoot, filepath.Base(lockfilePath))
		copyLock := exec.CommandContext(ctx, "docker", "cp", containerID+":/workspace/"+lockfilePath, outputPath)
		if output, copyErr := copyLock.CombinedOutput(); copyErr != nil {
			return result, fmt.Errorf("copy generated lockfile: %w: %s", copyErr, strings.TrimSpace(string(output)))
		}
		content, readErr := safefile.ReadSmallRegular(outputRoot, filepath.Base(lockfilePath), 8<<20)
		if readErr != nil {
			return result, fmt.Errorf("read generated lockfile: %w", readErr)
		}
		result.LockfilePath = lockfilePath
		result.Content = content
		return result, nil
	}
}

func retainContainerResourcesUntilRemoved(ctx context.Context, pool *docker.Pool, containerID, userID string) {
	if !handler.RegisterResourcesUntilContainerRemoved(ctx, func(complete func()) {
		pool.DiscardForUserRetained(containerID, userID, complete)
	}) {
		// Production cache mutation handlers install the handoff before acquiring
		// their leases. Compatibility callers still leave container ownership in
		// the pool and receive a bounded background removal attempt.
		pool.DiscardForUser(containerID, userID)
	}
}

func releaseContainerResourcesWhenSafe(ctx context.Context, pool *docker.Pool, containerID, userID string) {
	if !handler.RegisterResourcesUntilContainerRemoved(ctx, func(complete func()) {
		pool.ReleaseForUserRetained(containerID, userID, complete)
	}) {
		pool.ReleaseForUser(containerID, userID)
	}
}
