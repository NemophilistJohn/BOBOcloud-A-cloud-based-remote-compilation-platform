package collab

import (
	"errors"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
)

func TestFileLockLeaseRenewalAndStaleRelease(t *testing.T) {
	manager, fixture := testGitCollaboration(t)
	first, err := manager.AcquireLock(fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/main.go", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.LeaseID == "" {
		t.Fatal("acquire returned an empty lease ID")
	}
	firstExpiry := first.ExpiresAt
	renewed, err := manager.AcquireLock(fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/main.go", first.LeaseID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if renewed.LeaseID != first.LeaseID || !renewed.ExpiresAt.After(first.ExpiresAt) {
		t.Fatalf("renewed lock = %+v, first lock = %+v", renewed, first)
	}
	if !first.ExpiresAt.Equal(firstExpiry) {
		t.Fatalf("renewal mutated the previously returned lock: got %v, want %v", first.ExpiresAt, firstExpiry)
	}

	if err := manager.ReleaseLock(fixture.admin.ID, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/main.go", first.LeaseID); err != nil {
		t.Fatal(err)
	}
	// A later acquisition starts a new client generation. A delayed duplicate
	// close from the old generation must not release it.
	reopened, err := manager.AcquireLock(fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/main.go", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.LeaseID == first.LeaseID {
		t.Fatalf("new acquisition reused old lease ID %s", first.LeaseID)
	}
	if err := manager.ReleaseLock(fixture.admin.ID, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/main.go", first.LeaseID); operationErrorCode(err) != ErrorCodeLockStale {
		t.Fatalf("stale release error = %#v, want %s", err, ErrorCodeLockStale)
	}
	if err := manager.ReleaseLock(fixture.admin.ID, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/main.go", ""); operationErrorCode(err) != ErrorCodeLockStale {
		t.Fatalf("lease-less release error = %#v, want %s", err, ErrorCodeLockStale)
	}
	locks, err := manager.ListLocks(fixture.admin.ID, fixture.team.ID, fixture.project.ID)
	if err != nil || len(locks) != 1 || locks[0].LeaseID != reopened.LeaseID {
		t.Fatalf("stale release changed active lock: locks=%+v err=%v", locks, err)
	}
	if _, err := manager.AcquireLock(fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/main.go", first.LeaseID, 10); operationErrorCode(err) != ErrorCodeLockStale {
		t.Fatalf("stale renewal error = %#v, want %s", err, ErrorCodeLockStale)
	}
	if _, err := manager.AcquireLock(fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/main.go", "", 10); operationErrorCode(err) != ErrorCodeLockStale {
		t.Fatalf("lease-less renewal error = %#v, want %s", err, ErrorCodeLockStale)
	}
	if err := manager.ReleaseLock(fixture.admin.ID, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/main.go", reopened.LeaseID); err != nil {
		t.Fatal(err)
	}
}

func TestExpiredFileLockGetsNewLeaseGeneration(t *testing.T) {
	manager, fixture := testGitCollaboration(t)
	first, err := manager.AcquireLock(fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/expired.go", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	expired := *first
	expired.ExpiresAt = time.Now().Add(-time.Minute)
	if err := manager.Store().SaveLock(&expired); err != nil {
		t.Fatal(err)
	}
	second, err := manager.AcquireLock(fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/expired.go", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if second.LeaseID == first.LeaseID {
		t.Fatalf("expired lease ID %s was reused", first.LeaseID)
	}
	if err := manager.ReleaseLock(fixture.admin.ID, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/expired.go", first.LeaseID); operationErrorCode(err) != ErrorCodeLockStale {
		t.Fatalf("expired generation release error = %#v", err)
	}
}

func TestConcurrentFileLockAcquisitionHasSingleWinner(t *testing.T) {
	manager, fixture := testGitCollaboration(t)
	start := make(chan struct{})
	results := make(chan error, 2)
	var wait sync.WaitGroup
	for _, user := range []*auth.User{fixture.admin, fixture.member} {
		wait.Add(1)
		go func(user *auth.User) {
			defer wait.Done()
			<-start
			_, err := manager.AcquireLock(user, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/shared.go", "", 10)
			results <- err
		}(user)
	}
	close(start)
	wait.Wait()
	close(results)
	winners, held := 0, 0
	for err := range results {
		switch operationErrorCode(err) {
		case "":
			if err != nil {
				t.Fatalf("unexpected acquire error: %v", err)
			}
			winners++
		case ErrorCodeLockHeld:
			held++
		default:
			t.Fatalf("unexpected acquire error: %v", err)
		}
	}
	if winners != 1 || held != 1 {
		t.Fatalf("concurrent acquisitions: winners=%d lock-held=%d", winners, held)
	}
	locks, err := manager.ListLocks(fixture.admin.ID, fixture.team.ID, fixture.project.ID)
	if err != nil || len(locks) != 1 {
		t.Fatalf("stored locks = %+v, err = %v", locks, err)
	}
}

func TestLockHeldErrorExposesCurrentLeaseWithoutGitDiagnostics(t *testing.T) {
	manager, fixture := testGitCollaboration(t)
	held, err := manager.AcquireLock(fixture.admin, fixture.team.ID, fixture.project.ID, "", "src/held.go", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.AcquireLock(fixture.member, fixture.team.ID, fixture.project.ID, "", "src/held.go", "", 10)
	var operationErr *OperationError
	if !errors.As(err, &operationErr) || operationErr.Code != ErrorCodeLockHeld {
		t.Fatalf("lock held error = %#v", err)
	}
	if operationErr.Details.Lock == nil || operationErr.Details.Lock.LeaseID != held.LeaseID || operationErr.Details.SuggestedAction != SuggestedActionWaitForLock {
		t.Fatalf("lock held details = %+v", operationErr.Details)
	}
}

func TestFileLockLeaseIsCappedAtTwoMinutes(t *testing.T) {
	manager, fixture := testGitCollaboration(t)
	started := time.Now().UTC()
	lock, err := manager.AcquireLock(fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "src/capped.go", "", 120)
	if err != nil {
		t.Fatal(err)
	}
	if lock.ExpiresAt.After(started.Add(2*time.Minute + 5*time.Second)) {
		t.Fatalf("lock expiry %v exceeds short lease cap", lock.ExpiresAt)
	}
}

func operationErrorCode(err error) string {
	var operationErr *OperationError
	if errors.As(err, &operationErr) {
		return operationErr.Code
	}
	return ""
}
