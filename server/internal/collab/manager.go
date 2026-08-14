package collab

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/auth"
)

type Manager struct {
	store            Store
	users            auth.UserStore
	root             string
	mu               sync.Mutex
	memberHookMu     sync.RWMutex
	onMemberRevoked  func(teamID, userID string) error
	resourceMu       sync.Mutex
	teamDeleting     map[string]bool
	projectDeleting  map[string]bool
	projectActive    map[string]int
	memberRevoking   map[string]bool
	memberActive     map[string]int
	branchOperations keyedMutex
}

func NewManager(store Store, users auth.UserStore, root string) *Manager {
	return &Manager{
		store: store, users: users, root: filepath.Clean(root),
		teamDeleting: make(map[string]bool), projectDeleting: make(map[string]bool), projectActive: make(map[string]int),
		memberRevoking: make(map[string]bool), memberActive: make(map[string]int),
	}
}

func (m *Manager) Store() Store { return m.store }

// SetMemberRevokedHook installs a lifecycle hook that runs while membership is
// tombstoned, before its worktrees and membership record are removed.
func (m *Manager) SetMemberRevokedHook(hook func(teamID, userID string) error) {
	m.memberHookMu.Lock()
	m.onMemberRevoked = hook
	m.memberHookMu.Unlock()
}

func (m *Manager) notifyMemberRevoked(teamID, userID string) error {
	m.memberHookMu.RLock()
	hook := m.onMemberRevoked
	m.memberHookMu.RUnlock()
	if hook != nil {
		return hook(teamID, userID)
	}
	return nil
}

func cleanText(value string, max int) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\x00", ""))
	if len([]rune(value)) > max {
		value = string([]rune(value)[:max])
	}
	return value
}

func generatedID(prefix string) string { return prefix + "_" + auth.GenerateToken()[:20] }

func (m *Manager) CreateTeam(userID, name, description string, cacheQuotaMB int) (*Team, error) {
	name = cleanText(name, 80)
	if name == "" {
		return nil, fmt.Errorf("team name is required")
	}
	if cacheQuotaMB <= 0 {
		cacheQuotaMB = 4096
	}
	if cacheQuotaMB < 256 || cacheQuotaMB > 102400 {
		return nil, fmt.Errorf("cache quota must be between 256 and 102400 MB")
	}
	now := time.Now().UTC()
	team := &Team{ID: generatedID("team"), Name: name, Description: cleanText(description, 500), AdminUserID: userID, Avatar: "team-graphite", CacheQuotaMB: cacheQuotaMB, CacheRetentionDays: 30, CreatedAt: now, UpdatedAt: now}
	if err := m.store.SaveTeam(team); err != nil {
		return nil, err
	}
	if err := m.store.SaveMember(&Member{TeamID: team.ID, UserID: userID, JoinedAt: now}); err != nil {
		_ = m.store.DeleteTeam(team.ID)
		return nil, err
	}
	return team, nil
}

func (m *Manager) UpdateTeam(userID, teamID, name, description string, cacheQuotaMB, retentionDays int) (*Team, error) {
	team, err := m.requireAdmin(userID, teamID)
	if err != nil {
		return nil, err
	}
	if v := cleanText(name, 80); v != "" {
		team.Name = v
	}
	team.Description = cleanText(description, 500)
	if cacheQuotaMB > 0 {
		if cacheQuotaMB < 256 || cacheQuotaMB > 102400 {
			return nil, fmt.Errorf("cache quota must be between 256 and 102400 MB")
		}
		team.CacheQuotaMB = cacheQuotaMB
	}
	if retentionDays > 0 {
		if retentionDays > 365 {
			retentionDays = 365
		}
		team.CacheRetentionDays = retentionDays
	}
	team.UpdatedAt = time.Now().UTC()
	return team, m.store.SaveTeam(team)
}

func (m *Manager) IsMember(userID, teamID string) bool {
	_, err := m.store.GetMember(teamID, userID)
	return err == nil
}

func (m *Manager) requireMember(userID, teamID string) (*Team, error) {
	if err := m.memberAccessError(teamID, userID); err != nil {
		return nil, err
	}
	team, err := m.store.GetTeam(teamID)
	if err != nil {
		return nil, fmt.Errorf("team not found")
	}
	if _, err := m.store.GetMember(teamID, userID); err != nil {
		return nil, fmt.Errorf("you are not a member of this team")
	}
	if err := m.memberAccessError(teamID, userID); err != nil {
		return nil, err
	}
	return team, nil
}

func (m *Manager) requireAdmin(userID, teamID string) (*Team, error) {
	team, err := m.requireMember(userID, teamID)
	if err != nil {
		return nil, err
	}
	if team.AdminUserID != userID {
		return nil, fmt.Errorf("only the team administrator can perform this action")
	}
	return team, nil
}

func (m *Manager) ListTeams(userID string) ([]TeamView, error) {
	teams, err := m.store.ListTeams()
	if err != nil {
		return nil, err
	}
	views := make([]TeamView, 0)
	for _, team := range teams {
		if _, err := m.store.GetMember(team.ID, userID); err != nil {
			continue
		}
		members, _ := m.store.ListMembers(team.ID)
		projects, _ := m.store.ListProjects(team.ID)
		views = append(views, TeamView{Team: *team, IsAdmin: team.AdminUserID == userID, MemberCount: len(members), ProjectCount: len(projects)})
	}
	sort.Slice(views, func(i, j int) bool { return views[i].UpdatedAt.After(views[j].UpdatedAt) })
	return views, nil
}

func (m *Manager) GetTeam(userID, teamID string) (*Team, []MemberView, []*Project, error) {
	team, err := m.requireMember(userID, teamID)
	if err != nil {
		return nil, nil, nil, err
	}
	members, err := m.store.ListMembers(teamID)
	if err != nil {
		return nil, nil, nil, err
	}
	views := make([]MemberView, 0, len(members))
	for _, member := range members {
		user, userErr := m.users.Get(member.UserID)
		if userErr != nil {
			continue
		}
		views = append(views, MemberView{UserID: user.ID, UID: user.UID, Username: user.Username, Name: user.Name, Avatar: user.Avatar, IsAdmin: team.AdminUserID == user.ID, JoinedAt: member.JoinedAt})
	}
	projects, _ := m.store.ListProjects(teamID)
	return team, views, projects, nil
}

func (m *Manager) CreateInvite(userID, teamID string, expiresInHours, maxUses int) (*Invite, error) {
	if _, err := m.requireAdmin(userID, teamID); err != nil {
		return nil, err
	}
	if expiresInHours <= 0 {
		expiresInHours = 168
	}
	if expiresInHours > 24*90 {
		expiresInHours = 24 * 90
	}
	if maxUses <= 0 {
		maxUses = 1
	}
	if maxUses > 100 {
		maxUses = 100
	}
	now := time.Now().UTC()
	invite := &Invite{Code: "BT-" + strings.ToUpper(auth.GenerateToken()[:12]), TeamID: teamID, CreatedBy: userID, CreatedAt: now, ExpiresAt: now.Add(time.Duration(expiresInHours) * time.Hour), MaxUses: maxUses}
	return invite, m.store.SaveInvite(invite)
}

func (m *Manager) ListInvites(userID, teamID string) ([]*Invite, error) {
	if _, err := m.requireAdmin(userID, teamID); err != nil {
		return nil, err
	}
	return m.store.ListInvites(teamID)
}

func (m *Manager) RevokeInvite(userID, teamID, code string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.requireAdmin(userID, teamID); err != nil {
		return err
	}
	invite, err := m.store.GetInvite(strings.TrimSpace(code))
	if err != nil || invite.TeamID != teamID {
		return fmt.Errorf("invite not found")
	}
	invite.Revoked = true
	return m.store.SaveInvite(invite)
}

func (m *Manager) DeleteInvite(userID, teamID, code string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.requireAdmin(userID, teamID); err != nil {
		return err
	}
	code = strings.TrimSpace(code)
	invite, err := m.store.GetInvite(code)
	if err != nil || invite.TeamID != teamID {
		return fmt.Errorf("invite not found")
	}
	return m.store.DeleteInvite(code)
}

func (m *Manager) JoinTeam(userID, code string) (*Team, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	invite, err := m.store.GetInvite(strings.ToUpper(strings.TrimSpace(code)))
	if err != nil {
		return nil, fmt.Errorf("invalid team invitation")
	}
	if invite.Revoked {
		return nil, fmt.Errorf("team invitation was revoked")
	}
	if time.Now().After(invite.ExpiresAt) {
		return nil, fmt.Errorf("team invitation expired")
	}
	if invite.MaxUses > 0 && invite.UsedCount >= invite.MaxUses {
		return nil, fmt.Errorf("team invitation has no remaining uses")
	}
	team, err := m.store.GetTeam(invite.TeamID)
	if err != nil {
		return nil, fmt.Errorf("team no longer exists")
	}
	if _, err := m.store.GetMember(team.ID, userID); err == nil {
		return team, nil
	}
	if err := m.store.SaveMember(&Member{TeamID: team.ID, UserID: userID, JoinedAt: time.Now().UTC()}); err != nil {
		return nil, err
	}
	invite.UsedCount++
	if err := m.store.SaveInvite(invite); err != nil {
		_ = m.store.DeleteMember(team.ID, userID)
		return nil, err
	}
	return team, nil
}

func (m *Manager) RemoveMember(adminID, teamID, targetUserID string) error {
	targetUserID = strings.TrimSpace(targetUserID)
	team, err := m.requireAdmin(adminID, teamID)
	if err != nil {
		return err
	}
	if targetUserID == team.AdminUserID {
		return fmt.Errorf("the single team administrator cannot be removed")
	}
	return m.revokeMemberships([]memberRevocationTarget{{teamID: teamID, userID: targetUserID}})
}

func (m *Manager) LeaveTeam(userID, teamID string) error {
	team, err := m.requireMember(userID, teamID)
	if err != nil {
		return err
	}
	if team.AdminUserID == userID {
		return fmt.Errorf("administrator must delete the team instead of leaving it")
	}
	return m.revokeMemberships([]memberRevocationTarget{{teamID: teamID, userID: userID}})
}

type memberRevocationTarget struct {
	teamID string
	userID string
	member *Member
	finish func()
}

type stagedMemberWorktree struct {
	original string
	staged   string
	root     string
}

type memberArtifactTransaction struct {
	store     Store
	worktrees []stagedMemberWorktree
	locks     []*FileLock
}

func (m *Manager) revokeMemberships(targets []memberRevocationTarget) error {
	unique := make(map[string]memberRevocationTarget, len(targets))
	for _, target := range targets {
		target.teamID = strings.TrimSpace(target.teamID)
		target.userID = strings.TrimSpace(target.userID)
		if target.teamID == "" || target.userID == "" {
			return fmt.Errorf("team and member are required")
		}
		unique[memberResourceKey(target.teamID, target.userID)] = target
	}
	targets = targets[:0]
	for _, target := range unique {
		member, err := m.store.GetMember(target.teamID, target.userID)
		if err != nil {
			return fmt.Errorf("team member not found")
		}
		target.member = member
		targets = append(targets, target)
	}
	sort.Slice(targets, func(i, j int) bool {
		return memberResourceKey(targets[i].teamID, targets[i].userID) < memberResourceKey(targets[j].teamID, targets[j].userID)
	})
	for index := range targets {
		finish, err := m.beginMemberRevocation(targets[index].teamID, targets[index].userID)
		if err != nil {
			for previous := index - 1; previous >= 0; previous-- {
				targets[previous].finish()
			}
			return err
		}
		targets[index].finish = finish
	}
	defer func() {
		for index := len(targets) - 1; index >= 0; index-- {
			targets[index].finish()
		}
	}()
	for _, target := range targets {
		if _, err := m.store.GetMember(target.teamID, target.userID); err != nil {
			return fmt.Errorf("team member changed during revocation")
		}
		if err := m.notifyMemberRevoked(target.teamID, target.userID); err != nil {
			return fmt.Errorf("revoke member hook: %w", err)
		}
	}
	artifacts, err := m.stageMemberArtifacts(targets)
	if err != nil {
		return err
	}
	deleted := make([]memberRevocationTarget, 0, len(targets))
	for _, target := range targets {
		if err := m.store.DeleteMember(target.teamID, target.userID); err != nil {
			rollback := make([]memberRevocationTarget, 0, len(deleted)+1)
			rollback = append(rollback, deleted...)
			rollback = append(rollback, target)
			rollbackErr := errors.Join(
				restoreMemberships(m.store, rollback),
				artifacts.rollback(),
			)
			if rollbackErr != nil {
				return fmt.Errorf("delete team member: %w (revocation rollback failed: %v)", err, rollbackErr)
			}
			return fmt.Errorf("delete team member: %w", err)
		}
		deleted = append(deleted, target)
	}
	if err := artifacts.commit(); err != nil {
		return fmt.Errorf("finalize member artifact cleanup: %w", err)
	}
	return nil
}

func (m *Manager) stageMemberArtifacts(targets []memberRevocationTarget) (*memberArtifactTransaction, error) {
	tx := &memberArtifactTransaction{store: m.store}
	for _, target := range targets {
		projects, err := m.store.ListProjects(target.teamID)
		if err != nil {
			return nil, tx.fail(fmt.Errorf("list team projects during member cleanup: %w", err))
		}
		for _, project := range projects {
			worktree := filepath.Join(m.repoRoot(target.teamID, project.ID), "worktrees", safeFSName(target.userID))
			if err := tx.stageWorktree(worktree); err != nil {
				return nil, tx.fail(fmt.Errorf("stage member worktree: %w", err))
			}
			locks, err := m.store.ListLocks(target.teamID, project.ID)
			if err != nil {
				return nil, tx.fail(fmt.Errorf("list member locks: %w", err))
			}
			for _, lock := range locks {
				if lock.UserID != target.userID {
					continue
				}
				snapshot := *lock
				tx.locks = append(tx.locks, &snapshot)
				if err := m.store.DeleteLock(target.teamID, project.ID, lock.Branch, lock.Path); err != nil {
					return nil, tx.fail(fmt.Errorf("delete member lock: %w", err))
				}
			}
		}
	}
	return tx, nil
}

func (tx *memberArtifactTransaction) stageWorktree(original string) error {
	if _, err := os.Lstat(original); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	root, err := os.MkdirTemp(filepath.Dir(original), ".member-revoke-")
	if err != nil {
		return err
	}
	staged := filepath.Join(root, "worktree")
	if err := os.Rename(original, staged); err != nil {
		cleanupErr := os.RemoveAll(root)
		return errors.Join(err, cleanupErr)
	}
	tx.worktrees = append(tx.worktrees, stagedMemberWorktree{original: original, staged: staged, root: root})
	return nil
}

func (tx *memberArtifactTransaction) fail(cause error) error {
	if rollbackErr := tx.rollback(); rollbackErr != nil {
		return errors.Join(cause, fmt.Errorf("artifact rollback failed: %w", rollbackErr))
	}
	return cause
}

func (tx *memberArtifactTransaction) rollback() error {
	var rollbackErrs []error
	for index := len(tx.locks) - 1; index >= 0; index-- {
		lock := tx.locks[index]
		if err := tx.store.SaveLock(lock); err != nil {
			rollbackErrs = append(rollbackErrs, fmt.Errorf("restore member lock: %w", err))
		}
	}
	for index := len(tx.worktrees) - 1; index >= 0; index-- {
		worktree := tx.worktrees[index]
		if _, err := os.Lstat(worktree.original); err == nil {
			rollbackErrs = append(rollbackErrs, fmt.Errorf("restore member worktree: destination already exists: %s", worktree.original))
			continue
		} else if !os.IsNotExist(err) {
			rollbackErrs = append(rollbackErrs, fmt.Errorf("inspect member worktree restore destination: %w", err))
			continue
		}
		if err := os.MkdirAll(filepath.Dir(worktree.original), 0700); err != nil {
			rollbackErrs = append(rollbackErrs, fmt.Errorf("create member worktree restore directory: %w", err))
			continue
		}
		if err := os.Rename(worktree.staged, worktree.original); err != nil {
			rollbackErrs = append(rollbackErrs, fmt.Errorf("restore member worktree: %w", err))
			continue
		}
		if err := os.RemoveAll(worktree.root); err != nil {
			rollbackErrs = append(rollbackErrs, fmt.Errorf("remove member worktree staging directory: %w", err))
		}
	}
	return errors.Join(rollbackErrs...)
}

func (tx *memberArtifactTransaction) commit() error {
	var cleanupErrs []error
	for _, worktree := range tx.worktrees {
		if err := os.RemoveAll(worktree.root); err != nil {
			cleanupErrs = append(cleanupErrs, fmt.Errorf("remove staged member worktree: %w", err))
		}
	}
	return errors.Join(cleanupErrs...)
}

func restoreMemberships(store Store, targets []memberRevocationTarget) error {
	var rollbackErrs []error
	for index := len(targets) - 1; index >= 0; index-- {
		if err := store.SaveMember(targets[index].member); err != nil {
			rollbackErrs = append(rollbackErrs, fmt.Errorf("restore team membership: %w", err))
		}
	}
	return errors.Join(rollbackErrs...)
}

func (m *Manager) DeleteTeam(userID, teamID string) error {
	return m.DeleteTeamTransaction(userID, teamID, nil)
}

func (m *Manager) userDeletionMemberships(userID string) ([]memberRevocationTarget, error) {
	teams, err := m.store.ListTeams()
	if err != nil {
		return nil, err
	}
	var administered []string
	var memberships []memberRevocationTarget
	for _, team := range teams {
		if team.AdminUserID == userID {
			administered = append(administered, team.Name)
			continue
		}
		if _, err := m.store.GetMember(team.ID, userID); err == nil {
			memberships = append(memberships, memberRevocationTarget{teamID: team.ID, userID: userID})
		}
	}
	if len(administered) > 0 {
		sort.Strings(administered)
		return nil, fmt.Errorf("user administers team(s) %s; delete those teams first", strings.Join(administered, ", "))
	}
	return memberships, nil
}

// ValidateUserDeletion performs the collaboration checks that must complete
// before the account record is deleted, without changing memberships or files.
func (m *Manager) ValidateUserDeletion(userID string) error {
	_, err := m.userDeletionMemberships(userID)
	return err
}

// PrepareUserDeletion is idempotent post-commit cleanup for memberships and
// their worktrees. A retry after partial external cleanup is safe.
func (m *Manager) PrepareUserDeletion(userID string) error {
	memberships, err := m.userDeletionMemberships(userID)
	if err != nil {
		return err
	}
	return m.revokeMemberships(memberships)
}

func gitRun(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	text := strings.TrimSpace(stdout.String())
	if err != nil {
		diagnostic := strings.TrimSpace(stderr.String())
		if diagnostic == "" {
			diagnostic = text
		}
		if diagnostic == "" {
			diagnostic = err.Error()
		}
		return text, fmt.Errorf("git %s: %s", strings.Join(args, " "), diagnostic)
	}
	return text, nil
}

func checkBranch(ctx context.Context, branch string) error {
	branch = strings.TrimSpace(branch)
	if branch == "" || strings.HasPrefix(branch, "-") {
		return fmt.Errorf("invalid branch name")
	}
	if _, err := gitRun(ctx, "", "check-ref-format", "--branch", branch); err != nil {
		return fmt.Errorf("invalid branch name")
	}
	return nil
}

func (m *Manager) repoRoot(teamID, projectID string) string {
	return filepath.Join(m.root, teamID, "projects", projectID)
}
func (m *Manager) repoPath(teamID, projectID string) string {
	return filepath.Join(m.repoRoot(teamID, projectID), "repository.git")
}
func (m *Manager) worktreePath(teamID, projectID, userID, branch string) string {
	return filepath.Join(m.repoRoot(teamID, projectID), "worktrees", safeFSName(userID), safeFSName(branch))
}

func safeFSName(value string) string {
	clean := strings.NewReplacer("/", "_", "\\", "_", "..", "_").Replace(value)
	if len(clean) > 48 {
		clean = clean[:48]
	}
	// Branch names are already validated; a deterministic suffix avoids slash
	// collisions without exposing the path to traversal.
	var n uint32
	for i := 0; i < len(value); i++ {
		n = n*33 + uint32(value[i])
	}
	return fmt.Sprintf("%s-%08x", clean, n)
}

func (m *Manager) CreateProject(ctx context.Context, userID, teamID, name, description string) (*Project, error) {
	if _, err := m.requireMember(userID, teamID); err != nil {
		return nil, err
	}
	name = cleanText(name, 100)
	if name == "" {
		return nil, fmt.Errorf("project name is required")
	}
	project := &Project{ID: generatedID("proj"), TeamID: teamID, Name: name, Description: cleanText(description, 500), DefaultBranch: DefaultBranch, CreatedBy: userID, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	root := m.repoRoot(teamID, project.ID)
	repo := m.repoPath(teamID, project.ID)
	if err := os.MkdirAll(root, 0755); err != nil {
		return nil, err
	}
	if _, err := gitRun(ctx, "", "init", "--bare", repo); err != nil {
		_ = os.RemoveAll(root)
		return nil, err
	}
	seed, err := os.MkdirTemp(root, ".seed-")
	if err != nil {
		_ = os.RemoveAll(root)
		return nil, err
	}
	defer os.RemoveAll(seed)
	if _, err = gitRun(ctx, seed, "init"); err == nil {
		_, err = gitRun(ctx, seed, "checkout", "-b", DefaultBranch)
	}
	if err == nil {
		err = os.WriteFile(filepath.Join(seed, "README.md"), []byte("# "+name+"\n\n"+project.Description+"\n"), 0644)
	}
	if err == nil {
		_, err = gitRun(ctx, seed, "add", "README.md")
	}
	if err == nil {
		_, err = gitRun(ctx, seed, "-c", "user.name=BoboCloud", "-c", "user.email=system@bobocloud.local", "commit", "-m", "Initialize team project")
	}
	if err == nil {
		_, err = gitRun(ctx, seed, "remote", "add", "origin", repo)
	}
	if err == nil {
		_, err = gitRun(ctx, seed, "push", "-u", "origin", DefaultBranch)
	}
	if err != nil {
		_ = os.RemoveAll(root)
		return nil, err
	}
	_, _ = gitRun(ctx, "", "--git-dir", repo, "symbolic-ref", "HEAD", "refs/heads/"+DefaultBranch)
	if err := m.store.SaveProject(project); err != nil {
		_ = os.RemoveAll(root)
		return nil, err
	}
	return project, nil
}

func (m *Manager) ListProjects(userID, teamID string) ([]*Project, error) {
	if _, err := m.requireMember(userID, teamID); err != nil {
		return nil, err
	}
	return m.store.ListProjects(teamID)
}

func (m *Manager) DeleteProject(userID, teamID, projectID string) error {
	return m.DeleteProjectTransaction(userID, teamID, projectID, nil)
}

func (m *Manager) projectForMember(userID, teamID, projectID string) (*Project, error) {
	if _, err := m.requireMember(userID, teamID); err != nil {
		return nil, err
	}
	project, err := m.store.GetProject(projectID)
	if err != nil || project.TeamID != teamID {
		return nil, fmt.Errorf("team project not found")
	}
	if m.projectDeletionInProgress(teamID, projectID) {
		return nil, fmt.Errorf("team project deletion is in progress")
	}
	return project, nil
}

func (m *Manager) EnsureWorktree(ctx context.Context, userID, teamID, projectID, branch string, pull bool) (*WorktreeInfo, error) {
	project, err := m.projectForMember(userID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	if branch == "" {
		branch = project.DefaultBranch
	}
	branch = strings.TrimSpace(branch)
	if err := checkBranch(ctx, branch); err != nil {
		return nil, err
	}
	activity, err := m.AcquireProjectActivity(userID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	defer activity.Release()
	releaseBranch := m.branchOperations.lock(branchOperationKey(teamID, projectID, branch))
	defer releaseBranch()
	return m.ensureWorktree(ctx, project, userID, branch, pull)
}

// ensureWorktree runs with the project activity lease and branch operation lock
// already held by its caller.
func (m *Manager) ensureWorktree(ctx context.Context, project *Project, userID, branch string, pull bool) (*WorktreeInfo, error) {
	teamID, projectID := project.TeamID, project.ID
	repo := m.repoPath(teamID, projectID)
	if _, err := gitRun(ctx, "", "--git-dir", repo, "show-ref", "--verify", "refs/heads/"+branch); err != nil {
		return nil, fmt.Errorf("branch %q does not exist", branch)
	}
	worktree := m.worktreePath(teamID, projectID, userID, branch)
	if _, statErr := os.Stat(filepath.Join(worktree, ".git")); errors.Is(statErr, os.ErrNotExist) {
		_ = os.RemoveAll(worktree)
		if err := os.MkdirAll(filepath.Dir(worktree), 0755); err != nil {
			return nil, err
		}
		if _, err := gitRun(ctx, "", "clone", "--branch", branch, repo, worktree); err != nil {
			_ = os.RemoveAll(worktree)
			return nil, err
		}
	}
	status, _ := gitRun(ctx, worktree, "status", "--porcelain")
	dirty := strings.TrimSpace(status) != ""
	if pull && !dirty {
		if _, err := gitRun(ctx, worktree, "fetch", "--prune", "origin"); err != nil {
			return nil, err
		}
		if _, err := gitRun(ctx, worktree, "merge", "--ff-only", "origin/"+branch); err != nil {
			return nil, err
		}
	}
	head, _ := gitRun(ctx, worktree, "rev-parse", "HEAD")
	conflicts, _ := m.conflictPaths(ctx, worktree)
	return &WorktreeInfo{TeamID: teamID, ProjectID: projectID, ProjectName: project.Name, Branch: branch, RemotePath: filepath.ToSlash(worktree), Dirty: dirty, Conflicts: conflicts, Head: head}, nil
}

func (m *Manager) ResolveWorktree(ctx context.Context, userID, teamID, projectID, branch string) (string, error) {
	info, err := m.EnsureWorktree(ctx, userID, teamID, projectID, branch, false)
	if err != nil {
		return "", err
	}
	return filepath.FromSlash(info.RemotePath), nil
}

// ResetWorktree explicitly discards a member's uncommitted cloud-worktree
// changes and aligns it with the selected shared branch. Callers must only use
// this after an explicit destructive Pull choice in the client.
func (m *Manager) ResetWorktree(ctx context.Context, userID, teamID, projectID, branch string) (*WorktreeInfo, error) {
	project, err := m.projectForMember(userID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	if branch == "" {
		branch = project.DefaultBranch
	}
	branch = strings.TrimSpace(branch)
	if err := checkBranch(ctx, branch); err != nil {
		return nil, err
	}
	activity, err := m.AcquireProjectActivity(userID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	defer activity.Release()
	releaseBranch := m.branchOperations.lock(branchOperationKey(teamID, projectID, branch))
	defer releaseBranch()
	info, err := m.ensureWorktree(ctx, project, userID, branch, false)
	if err != nil {
		return nil, err
	}
	worktree := filepath.FromSlash(info.RemotePath)
	if _, err := gitRun(ctx, worktree, "fetch", "--prune", "origin"); err != nil {
		return nil, err
	}
	if _, err := gitRun(ctx, worktree, "reset", "--hard", "origin/"+info.Branch); err != nil {
		return nil, err
	}
	if _, err := gitRun(ctx, worktree, "clean", "-fd"); err != nil {
		return nil, err
	}
	info.Dirty = false
	info.Conflicts = nil
	info.Head, _ = gitRun(ctx, worktree, "rev-parse", "HEAD")
	return info, nil
}

func (m *Manager) CreateBranch(ctx context.Context, userID, teamID, projectID, name, from string) error {
	project, err := m.projectForMember(userID, teamID, projectID)
	if err != nil {
		return err
	}
	if from == "" {
		from = project.DefaultBranch
	}
	if err := checkBranch(ctx, name); err != nil {
		return err
	}
	if err := checkBranch(ctx, from); err != nil {
		return err
	}
	activity, err := m.AcquireProjectActivity(userID, teamID, projectID)
	if err != nil {
		return err
	}
	defer activity.Release()
	releaseBranches := m.branchOperations.lockMany(
		branchOperationKey(teamID, projectID, from),
		branchOperationKey(teamID, projectID, name),
	)
	defer releaseBranches()
	_, err = gitRun(ctx, "", "--git-dir", m.repoPath(teamID, projectID), "branch", name, from)
	return err
}

func (m *Manager) ListBranches(ctx context.Context, userID, teamID, projectID string) ([]BranchInfo, error) {
	project, err := m.projectForMember(userID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	// :unix was added after the Git 1.8 series still shipped by several
	// supported Linux hosts. :raw has the same epoch value followed by the
	// timezone and works on both old and current Git versions.
	format := "%(refname:short)%00%(objectname)%00%(subject)%00%(authorname)%00%(committerdate:raw)"
	out, err := gitRun(ctx, "", "--git-dir", m.repoPath(teamID, projectID), "for-each-ref", "--sort=-committerdate", "--format="+format, "refs/heads")
	if err != nil {
		return nil, err
	}
	result := make([]BranchInfo, 0)
	for _, line := range strings.Split(out, "\n") {
		parts := strings.Split(line, "\x00")
		if len(parts) != 5 {
			continue
		}
		dateFields := strings.Fields(parts[4])
		if len(dateFields) == 0 {
			continue
		}
		unix, parseErr := strconv.ParseInt(dateFields[0], 10, 64)
		if parseErr != nil {
			continue
		}
		result = append(result, BranchInfo{Name: parts[0], Commit: parts[1], Subject: parts[2], Author: parts[3], CommittedAt: time.Unix(unix, 0).UTC(), IsDefault: parts[0] == project.DefaultBranch})
	}
	return result, nil
}

func (m *Manager) History(ctx context.Context, userID, teamID, projectID string, limit int) ([]CommitInfo, error) {
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 200 {
		limit = 80
	}
	format := "%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%ct%x1f%s%x1e"
	out, err := gitRun(ctx, "", "--git-dir", m.repoPath(teamID, projectID), "log", "--all", "--date-order", "-n", strconv.Itoa(limit), "--pretty=format:"+format)
	if err != nil {
		return nil, err
	}
	result := make([]CommitInfo, 0)
	for _, record := range strings.Split(out, "\x1e") {
		parts := strings.Split(strings.TrimSpace(record), "\x1f")
		if len(parts) != 7 {
			continue
		}
		unix, _ := strconv.ParseInt(parts[5], 10, 64)
		authorUID := strings.TrimSuffix(parts[4], "@users.bobocloud.local")
		result = append(result, CommitInfo{ID: parts[0], Parents: strings.Fields(parts[1]), Refs: parts[2], Author: parts[3], AuthorUID: authorUID, CreatedAt: time.Unix(unix, 0).UTC(), Message: parts[6]})
	}
	return result, nil
}

func (m *Manager) Commit(ctx context.Context, user *auth.User, teamID, projectID, branch, message string) (*CommitInfo, error) {
	message = cleanText(message, 240)
	if message == "" {
		return nil, fmt.Errorf("commit message is required")
	}
	project, err := m.projectForMember(user.ID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	if branch == "" {
		branch = project.DefaultBranch
	}
	branch = strings.TrimSpace(branch)
	if err := checkBranch(ctx, branch); err != nil {
		return nil, err
	}
	activity, err := m.AcquireProjectActivity(user.ID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	defer activity.Release()
	releaseBranch := m.branchOperations.lock(branchOperationKey(teamID, projectID, branch))
	defer releaseBranch()

	info, err := m.ensureWorktree(ctx, project, user.ID, branch, false)
	if err != nil {
		return nil, err
	}
	worktree := filepath.FromSlash(info.RemotePath)
	if conflicts, conflictErr := m.conflictPaths(ctx, worktree); conflictErr != nil {
		return nil, conflictErr
	} else if len(conflicts) > 0 {
		return nil, mergeConflictError(len(conflicts), gitHead(ctx, worktree), nil)
	}
	if _, err := gitRun(ctx, worktree, "add", "-A"); err != nil {
		return nil, err
	}
	staged, _ := gitRun(ctx, worktree, "diff", "--cached", "--name-only")
	authorName := user.Name
	if authorName == "" {
		authorName = user.Username
	}
	authorEmail := user.UID + "@users.bobocloud.local"
	if strings.TrimSpace(staged) != "" {
		if _, err := gitRun(ctx, worktree, "-c", "user.name="+authorName, "-c", "user.email="+authorEmail, "commit", "-m", message); err != nil {
			return nil, err
		}
	} else {
		pending, pendingErr := m.hasPendingCommit(ctx, worktree, branch)
		if pendingErr != nil {
			return nil, pendingPushError(
				ErrorCodePushFailed,
				"The existing cloud commit could not be checked. It remains pending and can be retried.",
				gitHead(ctx, worktree),
				pendingErr,
			)
		}
		if !pending {
			return nil, operationError(ErrorCodeNoChanges, "There are no changes to commit.", ErrorDetails{
				Retryable:       false,
				SuggestedAction: SuggestedActionEditFiles,
			}, nil)
		}
	}
	if err := m.publishPendingCommit(ctx, worktree, branch, authorName, authorEmail); err != nil {
		return nil, err
	}
	return commitInfoAtHead(ctx, worktree)
}

func branchOperationKey(teamID, projectID, branch string) string {
	return strings.Join([]string{teamID, projectID, branch}, "\x00")
}

func gitHead(ctx context.Context, worktree string) string {
	head, _ := gitRun(ctx, worktree, "rev-parse", "HEAD")
	return strings.TrimSpace(head)
}

func commitInfoAtHead(ctx context.Context, worktree string) (*CommitInfo, error) {
	format := "%H%x1f%P%x1f%an%x1f%ae%x1f%ct%x1f%s"
	out, err := gitRun(ctx, worktree, "show", "-s", "--format="+format, "HEAD")
	if err != nil {
		return nil, err
	}
	parts := strings.Split(strings.TrimSpace(out), "\x1f")
	if len(parts) != 6 {
		return nil, fmt.Errorf("unexpected commit metadata")
	}
	unix, err := strconv.ParseInt(parts[4], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("parse commit time: %w", err)
	}
	return &CommitInfo{
		ID:        parts[0],
		Parents:   strings.Fields(parts[1]),
		Author:    parts[2],
		AuthorUID: strings.TrimSuffix(parts[3], "@users.bobocloud.local"),
		CreatedAt: time.Unix(unix, 0).UTC(),
		Message:   parts[5],
	}, nil
}

func fetchBranch(ctx context.Context, worktree, branch string) error {
	_, err := gitRun(ctx, worktree, "fetch", "--no-tags", "origin", "refs/heads/"+branch+":refs/remotes/origin/"+branch)
	return err
}

func (m *Manager) hasPendingCommit(ctx context.Context, worktree, branch string) (bool, error) {
	if err := fetchBranch(ctx, worktree, branch); err != nil {
		return false, err
	}
	ahead, err := gitRun(ctx, worktree, "rev-list", "--count", "origin/"+branch+"..HEAD")
	if err != nil {
		return false, err
	}
	count, err := strconv.Atoi(strings.TrimSpace(ahead))
	if err != nil {
		return false, fmt.Errorf("parse pending commit count: %w", err)
	}
	return count > 0, nil
}

func isNonFastForwardPush(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "non-fast-forward") ||
		(strings.Contains(message, "[rejected]") && strings.Contains(message, "fetch first"))
}

func (m *Manager) publishPendingCommit(ctx context.Context, worktree, branch, authorName, authorEmail string) error {
	const maxPushAttempts = 3
	for attempt := 0; attempt < maxPushAttempts; attempt++ {
		pendingCommit := gitHead(ctx, worktree)
		if err := fetchBranch(ctx, worktree, branch); err != nil {
			return pendingPushError(
				ErrorCodePushFailed,
				"The commit was saved in the cloud worktree, but the shared branch could not be refreshed. Retry the commit action.",
				pendingCommit,
				err,
			)
		}
		if _, err := gitRun(ctx, worktree, "-c", "user.name="+authorName, "-c", "user.email="+authorEmail, "merge", "--no-edit", "origin/"+branch); err != nil {
			conflicts, conflictErr := m.conflictPaths(ctx, worktree)
			if conflictErr == nil && len(conflicts) > 0 {
				return mergeConflictError(len(conflicts), pendingCommit, err)
			}
			return pendingPushError(
				ErrorCodePushFailed,
				"The commit was saved in the cloud worktree, but remote changes could not be integrated. Retry the commit action.",
				pendingCommit,
				err,
			)
		}
		pendingCommit = gitHead(ctx, worktree)
		if _, err := gitRun(ctx, worktree, "push", "origin", "HEAD:refs/heads/"+branch); err == nil {
			return nil
		} else if !isNonFastForwardPush(err) {
			return pendingPushError(
				ErrorCodePushFailed,
				"The commit was saved in the cloud worktree, but it could not be published. Retry the commit action.",
				pendingCommit,
				err,
			)
		}
	}
	return pendingPushError(
		ErrorCodePushConflict,
		"The shared branch changed repeatedly while publishing. The commit remains pending; retry after the other publish completes.",
		gitHead(ctx, worktree),
		nil,
	)
}

func (m *Manager) Compare(ctx context.Context, userID, teamID, projectID, from, to string) (*DiffInfo, error) {
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return nil, err
	}
	if err := checkBranch(ctx, from); err != nil {
		return nil, err
	}
	if err := checkBranch(ctx, to); err != nil {
		return nil, err
	}
	repo := m.repoPath(teamID, projectID)
	stats, err := gitRun(ctx, "", "--git-dir", repo, "diff", "--stat", "refs/heads/"+from+"..refs/heads/"+to)
	if err != nil {
		return nil, err
	}
	patch, err := gitRun(ctx, "", "--git-dir", repo, "diff", "--unified=3", "refs/heads/"+from+"..refs/heads/"+to)
	if err != nil {
		return nil, err
	}
	truncated := false
	if len(patch) > 500000 {
		patch = patch[:500000] + "\n... diff truncated ..."
		truncated = true
	}
	return &DiffInfo{From: from, To: to, Stats: stats, Patch: patch, Truncated: truncated}, nil
}

func (m *Manager) conflictPaths(ctx context.Context, worktree string) ([]string, error) {
	out, err := gitRun(ctx, worktree, "diff", "--name-only", "--diff-filter=U")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(out) == "" {
		return nil, nil
	}
	return strings.Fields(out), nil
}

func (m *Manager) Merge(ctx context.Context, user *auth.User, teamID, projectID, source, target string) (*WorktreeInfo, error) {
	project, err := m.projectForMember(user.ID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	if err := checkBranch(ctx, source); err != nil {
		return nil, err
	}
	if err := checkBranch(ctx, target); err != nil {
		return nil, err
	}
	activity, err := m.AcquireProjectActivity(user.ID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	defer activity.Release()
	releaseBranches := m.branchOperations.lockMany(
		branchOperationKey(teamID, projectID, source),
		branchOperationKey(teamID, projectID, target),
	)
	defer releaseBranches()
	info, err := m.ensureWorktree(ctx, project, user.ID, target, false)
	if err != nil {
		return nil, err
	}
	if info.Dirty {
		return nil, fmt.Errorf("cloud worktree has uncommitted changes; commit them or pull/reset before merging")
	}
	info, err = m.ensureWorktree(ctx, project, user.ID, target, true)
	if err != nil {
		return nil, err
	}
	worktree := filepath.FromSlash(info.RemotePath)
	authorName := user.Name
	if authorName == "" {
		authorName = user.Username
	}
	authorEmail := user.UID + "@users.bobocloud.local"
	_, mergeErr := gitRun(ctx, worktree, "-c", "user.name="+authorName, "-c", "user.email="+authorEmail, "merge", "--no-edit", "origin/"+source)
	conflicts, _ := m.conflictPaths(ctx, worktree)
	if len(conflicts) > 0 {
		info.Conflicts = conflicts
		info.Dirty = true
		return info, nil
	}
	if mergeErr != nil {
		return nil, mergeErr
	}
	if err := m.publishPendingCommit(ctx, worktree, target, authorName, authorEmail); err != nil {
		return nil, err
	}
	info.Head, _ = gitRun(ctx, worktree, "rev-parse", "HEAD")
	return info, nil
}

func readGitStage(ctx context.Context, worktree, stage, path string) string {
	out, err := gitRun(ctx, worktree, "show", stage+":"+path)
	if err != nil {
		return ""
	}
	if len(out) > 200000 {
		return out[:200000] + "\n... content truncated ..."
	}
	return out
}

func (m *Manager) ConflictFiles(ctx context.Context, userID, teamID, projectID, branch string) ([]ConflictFile, error) {
	project, err := m.projectForMember(userID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	if branch == "" {
		branch = project.DefaultBranch
	}
	branch = strings.TrimSpace(branch)
	if err := checkBranch(ctx, branch); err != nil {
		return nil, err
	}
	activity, err := m.AcquireProjectActivity(userID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	defer activity.Release()
	releaseBranch := m.branchOperations.lock(branchOperationKey(teamID, projectID, branch))
	defer releaseBranch()
	info, err := m.ensureWorktree(ctx, project, userID, branch, false)
	if err != nil {
		return nil, err
	}
	worktree := filepath.FromSlash(info.RemotePath)
	paths, err := m.conflictPaths(ctx, worktree)
	if err != nil {
		return nil, err
	}
	result := make([]ConflictFile, 0, len(paths))
	for _, p := range paths {
		result = append(result, ConflictFile{Path: p, Base: readGitStage(ctx, worktree, ":1", p), Ours: readGitStage(ctx, worktree, ":2", p), Theirs: readGitStage(ctx, worktree, ":3", p)})
	}
	return result, nil
}

func safeWorktreeFile(root, rel string) (string, error) {
	rel = strings.ReplaceAll(rel, "\\", "/")
	if rel == "" || strings.HasPrefix(rel, "/") {
		return "", fmt.Errorf("invalid file path")
	}
	full := filepath.Clean(filepath.Join(root, filepath.FromSlash(rel)))
	root = filepath.Clean(root)
	if full == root || !strings.HasPrefix(full, root+string(filepath.Separator)) {
		return "", fmt.Errorf("file path escapes worktree")
	}
	return full, nil
}

func (m *Manager) ResolveConflict(ctx context.Context, userID, teamID, projectID, branch, path, content string) error {
	project, err := m.projectForMember(userID, teamID, projectID)
	if err != nil {
		return err
	}
	if branch == "" {
		branch = project.DefaultBranch
	}
	branch = strings.TrimSpace(branch)
	if err := checkBranch(ctx, branch); err != nil {
		return err
	}
	activity, err := m.AcquireProjectActivity(userID, teamID, projectID)
	if err != nil {
		return err
	}
	defer activity.Release()
	releaseBranch := m.branchOperations.lock(branchOperationKey(teamID, projectID, branch))
	defer releaseBranch()
	info, err := m.ensureWorktree(ctx, project, userID, branch, false)
	if err != nil {
		return err
	}
	worktree := filepath.FromSlash(info.RemotePath)
	target, err := safeWorktreeFile(worktree, path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	if err := os.WriteFile(target, []byte(content), 0644); err != nil {
		return err
	}
	_, err = gitRun(ctx, worktree, "add", "--", path)
	return err
}

func (m *Manager) CompleteMerge(ctx context.Context, user *auth.User, teamID, projectID, branch, message string) (*CommitInfo, error) {
	project, err := m.projectForMember(user.ID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	if branch == "" {
		branch = project.DefaultBranch
	}
	branch = strings.TrimSpace(branch)
	if err := checkBranch(ctx, branch); err != nil {
		return nil, err
	}
	activity, err := m.AcquireProjectActivity(user.ID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	defer activity.Release()
	releaseBranch := m.branchOperations.lock(branchOperationKey(teamID, projectID, branch))
	defer releaseBranch()
	info, err := m.ensureWorktree(ctx, project, user.ID, branch, false)
	if err != nil {
		return nil, err
	}
	worktree := filepath.FromSlash(info.RemotePath)
	conflicts, conflictErr := m.conflictPaths(ctx, worktree)
	if conflictErr != nil {
		return nil, conflictErr
	}
	if len(conflicts) > 0 {
		return nil, mergeConflictError(len(conflicts), gitHead(ctx, worktree), nil)
	}
	if message == "" {
		message = "Resolve merge conflicts"
	}
	name := user.Name
	if name == "" {
		name = user.Username
	}
	email := user.UID + "@users.bobocloud.local"
	if _, err := gitRun(ctx, worktree, "-c", "user.name="+name, "-c", "user.email="+email, "commit", "-m", cleanText(message, 240)); err != nil {
		return nil, err
	}
	if err := m.publishPendingCommit(ctx, worktree, branch, name, email); err != nil {
		return nil, err
	}
	return commitInfoAtHead(ctx, worktree)
}

func normalizeLockPath(path string) (string, error) {
	path = strings.ReplaceAll(path, "\\", "/")
	if path == "" || strings.HasPrefix(path, "/") || strings.ContainsRune(path, '\x00') {
		return "", fmt.Errorf("invalid lock path")
	}
	path = pathpkg.Clean(path)
	if path == "." || path == ".." || strings.HasPrefix(path, "../") {
		return "", fmt.Errorf("invalid lock path")
	}
	return path, nil
}

func (m *Manager) AcquireLock(user *auth.User, teamID, projectID, branch, path, leaseID string, ttlMinutes int) (*FileLock, error) {
	project, err := m.projectForMember(user.ID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	branch = strings.TrimSpace(branch)
	if branch == "" {
		branch = project.DefaultBranch
	}
	path, err = normalizeLockPath(path)
	if err != nil {
		return nil, err
	}
	// Locks are short leases, not manual ten-minute reservations. Clients renew
	// while they remain active; old clients asking for a longer TTL are capped.
	if ttlMinutes <= 0 || ttlMinutes > 2 {
		ttlMinutes = 2
	}
	activity, err := m.AcquireProjectActivity(user.ID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	defer activity.Release()
	m.mu.Lock()
	defer m.mu.Unlock()
	locks, err := m.store.ListLocks(teamID, projectID)
	if err != nil {
		return nil, fmt.Errorf("list file locks: %w", err)
	}
	now := time.Now().UTC()
	for _, lock := range locks {
		if lock.Branch != branch || lock.Path != path || !lock.ExpiresAt.After(now) {
			continue
		}
		if lock.UserID != user.ID {
			holder := *lock
			return nil, operationError(ErrorCodeLockHeld, "This file is currently being edited by "+lock.UserName+".", ErrorDetails{
				Retryable:       true,
				SuggestedAction: SuggestedActionWaitForLock,
				Lock:            &holder,
			}, nil)
		}
		if lock.LeaseID != "" && leaseID != lock.LeaseID {
			return nil, staleLockError(lock)
		}
		renewed := *lock
		renewed.ExpiresAt = now.Add(time.Duration(ttlMinutes) * time.Minute)
		if renewed.LeaseID == "" {
			renewed.LeaseID = generatedID("lock")
		}
		return &renewed, m.store.SaveLock(&renewed)
	}
	name := user.Name
	if name == "" {
		name = user.Username
	}
	lock := &FileLock{TeamID: teamID, ProjectID: projectID, Branch: branch, Path: path, UserID: user.ID, UserUID: user.UID, UserName: name, LeaseID: generatedID("lock"), ExpiresAt: now.Add(time.Duration(ttlMinutes) * time.Minute)}
	return lock, m.store.SaveLock(lock)
}

func (m *Manager) ListLocks(userID, teamID, projectID string) ([]*FileLock, error) {
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return nil, err
	}
	activity, err := m.AcquireProjectActivity(userID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	defer activity.Release()
	m.mu.Lock()
	defer m.mu.Unlock()
	locks, err := m.store.ListLocks(teamID, projectID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	out := make([]*FileLock, 0, len(locks))
	for _, lock := range locks {
		if lock.ExpiresAt.After(now) {
			out = append(out, lock)
		} else {
			if err := m.store.DeleteLock(lock.TeamID, lock.ProjectID, lock.Branch, lock.Path); err != nil {
				return nil, fmt.Errorf("delete expired file lock: %w", err)
			}
		}
	}
	return out, nil
}

func (m *Manager) ReleaseLock(userID, teamID, projectID, branch, path, leaseID string) error {
	project, err := m.projectForMember(userID, teamID, projectID)
	if err != nil {
		return err
	}
	branch = strings.TrimSpace(branch)
	if branch == "" {
		branch = project.DefaultBranch
	}
	path, err = normalizeLockPath(path)
	if err != nil {
		return err
	}
	activity, err := m.AcquireProjectActivity(userID, teamID, projectID)
	if err != nil {
		return err
	}
	defer activity.Release()
	m.mu.Lock()
	defer m.mu.Unlock()
	locks, err := m.store.ListLocks(teamID, projectID)
	if err != nil {
		return fmt.Errorf("list file locks: %w", err)
	}
	for _, lock := range locks {
		if lock.Branch == branch && lock.Path == path {
			team, _ := m.store.GetTeam(teamID)
			if lock.UserID != userID && (team == nil || team.AdminUserID != userID) {
				return fmt.Errorf("only the lock owner or team administrator can release this lock")
			}
			isAdminOverride := team != nil && team.AdminUserID == userID && lock.UserID != userID
			if !isAdminOverride && lock.LeaseID != "" && leaseID != lock.LeaseID {
				return staleLockError(lock)
			}
			return m.store.DeleteLock(teamID, projectID, branch, path)
		}
	}
	return nil
}
