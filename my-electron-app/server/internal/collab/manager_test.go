package collab

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
)

func testUser(id, uid, name string) *auth.User {
	return &auth.User{ID: id, UID: uid, Username: name, Name: name, Avatar: "ocean", APIKey: "key-" + id, Role: auth.RoleMember, CreatedAt: time.Now()}
}

type deleteMemberFailStore struct {
	Store
	mu      sync.Mutex
	failAt  int
	calls   int
	failure error
}

func (s *deleteMemberFailStore) DeleteMember(teamID, userID string) error {
	s.mu.Lock()
	s.calls++
	shouldFail := s.calls == s.failAt
	s.mu.Unlock()
	if err := s.Store.DeleteMember(teamID, userID); err != nil {
		return err
	}
	if shouldFail {
		return s.failure
	}
	return nil
}

func TestEmptyStoreCollectionsAreNonNil(t *testing.T) {
	store := NewMemoryStore()
	checks := []struct {
		name string
		run  func() (int, bool)
	}{
		{"members", func() (int, bool) { values, _ := store.ListMembers("missing"); return len(values), values != nil }},
		{"invites", func() (int, bool) { values, _ := store.ListInvites("missing"); return len(values), values != nil }},
		{"projects", func() (int, bool) { values, _ := store.ListProjects("missing"); return len(values), values != nil }},
		{"locks", func() (int, bool) {
			values, _ := store.ListLocks("missing", "missing")
			return len(values), values != nil
		}},
	}
	for _, check := range checks {
		if length, nonNil := check.run(); !nonNil || length != 0 {
			t.Fatalf("%s must be an empty non-nil collection", check.name)
		}
	}
}

func TestTeamInvitationAdminAndGitWorkflow(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	users := auth.NewMemoryUserStore()
	admin := testUser("admin-internal", "u_admin", "alice")
	member := testUser("member-internal", "u_member", "bob")
	if err := users.Create(admin); err != nil {
		t.Fatal(err)
	}
	if err := users.Create(member); err != nil {
		t.Fatal(err)
	}
	m := NewManager(NewMemoryStore(), users, t.TempDir())
	ctx := context.Background()

	team, err := m.CreateTeam(admin.ID, "Compiler team", "shared Rust builds", 1024)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.CreateInvite(member.ID, team.ID, 1, 1); err == nil {
		t.Fatal("non-admin created an invitation")
	}
	invite, err := m.CreateInvite(admin.ID, team.ID, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.JoinTeam(member.ID, invite.Code); err != nil {
		t.Fatal(err)
	}

	project, err := m.CreateProject(ctx, admin.ID, team.ID, "rust-service", "test project")
	if err != nil {
		t.Fatal(err)
	}
	adminTree, err := m.EnsureWorktree(ctx, admin.ID, team.ID, project.ID, "main", true)
	if err != nil {
		t.Fatal(err)
	}
	readme := filepath.Join(filepath.FromSlash(adminTree.RemotePath), "README.md")
	if err := os.WriteFile(readme, []byte("# rust-service\n\ncompiled by alice\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Commit(ctx, admin, team.ID, project.ID, "main", "Update README"); err != nil {
		t.Fatal(err)
	}

	memberTree, err := m.EnsureWorktree(ctx, member.ID, team.ID, project.ID, "main", true)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(filepath.FromSlash(memberTree.RemotePath), "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "compiled by alice") {
		t.Fatalf("member did not pull team commit: %s", data)
	}
	memberReadme := filepath.Join(filepath.FromSlash(memberTree.RemotePath), "README.md")
	if err := os.WriteFile(memberReadme, []byte("uncommitted local state\n"), 0644); err != nil {
		t.Fatal(err)
	}
	resetTree, err := m.ResetWorktree(ctx, member.ID, team.ID, project.ID, "main")
	if err != nil {
		t.Fatal(err)
	}
	resetData, _ := os.ReadFile(filepath.Join(filepath.FromSlash(resetTree.RemotePath), "README.md"))
	if !strings.Contains(string(resetData), "compiled by alice") || strings.Contains(string(resetData), "uncommitted local state") {
		t.Fatalf("explicit reset did not restore shared branch: %s", resetData)
	}

	if err := m.CreateBranch(ctx, member.ID, team.ID, project.ID, "feature/cache", "main"); err != nil {
		t.Fatal(err)
	}
	branches, err := m.ListBranches(ctx, member.ID, team.ID, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(branches) != 2 {
		t.Fatalf("expected two branches, got %+v", branches)
	}
	for _, branch := range branches {
		if branch.CommittedAt.IsZero() || branch.CommittedAt.Year() < 2000 {
			t.Fatalf("branch date was not parsed from Git raw format: %+v", branch)
		}
	}
	if history, err := m.History(ctx, member.ID, team.ID, project.ID, 20); err != nil || len(history) < 2 {
		t.Fatalf("history unavailable: %+v %v", history, err)
	} else if history[0].AuthorUID != admin.UID {
		t.Fatalf("history did not expose the immutable public UID: %+v", history[0])
	}
}

func TestTeamAdministratorCanDeleteExpiredInvite(t *testing.T) {
	users := auth.NewMemoryUserStore()
	admin := testUser("invite-admin", "u_invite_admin", "alice")
	member := testUser("invite-member", "u_invite_member", "bob")
	_ = users.Create(admin)
	_ = users.Create(member)
	manager := NewManager(NewMemoryStore(), users, t.TempDir())
	team, err := manager.CreateTeam(admin.ID, "team", "", 1024)
	if err != nil {
		t.Fatal(err)
	}
	invite, err := manager.CreateInvite(admin.ID, team.ID, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	invite.ExpiresAt = time.Now().Add(-time.Minute)
	if err := manager.Store().SaveInvite(invite); err != nil {
		t.Fatal(err)
	}
	if err := manager.DeleteInvite(member.ID, team.ID, invite.Code); err == nil {
		t.Fatal("non-administrator deleted an invitation")
	}
	if err := manager.DeleteInvite(admin.ID, team.ID, invite.Code); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Store().GetInvite(invite.Code); err == nil {
		t.Fatal("expired invitation remains after deletion")
	}
}

func TestInvitationUseLimitIsAtomic(t *testing.T) {
	users := auth.NewMemoryUserStore()
	admin := testUser("admin", "u_admin", "alice")
	first := testUser("first", "u_first", "bob")
	second := testUser("second", "u_second", "chen")
	for _, user := range []*auth.User{admin, first, second} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	m := NewManager(NewMemoryStore(), users, t.TempDir())
	team, _ := m.CreateTeam(admin.ID, "team", "", 1024)
	invite, _ := m.CreateInvite(admin.ID, team.ID, 1, 1)

	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, user := range []*auth.User{first, second} {
		wg.Add(1)
		go func(user *auth.User) {
			defer wg.Done()
			_, err := m.JoinTeam(user.ID, invite.Code)
			results <- err
		}(user)
	}
	wg.Wait()
	close(results)
	succeeded := 0
	for err := range results {
		if err == nil {
			succeeded++
		}
	}
	if succeeded != 1 {
		t.Fatalf("one-use invite admitted %d users", succeeded)
	}
}

func TestOnlyAdministratorCanDeleteProject(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	users := auth.NewMemoryUserStore()
	admin := testUser("admin", "u_admin", "alice")
	member := testUser("member", "u_member", "bob")
	_ = users.Create(admin)
	_ = users.Create(member)
	m := NewManager(NewMemoryStore(), users, t.TempDir())
	team, _ := m.CreateTeam(admin.ID, "team", "", 1024)
	invite, _ := m.CreateInvite(admin.ID, team.ID, 1, 1)
	_, _ = m.JoinTeam(member.ID, invite.Code)
	project, err := m.CreateProject(context.Background(), admin.ID, team.ID, "project", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.DeleteProject(member.ID, team.ID, project.ID); err == nil {
		t.Fatal("non-administrator deleted a team project")
	}
	if err := m.DeleteProject(admin.ID, team.ID, project.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Store().GetProject(project.ID); err == nil {
		t.Fatal("deleted project remains in the collaboration store")
	}
	if _, err := os.Stat(m.repoRoot(team.ID, project.ID)); !os.IsNotExist(err) {
		t.Fatalf("deleted project repository remains on disk: %v", err)
	}
}

func TestUserDeletionCannotOrphanTeam(t *testing.T) {
	users := auth.NewMemoryUserStore()
	admin := testUser("admin", "u_admin", "alice")
	member := testUser("member", "u_member", "bob")
	_ = users.Create(admin)
	_ = users.Create(member)
	m := NewManager(NewMemoryStore(), users, t.TempDir())
	team, _ := m.CreateTeam(admin.ID, "Compiler team", "", 1024)
	invite, _ := m.CreateInvite(admin.ID, team.ID, 1, 1)
	_, _ = m.JoinTeam(member.ID, invite.Code)

	if err := m.PrepareUserDeletion(admin.ID); err == nil {
		t.Fatal("team administrator account deletion was allowed")
	}
	if err := m.PrepareUserDeletion(member.ID); err != nil {
		t.Fatal(err)
	}
	if m.IsMember(member.ID, team.ID) {
		t.Fatal("deleted user membership was retained")
	}
}

func TestAdvisoryFileLockOwnershipAndExpiry(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	users := auth.NewMemoryUserStore()
	admin := testUser("a", "u_a", "alice")
	member := testUser("b", "u_b", "bob")
	_ = users.Create(admin)
	_ = users.Create(member)
	m := NewManager(NewMemoryStore(), users, t.TempDir())
	team, _ := m.CreateTeam(admin.ID, "team", "", 1024)
	invite, _ := m.CreateInvite(admin.ID, team.ID, 1, 1)
	_, _ = m.JoinTeam(member.ID, invite.Code)
	project, err := m.CreateProject(context.Background(), admin.ID, team.ID, "project", "")
	if err != nil {
		t.Fatal(err)
	}

	adminLock, err := m.AcquireLock(admin, team.ID, project.ID, "main", "src/main.rs", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.AcquireLock(member, team.ID, project.ID, "main", "src/main.rs", "", 10); err == nil {
		t.Fatal("another member acquired an active lock")
	}
	if err := m.ReleaseLock(member.ID, team.ID, project.ID, "main", "src/main.rs", ""); err == nil {
		t.Fatal("non-owner released the lock")
	}
	if err := m.ReleaseLock(admin.ID, team.ID, project.ID, "main", "src/main.rs", adminLock.LeaseID); err != nil {
		t.Fatal(err)
	}
	memberTree, err := m.EnsureWorktree(context.Background(), member.ID, team.ID, project.ID, "main", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.AcquireLock(member, team.ID, project.ID, "main", "src/main.rs", "", 10); err != nil {
		t.Fatal(err)
	}
	hookCalled := false
	m.SetMemberRevokedHook(func(teamID, userID string) error {
		hookCalled = true
		if !m.IsMember(userID, teamID) {
			t.Error("member revocation hook ran after membership was deleted")
		}
		if _, err := os.Stat(filepath.FromSlash(memberTree.RemotePath)); err != nil {
			t.Errorf("member worktree was removed before revocation hook: %v", err)
		}
		return nil
	})
	if err := m.RemoveMember(admin.ID, team.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	if !hookCalled {
		t.Fatal("member revocation hook was not called")
	}
	if _, err := os.Stat(filepath.FromSlash(memberTree.RemotePath)); !os.IsNotExist(err) {
		t.Fatalf("removed member worktree still exists: %v", err)
	}
	if locks, _ := m.Store().ListLocks(team.ID, project.ID); len(locks) != 0 {
		t.Fatalf("removed member locks still exist: %+v", locks)
	}
}

func testMemberRevocationManager(t *testing.T) (*Manager, *auth.User, *auth.User, *Team, *Project) {
	return testMemberRevocationManagerWithStore(t, NewMemoryStore())
}

func testMemberRevocationManagerWithStore(t *testing.T, store Store) (*Manager, *auth.User, *auth.User, *Team, *Project) {
	t.Helper()
	users := auth.NewMemoryUserStore()
	admin := testUser("admin-revocation", "u_admin_revocation", "alice")
	member := testUser("member-revocation", "u_member_revocation", "bob")
	for _, user := range []*auth.User{admin, member} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	manager := NewManager(store, users, t.TempDir())
	team, err := manager.CreateTeam(admin.ID, "Revocation", "", 1024)
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
	project := &Project{ID: "project-revocation", TeamID: team.ID, Name: "project", DefaultBranch: "main", CreatedBy: admin.ID, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := store.SaveProject(project); err != nil {
		t.Fatal(err)
	}
	return manager, admin, member, team, project
}

type memberArtifactFixture struct {
	worktree string
	marker   string
	content  string
	lock     *FileLock
}

func seedMemberArtifactFixture(t *testing.T, manager *Manager, member *auth.User, team *Team, project *Project, suffix string) memberArtifactFixture {
	t.Helper()
	worktree := filepath.Join(manager.repoRoot(team.ID, project.ID), "worktrees", safeFSName(member.ID))
	marker := filepath.Join(worktree, "draft", "uncommitted-"+suffix+".txt")
	content := "uncommitted worktree content " + suffix
	if err := os.MkdirAll(filepath.Dir(marker), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	lock := &FileLock{
		TeamID: team.ID, ProjectID: project.ID, Branch: "main", Path: "src/" + suffix + ".go",
		UserID: member.ID, UserUID: member.UID, UserName: member.Username, ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := manager.Store().SaveLock(lock); err != nil {
		t.Fatal(err)
	}
	return memberArtifactFixture{worktree: worktree, marker: marker, content: content, lock: lock}
}

func assertMemberArtifactFixtureRestored(t *testing.T, manager *Manager, fixture memberArtifactFixture) {
	t.Helper()
	content, err := os.ReadFile(fixture.marker)
	if err != nil {
		t.Fatalf("read restored worktree marker: %v", err)
	}
	if string(content) != fixture.content {
		t.Fatalf("restored worktree content = %q, want %q", content, fixture.content)
	}
	locks, err := manager.Store().ListLocks(fixture.lock.TeamID, fixture.lock.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	lockRestored := false
	for _, lock := range locks {
		if lock.Branch == fixture.lock.Branch && lock.Path == fixture.lock.Path && lock.UserID == fixture.lock.UserID {
			lockRestored = true
			break
		}
	}
	if !lockRestored {
		t.Fatalf("member lock was not restored: %+v", locks)
	}
	entries, err := os.ReadDir(filepath.Dir(fixture.worktree))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".member-revoke-") {
			t.Fatalf("member artifact staging directory leaked after rollback: %s", entry.Name())
		}
	}
}

func TestActiveProjectLeaseBlocksEveryMemberRevocationPath(t *testing.T) {
	tests := []struct {
		name   string
		action func(*Manager, *auth.User, *auth.User, *Team) error
	}{
		{name: "administrator removal", action: func(manager *Manager, admin, member *auth.User, team *Team) error {
			return manager.RemoveMember(admin.ID, team.ID, member.ID)
		}},
		{name: "member leave", action: func(manager *Manager, _, member *auth.User, team *Team) error {
			return manager.LeaveTeam(member.ID, team.ID)
		}},
		{name: "account deletion", action: func(manager *Manager, _, member *auth.User, _ *Team) error {
			return manager.PrepareUserDeletion(member.ID)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manager, admin, member, team, project := testMemberRevocationManager(t)
			activity, err := manager.AcquireProjectActivity(member.ID, team.ID, project.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err := test.action(manager, admin, member, team); err == nil || !strings.Contains(err.Error(), "resources are currently in use") {
				t.Fatalf("active member revocation error = %v", err)
			}
			if !manager.IsMember(member.ID, team.ID) {
				t.Fatal("active project lease removal deleted membership")
			}
			activity.Release()
			if err := test.action(manager, admin, member, team); err != nil {
				t.Fatalf("member revocation after release: %v", err)
			}
			if manager.IsMember(member.ID, team.ID) {
				t.Fatal("successful member revocation retained membership")
			}
		})
	}
}

func TestMemberActivityCountSpansProjects(t *testing.T) {
	manager, admin, member, team, firstProject := testMemberRevocationManager(t)
	secondProject := &Project{ID: "project-revocation-second", TeamID: team.ID, Name: "second", DefaultBranch: "main", CreatedBy: admin.ID, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := manager.Store().SaveProject(secondProject); err != nil {
		t.Fatal(err)
	}
	first, err := manager.AcquireProjectActivity(member.ID, team.ID, firstProject.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.AcquireProjectActivity(member.ID, team.ID, secondProject.ID)
	if err != nil {
		first.Release()
		t.Fatal(err)
	}
	first.Release()
	if err := manager.RemoveMember(admin.ID, team.ID, member.ID); err == nil || !strings.Contains(err.Error(), "resources are currently in use") {
		t.Fatalf("remaining project activity did not block member removal: %v", err)
	}
	if !manager.IsMember(member.ID, team.ID) {
		t.Fatal("partial project activity release deleted membership")
	}
	second.Release()
	if err := manager.RemoveMember(admin.ID, team.ID, member.ID); err != nil {
		t.Fatalf("member removal after every project release: %v", err)
	}
}

func TestMemberRevocationTombstoneRejectsNewActivityAndMemberAccess(t *testing.T) {
	manager, admin, member, team, project := testMemberRevocationManager(t)
	entered := make(chan struct{})
	continueRevocation := make(chan struct{})
	manager.SetMemberRevokedHook(func(teamID, userID string) error {
		if !manager.IsMember(userID, teamID) {
			return fmt.Errorf("membership was deleted before revocation hook")
		}
		close(entered)
		<-continueRevocation
		return nil
	})
	done := make(chan error, 1)
	go func() { done <- manager.RemoveMember(admin.ID, team.ID, member.ID) }()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("member revocation hook was not reached")
	}
	if _, err := manager.AcquireProjectActivity(member.ID, team.ID, project.ID); err == nil || !strings.Contains(err.Error(), "revocation is in progress") {
		t.Fatalf("new activity entered a revoking membership: %v", err)
	}
	if _, err := manager.ListProjects(member.ID, team.ID); err == nil || !strings.Contains(err.Error(), "revocation is in progress") {
		t.Fatalf("requireMember admitted a revoking member: %v", err)
	}
	if !manager.IsMember(member.ID, team.ID) {
		t.Fatal("membership was deleted while revocation hook was running")
	}
	close(continueRevocation)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("member revocation did not finish")
	}
	if manager.IsMember(member.ID, team.ID) {
		t.Fatal("successful revocation did not delete membership")
	}
}

func TestMemberRevocationHookFailureRetainsMembershipAndCanRetry(t *testing.T) {
	manager, admin, member, team, project := testMemberRevocationManager(t)
	worktreeRoot := filepath.Join(manager.repoRoot(team.ID, project.ID), "worktrees", safeFSName(member.ID))
	if err := os.MkdirAll(worktreeRoot, 0755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(worktreeRoot, "uncommitted.txt")
	if err := os.WriteFile(marker, []byte("keep until hook succeeds"), 0644); err != nil {
		t.Fatal(err)
	}
	want := errors.New("stop analyzer failed")
	attempts := 0
	manager.SetMemberRevokedHook(func(_, _ string) error {
		attempts++
		if attempts == 1 {
			return want
		}
		return nil
	})
	if err := manager.RemoveMember(admin.ID, team.ID, member.ID); !errors.Is(err, want) {
		t.Fatalf("first revocation error = %v", err)
	}
	if !manager.IsMember(member.ID, team.ID) {
		t.Fatal("hook failure deleted membership")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("hook failure cleaned member artifacts: %v", err)
	}
	activity, err := manager.AcquireProjectActivity(member.ID, team.ID, project.ID)
	if err != nil {
		t.Fatalf("hook failure left member tombstone: %v", err)
	}
	activity.Release()
	if err := manager.RemoveMember(admin.ID, team.ID, member.ID); err != nil {
		t.Fatalf("retry member revocation: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("revocation hook attempts = %d", attempts)
	}
	if manager.IsMember(member.ID, team.ID) {
		t.Fatal("successful retry retained membership")
	}
	if _, err := os.Stat(worktreeRoot); !os.IsNotExist(err) {
		t.Fatalf("successful retry retained worktree: %v", err)
	}
}

func TestMemberRevocationDeleteFailureRestoresMembershipWorktreeAndLocks(t *testing.T) {
	want := errors.New("injected DeleteMember failure")
	store := &deleteMemberFailStore{Store: NewMemoryStore(), failAt: 1, failure: want}
	manager, admin, member, team, project := testMemberRevocationManagerWithStore(t, store)
	fixture := seedMemberArtifactFixture(t, manager, member, team, project, "single")
	unrelated := &FileLock{
		TeamID: team.ID, ProjectID: project.ID, Branch: "main", Path: "src/admin.go",
		UserID: admin.ID, UserUID: admin.UID, UserName: admin.Username, ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := manager.Store().SaveLock(unrelated); err != nil {
		t.Fatal(err)
	}

	if err := manager.RemoveMember(admin.ID, team.ID, member.ID); !errors.Is(err, want) {
		t.Fatalf("member revocation error = %v, want %v", err, want)
	}
	if !manager.IsMember(member.ID, team.ID) {
		t.Fatal("DeleteMember failure did not restore membership")
	}
	assertMemberArtifactFixtureRestored(t, manager, fixture)
	locks, err := manager.Store().ListLocks(team.ID, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(locks) != 2 {
		t.Fatalf("locks after rollback = %+v, want restored member and untouched administrator locks", locks)
	}
	activity, err := manager.AcquireProjectActivity(member.ID, team.ID, project.ID)
	if err != nil {
		t.Fatalf("DeleteMember failure left member tombstone: %v", err)
	}
	activity.Release()

	if err := manager.RemoveMember(admin.ID, team.ID, member.ID); err != nil {
		t.Fatalf("retry member revocation: %v", err)
	}
	if manager.IsMember(member.ID, team.ID) {
		t.Fatal("successful retry retained membership")
	}
	if _, err := os.Stat(fixture.worktree); !os.IsNotExist(err) {
		t.Fatalf("successful retry retained worktree: %v", err)
	}
	locks, err = manager.Store().ListLocks(team.ID, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(locks) != 1 || locks[0].UserID != admin.ID {
		t.Fatalf("successful retry changed unrelated locks: %+v", locks)
	}
}

func TestPrepareUserDeletionRollbackRestoresEveryMembershipArtifact(t *testing.T) {
	want := errors.New("injected second DeleteMember failure")
	store := &deleteMemberFailStore{Store: NewMemoryStore(), failAt: 2, failure: want}
	users := auth.NewMemoryUserStore()
	admin := testUser("admin-multi-revocation", "u_admin_multi_revocation", "alice")
	member := testUser("member-multi-revocation", "u_member_multi_revocation", "bob")
	for _, user := range []*auth.User{admin, member} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	manager := NewManager(store, users, t.TempDir())
	type membershipFixture struct {
		team     *Team
		project  *Project
		artifact memberArtifactFixture
	}
	fixtures := make([]membershipFixture, 0, 2)
	for index := 1; index <= 2; index++ {
		team, err := manager.CreateTeam(admin.ID, fmt.Sprintf("Rollback Team %d", index), "", 1024)
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
		project := &Project{
			ID: fmt.Sprintf("project-multi-revocation-%d", index), TeamID: team.ID, Name: fmt.Sprintf("project-%d", index),
			DefaultBranch: "main", CreatedBy: admin.ID, CreatedAt: time.Now(), UpdatedAt: time.Now(),
		}
		if err := manager.Store().SaveProject(project); err != nil {
			t.Fatal(err)
		}
		fixtures = append(fixtures, membershipFixture{
			team: team, project: project,
			artifact: seedMemberArtifactFixture(t, manager, member, team, project, fmt.Sprintf("multi-%d", index)),
		})
	}

	if err := manager.PrepareUserDeletion(member.ID); !errors.Is(err, want) {
		t.Fatalf("account membership revocation error = %v, want %v", err, want)
	}
	for _, fixture := range fixtures {
		if !manager.IsMember(member.ID, fixture.team.ID) {
			t.Fatalf("DeleteMember failure did not restore membership in team %s", fixture.team.ID)
		}
		assertMemberArtifactFixtureRestored(t, manager, fixture.artifact)
		activity, err := manager.AcquireProjectActivity(member.ID, fixture.team.ID, fixture.project.ID)
		if err != nil {
			t.Fatalf("rollback left member tombstone in team %s: %v", fixture.team.ID, err)
		}
		activity.Release()
	}

	if err := manager.PrepareUserDeletion(member.ID); err != nil {
		t.Fatalf("retry account membership revocation: %v", err)
	}
	for _, fixture := range fixtures {
		if manager.IsMember(member.ID, fixture.team.ID) {
			t.Fatalf("successful retry retained membership in team %s", fixture.team.ID)
		}
		if _, err := os.Stat(fixture.artifact.worktree); !os.IsNotExist(err) {
			t.Fatalf("successful retry retained worktree in team %s: %v", fixture.team.ID, err)
		}
		locks, err := manager.Store().ListLocks(fixture.team.ID, fixture.project.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(locks) != 0 {
			t.Fatalf("successful retry retained locks in team %s: %+v", fixture.team.ID, locks)
		}
	}
}
