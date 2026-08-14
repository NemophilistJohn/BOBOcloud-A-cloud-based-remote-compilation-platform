package collab

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"

	"bobocloud-server/internal/auth"
)

func testGitCollaboration(t *testing.T) (*Manager, *authFixture) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	users := auth.NewMemoryUserStore()
	admin := testUser("commit-admin", "u_commit_admin", "alice")
	member := testUser("commit-member", "u_commit_member", "bob")
	if err := users.Create(admin); err != nil {
		t.Fatal(err)
	}
	if err := users.Create(member); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp("", "bc-collab-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	manager := NewManager(NewMemoryStore(), users, root)
	team, err := manager.CreateTeam(admin.ID, "Commit team", "", 1024)
	if err != nil {
		t.Fatal(err)
	}
	invite, err := manager.CreateInvite(admin.ID, team.ID, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.JoinTeam(member.ID, invite.Code); err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(context.Background(), admin.ID, team.ID, "project", "")
	if err != nil {
		t.Fatal(err)
	}
	return manager, &authFixture{admin: admin, member: member, team: team, project: project}
}

type authFixture struct {
	admin   *auth.User
	member  *auth.User
	team    *Team
	project *Project
}

func worktreeFor(t *testing.T, manager *Manager, userID string, fixture *authFixture) string {
	t.Helper()
	info, err := manager.EnsureWorktree(context.Background(), userID, fixture.team.ID, fixture.project.ID, DefaultBranch, true)
	if err != nil {
		t.Fatal(err)
	}
	return filepath.FromSlash(info.RemotePath)
}

func writeWorktreeFile(t *testing.T, worktree, name, content string) {
	t.Helper()
	target := filepath.Join(worktree, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestCommitPublishesTwoConsecutiveChangesFromSameUser(t *testing.T) {
	manager, fixture := testGitCollaboration(t)
	ctx := context.Background()
	worktree := worktreeFor(t, manager, fixture.admin.ID, fixture)

	writeWorktreeFile(t, worktree, "first.txt", "first\n")
	first, err := manager.Commit(ctx, fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "First change")
	if err != nil {
		t.Fatal(err)
	}
	writeWorktreeFile(t, worktree, "second.txt", "second\n")
	second, err := manager.Commit(ctx, fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "Second change")
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID {
		t.Fatalf("consecutive commits returned the same ID %s", first.ID)
	}
	remoteHead, err := gitRun(ctx, "", "--git-dir", manager.repoPath(fixture.team.ID, fixture.project.ID), "rev-parse", DefaultBranch)
	if err != nil {
		t.Fatal(err)
	}
	if remoteHead != second.ID {
		t.Fatalf("remote head = %s, second commit = %s", remoteHead, second.ID)
	}
	count, err := gitRun(ctx, "", "--git-dir", manager.repoPath(fixture.team.ID, fixture.project.ID), "rev-list", "--count", DefaultBranch)
	if err != nil || count != "3" {
		t.Fatalf("remote commit count = %q, err = %v", count, err)
	}
}

func TestConcurrentMemberCommitsAreSerializedAndBothPublished(t *testing.T) {
	manager, fixture := testGitCollaboration(t)
	ctx := context.Background()
	adminTree := worktreeFor(t, manager, fixture.admin.ID, fixture)
	memberTree := worktreeFor(t, manager, fixture.member.ID, fixture)
	writeWorktreeFile(t, adminTree, "alice.txt", "alice\n")
	writeWorktreeFile(t, memberTree, "bob.txt", "bob\n")

	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, operation := range []func() error{
		func() error {
			_, err := manager.Commit(ctx, fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "Alice change")
			return err
		},
		func() error {
			_, err := manager.Commit(ctx, fixture.member, fixture.team.ID, fixture.project.ID, DefaultBranch, "Bob change")
			return err
		},
	} {
		wg.Add(1)
		go func(operation func() error) {
			defer wg.Done()
			<-start
			errs <- operation()
		}(operation)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent commit failed: %v", err)
		}
	}
	for _, path := range []string{"alice.txt", "bob.txt"} {
		if _, err := gitRun(ctx, "", "--git-dir", manager.repoPath(fixture.team.ID, fixture.project.ID), "show", DefaultBranch+":"+path); err != nil {
			t.Fatalf("remote branch is missing %s: %v", path, err)
		}
	}
}

func TestCommitRetryPublishesExistingPendingCommit(t *testing.T) {
	manager, fixture := testGitCollaboration(t)
	ctx := context.Background()
	worktree := worktreeFor(t, manager, fixture.admin.ID, fixture)
	writeWorktreeFile(t, worktree, "pending.txt", "pending\n")
	origin, err := gitRun(ctx, worktree, "remote", "get-url", "origin")
	if err != nil {
		t.Fatal(err)
	}
	missingOrigin := filepath.Join(t.TempDir(), "missing.git")
	if _, err := gitRun(ctx, worktree, "remote", "set-url", "origin", missingOrigin); err != nil {
		t.Fatal(err)
	}

	_, commitErr := manager.Commit(ctx, fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "Pending change")
	var operationErr *OperationError
	if !errors.As(commitErr, &operationErr) || operationErr.Code != ErrorCodePushFailed {
		t.Fatalf("first commit error = %#v, want %s", commitErr, ErrorCodePushFailed)
	}
	if !operationErr.Details.Retryable || operationErr.Details.SuggestedAction != SuggestedActionRetryCommit || operationErr.Details.PendingCommit == "" {
		t.Fatalf("pending commit details = %+v", operationErr.Details)
	}
	pendingHead := gitHead(ctx, worktree)
	if pendingHead != operationErr.Details.PendingCommit {
		t.Fatalf("pending head = %s, response pending commit = %s", pendingHead, operationErr.Details.PendingCommit)
	}
	if _, err := gitRun(ctx, worktree, "remote", "set-url", "origin", origin); err != nil {
		t.Fatal(err)
	}
	retried, err := manager.Commit(ctx, fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "Retry pending change")
	if err != nil {
		t.Fatal(err)
	}
	if retried.ID != pendingHead {
		t.Fatalf("retry created a replacement commit %s; pending commit was %s", retried.ID, pendingHead)
	}
	if retried.Message != "Pending change" {
		t.Fatalf("retry returned message %q instead of pending commit metadata", retried.Message)
	}
	remoteHead, err := gitRun(ctx, "", "--git-dir", manager.repoPath(fixture.team.ID, fixture.project.ID), "rev-parse", DefaultBranch)
	if err != nil || remoteHead != pendingHead {
		t.Fatalf("remote head = %s, pending head = %s, err = %v", remoteHead, pendingHead, err)
	}
}

func TestCommitReturnsStableNoChangesAndMergeConflictErrors(t *testing.T) {
	manager, fixture := testGitCollaboration(t)
	ctx := context.Background()
	adminTree := worktreeFor(t, manager, fixture.admin.ID, fixture)
	memberTree := worktreeFor(t, manager, fixture.member.ID, fixture)

	_, err := manager.Commit(ctx, fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "Nothing")
	var noChanges *OperationError
	if !errors.As(err, &noChanges) || noChanges.Code != ErrorCodeNoChanges || noChanges.Details.SuggestedAction != SuggestedActionEditFiles {
		t.Fatalf("no changes error = %#v", err)
	}

	writeWorktreeFile(t, adminTree, "README.md", "alice\n")
	if _, err := manager.Commit(ctx, fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "Alice README"); err != nil {
		t.Fatal(err)
	}
	writeWorktreeFile(t, memberTree, "README.md", "bob\n")
	_, err = manager.Commit(ctx, fixture.member, fixture.team.ID, fixture.project.ID, DefaultBranch, "Bob README")
	var conflict *OperationError
	if !errors.As(err, &conflict) || conflict.Code != ErrorCodeMergeConflict {
		t.Fatalf("merge conflict error = %#v", err)
	}
	if conflict.Details.ConflictCount != 1 || conflict.Details.PendingCommit == "" || conflict.Details.SuggestedAction != SuggestedActionResolveConflicts {
		t.Fatalf("merge conflict details = %+v", conflict.Details)
	}
	_, err = manager.CompleteMerge(ctx, fixture.member, fixture.team.ID, fixture.project.ID, DefaultBranch, "Resolve")
	var unresolved *OperationError
	if !errors.As(err, &unresolved) || unresolved.Code != ErrorCodeMergeConflict || unresolved.Details.ConflictCount != 1 {
		t.Fatalf("complete merge conflict error = %#v", err)
	}
}
