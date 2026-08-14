package collab

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type ProjectActivityLease struct {
	release func()
	once    sync.Once
}

func (lease *ProjectActivityLease) Release() {
	if lease == nil || lease.release == nil {
		return
	}
	lease.once.Do(lease.release)
}

func projectResourceKey(teamID, projectID string) string {
	return strings.TrimSpace(teamID) + "\x00" + strings.TrimSpace(projectID)
}

func memberResourceKey(teamID, userID string) string {
	return strings.TrimSpace(teamID) + "\x00" + strings.TrimSpace(userID)
}

func (m *Manager) memberAccessError(teamID, userID string) error {
	if m == nil {
		return nil
	}
	teamID = strings.TrimSpace(teamID)
	m.resourceMu.Lock()
	defer m.resourceMu.Unlock()
	if m.teamDeleting[teamID] {
		return fmt.Errorf("team deletion is in progress")
	}
	if m.memberRevoking[memberResourceKey(teamID, userID)] {
		return fmt.Errorf("team membership revocation is in progress")
	}
	return nil
}

func (m *Manager) projectDeletionInProgress(teamID, projectID string) bool {
	if m == nil {
		return false
	}
	m.resourceMu.Lock()
	defer m.resourceMu.Unlock()
	return m.teamDeleting[strings.TrimSpace(teamID)] || m.projectDeleting[projectResourceKey(teamID, projectID)]
}

// AcquireProjectActivity prevents a team or project deletion transaction from
// starting while a run or analyzer can still access its worktree/cache.
func (m *Manager) AcquireProjectActivity(userID, teamID, projectID string) (*ProjectActivityLease, error) {
	if m == nil {
		return &ProjectActivityLease{}, nil
	}
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return nil, err
	}
	userID, teamID, projectID = strings.TrimSpace(userID), strings.TrimSpace(teamID), strings.TrimSpace(projectID)
	key := projectResourceKey(teamID, projectID)
	memberKey := memberResourceKey(teamID, userID)
	m.resourceMu.Lock()
	if m.teamDeleting[teamID] || m.projectDeleting[key] {
		m.resourceMu.Unlock()
		return nil, fmt.Errorf("team project deletion is in progress")
	}
	if m.memberRevoking[memberKey] {
		m.resourceMu.Unlock()
		return nil, fmt.Errorf("team membership revocation is in progress")
	}
	// The optimistic authorization above deliberately avoids holding the
	// lifecycle mutex across ordinary store I/O. Recheck while the mutation
	// tombstones are locked so a deletion that completed in that gap cannot be
	// followed by a stale activity lease.
	if _, err := m.store.GetTeam(teamID); err != nil {
		m.resourceMu.Unlock()
		return nil, fmt.Errorf("team not found")
	}
	if _, err := m.store.GetMember(teamID, userID); err != nil {
		m.resourceMu.Unlock()
		return nil, fmt.Errorf("you are not a member of this team")
	}
	project, err := m.store.GetProject(projectID)
	if err != nil || project.TeamID != teamID {
		m.resourceMu.Unlock()
		return nil, fmt.Errorf("team project not found")
	}
	m.projectActive[key]++
	m.memberActive[memberKey]++
	m.resourceMu.Unlock()
	return &ProjectActivityLease{release: func() {
		m.resourceMu.Lock()
		if m.projectActive[key] > 1 {
			m.projectActive[key]--
		} else {
			delete(m.projectActive, key)
		}
		if m.memberActive[memberKey] > 1 {
			m.memberActive[memberKey]--
		} else {
			delete(m.memberActive, memberKey)
		}
		m.resourceMu.Unlock()
	}}, nil
}

func (m *Manager) beginMemberRevocation(teamID, userID string) (func(), error) {
	teamID, userID = strings.TrimSpace(teamID), strings.TrimSpace(userID)
	key := memberResourceKey(teamID, userID)
	projectPrefix := teamID + "\x00"
	m.resourceMu.Lock()
	defer m.resourceMu.Unlock()
	if m.teamDeleting[teamID] {
		return nil, fmt.Errorf("team deletion is in progress")
	}
	if m.memberRevoking[key] {
		return nil, fmt.Errorf("team membership revocation is already in progress")
	}
	if m.memberActive[key] > 0 {
		return nil, fmt.Errorf("team member resources are currently in use")
	}
	for projectKey, deleting := range m.projectDeleting {
		if deleting && strings.HasPrefix(projectKey, projectPrefix) {
			return nil, fmt.Errorf("team project deletion is in progress")
		}
	}
	m.memberRevoking[key] = true
	return func() {
		m.resourceMu.Lock()
		delete(m.memberRevoking, key)
		m.resourceMu.Unlock()
	}, nil
}

func (m *Manager) beginTeamDeletion(teamID string) (func(), error) {
	teamID = strings.TrimSpace(teamID)
	m.resourceMu.Lock()
	defer m.resourceMu.Unlock()
	if m.teamDeleting[teamID] {
		return nil, fmt.Errorf("team deletion is already in progress")
	}
	prefix := teamID + "\x00"
	for key, count := range m.projectActive {
		if count > 0 && strings.HasPrefix(key, prefix) {
			return nil, fmt.Errorf("team resources are currently in use")
		}
	}
	for key, revoking := range m.memberRevoking {
		if revoking && strings.HasPrefix(key, prefix) {
			return nil, fmt.Errorf("team membership revocation is in progress")
		}
	}
	for key, deleting := range m.projectDeleting {
		if deleting && strings.HasPrefix(key, prefix) {
			return nil, fmt.Errorf("team project deletion is in progress")
		}
	}
	m.teamDeleting[teamID] = true
	return func() {
		m.resourceMu.Lock()
		delete(m.teamDeleting, teamID)
		m.resourceMu.Unlock()
	}, nil
}

func (m *Manager) beginProjectDeletion(teamID, projectID string) (func(), error) {
	teamID = strings.TrimSpace(teamID)
	key := projectResourceKey(teamID, projectID)
	m.resourceMu.Lock()
	defer m.resourceMu.Unlock()
	if m.teamDeleting[teamID] || m.projectDeleting[key] {
		return nil, fmt.Errorf("team project deletion is already in progress")
	}
	if m.projectActive[key] > 0 {
		return nil, fmt.Errorf("team project resources are currently in use")
	}
	memberPrefix := teamID + "\x00"
	for memberKey, revoking := range m.memberRevoking {
		if revoking && strings.HasPrefix(memberKey, memberPrefix) {
			return nil, fmt.Errorf("team membership revocation is in progress")
		}
	}
	m.projectDeleting[key] = true
	return func() {
		m.resourceMu.Lock()
		delete(m.projectDeleting, key)
		m.resourceMu.Unlock()
	}, nil
}

func (m *Manager) DeleteTeamTransaction(userID, teamID string, cleanup func() error) error {
	if _, err := m.requireAdmin(userID, teamID); err != nil {
		return err
	}
	finish, err := m.beginTeamDeletion(teamID)
	if err != nil {
		return err
	}
	defer finish()
	if cleanup != nil {
		if err := cleanup(); err != nil {
			return err
		}
	}
	if err := m.store.DeleteTeam(teamID); err != nil {
		return err
	}
	return os.RemoveAll(filepath.Join(m.root, teamID))
}

func (m *Manager) DeleteProjectTransaction(userID, teamID, projectID string, cleanup func() error) error {
	if _, err := m.requireAdmin(userID, teamID); err != nil {
		return err
	}
	project, err := m.store.GetProject(projectID)
	if err != nil || project.TeamID != teamID {
		return fmt.Errorf("team project not found")
	}
	finish, err := m.beginProjectDeletion(teamID, projectID)
	if err != nil {
		return err
	}
	defer finish()
	if cleanup != nil {
		if err := cleanup(); err != nil {
			return err
		}
	}
	locks, _ := m.store.ListLocks(teamID, projectID)
	for _, lock := range locks {
		_ = m.store.DeleteLock(teamID, projectID, lock.Branch, lock.Path)
	}
	if err := m.store.DeleteProject(projectID); err != nil {
		return err
	}
	return os.RemoveAll(m.repoRoot(teamID, projectID))
}
