package metrics

import (
	"testing"
	"time"
)

func TestRegistryKeepsBoundedSamplesAndCounters(t *testing.T) {
	r := New(true, 3)
	for _, value := range []time.Duration{time.Millisecond, 2 * time.Millisecond, 3 * time.Millisecond, 20 * time.Millisecond} {
		r.Observe("compile", value)
	}
	r.Cache("dependency.cache", true)
	r.Cache("dependency.cache", false)
	r.AddBytes("persist.growth", 42)
	snapshot := r.Snapshot()
	if got := snapshot.Stages["compile"]; got.Count != 4 || got.MaxMS != 20 || got.P95MS != 20 {
		t.Fatalf("compile snapshot = %+v", got)
	}
	if got := snapshot.Stages["dependency.cache"]; got.CacheHits != 1 || got.CacheMisses != 1 || got.HitRate != .5 {
		t.Fatalf("cache snapshot = %+v", got)
	}
	if got := snapshot.Stages["persist.growth"].Bytes; got != 42 {
		t.Fatalf("growth bytes = %d", got)
	}
}

func TestDisabledRegistryDoesNotCollect(t *testing.T) {
	r := New(false, 10)
	r.Observe("run", time.Second)
	if len(r.Snapshot().Stages) != 0 {
		t.Fatal("disabled registry collected observations")
	}
}
