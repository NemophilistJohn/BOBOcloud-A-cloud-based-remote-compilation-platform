package config

import "testing"

func TestServerRuntimeDefaultsProtectLongLivedStreams(t *testing.T) {
	cfg := Default()
	if cfg.HTTPReadHeaderTimeoutSeconds != 10 {
		t.Fatalf("read-header timeout = %d, want 10", cfg.HTTPReadHeaderTimeoutSeconds)
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

func TestServerRuntimeEnvironmentOverrides(t *testing.T) {
	t.Setenv("BOBOCLOUD_HTTP_READ_HEADER_TIMEOUT_SECONDS", "7")
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
	if cfg.HTTPMaxHeaderBytes != 524288 || cfg.ShutdownGracePeriodSeconds != 12 {
		t.Fatalf("unexpected runtime limits: headers=%d shutdown=%d", cfg.HTTPMaxHeaderBytes, cfg.ShutdownGracePeriodSeconds)
	}
	if cfg.UserDeletionCleanupRetrySeconds != 9 {
		t.Fatalf("user deletion retry = %d, want 9", cfg.UserDeletionCleanupRetrySeconds)
	}
}
