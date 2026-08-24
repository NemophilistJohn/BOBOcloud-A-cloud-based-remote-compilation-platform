package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPackageCenterDefaultsExposeOfficialAndTUNASources(t *testing.T) {
	cfg := Default()
	if !cfg.PackageCenterEnabled || len(cfg.PackageSources) < 3 || cfg.PackageSources[0].ID != "pypi-official" || cfg.PackageSources[1].ID != "pypi-tuna" || cfg.PackageSources[2].ID != "pypi-aliyun" {
		t.Fatalf("package center defaults = %+v", cfg.PackageSources)
	}
	if cfg.PackageOperationMaxPlans != 512 || cfg.PackageOperationMaxPlansPerUser != 32 || cfg.PackagePlanStoreMaxBytes != 64<<20 || cfg.PackagePlanStoreMaxBytesPerUser != 16<<20 || cfg.PackagePlanResultMaxBytes != 64<<10 {
		t.Fatalf("package plan limits = global:%d user:%d bytes:%d userBytes:%d resultBytes:%d", cfg.PackageOperationMaxPlans, cfg.PackageOperationMaxPlansPerUser, cfg.PackagePlanStoreMaxBytes, cfg.PackagePlanStoreMaxBytesPerUser, cfg.PackagePlanResultMaxBytes)
	}
	if cfg.PackagePlanCompletedTTLSeconds != 60*60 {
		t.Fatalf("completed plan TTL = %d", cfg.PackagePlanCompletedTTLSeconds)
	}
	if cfg.PackageRuntimeProbeTimeoutSeconds != 3 || cfg.PackageRuntimeMetadataTTLSeconds != 60*60 {
		t.Fatalf("runtime metadata policy = timeout:%d ttl:%d", cfg.PackageRuntimeProbeTimeoutSeconds, cfg.PackageRuntimeMetadataTTLSeconds)
	}
	if cfg.PackageDefaultSource != "pypi-official" {
		t.Fatalf("default package source = %q", cfg.PackageDefaultSource)
	}
	if cfg.PackageSources[0].CatalogURL != "https://pypi.org" || cfg.PackageSources[1].CatalogURL != "https://pypi.tuna.tsinghua.edu.cn" || cfg.PackageSources[1].InstallURL != "https://pypi.tuna.tsinghua.edu.cn/simple/" {
		t.Fatalf("package catalog authorities = %+v", cfg.PackageSources)
	}
	for _, source := range cfg.PackageSources {
		if source.EquivalenceGroup != "pypi" {
			t.Fatalf("source is outside the PyPI equivalence group: %+v", source)
		}
	}
}

func TestPackageCenterCompletedTTLCoversOperationAndRetryGrace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"package_operation_timeout_seconds":600,"package_plan_completed_ttl_seconds":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PackagePlanCompletedTTLSeconds != 660 {
		t.Fatalf("completed TTL = %d, want operation timeout plus retry grace", cfg.PackagePlanCompletedTTLSeconds)
	}
}

func TestPackageCenterRejectsUntrustedOrNonEquivalentSources(t *testing.T) {
	for name, payload := range map[string]string{
		"plaintext":       `{"package_sources":[{"id":"bad","ecosystem":"python","kind":"mirror","catalog_url":"http://registry.example","install_url":"https://registry.example/simple","equivalence_group":"pypi"}]}`,
		"arbitrary":       `{"package_sources":[{"id":"private","ecosystem":"python","kind":"mirror","catalog_url":"https://registry.example","install_url":"https://registry.example/simple","equivalence_group":"private"}]}`,
		"duplicate":       `{"package_sources":[{"id":"same","ecosystem":"python","kind":"official","catalog_url":"https://pypi.org","install_url":"https://pypi.org/simple","equivalence_group":"pypi"},{"id":"same","ecosystem":"python","kind":"mirror","catalog_url":"https://pypi.org","install_url":"https://mirror.example/simple","equivalence_group":"pypi"}]}`,
		"unknown default": `{"package_default_source":"missing"}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, []byte(payload), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "package source") {
				t.Fatalf("invalid package source was accepted: %v", err)
			}
		})
	}
}

func TestPackageCenterClampsUnsafeCompletedResultLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"package_plan_result_max_bytes":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PackagePlanResultMaxBytes != minimumPackagePlanResultBytes {
		t.Fatalf("completed result limit = %d, want minimum %d", cfg.PackagePlanResultMaxBytes, minimumPackagePlanResultBytes)
	}
}
