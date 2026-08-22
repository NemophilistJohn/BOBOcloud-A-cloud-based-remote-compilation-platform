package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPersonalCacheDefaultsAndValidation(t *testing.T) {
	cfg := Default()
	if cfg.PersonalDependencyScope != "project-lock" || cfg.RunOutputRetainedBytes <= 0 || cfg.DockerQueueSize != 50 ||
		cfg.PersonalPersistMaxFiles != 250_000 || cfg.PersonalPersistReservationFiles != 10_000 {
		t.Fatalf("defaults = %+v", cfg)
	}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"personal_dependency_scope":"shared-user"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("invalid dependency scope was accepted")
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
