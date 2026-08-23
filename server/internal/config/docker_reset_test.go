package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDockerContainerResetStrategyDefaultsToVerified(t *testing.T) {
	if got := Default().DockerContainerResetStrategy; got != "verified" {
		t.Fatalf("reset strategy = %q, want verified", got)
	}
}

func TestDockerContainerResetStrategyCanUseRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"docker_container_reset_strategy":"restart"}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DockerContainerResetStrategy != "restart" {
		t.Fatalf("reset strategy = %q", cfg.DockerContainerResetStrategy)
	}
}

func TestDockerContainerResetStrategyNormalizesConfiguredValue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"docker_container_reset_strategy":" VERIFIED "}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DockerContainerResetStrategy != "verified" {
		t.Fatalf("reset strategy = %q", cfg.DockerContainerResetStrategy)
	}
}

func TestDockerContainerResetStrategyRejectsUnknownValue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"docker_container_reset_strategy":"unsafe"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("unknown reset strategy was accepted")
	}
}

func TestDockerContainerResetStrategyEnvironmentOverrideIsValidated(t *testing.T) {
	t.Setenv("BOBOCLOUD_DOCKER_CONTAINER_RESET_STRATEGY", "restart")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DockerContainerResetStrategy != "restart" {
		t.Fatalf("reset strategy = %q", cfg.DockerContainerResetStrategy)
	}
}
