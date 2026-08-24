package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPersonalCacheDefaultsAndValidation(t *testing.T) {
	cfg := Default()
	if cfg.PersonalCacheMaxGenerations != 2 || !cfg.PersonalBuildCacheEnabled || cfg.PersonalBuildResultReuse != PersonalBuildResultReuseCompileOnly ||
		cfg.RunOutputRetainedBytes <= 0 || cfg.DockerQueueSize != 50 ||
		cfg.PersonalPersistMaxFiles != 250_000 || cfg.PersonalPersistReservationFiles != 10_000 {
		t.Fatalf("defaults = %+v", cfg)
	}

	for _, test := range []struct {
		name string
		body string
	}{
		{name: "zero generations", body: `{"personal_cache_max_generations":0}`},
		{name: "too many generations", body: `{"personal_cache_max_generations":33}`},
		{name: "run output reuse", body: `{"personal_build_result_reuse":"run-output"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, []byte(test.body), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil {
				t.Fatalf("invalid cache-v2 config was accepted: %s", test.body)
			}
		})
	}
}

func TestPersonalCacheV2EnvironmentOverrides(t *testing.T) {
	t.Setenv("BOBOCLOUD_PERSONAL_CACHE_MAX_GENERATIONS", "7")
	t.Setenv("BOBOCLOUD_PERSONAL_BUILD_CACHE_ENABLED", "false")
	t.Setenv("BOBOCLOUD_PERSONAL_BUILD_RESULT_REUSE", "OFF")

	cfg, err := Load(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PersonalCacheMaxGenerations != 7 || cfg.PersonalBuildCacheEnabled || cfg.PersonalBuildResultReuse != PersonalBuildResultReuseOff {
		t.Fatalf("environment overrides = %+v", cfg)
	}
}

func TestPersonalCacheV2CanBeConfigured(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{
		"personal_cache_max_generations": 1,
		"personal_build_cache_enabled": false,
		"personal_build_result_reuse": "off"
	}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PersonalCacheMaxGenerations != 1 || cfg.PersonalBuildCacheEnabled || cfg.PersonalBuildResultReuse != PersonalBuildResultReuseOff {
		t.Fatalf("configured cache-v2 policy = %+v", cfg)
	}
}

func TestPersonalCacheV2RejectsInvalidEnvironment(t *testing.T) {
	for _, test := range []struct {
		name  string
		key   string
		value string
	}{
		{name: "non-integer generations", key: "BOBOCLOUD_PERSONAL_CACHE_MAX_GENERATIONS", value: "many"},
		{name: "zero generations", key: "BOBOCLOUD_PERSONAL_CACHE_MAX_GENERATIONS", value: "0"},
		{name: "invalid build gate", key: "BOBOCLOUD_PERSONAL_BUILD_CACHE_ENABLED", value: "sometimes"},
		{name: "run output reuse", key: "BOBOCLOUD_PERSONAL_BUILD_RESULT_REUSE", value: "run-output"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(test.key, test.value)
			if _, err := Load(filepath.Join(t.TempDir(), "missing.json")); err == nil {
				t.Fatalf("invalid environment override was accepted: %s=%s", test.key, test.value)
			}
		})
	}
}

func TestPersonalDependencyScopeIsExplicitlyRetired(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"personal_dependency_scope":"legacy-user"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "removed") {
		t.Fatalf("retired config field was accepted: %v", err)
	}

	defaultPath := filepath.Join(t.TempDir(), "default.json")
	if err := WriteDefault(defaultPath); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(defaultPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "personal_dependency_scope") {
		t.Fatalf("default config still exposes the retired scope: %s", data)
	}

	t.Setenv("BOBOCLOUD_PERSONAL_DEPENDENCY_SCOPE", "legacy-user")
	if _, err := Load(filepath.Join(t.TempDir(), "missing.json")); err == nil || !strings.Contains(err.Error(), "removed") {
		t.Fatalf("retired environment override was accepted: %v", err)
	}
}

func TestPersonalCacheFileReservationCannotExceedQuota(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"personal_persist_max_files":100,"personal_persist_reservation_files":101}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("file reservation larger than quota was accepted")
	}
}

func TestPersonalCacheFileQuotaCanBeConfigured(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"personal_persist_max_files":12345,"personal_persist_reservation_files":321}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PersonalPersistMaxFiles != 12_345 || cfg.PersonalPersistReservationFiles != 321 {
		t.Fatalf("configured file quota = %d reserve=%d", cfg.PersonalPersistMaxFiles, cfg.PersonalPersistReservationFiles)
	}
}

func TestPersonalCacheRetentionCanDisableAgeEviction(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"personal_persist_retention_days":0}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PersonalPersistRetentionDays != 0 || cfg.PersonalPersistRetention() != 0 {
		t.Fatalf("zero retention was not preserved: days=%d duration=%v", cfg.PersonalPersistRetentionDays, cfg.PersonalPersistRetention())
	}
}
