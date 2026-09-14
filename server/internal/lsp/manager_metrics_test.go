package lsp

import (
	"testing"
	"time"

	"bobocloud-server/internal/metrics"
)

func TestManagerPublishesBoundedStartupAndCleanupTimings(t *testing.T) {
	registry := metrics.New(true, 8)
	catalog, err := NewCatalog(Manifest{Version: 1, Servers: []ServerSpec{{
		LanguageID: "python",
		Command:    []string{"python-language-server", "--stdio"},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	starter := &captureStarter{launches: make(chan LaunchSpec, 1)}
	manager := NewManager(catalog, NewCacheManager(t.TempDir(), 16, 7), starter, ManagerOptions{
		CleanupInterval: time.Hour,
		Metrics:         registry,
	})
	defer manager.Close()

	session, err := manager.Start(SessionContext{
		UserID: "metrics-user", WorkspaceKind: "personal", FolderKey: "metrics-project",
		RuntimeID: "local", LanguageID: "python", Mode: ModeStandard, RemoteRoot: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	launch := <-starter.launches
	if launch.Metrics != registry {
		t.Fatal("LSP launch did not receive the shared metrics registry")
	}
	session.Stop()
	select {
	case <-session.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("LSP session did not stop")
	}

	snapshot := registry.Snapshot()
	for _, name := range []string{
		"lsp.session.start", "lsp.session.cache_prepare", "lsp.cache.prepare",
		"lsp.process.start", "lsp.process.wait", "lsp.session.cleanup",
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
