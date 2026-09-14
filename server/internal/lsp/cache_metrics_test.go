package lsp

import (
	"testing"

	"bobocloud-server/internal/metrics"
)

func TestCacheManagerPublishesBoundedScanAndLifecycleTimings(t *testing.T) {
	registry := metrics.New(true, 8)
	manager := NewCacheManager(t.TempDir(), 16, 7)
	manager.SetMetrics(registry)

	manager.Inspect("user", "cache-metrics")
	manager.Inspect("user", "cache-metrics")

	snapshot := registry.Snapshot()
	scan, ok := snapshot.Stages["lsp.cache.inspect"]
	if !ok || scan.Count != 2 || scan.P95MS < 0 || scan.P99MS < scan.P95MS {
		t.Fatalf("cache inspect stage = %+v", scan)
	}
	scanHit, ok := snapshot.Stages["lsp.cache.scan"]
	if !ok || scanHit.CacheHits != 1 || scanHit.CacheMisses != 1 || scanHit.HitRate != .5 {
		t.Fatalf("cache scan hit/miss stage = %+v", scanHit)
	}
}
