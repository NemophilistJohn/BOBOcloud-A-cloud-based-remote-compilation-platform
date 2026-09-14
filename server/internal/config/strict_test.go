package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTopLevelConfigRejectsUnknownFieldsButAllowsDocumentation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"_comment":"kept for people","http_port":4100}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil || cfg.HTTPPort != 4100 {
		t.Fatalf("documented config failed: port=%d err=%v", cfg.HTTPPort, err)
	}
	if err := os.WriteFile(path, []byte(`{"auth_mod":"multi"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("unknown field error=%v", err)
	}
}

func TestRepositoryConfigUsesOnlySupportedFields(t *testing.T) {
	path := filepath.Join("..", "..", "config.json")
	if _, err := Load(path); err != nil {
		t.Fatalf("repository config failed strict decoding: %v", err)
	}
}

func TestConfigRejectsUnsafeRootAndSeedUserIdentities(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{name: "root traversal", body: `{"root_user":{"username":"../../root"}}`, want: "root_user.username"},
		{name: "seed traversal", body: `{"users":[{"id":"../../escape"}]}`, want: "users[0].id"},
		{name: "reserved root", body: `{"root_user":{"username":"CON"}}`, want: "root_user.username"},
		{name: "root whitespace", body: `{"root_user":{"username":" root "}}`, want: "root_user.username"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, []byte(test.body), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("config error = %v, want %s", err, test.want)
			}
		})
	}
}

func TestConfigRejectsUnboundedRunOutputFromJSONAndEnvironment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"run_output_retained_bytes":16777217}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "run_output_retained_bytes") {
		t.Fatalf("JSON retention error = %v", err)
	}
	t.Setenv("BOBOCLOUD_RUN_OUTPUT_RETAINED_BYTES", "16777217")
	if _, err := Load(""); err == nil || !strings.Contains(err.Error(), "run_output_retained_bytes") {
		t.Fatalf("environment retention error = %v", err)
	}
}

func TestConfigTLSRequiredFailsClosedForPlaintextOrMissingCredentials(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cases := []struct {
		name string
		body string
		want string
	}{
		{name: "required without enabled", body: `{"tls_required":true}`, want: "tls_required"},
		{name: "enabled without certificate", body: `{"tls_required":true,"tls_enabled":true,"tls_key_file":"/etc/bobocloud/tls/bobocloud.key"}`, want: "tls_enabled"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(test.body), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("TLS config error = %v, want %s", err, test.want)
			}
		})
	}

	t.Setenv("BOBOCLOUD_TLS_REQUIRED", "true")
	if _, err := Load(""); err == nil || !strings.Contains(err.Error(), "tls_required") {
		t.Fatalf("environment TLS requirement was not enforced: %v", err)
	}
}

func TestConfigTLSRequiredEnvironmentOverridesCompleteConfiguration(t *testing.T) {
	t.Setenv("BOBOCLOUD_TLS_REQUIRED", "true")
	t.Setenv("BOBOCLOUD_TLS_ENABLED", "true")
	t.Setenv("BOBOCLOUD_TLS_CERT_FILE", "/etc/bobocloud/tls/bobocloud.crt")
	t.Setenv("BOBOCLOUD_TLS_KEY_FILE", "/etc/bobocloud/tls/bobocloud.key")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.TLSRequired || !cfg.TLSEnabled || cfg.TLSCertFile == "" || cfg.TLSKeyFile == "" {
		t.Fatalf("TLS environment overrides = required:%v enabled:%v cert:%q key:%q", cfg.TLSRequired, cfg.TLSEnabled, cfg.TLSCertFile, cfg.TLSKeyFile)
	}
}

func TestConfigServerRootEnvironmentOverride(t *testing.T) {
	t.Setenv("BOBOCLOUD_SERVER_ROOT", "/srv/bobocloud-workspaces")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerRoot != "/srv/bobocloud-workspaces" {
		t.Fatalf("server root environment override = %q", cfg.ServerRoot)
	}
}

func TestConfigRejectsInvalidWebSocketBounds(t *testing.T) {
	tests := []struct {
		field string
		value int
	}{
		{field: "ws_read_limit", value: 0},
		{field: "ws_read_limit", value: maximumWSReadLimit + 1},
		{field: "ws_write_wait_seconds", value: 0},
		{field: "ws_write_wait_seconds", value: maximumWSWriteWaitSeconds + 1},
		{field: "ws_ping_period_seconds", value: 0},
		{field: "ws_ping_period_seconds", value: maximumWSPingPeriodSeconds + 1},
		{field: "chunk_size", value: 0},
		{field: "chunk_size", value: maximumChunkSize + 1},
	}
	for _, test := range tests {
		t.Run(fmt.Sprintf("%s=%d", test.field, test.value), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			body := fmt.Sprintf(`{"%s":%d}`, test.field, test.value)
			if err := os.WriteFile(path, []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil || !strings.Contains(err.Error(), test.field) {
				t.Fatalf("config error = %v, want %s", err, test.field)
			}
		})
	}
}
