package lifecycle

import (
	"context"
	"errors"
	"testing"
)

func TestWorkspaceMutationExcludesOnlyMatchingActivity(t *testing.T) {
	manager := NewManager()
	activity, err := manager.AcquireActivity("user", "project-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.BeginWorkspaceMutation("user", "project-a"); !errors.Is(err, ErrResourcesInUse) {
		t.Fatalf("matching mutation error = %v", err)
	}
	other, err := manager.BeginWorkspaceMutation("user", "project-b")
	if err != nil {
		t.Fatalf("unrelated workspace was blocked: %v", err)
	}
	if _, err := manager.AcquireActivity("user", "project-b"); !errors.Is(err, ErrResourcesInUse) {
		t.Fatalf("activity entered mutating workspace: %v", err)
	}
	other.Release()
	activity.Release()
}

func TestUserMutationBlocksAllActivityAndIsIdempotent(t *testing.T) {
	manager := NewManager()
	terminal, err := manager.AcquireActivity("user", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.BeginUserMutation("user"); !errors.Is(err, ErrResourcesInUse) {
		t.Fatalf("user mutation with terminal error = %v", err)
	}
	terminal.Release()
	mutation, err := manager.BeginUserMutation("user")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.AcquireActivity("user", "project"); !errors.Is(err, ErrResourcesInUse) {
		t.Fatalf("activity entered user mutation: %v", err)
	}
	mutation.Release()
	mutation.Release()
	activity, err := manager.AcquireActivity("user", "project")
	if err != nil {
		t.Fatal(err)
	}
	activity.Release()
}

func TestUserDeletionCoordinatesAuthenticatedRequestsWithoutSelfConflict(t *testing.T) {
	manager := NewManager()
	request, err := manager.AcquireRequest("user")
	if err != nil {
		t.Fatal(err)
	}
	mutation, err := manager.BeginUserMutation("user")
	if err != nil {
		t.Fatalf("request lease conflicted with its own internal mutation: %v", err)
	}
	if _, err := manager.BeginUserDeletion("user"); !errors.Is(err, ErrResourcesInUse) {
		t.Fatalf("deletion entered while an authenticated request was active: %v", err)
	}
	mutation.Release()
	request.Release()

	deletion, err := manager.BeginUserDeletion("user")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.AcquireRequest("user"); !errors.Is(err, ErrResourcesInUse) {
		t.Fatalf("request entered during account deletion: %v", err)
	}
	if _, err := manager.BeginUserMutation("user"); !errors.Is(err, ErrResourcesInUse) {
		t.Fatalf("resource mutation entered during account deletion: %v", err)
	}
	deletion.Release()
	request, err = manager.AcquireRequest("user")
	if err != nil {
		t.Fatalf("request stayed blocked after deletion lease release: %v", err)
	}
	request.Release()
}

func TestRevokeUserCancelsOnlyMatchingOperations(t *testing.T) {
	manager := NewManager()
	aliceCtx, alice, err := manager.BindOperation(context.Background(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	defer alice.Release()
	bobCtx, bob, err := manager.BindOperation(context.Background(), "bob")
	if err != nil {
		t.Fatal(err)
	}
	defer bob.Release()

	if cancelled := manager.RevokeUser("alice", ErrUserRevoked); cancelled != 1 {
		t.Fatalf("cancelled operations = %d, want 1", cancelled)
	}
	if !errors.Is(context.Cause(aliceCtx), ErrUserRevoked) {
		t.Fatalf("alice context cause = %v", context.Cause(aliceCtx))
	}
	select {
	case <-bobCtx.Done():
		t.Fatalf("bob context was cancelled: %v", context.Cause(bobCtx))
	default:
	}
}

func TestUserDeletionWaitsForBoundOperation(t *testing.T) {
	manager := NewManager()
	_, operation, err := manager.BindOperation(context.Background(), "user")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.BeginUserDeletion("user"); !errors.Is(err, ErrResourcesInUse) {
		t.Fatalf("deletion with bound operation error = %v", err)
	}
	operation.Release()
	deletion, err := manager.BeginUserDeletion("user")
	if err != nil {
		t.Fatal(err)
	}
	deletion.Release()
}
