package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// UserConfig 是配置文件中预设用户的定义
type UserConfig struct {
	ID             string `json:"id"`              // 用户唯一标识
	Name           string `json:"name"`            // 显示名称
	APIKey         string `json:"api_key"`         // API Key（客户端填入 Authorization header）
	Role           string `json:"role"`            // root / admin / member（留空：id=admin→admin，其余→member）
	ContainerLimit int    `json:"container_limit"` // 容器配额
	RateLimit      int    `json:"rate_limit"`      // 请求速率限制（次/分钟）
	DiskQuotaMB    int    `json:"disk_quota_mb"`   // 磁盘配额（MB），0=不限
}

// RootUserConfig 是 root 管理员的种子配置（仅多人模式首次启动时生效）
type RootUserConfig struct {
	Username string `json:"username"` // 默认 "root"
	Email    string `json:"email"`
	Name     string `json:"name"`     // 显示名，默认 "Root Admin"
	Password string `json:"password"` // 留空则自动生成并打印到日志（仅首次）
}

// Config 是服务端所有可配置项的集合。
type Config struct {
	// 网络配置
	ServerRoot string `json:"server_root"`
	HTTPPort   int    `json:"http_port"`
	WSPort     int    `json:"ws_port"`
	// DAPChildWSPort carries js-debug child sessions on a separate WebSocket
	// listener. It is never a Docker adapter port and must use the same TLS
	// policy as the primary API/WebSocket listeners.
	DAPChildWSPort int    `json:"dap_child_ws_port"`
	TLSEnabled     bool   `json:"tls_enabled"`
	TLSCertFile    string `json:"tls_cert_file"`
	TLSKeyFile     string `json:"tls_key_file"`

	// 数据目录
	DataDir string `json:"data_dir"`

	// Docker 池配置
	DockerHotPoolSize           int      `json:"docker_hot_pool_size"`
	DockerMaxContainers         int      `json:"docker_max_containers"`
	DockerMaxIdle               int      `json:"docker_max_idle"`
	DockerMemoryLimit           string   `json:"docker_memory_limit"`
	DockerCPULimit              string   `json:"docker_cpu_limit"`
	DockerTerminalTimeout       int      `json:"docker_terminal_timeout_seconds"`
	DockerPoolReplenishInterval int      `json:"docker_pool_replenish_interval_seconds"`
	DockerDefaultNetwork        bool     `json:"docker_default_network"`
	DockerRegistryMirrors       []string `json:"docker_registry_mirrors"`     // 镜像加速器地址列表
	DockerPullTimeout           int      `json:"docker_pull_timeout_seconds"` // 拉取超时（秒）
	DockerHardening             bool     `json:"docker_hardening"`            // 容器安全加固（cap-drop/no-new-privileges/pids-limit/init）
	DockerReadOnlyRootfs        bool     `json:"docker_readonly_rootfs"`      // 只读根文件系统（实验性，可能影响部分运行时）

	// 超时配置
	DefaultCompileTimeout  int `json:"compile_timeout_seconds"`
	RustCompileTimeout     int `json:"rust_compile_timeout_seconds"`
	DefaultRunTimeout      int `json:"run_timeout_seconds"`
	SessionTTL             int `json:"session_ttl_seconds"`
	SessionCleanupInterval int `json:"session_cleanup_interval_seconds"`

	// WebSocket 配置
	WSReadLimit  int `json:"ws_read_limit"`
	WSWriteWait  int `json:"ws_write_wait_seconds"`
	WSPingPeriod int `json:"ws_ping_period_seconds"`
	ChunkSize    int `json:"chunk_size"`

	// Interactive terminal sessions are independent WebSocket resources. Their
	// limits deliberately differ from short-lived run sessions so an abandoned
	// shell cannot retain a user container indefinitely.
	TerminalHandshakeTimeoutSeconds     int   `json:"terminal_handshake_timeout_seconds"`
	TerminalIdleTTLSeconds              int   `json:"terminal_idle_ttl_seconds"`
	TerminalMaxSessionSeconds           int   `json:"terminal_max_session_seconds"`
	TerminalMaxMessageBytes             int   `json:"terminal_max_message_bytes"`
	TerminalBandwidthPerMinuteBytes     int64 `json:"terminal_bandwidth_per_minute_bytes"`
	TerminalWorkspaceCopyTimeoutSeconds int   `json:"terminal_workspace_copy_timeout_seconds"`
	TerminalWorkspaceCopyMaxBytes       int64 `json:"terminal_workspace_copy_max_bytes"`

	// 认证配置
	AuthMode             string         `json:"auth_mode"`     // "single"=单机模式 / "multi"=多人模式（留空则按 auth_enabled 推断）
	AuthEnabled          bool           `json:"auth_enabled"`  // 向后兼容：等价于 auth_mode 的开关形式
	AdminAPIKey          string         `json:"admin_api_key"` // 向后兼容：auth_enabled=true 且 users 为空时生效
	Users                []UserConfig   `json:"users"`         // 预设用户列表（批量导入，API Key 用户）
	RootUser             RootUserConfig `json:"root_user"`     // 多人模式的 root 管理员种子
	DefaultQuota         int            `json:"default_quota"`
	DefaultRateLimit     int            `json:"default_rate_limit"`
	DefaultDiskQuotaMB   int            `json:"default_disk_quota_mb"`   // 新用户默认磁盘配额（MB），0=不限
	SessionTokenTTLHours int            `json:"session_token_ttl_hours"` // 登录会话 token 有效期（小时），默认 720（30 天）
	InviteTTLHours       int            `json:"invite_ttl_hours"`        // 邀请码默认有效期（小时），默认 168（7 天）
	LoginRateLimit       int            `json:"login_rate_limit"`        // 登录接口限速（次/分钟/IP），默认 5

	// 日志配置
	LogLevel  string `json:"log_level"`
	LogFormat string `json:"log_format"`

	// BoltDB 路径
	DBPath string `json:"db_path"`

	// 运行历史
	HistoryMaxPerUser int `json:"history_max_per_user"` // 每用户保留的最大运行历史条数（listRunHistory 的返回上限 + 清理阈值）

	// 团队增量编译缓存。配额按团队统计，后台只淘汰不活跃的 LRU 命名空间。
	TeamCacheDefaultQuotaMB     int `json:"team_cache_default_quota_mb"`
	TeamCacheCleanupIntervalMin int `json:"team_cache_cleanup_interval_minutes"`

	// Remote language servers and their independent analysis cache. LSP cache
	// never shares a root with team incremental build/dependency caches.
	LSPEnabled                 bool   `json:"lsp_enabled"`
	LSPManifestPath            string `json:"lsp_manifest_path"`
	LSPMaxSessions             int    `json:"lsp_max_sessions"`
	LSPMaxSessionsPerUser      int    `json:"lsp_max_sessions_per_user"`
	LSPIdleTTLSeconds          int    `json:"lsp_idle_ttl_seconds"`
	LSPMaxMessageBytes         int    `json:"lsp_max_message_bytes"`
	LSPBandwidthPerMinuteBytes int64  `json:"lsp_bandwidth_per_minute_bytes"`
	LSPCacheQuotaMB            int    `json:"lsp_cache_quota_mb"`
	LSPCacheRetentionDays      int    `json:"lsp_cache_retention_days"`
	LSPMemoryLimit             string `json:"lsp_memory_limit"`
	LSPCPULimit                string `json:"lsp_cpu_limit"`

	// Remote debug adapters are independent from LSP analyzers. Every DAP
	// session owns one managed Docker adapter/debuggee container.
	DAPEnabled                     bool   `json:"dap_enabled"`
	DAPManifestPath                string `json:"dap_manifest_path"`
	DAPMaxSessions                 int    `json:"dap_max_sessions"`
	DAPMaxSessionsPerUser          int    `json:"dap_max_sessions_per_user"`
	DAPIdleTTLSeconds              int    `json:"dap_idle_ttl_seconds"`
	DAPMaxSessionSeconds           int    `json:"dap_max_session_seconds"`
	DAPHandshakeTimeoutSeconds     int    `json:"dap_handshake_timeout_seconds"`
	DAPMaxMessageBytes             int    `json:"dap_max_message_bytes"`
	DAPBandwidthPerMinuteBytes     int64  `json:"dap_bandwidth_per_minute_bytes"`
	DAPMemoryLimit                 string `json:"dap_memory_limit"`
	DAPCPULimit                    string `json:"dap_cpu_limit"`
	DAPNetworkEnabled              bool   `json:"dap_network_enabled"`
	DAPWorkspaceCopyTimeoutSeconds int    `json:"dap_workspace_copy_timeout_seconds"`
	DAPWorkspaceCopyMaxBytes       int64  `json:"dap_workspace_copy_max_bytes"`
}

// Default 返回带默认值的配置。
func Default() *Config {
	return &Config{
		ServerRoot:                  "/shareOnling",
		HTTPPort:                    3100,
		WSPort:                      3101,
		DAPChildWSPort:              3102,
		TLSEnabled:                  false,
		DataDir:                     "./data",
		DockerHotPoolSize:           2,
		DockerMaxContainers:         20,
		DockerMaxIdle:               5,
		DockerMemoryLimit:           "512m",
		DockerCPULimit:              "1.0",
		DockerTerminalTimeout:       300,
		DockerPoolReplenishInterval: 10,
		DockerDefaultNetwork:        true,
		DockerRegistryMirrors: []string{
			"https://docker.m.daocloud.io",
		},
		DockerPullTimeout:                   600,
		DockerHardening:                     true,
		DockerReadOnlyRootfs:                false,
		DefaultCompileTimeout:               30,
		RustCompileTimeout:                  60,
		DefaultRunTimeout:                   30,
		SessionTTL:                          120,
		SessionCleanupInterval:              30,
		WSReadLimit:                         65536,
		WSWriteWait:                         10,
		WSPingPeriod:                        30,
		ChunkSize:                           200000,
		TerminalHandshakeTimeoutSeconds:     10,
		TerminalIdleTTLSeconds:              900,
		TerminalMaxSessionSeconds:           3600,
		TerminalMaxMessageBytes:             65536,
		TerminalBandwidthPerMinuteBytes:     8 << 20,
		TerminalWorkspaceCopyTimeoutSeconds: 30,
		TerminalWorkspaceCopyMaxBytes:       512 << 20,
		AuthMode:                            "", // 留空按 auth_enabled 推断
		AuthEnabled:                         false,
		Users:                               nil, // 预设用户列表，留空则使用 admin_api_key 创建单用户
		DefaultQuota:                        5,
		DefaultRateLimit:                    60,
		DefaultDiskQuotaMB:                  2048, // 2GB
		SessionTokenTTLHours:                720,  // 30 天
		InviteTTLHours:                      168,  // 7 天
		LoginRateLimit:                      5,
		LogLevel:                            "info",
		LogFormat:                           "json",
		DBPath:                              "",
		HistoryMaxPerUser:                   200,
		TeamCacheDefaultQuotaMB:             4096,
		TeamCacheCleanupIntervalMin:         10,
		LSPEnabled:                          true,
		LSPManifestPath:                     "lsp_servers.json",
		LSPMaxSessions:                      8,
		LSPMaxSessionsPerUser:               2,
		LSPIdleTTLSeconds:                   900,
		LSPMaxMessageBytes:                  1 << 20,
		LSPBandwidthPerMinuteBytes:          16 << 20,
		LSPCacheQuotaMB:                     1024,
		LSPCacheRetentionDays:               7,
		LSPMemoryLimit:                      "512m",
		LSPCPULimit:                         "1.0",
		DAPEnabled:                          true,
		DAPManifestPath:                     "dap_adapters.json",
		DAPMaxSessions:                      1,
		DAPMaxSessionsPerUser:               1,
		DAPIdleTTLSeconds:                   900,
		DAPMaxSessionSeconds:                3600,
		DAPHandshakeTimeoutSeconds:          10,
		DAPMaxMessageBytes:                  1 << 20,
		DAPBandwidthPerMinuteBytes:          16 << 20,
		DAPMemoryLimit:                      "384m",
		DAPCPULimit:                         "1.0",
		DAPNetworkEnabled:                   false,
		DAPWorkspaceCopyTimeoutSeconds:      30,
		DAPWorkspaceCopyMaxBytes:            512 << 20,
	}
}

// IsMultiUser 返回是否为多人模式：auth_mode 显式指定优先，否则按 auth_enabled 推断
func (c *Config) IsMultiUser() bool {
	switch c.AuthMode {
	case "multi":
		return true
	case "single":
		return false
	default:
		return c.AuthEnabled
	}
}

// SessionTokenTTL 返回登录会话有效期
func (c *Config) SessionTokenTTL() time.Duration {
	if c.SessionTokenTTLHours <= 0 {
		return 720 * time.Hour
	}
	return time.Duration(c.SessionTokenTTLHours) * time.Hour
}

// InviteTTL 返回邀请码默认有效期
func (c *Config) InviteTTL() time.Duration {
	if c.InviteTTLHours <= 0 {
		return 168 * time.Hour
	}
	return time.Duration(c.InviteTTLHours) * time.Hour
}

// Load 从 JSON 文件加载配置，并应用环境变量覆盖。
// 如果文件不存在，则返回默认配置。
func Load(path string) (*Config, error) {
	cfg := Default()

	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				// 文件不存在时使用默认值
				return cfg, nil
			}
			return nil, fmt.Errorf("failed to read config file %s: %w", path, err)
		}
		if err := json.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("failed to parse config file %s: %w", path, err)
		}
	}

	// 环境变量覆盖
	applyEnvOverrides(cfg)

	// 推导 DBPath（如果未显式设置）
	if cfg.DBPath == "" {
		cfg.DBPath = cfg.DataDir + "/db/bobocloud.db"
	}

	// 历史条数兜底（旧配置文件无此字段或显式置 0 时用默认值）
	if cfg.HistoryMaxPerUser <= 0 {
		cfg.HistoryMaxPerUser = 200
	}
	if cfg.TeamCacheDefaultQuotaMB <= 0 {
		cfg.TeamCacheDefaultQuotaMB = 4096
	}
	if cfg.TeamCacheCleanupIntervalMin <= 0 {
		cfg.TeamCacheCleanupIntervalMin = 10
	}
	if cfg.LSPMaxSessions <= 0 {
		cfg.LSPMaxSessions = 8
	}
	if cfg.LSPMaxSessionsPerUser <= 0 {
		cfg.LSPMaxSessionsPerUser = 2
	}
	if cfg.LSPIdleTTLSeconds <= 0 {
		cfg.LSPIdleTTLSeconds = 900
	}
	if cfg.LSPMaxMessageBytes <= 0 {
		cfg.LSPMaxMessageBytes = 1 << 20
	}
	if cfg.LSPBandwidthPerMinuteBytes <= 0 {
		cfg.LSPBandwidthPerMinuteBytes = 16 << 20
	}
	if cfg.LSPCacheQuotaMB <= 0 {
		cfg.LSPCacheQuotaMB = 1024
	}
	if cfg.LSPCacheRetentionDays <= 0 {
		cfg.LSPCacheRetentionDays = 7
	}
	if cfg.LSPMemoryLimit == "" {
		cfg.LSPMemoryLimit = "512m"
	}
	if cfg.LSPCPULimit == "" {
		cfg.LSPCPULimit = "1.0"
	}
	if cfg.DAPMaxSessions <= 0 {
		cfg.DAPMaxSessions = 1
	}
	if cfg.DAPMaxSessionsPerUser <= 0 {
		cfg.DAPMaxSessionsPerUser = 1
	}
	if cfg.DAPIdleTTLSeconds <= 0 {
		cfg.DAPIdleTTLSeconds = 900
	}
	if cfg.DAPMaxSessionSeconds <= 0 {
		cfg.DAPMaxSessionSeconds = 3600
	}
	if cfg.DAPHandshakeTimeoutSeconds <= 0 {
		cfg.DAPHandshakeTimeoutSeconds = 10
	}
	if cfg.DAPMaxMessageBytes <= 0 {
		cfg.DAPMaxMessageBytes = 1 << 20
	}
	if cfg.DAPBandwidthPerMinuteBytes <= 0 {
		cfg.DAPBandwidthPerMinuteBytes = 16 << 20
	}
	if cfg.DAPMemoryLimit == "" {
		cfg.DAPMemoryLimit = "384m"
	}
	if cfg.DAPCPULimit == "" {
		cfg.DAPCPULimit = "1.0"
	}
	if cfg.DAPWorkspaceCopyTimeoutSeconds <= 0 {
		cfg.DAPWorkspaceCopyTimeoutSeconds = 30
	}
	if cfg.DAPWorkspaceCopyMaxBytes <= 0 {
		cfg.DAPWorkspaceCopyMaxBytes = 512 << 20
	}
	if cfg.DAPChildWSPort <= 0 {
		cfg.DAPChildWSPort = 3102
	}
	if cfg.TerminalHandshakeTimeoutSeconds <= 0 {
		cfg.TerminalHandshakeTimeoutSeconds = 10
	}
	if cfg.TerminalIdleTTLSeconds <= 0 {
		cfg.TerminalIdleTTLSeconds = 900
	}
	if cfg.TerminalMaxSessionSeconds <= 0 {
		cfg.TerminalMaxSessionSeconds = 3600
	}
	if cfg.TerminalMaxMessageBytes <= 0 {
		cfg.TerminalMaxMessageBytes = 64 * 1024
	}
	if cfg.TerminalBandwidthPerMinuteBytes <= 0 {
		cfg.TerminalBandwidthPerMinuteBytes = 8 << 20
	}
	if cfg.TerminalWorkspaceCopyTimeoutSeconds <= 0 {
		cfg.TerminalWorkspaceCopyTimeoutSeconds = 30
	}
	if cfg.TerminalWorkspaceCopyMaxBytes <= 0 {
		cfg.TerminalWorkspaceCopyMaxBytes = 512 << 20
	}
	if cfg.TLSEnabled && (strings.TrimSpace(cfg.TLSCertFile) == "" || strings.TrimSpace(cfg.TLSKeyFile) == "") {
		return nil, fmt.Errorf("tls_enabled requires tls_cert_file and tls_key_file")
	}

	return cfg, nil
}

// applyEnvOverrides 用环境变量覆盖配置值。
func applyEnvOverrides(cfg *Config) {
	if v := os.Getenv("BOBOCLOUD_DATA_DIR"); v != "" {
		cfg.DataDir = v
	}
	if v := os.Getenv("BOBOCLOUD_HTTP_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.HTTPPort = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_WS_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.WSPort = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_TERMINAL_IDLE_TTL_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.TerminalIdleTTLSeconds = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_TERMINAL_MAX_SESSION_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.TerminalMaxSessionSeconds = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_TERMINAL_WORKSPACE_COPY_TIMEOUT_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.TerminalWorkspaceCopyTimeoutSeconds = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_TERMINAL_WORKSPACE_COPY_MAX_BYTES"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			cfg.TerminalWorkspaceCopyMaxBytes = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_DAP_CHILD_WS_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.DAPChildWSPort = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_TLS_ENABLED"); v != "" {
		cfg.TLSEnabled = v == "true" || v == "1"
	}
	if v := os.Getenv("BOBOCLOUD_TLS_CERT_FILE"); v != "" {
		cfg.TLSCertFile = v
	}
	if v := os.Getenv("BOBOCLOUD_TLS_KEY_FILE"); v != "" {
		cfg.TLSKeyFile = v
	}
	if v := os.Getenv("BOBOCLOUD_LOG_LEVEL"); v != "" {
		cfg.LogLevel = v
	}
	if v := os.Getenv("BOBOCLOUD_AUTH_ENABLED"); v == "true" || v == "1" {
		cfg.AuthEnabled = true
	}
	if v := os.Getenv("BOBOCLOUD_AUTH_MODE"); v == "single" || v == "multi" {
		cfg.AuthMode = v
	}
	if v := os.Getenv("BOBOCLOUD_ROOT_PASSWORD"); v != "" {
		cfg.RootUser.Password = v
	}
	if v := os.Getenv("BOBOCLOUD_ADMIN_API_KEY"); v != "" {
		cfg.AdminAPIKey = v
	}
	if v := os.Getenv("BOBOCLOUD_MAX_CONTAINERS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.DockerMaxContainers = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_TEAM_CACHE_QUOTA_MB"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.TeamCacheDefaultQuotaMB = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_LSP_ENABLED"); v != "" {
		cfg.LSPEnabled = v == "true" || v == "1"
	}
	if v := os.Getenv("BOBOCLOUD_LSP_MANIFEST"); v != "" {
		cfg.LSPManifestPath = v
	}
	if v := os.Getenv("BOBOCLOUD_LSP_MAX_SESSIONS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.LSPMaxSessions = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_LSP_MAX_SESSIONS_PER_USER"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.LSPMaxSessionsPerUser = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_LSP_CACHE_QUOTA_MB"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.LSPCacheQuotaMB = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_LSP_MEMORY_LIMIT"); v != "" {
		cfg.LSPMemoryLimit = v
	}
	if v := os.Getenv("BOBOCLOUD_LSP_CPU_LIMIT"); v != "" {
		cfg.LSPCPULimit = v
	}
	if v := os.Getenv("BOBOCLOUD_DAP_ENABLED"); v != "" {
		cfg.DAPEnabled = v == "true" || v == "1"
	}
	if v := os.Getenv("BOBOCLOUD_DAP_MANIFEST"); v != "" {
		cfg.DAPManifestPath = v
	}
	if v := os.Getenv("BOBOCLOUD_DAP_MAX_SESSIONS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.DAPMaxSessions = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_DAP_MAX_SESSIONS_PER_USER"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.DAPMaxSessionsPerUser = n
		}
	}
	if v := os.Getenv("BOBOCLOUD_DAP_MEMORY_LIMIT"); v != "" {
		cfg.DAPMemoryLimit = v
	}
	if v := os.Getenv("BOBOCLOUD_DAP_CPU_LIMIT"); v != "" {
		cfg.DAPCPULimit = v
	}
	if v := os.Getenv("BOBOCLOUD_DAP_NETWORK_ENABLED"); v != "" {
		cfg.DAPNetworkEnabled = v == "true" || v == "1"
	}
}

// WriteDefault 将默认配置写入指定路径的 JSON 文件。
func WriteDefault(path string) error {
	cfg := Default()
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// Duration 辅助方法

// SessionTTLDuration 返回 SessionTTL 的 time.Duration。
func (c *Config) SessionTTLDuration() time.Duration {
	return time.Duration(c.SessionTTL) * time.Second
}

// SessionCleanupDuration 返回清理间隔的 time.Duration。
func (c *Config) SessionCleanupDuration() time.Duration {
	return time.Duration(c.SessionCleanupInterval) * time.Second
}

// CompileTimeoutDuration 返回编译超时的 time.Duration。
func (c *Config) CompileTimeoutDuration() time.Duration {
	return time.Duration(c.DefaultCompileTimeout) * time.Second
}

// RunTimeoutDuration 返回运行超时的 time.Duration。
func (c *Config) RunTimeoutDuration() time.Duration {
	return time.Duration(c.DefaultRunTimeout) * time.Second
}

// WSWriteWaitDuration 返回 WebSocket 写超时的 time.Duration。
func (c *Config) WSWriteWaitDuration() time.Duration {
	return time.Duration(c.WSWriteWait) * time.Second
}

// WSPingDuration 返回 WebSocket ping 间隔的 time.Duration。
func (c *Config) WSPingDuration() time.Duration {
	return time.Duration(c.WSPingPeriod) * time.Second
}

// TerminalHandshakeDuration returns the terminal start-frame deadline.
func (c *Config) TerminalHandshakeDuration() time.Duration {
	if c == nil || c.TerminalHandshakeTimeoutSeconds <= 0 {
		return 10 * time.Second
	}
	return time.Duration(c.TerminalHandshakeTimeoutSeconds) * time.Second
}

// TerminalIdleDuration returns the maximum period without client or process
// activity before an interactive terminal is stopped.
func (c *Config) TerminalIdleDuration() time.Duration {
	if c == nil || c.TerminalIdleTTLSeconds <= 0 {
		return 15 * time.Minute
	}
	return time.Duration(c.TerminalIdleTTLSeconds) * time.Second
}

// TerminalMaxSessionDuration returns the hard upper bound for one terminal.
func (c *Config) TerminalMaxSessionDuration() time.Duration {
	if c == nil || c.TerminalMaxSessionSeconds <= 0 {
		return time.Hour
	}
	return time.Duration(c.TerminalMaxSessionSeconds) * time.Second
}

// TerminalMaxMessageLimit bounds one terminal WebSocket frame.
func (c *Config) TerminalMaxMessageLimit() int64 {
	if c == nil || c.TerminalMaxMessageBytes <= 0 {
		return 64 * 1024
	}
	return int64(c.TerminalMaxMessageBytes)
}

// TerminalBandwidthLimit bounds aggregate terminal traffic per minute.
func (c *Config) TerminalBandwidthLimit() int64 {
	if c == nil || c.TerminalBandwidthPerMinuteBytes <= 0 {
		return 8 << 20
	}
	return c.TerminalBandwidthPerMinuteBytes
}

// TerminalWorkspaceCopyTimeoutDuration bounds staging one isolated terminal
// workspace before Docker receives it.
func (c *Config) TerminalWorkspaceCopyTimeoutDuration() time.Duration {
	if c == nil || c.TerminalWorkspaceCopyTimeoutSeconds <= 0 {
		return 30 * time.Second
	}
	return time.Duration(c.TerminalWorkspaceCopyTimeoutSeconds) * time.Second
}

// TerminalWorkspaceCopyLimit bounds the source bytes staged for one terminal.
func (c *Config) TerminalWorkspaceCopyLimit() int64 {
	if c == nil || c.TerminalWorkspaceCopyMaxBytes <= 0 {
		return 512 << 20
	}
	return c.TerminalWorkspaceCopyMaxBytes
}

// TerminalTimeoutDuration 返回终端命令超时的 time.Duration。
func (c *Config) TerminalTimeoutDuration() time.Duration {
	return time.Duration(c.DockerTerminalTimeout) * time.Second
}

// PoolReplenishDuration 返回补池间隔的 time.Duration。
func (c *Config) PoolReplenishDuration() time.Duration {
	return time.Duration(c.DockerPoolReplenishInterval) * time.Second
}
