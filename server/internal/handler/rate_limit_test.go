package handler

import (
	"testing"
	"time"
)

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

func TestPerUserRateStillAppliesWhenDefaultRateIsZero(t *testing.T) {
	limiter := DisabledLimiter()
	if !limiter.AllowWithRate("limited", 1) || !limiter.AllowWithRate("limited", 1) {
		t.Fatal("per-user limiter did not grant its initial burst")
	}
	if limiter.AllowWithRate("limited", 1) {
		t.Fatal("per-user limiter was bypassed because the default rate was zero")
	}
	if !limiter.AllowWithRate("unlimited", 0) {
		t.Fatal("zero default rate should remain unlimited")
	}
}

func TestRateLimiterBoundsUniqueKeyState(t *testing.T) {
	limiter := NewRateLimiterWithCapacity(60, 1, 2)
	if !limiter.Allow("first") || !limiter.Allow("second") {
		t.Fatal("configured buckets were not admitted")
	}
	if limiter.Allow("third") {
		t.Fatal("limiter admitted state beyond its configured capacity")
	}
	limiter.CleanupExpired(-time.Second)
	if !limiter.Allow("third") {
		t.Fatal("expired bucket cleanup did not reopen capacity")
	}
}
