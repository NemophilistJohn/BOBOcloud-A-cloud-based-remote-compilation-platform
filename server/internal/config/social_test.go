package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProjectSnapshotCapacityDefaultsAndEnvironment(t *testing.T) {
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ProjectSnapshotCapacityBytes != 2<<30 || cfg.ProjectSnapshotReserveBytes != 1<<30 {
		t.Fatalf("unexpected snapshot defaults: %d %d", cfg.ProjectSnapshotCapacityBytes, cfg.ProjectSnapshotReserveBytes)
	}
	t.Setenv("BOBOCLOUD_PROJECT_SNAPSHOT_CAPACITY_BYTES", "104857600")
	t.Setenv("BOBOCLOUD_PROJECT_SNAPSHOT_RESERVE_BYTES", "209715200")
	cfg, err = Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ProjectSnapshotCapacityBytes != 104857600 || cfg.ProjectSnapshotReserveBytes != 209715200 {
		t.Fatalf("snapshot environment settings ignored: %d %d", cfg.ProjectSnapshotCapacityBytes, cfg.ProjectSnapshotReserveBytes)
	}
	for _, value := range []string{"-1", "0", "invalid", "9223372036854775808"} {
		t.Setenv("BOBOCLOUD_PROJECT_SNAPSHOT_RESERVE_BYTES", value)
		if _, err := Load(""); err == nil {
			t.Fatalf("invalid snapshot reserve accepted: %q", value)
		}
	}
}

func TestProjectSnapshotCapacityJSONValidation(t *testing.T) {
	for _, text := range []string{
		`{"project_snapshot_capacity_bytes":0}`,
		`{"project_snapshot_reserve_bytes":-1}`,
	} {
		path := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Fatalf("invalid explicit snapshot settings accepted: %s", text)
		}
	}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"project_snapshot_capacity_bytes":134217728,"project_snapshot_reserve_bytes":268435456}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil || cfg.ProjectSnapshotCapacityBytes != 134217728 || cfg.ProjectSnapshotReserveBytes != 268435456 {
		t.Fatalf("snapshot JSON settings not applied: %+v %v", cfg, err)
	}
}
