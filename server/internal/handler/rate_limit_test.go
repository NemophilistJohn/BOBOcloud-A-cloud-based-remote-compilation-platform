package handler

import "testing"

func TestRateLimiterUsesPerUserRate(t *testing.T) {
	limiter := NewRateLimiter(60, 2)
	if !limiter.AllowWithRate("slow", 1) || !limiter.AllowWithRate("slow", 1) {
		t.Fatal("slow user should receive its initial burst")
	}
	if limiter.AllowWithRate("slow", 1) {
		t.Fatal("slow user exceeded its per-user burst")
	}
	for i := 0; i < 6; i++ {
		if !limiter.AllowWithRate("fast", 3) {
			t.Fatalf("fast user request %d unexpectedly rejected", i+1)
		}
	}
	if limiter.AllowWithRate("fast", 3) {
		t.Fatal("fast user exceeded its per-user burst")
	}
}
