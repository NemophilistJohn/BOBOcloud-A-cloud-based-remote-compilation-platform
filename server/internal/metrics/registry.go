package metrics

import (
	"math"
	"sort"
	"sync"
	"time"
)

// Registry keeps a bounded in-process observation window. It is intentionally
// dependency-free so compiler telemetry remains available before an external
// metrics backend is configured.
type Registry struct {
	enabled bool
	window  int
	mu      sync.Mutex
	stages  map[string]*stage
}

type stage struct {
	count      int64
	totalNanos int64
	maxNanos   int64
	bytes      int64
	hits       int64
	misses     int64
	samples    []int64
	next       int
}

type Snapshot struct {
	GeneratedAt time.Time                `json:"generated_at"`
	WindowSize  int                      `json:"window_size"`
	Stages      map[string]StageSnapshot `json:"stages"`
}

type StageSnapshot struct {
	Count       int64   `json:"count"`
	TotalMS     float64 `json:"total_ms"`
	AverageMS   float64 `json:"average_ms"`
	P50MS       float64 `json:"p50_ms"`
	P95MS       float64 `json:"p95_ms"`
	P99MS       float64 `json:"p99_ms"`
	MaxMS       float64 `json:"max_ms"`
	Bytes       int64   `json:"bytes"`
	CacheHits   int64   `json:"cache_hits"`
	CacheMisses int64   `json:"cache_misses"`
	HitRate     float64 `json:"hit_rate"`
}

func New(enabled bool, window int) *Registry {
	if window <= 0 {
		window = 512
	}
	return &Registry{enabled: enabled, window: window, stages: make(map[string]*stage)}
}

func (r *Registry) Enabled() bool { return r != nil && r.enabled }

func (r *Registry) Observe(name string, elapsed time.Duration) {
	if !r.Enabled() || name == "" {
		return
	}
	nanos := elapsed.Nanoseconds()
	if nanos < 0 {
		nanos = 0
	}
	r.mu.Lock()
	s := r.stageLocked(name)
	s.count++
	s.totalNanos += nanos
	if nanos > s.maxNanos {
		s.maxNanos = nanos
	}
	if len(s.samples) < r.window {
		s.samples = append(s.samples, nanos)
	} else {
		s.samples[s.next] = nanos
		s.next = (s.next + 1) % r.window
	}
	r.mu.Unlock()
}

func (r *Registry) AddBytes(name string, bytes int64) {
	if !r.Enabled() || name == "" {
		return
	}
	r.mu.Lock()
	r.stageLocked(name).bytes += bytes
	r.mu.Unlock()
}

func (r *Registry) Cache(name string, hit bool) {
	if !r.Enabled() || name == "" {
		return
	}
	r.mu.Lock()
	s := r.stageLocked(name)
	if hit {
		s.hits++
	} else {
		s.misses++
	}
	r.mu.Unlock()
}

func (r *Registry) stageLocked(name string) *stage {
	s := r.stages[name]
	if s == nil {
		s = &stage{}
		r.stages[name] = s
	}
	return s
}

func (r *Registry) Snapshot() Snapshot {
	result := Snapshot{GeneratedAt: time.Now().UTC(), Stages: make(map[string]StageSnapshot)}
	if r == nil {
		return result
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	result.WindowSize = r.window
	for name, value := range r.stages {
		samples := append([]int64(nil), value.samples...)
		sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
		snapshot := StageSnapshot{
			Count: value.count, TotalMS: millis(value.totalNanos), MaxMS: millis(value.maxNanos),
			Bytes: value.bytes, CacheHits: value.hits, CacheMisses: value.misses,
		}
		if value.count > 0 {
			snapshot.AverageMS = millis(value.totalNanos / value.count)
		}
		if len(samples) > 0 {
			snapshot.P50MS = millis(percentile(samples, 0.50))
			snapshot.P95MS = millis(percentile(samples, 0.95))
			snapshot.P99MS = millis(percentile(samples, 0.99))
		}
		if total := value.hits + value.misses; total > 0 {
			snapshot.HitRate = float64(value.hits) / float64(total)
		}
		result.Stages[name] = snapshot
	}
	return result
}

func percentile(values []int64, quantile float64) int64 {
	if len(values) == 0 {
		return 0
	}
	index := int(math.Ceil(float64(len(values))*quantile)) - 1
	if index < 0 {
		index = 0
	}
	if index >= len(values) {
		index = len(values) - 1
	}
	return values[index]
}

func millis(nanos int64) float64 { return float64(nanos) / float64(time.Millisecond) }
