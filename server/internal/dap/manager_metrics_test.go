package dap

import (
	"testing"
	"time"

	"bobocloud-server/internal/metrics"
)

func TestManagerPublishesAdapterStartupAndCleanupTimings(t *testing.T) {
	registry := metrics.New(true, 8)
	starter := &managerTestStarter{}
	manager := NewManager(managerTestCatalog(), starter, ManagerOptions{
		MaxSessions: 1,
		MaxPerUser:  1,
		Inspector:   catalogTestInspector{available: true},
		Metrics:     registry,
	})
	defer manager.Close()

	session, err := manager.Start(managerTestContext(t.TempDir(), nil))
	if err != nil {
		t.Fatal(err)
	}
	launch := starter.launch(0)
	if launch.Metrics != registry {
		t.Fatal("DAP launch did not receive the shared metrics registry")
	}
	session.Stop()
	select {
	case <-session.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("DAP session did not stop")
	}

	snapshot := registry.Snapshot()
	for _, name := range []string{
		"dap.session.start", "dap.adapter.inspect", "dap.process.start",
		"dap.process.wait", "dap.session.cleanup",
	} {
		stage, ok := snapshot.Stages[name]
		if !ok || stage.Count == 0 {
			t.Fatalf("stage %q was not observed: %+v", name, snapshot.Stages)
		}
		if stage.P95MS < 0 || stage.P99MS < stage.P95MS {
			t.Fatalf("stage %q has invalid bounded quantiles: %+v", name, stage)
		}
	}
}
