package docker

import (
	"context"
	"testing"
)

func TestCheckReadyFailsClosedForNilOrClosedPool(t *testing.T) {
	var nilPool *Pool
	if err := nilPool.CheckReady(context.Background()); err == nil {
		t.Fatal("nil pool reported ready")
	}

	pool := &Pool{closed: true}
	if err := pool.CheckReady(context.Background()); err == nil {
		t.Fatal("closed pool reported ready")
	}
}
