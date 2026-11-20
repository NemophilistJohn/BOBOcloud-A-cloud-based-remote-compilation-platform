package collab

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

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
	if err := manager.Store().SaveMember(&Member{TeamID: team.ID, UserID: member.ID, JoinedAt: time.Now().UTC()}); err != nil {
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

func writeWorktreeBytes(t *testing.T, worktree, name string, content []byte) {
	t.Helper()
	target := filepath.Join(worktree, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, content, 0644); err != nil {
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
	writeWorktreeBytes(t, adminTree, "image.bin", []byte{0x00, 0x01, 0x02})
	if _, err := manager.Commit(ctx, fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "Add binary fixture"); err != nil {
		t.Fatal(err)
	}

	_, err := manager.Commit(ctx, fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "Nothing")
	var noChanges *OperationError
	if !errors.As(err, &noChanges) || noChanges.Code != ErrorCodeNoChanges || noChanges.Details.SuggestedAction != SuggestedActionEditFiles {
		t.Fatalf("no changes error = %#v", err)
	}

	writeWorktreeFile(t, adminTree, "README.md", "alice\n")
	writeWorktreeBytes(t, adminTree, "image.bin", []byte{0x00, 0x03, 0xff})
	if _, err := manager.Commit(ctx, fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "Alice README"); err != nil {
		t.Fatal(err)
	}
	writeWorktreeFile(t, memberTree, "README.md", "bob\n")
	currentBinary := []byte{0x00, 0x04, 0xfe}
	writeWorktreeBytes(t, memberTree, "image.bin", currentBinary)
	_, err = manager.Commit(ctx, fixture.member, fixture.team.ID, fixture.project.ID, DefaultBranch, "Bob README")
	var conflict *OperationError
	if !errors.As(err, &conflict) || conflict.Code != ErrorCodeMergeConflict {
		t.Fatalf("merge conflict error = %#v", err)
	}
	if conflict.Details.ConflictCount != 2 || conflict.Details.PendingCommit == "" || conflict.Details.SuggestedAction != SuggestedActionResolveConflicts {
		t.Fatalf("merge conflict details = %+v", conflict.Details)
	}
	_, err = manager.CompleteMerge(ctx, fixture.member, fixture.team.ID, fixture.project.ID, DefaultBranch, "Resolve")
	var unresolved *OperationError
	if !errors.As(err, &unresolved) || unresolved.Code != ErrorCodeMergeConflict || unresolved.Details.ConflictCount != 2 {
		t.Fatalf("complete merge conflict error = %#v", err)
	}
	for _, path := range []string{"README.md", "image.bin"} {
		if err := manager.ResolveConflict(ctx, fixture.member.ID, fixture.team.ID, fixture.project.ID, DefaultBranch, path, "", "current"); err != nil {
			t.Fatalf("resolve %s conflict from current stage: %v", path, err)
		}
	}
	resolved, err := manager.CompleteMerge(ctx, fixture.member, fixture.team.ID, fixture.project.ID, DefaultBranch, "Resolve README")
	if err != nil {
		t.Fatalf("complete resolved merge: %v", err)
	}
	if resolved == nil || resolved.ID == "" {
		t.Fatal("complete resolved merge returned no commit")
	}
	remoteContent, err := gitRun(ctx, "", "--git-dir", manager.repoPath(fixture.team.ID, fixture.project.ID), "show", DefaultBranch+":README.md")
	if err != nil || remoteContent != "bob" {
		t.Fatalf("remote README = %q, err = %v", remoteContent, err)
	}
	remoteBinary, err := gitRun(ctx, "", "--git-dir", manager.repoPath(fixture.team.ID, fixture.project.ID), "show", DefaultBranch+":image.bin")
	if err != nil || remoteBinary != string(currentBinary) {
		t.Fatalf("remote binary = %v, err = %v; want %v", []byte(remoteBinary), err, currentBinary)
	}
}

func TestTeamActivityAggregatesMemberAndProjectGitContributions(t *testing.T) {
	manager, fixture := testGitCollaboration(t)
	ctx := context.Background()
	adminTree := worktreeFor(t, manager, fixture.admin.ID, fixture)
	writeWorktreeFile(t, adminTree, "admin.txt", "admin contribution\n")
	if _, err := manager.Commit(ctx, fixture.admin, fixture.team.ID, fixture.project.ID, DefaultBranch, "Admin contribution"); err != nil {
		t.Fatal(err)
	}
	memberTree := worktreeFor(t, manager, fixture.member.ID, fixture)
	writeWorktreeFile(t, memberTree, "member.txt", "member contribution\n")
	if _, err := manager.Commit(ctx, fixture.member, fixture.team.ID, fixture.project.ID, DefaultBranch, "Member contribution"); err != nil {
		t.Fatal(err)
	}

	activity, err := manager.TeamActivity(ctx, fixture.admin.ID, fixture.team.ID)
	if err != nil {
		t.Fatal(err)
	}
	if activity.Days != 200 || len(activity.Members) != 2 || len(activity.Projects) != 1 {
		t.Fatalf("activity shape = %+v", activity)
	}
	if !activity.Members[0].IsAdmin {
		t.Fatalf("administrator should be first in activity rows: %+v", activity.Members)
	}
	byUID := map[string]TeamMemberActivity{}
	for _, member := range activity.Members {
		byUID[member.UID] = member
	}
	for _, user := range []*auth.User{fixture.admin, fixture.member} {
		member, ok := byUID[user.UID]
		if !ok || member.Total != 1 || member.Daily[len(member.Daily)-1] != 1 {
			t.Fatalf("activity for %s = %+v", user.UID, member)
		}
	}
	project := activity.Projects[0]
	if project.ProjectID != fixture.project.ID || project.Total != 2 || project.Daily[len(project.Daily)-1] != 2 {
		t.Fatalf("project activity = %+v", project)
	}
}
