package collab

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// AcquireSyncRoot resolves only a current member's ordinary worktree. It does
// not create clones and never exposes a repository, realtime room or analyzer.
// The caller releases the activity lease after its actual filesystem syscall.
func (m *Manager) AcquireSyncRoot(userID, absolute string) (string, func(), error) {
	rel, err := filepath.Rel(m.root, absolute)
	if err != nil || !filepath.IsLocal(rel) {
		return "", nil, fmt.Errorf("sync path outside teams")
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) < 6 || parts[1] != "projects" || parts[3] != "worktrees" || parts[4] != safeFSName(userID) {
		return "", nil, fmt.Errorf("sync worktree access denied")
	}
	teamID, projectID := parts[0], parts[2]
	lease, err := m.AcquireProjectActivity(userID, teamID, projectID)
	if err != nil {
		return "", nil, err
	}
	fail := func(err error) (string, func(), error) { lease.Release(); return "", nil, err }
	// Read the generation only while holding the project activity lease: a mode
	// transition between an earlier read and acquiring the lease could otherwise
	// authorize a stale worktree after realtime mode has been disabled again.
	project, err := m.projectForMember(userID, teamID, projectID)
	if err != nil {
		return fail(err)
	}
	if err = m.GuardLegacyProject(userID, teamID, projectID, "*"); err != nil {
		return fail(err)
	}
	index := 5
	if project.WorktreeGeneration != "" {
		if len(parts) < 7 || parts[index] != "generation-"+safeFSName(project.WorktreeGeneration) {
			return fail(fmt.Errorf("stale worktree generation"))
		}
		index++
	}
	if parts[index] == "." || parts[index] == ".." {
		return fail(fmt.Errorf("invalid worktree"))
	}
	root := filepath.Join(append([]string{m.root}, parts[:index+1]...)...)
	// A generation container has no .git, while every server-created worktree
	// is a Git clone. This also permits a real branch named generation-*.
	info, statErr := os.Lstat(filepath.Join(root, ".git"))
	if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fail(fmt.Errorf("invalid worktree root"))
	}
	return root, lease.Release, nil
}
