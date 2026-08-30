package containercleanup

import (
	"context"
	"reflect"
	"testing"
)

func TestReleaseGateRunsImmediatelyWithoutRetentionInDeferOrder(t *testing.T) {
	_, gate := WithReleaseGate(context.Background())
	var released []string
	gate.Add(func() { released = append(released, "first") })
	gate.Add(func() { released = append(released, "second") })
	gate.Finalize()
	gate.Finalize()
	if !reflect.DeepEqual(released, []string{"second", "first"}) {
		t.Fatalf("release order = %#v", released)
	}
}

func TestReleaseGateWaitsForRetainedCleanupAndCompletesOnce(t *testing.T) {
	ctx, gate := WithReleaseGate(context.Background())
	released := 0
	gate.Add(func() { released++ })
	var done func()
	if !Retain(ctx, func(complete func()) { done = complete }) {
		t.Fatal("cleanup ownership was not retained")
	}
	gate.Finalize()
	if released != 0 {
		t.Fatal("finalize released resources before container cleanup")
	}
	done()
	done()
	if released != 1 {
		t.Fatalf("release count = %d, want 1", released)
	}
}
