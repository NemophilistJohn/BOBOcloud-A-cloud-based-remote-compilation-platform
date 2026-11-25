package collab

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"

	"bobocloud-server/internal/auth"
)

func TestSyncRootTeamMembershipAndRealtimeGeneration(t *testing.T) {
	if _, e := exec.LookPath("git"); e != nil {
		t.Fatal(e)
	}
	users := auth.NewMemoryUserStore()
	admin := testUser("admin-sync", "u_admin_sync", "admin")
	member := testUser("member-sync", "u_member_sync", "member")
	outsider := testUser("outside-sync", "u_outside_sync", "outside")
	for _, u := range []*auth.User{admin, member, outsider} {
		if e := users.Create(u); e != nil {
			t.Fatal(e)
		}
	}
	m := NewManager(NewMemoryStore(), users, t.TempDir())
	ctx := context.Background()
	team, e := m.CreateTeam(admin.ID, "team", "", 1024)
	if e != nil {
		t.Fatal(e)
	}
	addTeamMember(t, m.Store(), team.ID, member.ID)
	project, e := m.CreateProject(ctx, admin.ID, team.ID, "project", "")
	if e != nil {
		t.Fatal(e)
	}
	tree, e := m.EnsureWorktree(ctx, member.ID, team.ID, project.ID, "main", false)
	if e != nil {
		t.Fatal(e)
	}
	original := filepath.FromSlash(tree.RemotePath)
	check := func(user, p string, want bool) {
		t.Helper()
		root, release, e := m.AcquireSyncRoot(user, p)
		if e == nil {
			release()
		}
		if (e == nil) != want {
			t.Fatalf("user %s path %s allowed=%v root=%s err=%v", user, p, want, root, e)
		}
	}
	check(member.ID, filepath.Join(original, "README.md"), true)
	check(outsider.ID, filepath.Join(original, "README.md"), false)
	check(admin.ID, filepath.Join(original, "README.md"), false)
	check(member.ID, filepath.Join(m.repoRoot(team.ID, project.ID), "repository.git"), false)
	team2, e := m.CreateTeam(admin.ID, "team2", "", 1024)
	if e != nil {
		t.Fatal(e)
	}
	project2, e := m.CreateProject(ctx, admin.ID, team2.ID, "project2", "")
	if e != nil {
		t.Fatal(e)
	}
	other, e := m.EnsureWorktree(ctx, admin.ID, team2.ID, project2.ID, "main", false)
	if e != nil {
		t.Fatal(e)
	}
	check(member.ID, filepath.FromSlash(other.RemotePath), false)
	if e = m.CreateBranch(ctx, member.ID, team.ID, project.ID, "generation-foo", "main"); e != nil {
		t.Fatal(e)
	}
	branch, e := m.EnsureWorktree(ctx, member.ID, team.ID, project.ID, "generation-foo", false)
	if e != nil {
		t.Fatal(e)
	}
	check(member.ID, filepath.FromSlash(branch.RemotePath), true)
	state, e := m.SetRealtimeMode(ctx, admin.ID, team.ID, project.ID, "main", "", true)
	if e != nil {
		t.Fatal(e)
	}
	check(member.ID, original, false)
	_, e = m.SetRealtimeMode(ctx, admin.ID, team.ID, project.ID, "main", state.Epoch, false)
	if e != nil {
		t.Fatal(e)
	}
	fresh, e := m.EnsureWorktree(ctx, member.ID, team.ID, project.ID, "main", false)
	if e != nil {
		t.Fatal(e)
	}
	check(member.ID, original, false)
	check(member.ID, filepath.FromSlash(fresh.RemotePath), true)
	_, release, e := m.AcquireSyncRoot(member.ID, filepath.FromSlash(fresh.RemotePath))
	if e != nil {
		t.Fatal(e)
	}
	if e = m.RemoveMember(admin.ID, team.ID, member.ID); e == nil {
		release()
		t.Fatal("member removed while SFTP lease active")
	}
	release()
	if e = m.RemoveMember(admin.ID, team.ID, member.ID); e != nil {
		t.Fatal(e)
	}
	check(member.ID, filepath.FromSlash(fresh.RemotePath), false)
	check(admin.ID, filepath.FromSlash(other.RemotePath), true)
	if e = m.DeleteProject(admin.ID, team2.ID, project2.ID); e != nil {
		t.Fatal(e)
	}
	check(admin.ID, filepath.FromSlash(other.RemotePath), false)
}
