package packageops

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/model"
)

func TestPlanStoreIsUserBoundClaimedAndConsumed(t *testing.T) {
	store := NewStore(time.Minute, 2)
	stored, err := store.Put(ExecutionPlan{UserID: "alice", WorkspaceID: "workspace"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "bob"); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("another user claimed a plan: %v", err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); !errors.Is(err, ErrPlanInUse) {
		t.Fatalf("concurrent claim = %v", err)
	}
	store.Release(stored.Public.PlanID)
	if _, err := store.Claim(stored.Public.PlanID, "alice"); err != nil {
		t.Fatalf("released plan was not retryable: %v", err)
	}
	store.Complete(stored.Public.PlanID)
	if _, err := store.Claim(stored.Public.PlanID, "alice"); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("completed plan remained replayable: %v", err)
	}
}

func TestPlanStoreExpiresIdlePlans(t *testing.T) {
	store := NewStore(time.Minute, 2)
	now := time.Unix(100, 0)
	store.now = func() time.Time { return now }
	stored, err := store.Put(ExecutionPlan{UserID: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Minute)
	if _, err := store.Claim(stored.Public.PlanID, "alice"); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("expired plan claim = %v", err)
	}
	if len(store.plans) != 0 || store.totalPlanBytes != 0 || len(store.planCounts) != 0 || len(store.planBytes) != 0 {
		t.Fatalf("expired plan retained capacity: plans=%d bytes=%d counts=%v userBytes=%v", len(store.plans), store.totalPlanBytes, store.planCounts, store.planBytes)
	}
}

func TestPlanStoreDeleteWorkspaceIsUserBoundAndReleasesCapacity(t *testing.T) {
	store := NewStoreWithLimits(time.Minute, StoreLimits{
		MaxPlans: 4, MaxPlansPerUser: 3, MaxBytes: 1 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: 4 << 10,
	})
	put := func(userID, workspaceID string) ExecutionPlan {
		t.Helper()
		plan, err := store.Put(ExecutionPlan{UserID: userID, WorkspaceID: workspaceID})
		if err != nil {
			t.Fatal(err)
		}
		return plan
	}
	target := put("alice", "workspace-a")
	sameUser := put("alice", "workspace-b")
	sameWorkspace := put("bob", "workspace-a")

	if err := store.DeleteWorkspace("", "workspace-a"); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteWorkspace("alice", ""); err != nil {
		t.Fatal(err)
	}
	if len(store.plans) != 3 {
		t.Fatalf("empty binding deleted plans: %+v", store.plans)
	}
	if _, err := store.Claim(target.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}

	wantBytes := store.plans[sameUser.Public.PlanID].bytes + store.plans[sameWorkspace.Public.PlanID].bytes
	if err := store.DeleteWorkspace("alice", "workspace-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(target.Public.PlanID, "alice"); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("deleted workspace plan claim = %v", err)
	}
	for _, survivor := range []struct {
		plan   ExecutionPlan
		userID string
	}{{sameUser, "alice"}, {sameWorkspace, "bob"}} {
		if _, err := store.Claim(survivor.plan.Public.PlanID, survivor.userID); err != nil {
			t.Fatalf("surviving plan %s claim = %v", survivor.plan.Public.PlanID, err)
		}
	}
	if len(store.plans) != 2 || store.planCounts["alice"] != 1 || store.planCounts["bob"] != 1 ||
		store.planBytes["alice"] != store.plans[sameUser.Public.PlanID].bytes ||
		store.planBytes["bob"] != store.plans[sameWorkspace.Public.PlanID].bytes || store.totalPlanBytes != wantBytes {
		t.Fatalf("workspace cleanup retained incorrect capacity: plans=%d bytes=%d counts=%v userBytes=%v", len(store.plans), store.totalPlanBytes, store.planCounts, store.planBytes)
	}
	if err := store.DeleteWorkspace("alice", "workspace-a"); err != nil {
		t.Fatalf("idempotent workspace cleanup = %v", err)
	}
}

func TestPlanStoreEnforcesPerUserBudgetWithoutCrossUserEviction(t *testing.T) {
	store := NewStoreWithLimits(time.Minute, StoreLimits{MaxPlans: 3, MaxPlansPerUser: 1, MaxBytes: 1 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: 4 << 10})
	alice, err := store.Put(ExecutionPlan{UserID: "alice", WorkspaceID: "alice-workspace"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(ExecutionPlan{UserID: "alice", WorkspaceID: "alice-second"}); !errors.Is(err, ErrPlanCapacity) {
		t.Fatalf("second per-user plan error = %v", err)
	}
	if _, err := store.Put(ExecutionPlan{UserID: "bob", WorkspaceID: "bob-workspace"}); err != nil {
		t.Fatalf("another user's budget was blocked: %v", err)
	}
	if _, err := store.Claim(alice.Public.PlanID, "alice"); err != nil {
		t.Fatalf("capacity pressure evicted another plan: %v", err)
	}
}

func TestPlanStoreRejectsWhenAllGlobalSlotsAreActive(t *testing.T) {
	store := NewStoreWithLimits(time.Minute, StoreLimits{MaxPlans: 2, MaxPlansPerUser: 2, MaxBytes: 1 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: 4 << 10})
	for index := 0; index < 2; index++ {
		plan, err := store.Put(ExecutionPlan{UserID: "alice", WorkspaceID: string(rune('a' + index))})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.Claim(plan.Public.PlanID, "alice"); err != nil {
			t.Fatal(err)
		}
	}
	beforeBytes := store.totalPlanBytes
	if _, err := store.Put(ExecutionPlan{UserID: "bob", WorkspaceID: "overflow"}); !errors.Is(err, ErrPlanCapacity) {
		t.Fatalf("full active store error = %v", err)
	}
	if len(store.plans) != 2 || store.totalPlanBytes != beforeBytes {
		t.Fatalf("full active store exceeded limits: plans=%d bytes=%d before=%d", len(store.plans), store.totalPlanBytes, beforeBytes)
	}
}

func TestPlanStoreEnforcesByteBudgetsAndCopiesInput(t *testing.T) {
	public := model.ProjectPackageChangePlan{LocalChanges: []model.ProjectPackageLocalChange{{Path: "requirements.txt", NewContent: strings.Repeat("x", 1024)}}}
	probeStore := NewStoreWithLimits(time.Minute, StoreLimits{MaxPlans: 4, MaxPlansPerUser: 4, MaxBytes: 1 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: minimumMaxResultBytes})
	probe, err := probeStore.Put(ExecutionPlan{Public: public, UserID: "alice", WorkspaceID: "workspace"})
	if err != nil {
		t.Fatal(err)
	}
	size := probeStore.plans[probe.Public.PlanID].bytes
	store := NewStoreWithLimits(time.Minute, StoreLimits{MaxPlans: 4, MaxPlansPerUser: 4, MaxBytes: size * 3, MaxBytesPerUser: size + 64, MaxResultBytes: minimumMaxResultBytes})
	stored, err := store.Put(ExecutionPlan{Public: public, UserID: "alice", WorkspaceID: "workspace"})
	if err != nil {
		t.Fatal(err)
	}
	public.LocalChanges[0].NewContent = strings.Repeat("mutated", 2048)
	claimed, err := store.Claim(stored.Public.PlanID, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Public.LocalChanges[0].NewContent != strings.Repeat("x", 1024) {
		t.Fatal("stored plan shares mutable input slices")
	}
	store.Release(stored.Public.PlanID)
	if _, err := store.Put(ExecutionPlan{Public: model.ProjectPackageChangePlan{LocalChanges: []model.ProjectPackageLocalChange{{NewContent: strings.Repeat("y", 1024)}}}, UserID: "alice"}); !errors.Is(err, ErrPlanCapacity) {
		t.Fatalf("per-user byte budget error = %v", err)
	}
	if _, err := store.Put(ExecutionPlan{Public: model.ProjectPackageChangePlan{LocalChanges: []model.ProjectPackageLocalChange{{NewContent: strings.Repeat("z", int(size*4))}}}, UserID: "bob"}); !errors.Is(err, ErrPlanCapacity) {
		t.Fatalf("global byte budget error = %v", err)
	}
}

func TestPlanStoreResultMinimumDoesNotExpandByteBudget(t *testing.T) {
	store := NewStoreWithLimits(time.Minute, StoreLimits{
		MaxPlans: 1, MaxPlansPerUser: 1, MaxBytes: 1 << 10, MaxBytesPerUser: 1 << 10, MaxResultBytes: 1,
	})
	if store.limits.MaxResultBytes != minimumMaxResultBytes {
		t.Fatalf("result limit = %d, want minimum %d", store.limits.MaxResultBytes, minimumMaxResultBytes)
	}
	if _, err := store.Put(ExecutionPlan{UserID: "alice"}); !errors.Is(err, ErrPlanCapacity) {
		t.Fatalf("undersized byte budget admitted a plan: %v", err)
	}
	if len(store.plans) != 0 || store.totalPlanBytes != 0 || len(store.planCounts) != 0 || len(store.planBytes) != 0 {
		t.Fatalf("rejected plan consumed capacity: plans=%d bytes=%d counts=%v userBytes=%v", len(store.plans), store.totalPlanBytes, store.planCounts, store.planBytes)
	}
}

func TestPlanStoreRetainsUserBoundCompletedResultDeepCopy(t *testing.T) {
	store := NewStoreWithLimits(time.Minute, StoreLimits{
		MaxPlans: 2, MaxPlansPerUser: 2, MaxBytes: 1 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: 64 << 10,
	})
	source := model.PackageCenterSource{ID: "pypi", Ecosystem: "python", Name: "PyPI", Kind: "official", Official: true, EquivalenceGroup: "pypi"}
	stored, err := store.Put(ExecutionPlan{
		Public: model.ProjectPackageChangePlan{Source: source}, UserID: "alice", WorkspaceID: "workspace",
		FolderKey: "folder", RuntimeID: "python:3.12", Language: "python", InstallURL: "https://pypi.org/simple/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	result := model.ProjectPackageChangeResult{
		Schema: "project-package-change-result/v1", PlanID: "untrusted-plan", Applied: true, Stdout: "installed",
		Environment: &model.ProjectEnvironment{Packages: model.ProjectEnvironmentPackages{
			Declared: []model.ProjectEnvironmentPackage{{Name: "numpy", Version: "2.1.0"}},
		}},
	}
	if err := store.CompleteWithResult(stored.Public.PlanID, "bob", result); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("another user completed the plan: %v", err)
	}
	if err := store.CompleteWithResult(stored.Public.PlanID, "alice", result); err != nil {
		t.Fatal(err)
	}
	result.Stdout = "mutated"
	result.Environment.Packages.Declared[0].Name = "mutated"

	if _, err := store.Claim(stored.Public.PlanID, "alice"); !errors.Is(err, ErrPlanCompleted) {
		t.Fatalf("legacy claim did not distinguish completion: %v", err)
	}
	if _, completed, err := store.ClaimOrCompleted(stored.Public.PlanID, "bob"); !errors.Is(err, ErrPlanNotFound) || completed != nil {
		t.Fatalf("completed result crossed user boundary: result=%+v err=%v", completed, err)
	}
	completedPlan, completed, err := store.ClaimOrCompleted(stored.Public.PlanID, "alice")
	if err != nil || completed == nil {
		t.Fatalf("completed result unavailable: result=%+v err=%v", completed, err)
	}
	if completedPlan.UserID != "alice" || completedPlan.WorkspaceID != "workspace" || completedPlan.FolderKey != "folder" || completedPlan.RuntimeID != "python:3.12" || completedPlan.Language != "python" || completedPlan.InstallURL != "" {
		t.Fatalf("completed plan identity = %+v", completedPlan)
	}
	if completedPlan.Public.PlanID != stored.Public.PlanID || completedPlan.Public.Source != source || completedPlan.Public.ExpiresAt != completedPlan.ExpiresAt.UnixMilli() || !completedPlan.CreatedAt.Equal(stored.CreatedAt) || !completedPlan.ExpiresAt.After(completedPlan.CreatedAt) {
		t.Fatalf("completed public identity or times = %+v", completedPlan)
	}
	if completed.PlanID != stored.Public.PlanID || completed.Stdout != "installed" || completed.Environment.Packages.Declared[0].Name != "numpy" {
		t.Fatalf("completed result was not copied or bound to its plan: %+v", completed)
	}
	completedPlan.Public.Source.Name = "response-mutated"
	completed.Stdout = "response-mutated"
	completed.Environment.Packages.Declared[0].Name = "response-mutated"
	if err := store.CompleteWithResult(stored.Public.PlanID, "alice", model.ProjectPackageChangeResult{Applied: true, Stdout: strings.Repeat("x", 128<<10)}); err != nil {
		t.Fatalf("repeated completion was not idempotent: %v", err)
	}
	store.Release(stored.Public.PlanID)
	store.Complete(stored.Public.PlanID)
	completedPlanAgain, completedAgain, err := store.ClaimOrCompleted(stored.Public.PlanID, "alice")
	if err != nil || completedAgain == nil || completedPlanAgain.Public.Source.Name != "PyPI" || completedAgain.Stdout != "installed" || completedAgain.Environment.Packages.Declared[0].Name != "numpy" {
		t.Fatalf("retained identity/result shared response state or was deleted: plan=%+v result=%+v err=%v", completedPlanAgain, completedAgain, err)
	}
}

func TestPlanStoreConcurrentCompletionNeverReclaimsExecution(t *testing.T) {
	store := NewStoreWithLimits(time.Minute, StoreLimits{
		MaxPlans: 2, MaxPlansPerUser: 2, MaxBytes: 1 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: 4 << 10,
	})
	stored, err := store.Put(ExecutionPlan{UserID: "alice", WorkspaceID: "workspace"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}

	type claimOutcome struct {
		plan      ExecutionPlan
		completed *model.ProjectPackageChangeResult
		err       error
	}
	start := make(chan struct{})
	outcomes := make(chan claimOutcome, 64)
	completeErr := make(chan error, 1)
	var wait sync.WaitGroup
	for index := 0; index < cap(outcomes); index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			plan, completed, claimErr := store.ClaimOrCompleted(stored.Public.PlanID, "alice")
			outcomes <- claimOutcome{plan: plan, completed: completed, err: claimErr}
		}()
	}
	go func() {
		<-start
		completeErr <- store.CompleteWithResult(stored.Public.PlanID, "alice", model.ProjectPackageChangeResult{Applied: true, Stdout: "done"})
	}()
	close(start)
	wait.Wait()
	close(outcomes)
	if err := <-completeErr; err != nil {
		t.Fatal(err)
	}
	for outcome := range outcomes {
		if outcome.err == nil && outcome.completed == nil {
			t.Fatalf("completed or active plan was reclaimed for execution: %+v", outcome.plan)
		}
		if outcome.err != nil && !errors.Is(outcome.err, ErrPlanInUse) {
			t.Fatalf("concurrent claim error = %v", outcome.err)
		}
		if outcome.completed != nil && outcome.completed.Stdout != "done" {
			t.Fatalf("concurrent completed result = %+v", outcome.completed)
		}
	}
	if _, completed, err := store.ClaimOrCompleted(stored.Public.PlanID, "alice"); err != nil || completed == nil || completed.Stdout != "done" {
		t.Fatalf("final completed result = %+v, error=%v", completed, err)
	}
}

func TestPlanStoreCompletedTombstoneRetainsAndReleasesBudget(t *testing.T) {
	store := NewStoreWithLimits(time.Minute, StoreLimits{
		MaxPlans: 2, MaxPlansPerUser: 1, MaxBytes: 1 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: 4 << 10,
	})
	now := time.Unix(100, 0)
	store.now = func() time.Time { return now }
	stored, err := store.Put(ExecutionPlan{UserID: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	reservedBytes := store.totalPlanBytes
	now = now.Add(30 * time.Second)
	if err := store.CompleteWithResult(stored.Public.PlanID, "alice", model.ProjectPackageChangeResult{Applied: true}); err != nil {
		t.Fatal(err)
	}
	if len(store.plans) != 1 || store.planCounts["alice"] != 1 || store.planBytes["alice"] != reservedBytes || store.totalPlanBytes != reservedBytes {
		t.Fatalf("completed tombstone lost its budget: plans=%d counts=%v userBytes=%v total=%d", len(store.plans), store.planCounts, store.planBytes, store.totalPlanBytes)
	}
	if _, err := store.Put(ExecutionPlan{UserID: "alice"}); !errors.Is(err, ErrPlanCapacity) {
		t.Fatalf("completed tombstone did not retain the user slot: %v", err)
	}

	// Completion resets retention to a full TTL; this is past the plan's
	// original expiry but still inside the completed-result retention window.
	now = now.Add(40 * time.Second)
	if _, completed, err := store.ClaimOrCompleted(stored.Public.PlanID, "alice"); err != nil || completed == nil {
		t.Fatalf("completed result expired from the original plan deadline: result=%+v err=%v", completed, err)
	}
	now = now.Add(21 * time.Second)
	if _, _, err := store.ClaimOrCompleted(stored.Public.PlanID, "alice"); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("expired tombstone claim = %v", err)
	}
	if len(store.plans) != 0 || store.totalPlanBytes != 0 || len(store.planCounts) != 0 || len(store.planBytes) != 0 {
		t.Fatalf("expired tombstone retained budget: plans=%d bytes=%d counts=%v userBytes=%v", len(store.plans), store.totalPlanBytes, store.planCounts, store.planBytes)
	}
	if _, err := store.Put(ExecutionPlan{UserID: "alice"}); err != nil {
		t.Fatalf("expired tombstone did not release capacity: %v", err)
	}
}

func TestPlanStoreResultLimitAtomicallyRetainsCompletionMarker(t *testing.T) {
	store := NewStoreWithLimits(time.Minute, StoreLimits{
		MaxPlans: 1, MaxPlansPerUser: 1, MaxBytes: 1 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: 128,
	})
	if store.limits.MaxResultBytes != minimumMaxResultBytes {
		t.Fatalf("result limit = %d, want minimum %d", store.limits.MaxResultBytes, minimumMaxResultBytes)
	}
	stored, err := store.Put(ExecutionPlan{UserID: "alice", WorkspaceID: "workspace", RuntimeID: "python:3.12", Language: "python"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := store.CompleteWithResult(stored.Public.PlanID, "alice", model.ProjectPackageChangeResult{Applied: true, Stdout: strings.Repeat("x", int(minimumMaxResultBytes)+1024)}); !errors.Is(err, ErrPlanResultTooLarge) {
		t.Fatalf("oversized result completion error = %v", err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); !errors.Is(err, ErrPlanCompleted) {
		t.Fatalf("oversized result did not close execution: %v", err)
	}
	identity, completed, err := store.ClaimOrCompleted(stored.Public.PlanID, "alice")
	if err != nil || completed == nil || !completed.Applied || completed.PlanID != stored.Public.PlanID || completed.Stdout != "" || identity.WorkspaceID != "workspace" || identity.RuntimeID != "python:3.12" || identity.Language != "python" {
		t.Fatalf("oversized result marker = plan:%+v result:%+v error:%v", identity, completed, err)
	}
	store.Release(stored.Public.PlanID)
	store.Complete(stored.Public.PlanID)
	if err := store.CompleteWithResult(stored.Public.PlanID, "alice", model.ProjectPackageChangeResult{Applied: true}); err != nil {
		t.Fatalf("completion marker was not idempotent: %v", err)
	}
	if _, completed, err := store.ClaimOrCompleted(stored.Public.PlanID, "alice"); err != nil || completed == nil || !completed.Applied {
		t.Fatalf("legacy cleanup removed oversized result marker: result=%+v error=%v", completed, err)
	}
}

func TestPlanStoreMarkCompletedBypassesResultLimitAndPreservesLifecycle(t *testing.T) {
	store := NewStoreWithLimits(time.Minute, StoreLimits{
		MaxPlans: 2, MaxPlansPerUser: 1, MaxBytes: 1 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: 1,
	})
	if store.limits.MaxResultBytes != minimumMaxResultBytes {
		t.Fatalf("result limit = %d, want minimum %d", store.limits.MaxResultBytes, minimumMaxResultBytes)
	}
	now := time.Unix(100, 0).UTC()
	store.now = func() time.Time { return now }
	source := model.PackageCenterSource{ID: "pypi-tuna", Ecosystem: "python", Name: "TUNA", Kind: "mirror", EquivalenceGroup: "pypi"}
	stored, err := store.Put(ExecutionPlan{
		Public: model.ProjectPackageChangePlan{Source: source}, UserID: "alice", WorkspaceID: "workspace-a",
		FolderKey: "folder-a", RuntimeID: "python:3.12", Language: "python", InstallURL: "https://mirror.example/simple/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.MarkCompleted(stored.Public.PlanID, "alice"); !errors.Is(err, ErrPlanNotClaimed) {
		t.Fatalf("unclaimed completion marker error = %v", err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkCompleted(stored.Public.PlanID, "bob"); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("another user marked the plan completed: %v", err)
	}

	// An ordinary failed operation remains retryable when its owner releases the
	// claim without recording either a result or a marker.
	store.Release(stored.Public.PlanID)
	if _, err := store.Claim(stored.Public.PlanID, "alice"); err != nil {
		t.Fatalf("released failed operation was not retryable: %v", err)
	}
	reservedBytes := store.totalPlanBytes
	now = now.Add(30 * time.Second)
	// MarkCompleted remains a last-resort transition even if an already-admitted
	// store is given a result limit smaller than the fixed marker payload.
	store.limits.MaxResultBytes = 1
	if err := store.MarkCompleted(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	if store.totalPlanBytes != reservedBytes || store.planBytes["alice"] != reservedBytes || store.planCounts["alice"] != 1 {
		t.Fatalf("completion marker changed reserved budget: total=%d users=%v counts=%v", store.totalPlanBytes, store.planBytes, store.planCounts)
	}
	if int64(len(store.plans[stored.Public.PlanID].completedResult)) <= store.limits.MaxResultBytes {
		t.Fatal("completion marker did not exercise the result-limit bypass")
	}

	if _, completed, err := store.ClaimOrCompleted(stored.Public.PlanID, "bob"); !errors.Is(err, ErrPlanNotFound) || completed != nil {
		t.Fatalf("completion marker crossed user boundary: result=%+v err=%v", completed, err)
	}
	identity, completed, err := store.ClaimOrCompleted(stored.Public.PlanID, "alice")
	if err != nil || completed == nil || !completed.Applied || completed.PlanID != stored.Public.PlanID {
		t.Fatalf("completion marker replay = plan:%+v result:%+v err:%v", identity, completed, err)
	}
	if identity.UserID != "alice" || identity.WorkspaceID != "workspace-a" || identity.FolderKey != "folder-a" || identity.RuntimeID != "python:3.12" || identity.Language != "python" || identity.InstallURL != "" || identity.Public.Source != source || !identity.CreatedAt.Equal(stored.CreatedAt) {
		t.Fatalf("completion marker identity = %+v", identity)
	}
	wantExpiry := now.Add(time.Minute)
	if !identity.ExpiresAt.Equal(wantExpiry) || identity.Public.ExpiresAt != wantExpiry.UnixMilli() {
		t.Fatalf("completion marker expiry = %v/%d, want %v", identity.ExpiresAt, identity.Public.ExpiresAt, wantExpiry)
	}

	identity.Public.Source.Name = "mutated"
	if err := store.MarkCompleted(stored.Public.PlanID, "alice"); err != nil {
		t.Fatalf("repeated marker completion = %v", err)
	}
	if err := store.CompleteWithResult(stored.Public.PlanID, "alice", model.ProjectPackageChangeResult{Applied: true, Stdout: strings.Repeat("x", 1024)}); err != nil {
		t.Fatalf("completed marker was not idempotent: %v", err)
	}
	store.Release(stored.Public.PlanID)
	store.Complete(stored.Public.PlanID)
	identityAgain, completedAgain, err := store.ClaimOrCompleted(stored.Public.PlanID, "alice")
	if err != nil || completedAgain == nil || !completedAgain.Applied || identityAgain.Public.Source.Name != "TUNA" {
		t.Fatalf("legacy cleanup deleted or mutated marker: plan=%+v result=%+v err=%v", identityAgain, completedAgain, err)
	}
	if _, err := store.Put(ExecutionPlan{UserID: "alice"}); !errors.Is(err, ErrPlanCapacity) {
		t.Fatalf("completion marker released its retained user slot: %v", err)
	}

	// Completion gets a fresh TTL instead of inheriting the original deadline.
	now = now.Add(40 * time.Second)
	if _, completed, err := store.ClaimOrCompleted(stored.Public.PlanID, "alice"); err != nil || completed == nil {
		t.Fatalf("completion marker expired at original deadline: result=%+v err=%v", completed, err)
	}
	now = now.Add(21 * time.Second)
	if _, _, err := store.ClaimOrCompleted(stored.Public.PlanID, "alice"); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("expired completion marker claim = %v", err)
	}
	if len(store.plans) != 0 || store.totalPlanBytes != 0 || len(store.planCounts) != 0 || len(store.planBytes) != 0 {
		t.Fatalf("expired completion marker retained capacity: plans=%d bytes=%d counts=%v userBytes=%v", len(store.plans), store.totalPlanBytes, store.planCounts, store.planBytes)
	}
}
