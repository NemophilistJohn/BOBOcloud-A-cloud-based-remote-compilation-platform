package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDockerPoolReplenishIntervalDefaultsToPositiveDuration(t *testing.T) {
	cfg := Default()
	if cfg.DockerPoolReplenishInterval <= 0 {
		t.Fatalf("replenish interval = %d, want a positive value", cfg.DockerPoolReplenishInterval)
	}
	if got := cfg.PoolReplenishDuration(); got != time.Duration(cfg.DockerPoolReplenishInterval)*time.Second {
		t.Fatalf("replenish duration = %v", got)
	}
}

func TestDockerPoolReplenishIntervalRejectsNonPositiveValues(t *testing.T) {
	for _, value := range []string{"0", "-1"} {
		t.Run(value, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			body := []byte(`{"docker_pool_replenish_interval_seconds":` + value + `}`)
			if err := os.WriteFile(path, body, 0600); err != nil {
				t.Fatal(err)
			}
			_, err := Load(path)
			if err == nil || !strings.Contains(err.Error(), "docker_pool_replenish_interval_seconds") {
				t.Fatalf("invalid replenish interval %s was accepted: %v", value, err)
			}
		})
	}
}
