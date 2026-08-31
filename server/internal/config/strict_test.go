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
