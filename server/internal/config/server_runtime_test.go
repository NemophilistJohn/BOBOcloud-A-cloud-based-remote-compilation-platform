package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServerRuntimeDefaultsProtectLongLivedStreams(t *testing.T) {
	cfg := Default()
	if cfg.RootUser.Username != "root" {
		t.Fatalf("default root username = %q", cfg.RootUser.Username)
	}
	if cfg.HTTPReadHeaderTimeoutSeconds != 10 {
		t.Fatalf("read-header timeout = %d, want 10", cfg.HTTPReadHeaderTimeoutSeconds)
	}
	if cfg.HTTPRequestBodyTimeoutSeconds != 15 {
		t.Fatalf("request-body timeout = %d, want 15", cfg.HTTPRequestBodyTimeoutSeconds)
	}
	if cfg.ExecutionMaxSessionSeconds != 600 {
		t.Fatalf("execution max session = %d, want 600", cfg.ExecutionMaxSessionSeconds)
	}
	if cfg.ArtifactMaxFiles != 128 || cfg.ArtifactMaxTotalBytes != 64<<20 {
		t.Fatalf("artifact limits = files %d bytes %d", cfg.ArtifactMaxFiles, cfg.ArtifactMaxTotalBytes)
	}
	if cfg.WorkspaceCopyMaxFiles != 20_000 || cfg.WorkspaceCopyMaxTotalBytes != 1<<30 || cfg.WorkspaceCopyMaxPathBytes != 4096 {
		t.Fatalf("workspace copy limits = files %d bytes %d path %d", cfg.WorkspaceCopyMaxFiles, cfg.WorkspaceCopyMaxTotalBytes, cfg.WorkspaceCopyMaxPathBytes)
	}
	if cfg.HTTPIdleTimeoutSeconds != 90 {
		t.Fatalf("idle timeout = %d, want 90", cfg.HTTPIdleTimeoutSeconds)
	}
	if cfg.HTTPMaxHeaderBytes != 1<<20 {
		t.Fatalf("max header bytes = %d, want %d", cfg.HTTPMaxHeaderBytes, 1<<20)
	}
	if cfg.ShutdownGracePeriodSeconds != 15 {
		t.Fatalf("shutdown grace = %d, want 15", cfg.ShutdownGracePeriodSeconds)
	}
	if cfg.UserDeletionCleanupRetrySeconds != 15 {
		t.Fatalf("user deletion retry = %d, want 15", cfg.UserDeletionCleanupRetrySeconds)
	}
}

func TestWebSocketRuntimeHelpersClampUnvalidatedConfig(t *testing.T) {
	cfg := &Config{}
	if cfg.WSReadLimitBytes() != 65536 || cfg.WSWriteWaitDuration() != 10*time.Second ||
		cfg.WSPingDuration() != 30*time.Second || cfg.ChunkSizeBytes() != 200000 {
		t.Fatalf("zero-value WebSocket limits were not defaulted")
	}
	cfg.WSReadLimit = 1
	cfg.ChunkSize = 1
	if cfg.WSReadLimitBytes() != minimumWSReadLimit || cfg.ChunkSizeBytes() != minimumChunkSize {
		t.Fatal("undersized WebSocket limits were not clamped")
	}
	cfg.WSReadLimit = maximumWSReadLimit + 1
	cfg.WSWriteWait = maximumWSWriteWaitSeconds + 1
	cfg.WSPingPeriod = maximumWSPingPeriodSeconds + 1
	cfg.ChunkSize = maximumChunkSize + 1
	if cfg.WSReadLimitBytes() != maximumWSReadLimit || cfg.WSWriteWaitDuration() != maximumWSWriteWaitSeconds*time.Second ||
		cfg.WSPingDuration() != maximumWSPingPeriodSeconds*time.Second || cfg.ChunkSizeBytes() != maximumChunkSize {
		t.Fatalf("oversized WebSocket limits were not clamped")
	}
}

func TestServerRuntimeEnvironmentOverrides(t *testing.T) {
	t.Setenv("BOBOCLOUD_HTTP_READ_HEADER_TIMEOUT_SECONDS", "7")
	t.Setenv("BOBOCLOUD_HTTP_REQUEST_BODY_TIMEOUT_SECONDS", "11")
	t.Setenv("BOBOCLOUD_EXECUTION_MAX_SESSION_SECONDS", "321")
	t.Setenv("BOBOCLOUD_ARTIFACT_MAX_FILES", "23")
	t.Setenv("BOBOCLOUD_ARTIFACT_MAX_TOTAL_BYTES", "1234567")
	t.Setenv("BOBOCLOUD_WORKSPACE_COPY_MAX_FILES", "23456")
	t.Setenv("BOBOCLOUD_WORKSPACE_COPY_MAX_TOTAL_BYTES", "7654321")
	t.Setenv("BOBOCLOUD_WORKSPACE_COPY_MAX_PATH_BYTES", "2048")
	t.Setenv("BOBOCLOUD_HTTP_IDLE_TIMEOUT_SECONDS", "75")
	t.Setenv("BOBOCLOUD_HTTP_MAX_HEADER_BYTES", "524288")
	t.Setenv("BOBOCLOUD_SHUTDOWN_GRACE_PERIOD_SECONDS", "12")
	t.Setenv("BOBOCLOUD_USER_DELETION_CLEANUP_RETRY_SECONDS", "9")

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HTTPReadHeaderTimeoutSeconds != 7 || cfg.HTTPIdleTimeoutSeconds != 75 {
		t.Fatalf("unexpected listener timeouts: read-header=%d idle=%d", cfg.HTTPReadHeaderTimeoutSeconds, cfg.HTTPIdleTimeoutSeconds)
	}
	if cfg.HTTPRequestBodyTimeoutSeconds != 11 || cfg.ExecutionMaxSessionSeconds != 321 {
		t.Fatalf("unexpected request budgets: body=%d execution=%d", cfg.HTTPRequestBodyTimeoutSeconds, cfg.ExecutionMaxSessionSeconds)
	}
	if cfg.ArtifactMaxFiles != 23 || cfg.ArtifactMaxTotalBytes != 1234567 {
		t.Fatalf("unexpected artifact limits: files=%d bytes=%d", cfg.ArtifactMaxFiles, cfg.ArtifactMaxTotalBytes)
	}
	if cfg.WorkspaceCopyMaxFiles != 23456 || cfg.WorkspaceCopyMaxTotalBytes != 7654321 || cfg.WorkspaceCopyMaxPathBytes != 2048 {
		t.Fatalf("unexpected workspace copy limits: files=%d bytes=%d path=%d", cfg.WorkspaceCopyMaxFiles, cfg.WorkspaceCopyMaxTotalBytes, cfg.WorkspaceCopyMaxPathBytes)
	}
	if cfg.HTTPMaxHeaderBytes != 524288 || cfg.ShutdownGracePeriodSeconds != 12 {
		t.Fatalf("unexpected runtime limits: headers=%d shutdown=%d", cfg.HTTPMaxHeaderBytes, cfg.ShutdownGracePeriodSeconds)
	}
	if cfg.UserDeletionCleanupRetrySeconds != 9 {
		t.Fatalf("user deletion retry = %d, want 9", cfg.UserDeletionCleanupRetrySeconds)
	}
}

func TestWorkspaceCopyLimitsRejectUnboundedValues(t *testing.T) {
	tests := []struct {
		body string
		want string
	}{
		{`{"workspace_copy_max_files":100001}`, "workspace_copy_max_files"},
		{`{"workspace_copy_max_total_bytes":8589934593}`, "workspace_copy_max_total_bytes"},
		{`{"workspace_copy_max_path_bytes":4097}`, "workspace_copy_max_path_bytes"},
	}
	for _, test := range tests {
		path := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, []byte(test.body), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("config %s error=%v", test.body, err)
		}
	}
}
