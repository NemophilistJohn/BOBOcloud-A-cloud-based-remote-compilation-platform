package config

import "testing"

func TestDAPDefaultsFitTheProductionNode(t *testing.T) {
	cfg := Default()
	if !cfg.DAPEnabled || cfg.DAPMaxSessions != 1 || cfg.DAPMaxSessionsPerUser != 1 {
		t.Fatalf("unexpected DAP concurrency defaults: global=%d user=%d enabled=%v", cfg.DAPMaxSessions, cfg.DAPMaxSessionsPerUser, cfg.DAPEnabled)
	}
	if cfg.DAPMemoryLimit != "384m" || cfg.DAPNetworkEnabled {
		t.Fatalf("unexpected DAP resource defaults: memory=%q network=%v", cfg.DAPMemoryLimit, cfg.DAPNetworkEnabled)
	}
}
