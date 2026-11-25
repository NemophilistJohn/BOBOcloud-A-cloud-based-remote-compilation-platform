package collab

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"bobocloud-server/internal/auth"
)

func TestRealtimeMirrorBaseline(t *testing.T) {
	ctx := context.Background()
	users := auth.NewMemoryUserStore()
	root, bob := testUser("root", "u_root", "Root"), testUser("bob", "u_bob", "BOBO")
	for _, user := range []*auth.User{root, bob} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	m := NewManager(NewMemoryStore(), users, t.TempDir())
	team, err := m.CreateTeam(root.ID, "Test", "", 256)
	if err != nil {
		t.Fatal(err)
	}
	addTeamMember(t, m.store, team.ID, bob.ID)
	project, err := m.CreateProject(ctx, root.ID, team.ID, "demo", "")
	if err != nil {
		t.Fatal(err)
	}
	rootTree, err := m.EnsureWorktree(ctx, root.ID, team.ID, project.ID, "main", false)
	if err != nil {
		t.Fatal(err)
	}
	bobTree, err := m.EnsureWorktree(ctx, bob.ID, team.ID, project.ID, "main", false)
	if err != nil {
		t.Fatal(err)
	}
	rootPath, bobPath := filepath.FromSlash(rootTree.RemotePath), filepath.FromSlash(bobTree.RemotePath)
	source := []byte("print('shared demo')\n")
	for _, tree := range []string{rootPath, bobPath} {
		if err = os.WriteFile(filepath.Join(tree, "demo.py"), source, 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err = os.WriteFile(filepath.Join(bobPath, ".bobocloud-team.json"), []byte(`{"localPath":"bob-private"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Commit(ctx, bob, team.ID, project.ID, "main", "Publish demo and historical marker"); err != nil {
		t.Fatal(err)
	}
	marker := []byte(`{"localPath":"root-private"}`)
	if err = os.WriteFile(filepath.Join(rootPath, ".bobocloud-team.json"), marker, 0644); err != nil {
		t.Fatal(err)
	}
	assertBlocked := func(expected string) {
		t.Helper()
		_, e := m.SetRealtimeMode(ctx, root.ID, team.ID, project.ID, "main", "", true)
		var operation *OperationError
		if !errors.As(e, &operation) || operation.Code != ErrorCodeRealtimeBaselineDirty || operation.Details.Baseline == nil {
			t.Fatalf("uncommitted changes were not diagnosed: %v", e)
		}
		details := operation.Details.Baseline
		if details.UserID != root.ID || details.Branch != "main" || !strings.Contains(e.Error(), "Root") || !strings.Contains(e.Error(), expected) {
			t.Fatalf("dirty member/path missing: %+v %v", details, e)
		}
		found := false
		for _, change := range details.Changes {
			if change.Path == expected {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing changed path %q: %+v", expected, details.Changes)
		}
	}
	private := []byte("print('unpublished private work')\n")
	if err = os.WriteFile(filepath.Join(rootPath, "draft.py"), private, 0644); err != nil {
		t.Fatal(err)
	}
	assertBlocked("draft.py")
	preserved, _ := os.ReadFile(filepath.Join(rootPath, "draft.py"))
	if string(preserved) != string(private) {
		t.Fatal("private untracked source changed")
	}
	_ = os.Remove(filepath.Join(rootPath, "draft.py"))
	modified := append(append([]byte{}, source...), []byte("# private changes\n")...)
	if err = os.WriteFile(filepath.Join(rootPath, "demo.py"), modified, 0644); err != nil {
		t.Fatal(err)
	}
	assertBlocked("demo.py")
	preserved, _ = os.ReadFile(filepath.Join(rootPath, "demo.py"))
	if string(preserved) != string(modified) {
		t.Fatal("modified mirror source changed")
	}
	_ = os.WriteFile(filepath.Join(rootPath, "demo.py"), source, 0644)
	readmePath := filepath.Join(rootPath, "README.md")
	readme, err := os.ReadFile(readmePath)
	if err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(readmePath, []byte("private tracked changes\n"), 0644)
	assertBlocked("README.md")
	preserved, _ = os.ReadFile(readmePath)
	if string(preserved) != "private tracked changes\n" {
		t.Fatal("tracked source changed")
	}
	_ = os.WriteFile(readmePath, readme, 0644)
	if _, err = gitRun(ctx, rootPath, "add", "--", "demo.py"); err != nil {
		t.Fatal(err)
	}
	assertBlocked("demo.py")
	if _, err = gitRun(ctx, rootPath, "reset", "--", "demo.py"); err != nil {
		t.Fatal(err)
	}
	// Real unmerged index entries must remain blockers even with unchanged bytes.
	blob, err := gitRun(ctx, rootPath, "rev-parse", "HEAD:README.md")
	if err != nil {
		t.Fatal(err)
	}
	indexInput := "0 " + strings.Repeat("0", len(blob)) + "\tREADME.md\n"
	for _, stage := range []string{"1", "2", "3"} {
		indexInput += "100644 " + blob + " " + stage + "\tREADME.md\n"
	}
	command := exec.CommandContext(ctx, "git", "-C", rootPath, "update-index", "--index-info")
	command.Stdin = strings.NewReader(indexInput)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("prepare unmerged index: %s %v", output, err)
	}
	assertBlocked("README.md")
	if _, err = gitRun(ctx, rootPath, "reset", "--", "README.md"); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err = os.Chmod(filepath.Join(rootPath, "demo.py"), 0755); err != nil {
			t.Fatal(err)
		}
		assertBlocked("demo.py")
		_ = os.Chmod(filepath.Join(rootPath, "demo.py"), 0644)
	}
	// BOBO's tracked host marker can differ too; it is never a source document.
	_ = os.WriteFile(filepath.Join(bobPath, ".bobocloud-team.json"), []byte(`{"localPath":"bob-new-local-path"}`), 0644)
	state, err := m.SetRealtimeMode(ctx, root.ID, team.ID, project.ID, "main", "", true)
	if err != nil {
		t.Fatal(err)
	}
	state, err = m.GetRealtimeSnapshot(root.ID, team.ID, project.ID, state.Epoch)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, file := range state.Files {
		if realtimeHostMetadata(file.Path) {
			t.Fatal("host metadata entered canonical source")
		}
		if file.Path == "demo.py" {
			found = true
			if file.Content != string(source) {
				t.Fatalf("wrong canonical demo bytes: got %q, want %q", file.Content, string(source))
			}
		}
	}
	if !found {
		t.Fatal("canonical shared demo missing")
	}
	head, err := gitRun(ctx, rootPath, "rev-parse", "HEAD")
	if err != nil || head != rootTree.Head {
		t.Fatalf("mode enable merged/reset old member worktree: %s %v", head, err)
	}
	preserved, _ = os.ReadFile(filepath.Join(rootPath, ".bobocloud-team.json"))
	if string(preserved) != string(marker) {
		t.Fatal("local mapping metadata overwritten")
	}
	preserved, _ = os.ReadFile(filepath.Join(rootPath, "demo.py"))
	if string(preserved) != string(source) {
		t.Fatal("matching untracked source changed")
	}
}

func TestRealtimeUnpublishedCommitBlocks(t *testing.T) {
	ctx := context.Background()
	users := auth.NewMemoryUserStore()
	user := testUser("root", "u_root", "Root")
	_ = users.Create(user)
	m := NewManager(NewMemoryStore(), users, t.TempDir())
	team, err := m.CreateTeam(user.ID, "Test", "", 256)
	if err != nil {
		t.Fatal(err)
	}
	project, err := m.CreateProject(ctx, user.ID, team.ID, "Demo", "")
	if err != nil {
		t.Fatal(err)
	}
	tree, err := m.EnsureWorktree(ctx, user.ID, team.ID, project.ID, "main", false)
	if err != nil {
		t.Fatal(err)
	}
	worktree := filepath.FromSlash(tree.RemotePath)
	if err = os.WriteFile(filepath.Join(worktree, "private.py"), []byte("private commit"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = gitRun(ctx, worktree, "add", "private.py"); err != nil {
		t.Fatal(err)
	}
	if _, err = gitRun(ctx, worktree, "-c", "user.name=Root", "-c", "user.email=root@test.local", "commit", "-m", "Unpublished"); err != nil {
		t.Fatal(err)
	}
	head, _ := gitRun(ctx, worktree, "rev-parse", "HEAD")
	if _, err = m.SetRealtimeMode(ctx, user.ID, team.ID, project.ID, "main", "", true); err == nil || !strings.Contains(err.Error(), "publish pending commits") {
		t.Fatalf("unpublished commit accepted: %v", err)
	}
	after, _ := gitRun(ctx, worktree, "rev-parse", "HEAD")
	if after != head {
		t.Fatal("unpublished commit was modified")
	}
}
