package handler

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// ============================================================
// rate_limit.go — 令牌桶限流器（per-user）
// ============================================================

// RateLimiter 基于令牌桶算法的 per-user 限流器，线程安全。
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*tokenBucket
	rate    float64 // 令牌/秒
	burst   int     // 桶容量（突发允许量）
	enabled bool
}

type tokenBucket struct {
	tokens   float64
	lastFill time.Time
}

// NewRateLimiter 创建限流器。
// ratePerMinute: 每分钟允许的请求数。
// burst: 突发容量（瞬间允许的最大并发请求数）。
func NewRateLimiter(ratePerMinute, burst int) *RateLimiter {
	return &RateLimiter{
		buckets: make(map[string]*tokenBucket),
		rate:    float64(ratePerMinute) / 60.0,
		burst:   burst,
		enabled: ratePerMinute > 0,
	}
}

// DisabledLimiter 返回一个禁用的限流器（不限速）
func DisabledLimiter() *RateLimiter {
	return &RateLimiter{enabled: false}
}

// Allow 检查指定 key（通常为 userID）的请求是否允许。
// 返回 true 表示放行，false 表示被限流。
func (rl *RateLimiter) Allow(key string) bool {
	return rl.allowAt(key, rl.rate, rl.burst)
}

// AllowWithRate 使用指定用户的每分钟额度。ratePerMinute <= 0 时回退到
// 限流器默认值；这样已有全局配置与登录限流行为保持不变。
func (rl *RateLimiter) AllowWithRate(key string, ratePerMinute int) bool {
	if ratePerMinute <= 0 {
		return rl.Allow(key)
	}
	burst := ratePerMinute * 2
	if burst < 1 {
		burst = 1
	}
	return rl.allowAt(key, float64(ratePerMinute)/60.0, burst)
}

func (rl *RateLimiter) allowAt(key string, rate float64, burst int) bool {
	if !rl.enabled {
		return true
	}

	rl.mu.Lock()
	defer rl.mu.Unlock()

	bucket, ok := rl.buckets[key]
	if !ok {
		// 新用户：初始给满 burst 容量
		bucket = &tokenBucket{tokens: float64(burst), lastFill: time.Now()}
		rl.buckets[key] = bucket
	}

	// 补充令牌
	now := time.Now()
	elapsed := now.Sub(bucket.lastFill).Seconds()
	bucket.tokens += elapsed * rate
	if bucket.tokens > float64(burst) {
		bucket.tokens = float64(burst)
	}
	bucket.lastFill = now

	// 尝试消费
	if bucket.tokens >= 1.0 {
		bucket.tokens -= 1.0
		return true
	}
	return false
}

// CleanupExpired 清理超过 ttl 未使用的桶（后台协程定时调用）
func (rl *RateLimiter) CleanupExpired(ttl time.Duration) {
	if !rl.enabled {
		return
	}
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	for key, bucket := range rl.buckets {
		if now.Sub(bucket.lastFill) > ttl {
			delete(rl.buckets, key)
		}
	}
}

// Middleware 返回一个 HTTP 中间件，对请求进行限流。
// keyFunc 用于从 request 中提取限流 key（如 userID）。
func (rl *RateLimiter) Middleware(keyFunc func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := keyFunc(r)
			if !rl.Allow(key) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", "1")
				w.WriteHeader(http.StatusTooManyRequests)
				json.NewEncoder(w).Encode(map[string]interface{}{
					"success":    false,
					"error":      "Rate limit exceeded. Please slow down.",
					"retryAfter": 1,
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
