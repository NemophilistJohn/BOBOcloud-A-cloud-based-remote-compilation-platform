package collab

import (
	"errors"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
)

type projectLookupBarrierStore struct {
	Store
	mu      sync.Mutex
	armed   bool
	entered chan struct{}
	release chan struct{}
}

func (store *projectLookupBarrierStore) arm() {
	store.mu.Lock()
	store.armed = true
	store.entered = make(chan struct{})
	store.release = make(chan struct{})
	store.mu.Unlock()
}

func (store *projectLookupBarrierStore) GetProject(projectID string) (*Project, error) {
	project, err := store.Store.GetProject(projectID)
	store.mu.Lock()
	if !store.armed {
		store.mu.Unlock()
		return project, err
	}
	store.armed = false
	entered, release := store.entered, store.release
	close(entered)
	store.mu.Unlock()
	<-release
	return project, err
}

func testProjectLifecycleManager(t *testing.T) (*Manager, *auth.User, *Team, *Project) {
	t.Helper()
	users := auth.NewMemoryUserStore()
	admin := testUser("admin-lifecycle", "u_lifecycle", "admin")
	if err := users.Create(admin); err != nil {
		t.Fatal(err)
	}
	store := NewMemoryStore()
	manager := NewManager(store, users, t.TempDir())
	team, err := manager.CreateTeam(admin.ID, "Lifecycle", "", 1024)
	if err != nil {
		t.Fatal(err)
	}
	project := &Project{ID: "project-lifecycle", TeamID: team.ID, Name: "project", DefaultBranch: "main", CreatedBy: admin.ID, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := store.SaveProject(project); err != nil {
		t.Fatal(err)
	}
	return manager, admin, team, project
}

func TestProjectDeletionRejectsActiveAndBlocksNewActivity(t *testing.T) {
	manager, admin, team, project := testProjectLifecycleManager(t)
	activity, err := manager.AcquireProjectActivity(admin.ID, team.ID, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	cleanupCalled := false
	err = manager.DeleteProjectTransaction(admin.ID, team.ID, project.ID, func() error {
		cleanupCalled = true
		return nil
	})
	if err == nil || cleanupCalled {
		t.Fatalf("active deletion err=%v cleanup=%v", err, cleanupCalled)
	}
	activity.Release()

	entered := make(chan struct{})
	continueDelete := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- manager.DeleteProjectTransaction(admin.ID, team.ID, project.ID, func() error {
			close(entered)
			<-continueDelete
			return nil
		})
	}()
	<-entered
	if _, err := manager.AcquireProjectActivity(admin.ID, team.ID, project.ID); err == nil {
		t.Fatal("activity entered a deleting project")
	}
	close(continueDelete)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestProjectDeletionCleanupFailureRestoresAvailability(t *testing.T) {
	manager, admin, team, project := testProjectLifecycleManager(t)
	want := errors.New("cleanup failed")
	if err := manager.DeleteProjectTransaction(admin.ID, team.ID, project.ID, func() error { return want }); !errors.Is(err, want) {
		t.Fatalf("delete error = %v", err)
	}
	activity, err := manager.AcquireProjectActivity(admin.ID, team.ID, project.ID)
	if err != nil {
		t.Fatalf("cleanup failure left tombstone: %v", err)
	}
	activity.Release()
}

func TestActivityRechecksAuthorizationAfterCompletedMutation(t *testing.T) {
	tests := []struct {
		name   string
		member bool
		mutate func(*Manager, *auth.User, *auth.User, *Team, *Project) error
	}{
		{name: "member removed", member: true, mutate: func(manager *Manager, admin, member *auth.User, team *Team, _ *Project) error {
			return manager.RemoveMember(admin.ID, team.ID, member.ID)
		}},
		{name: "project deleted", mutate: func(manager *Manager, admin, _ *auth.User, team *Team, project *Project) error {
			return manager.DeleteProjectTransaction(admin.ID, team.ID, project.ID, nil)
		}},
		{name: "team deleted", mutate: func(manager *Manager, admin, _ *auth.User, team *Team, _ *Project) error {
			return manager.DeleteTeamTransaction(admin.ID, team.ID, nil)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			users := auth.NewMemoryUserStore()
			admin := testUser("activity-admin", "activity_admin", "admin")
			member := testUser("activity-member", "activity_member", "member")
			if err := users.Create(admin); err != nil {
				t.Fatal(err)
			}
			if err := users.Create(member); err != nil {
				t.Fatal(err)
			}
			base := NewMemoryStore()
			store := &projectLookupBarrierStore{Store: base}
			manager := NewManager(store, users, t.TempDir())
			team, err := manager.CreateTeam(admin.ID, "Activity", "", 1024)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.SaveMember(&Member{TeamID: team.ID, UserID: member.ID, JoinedAt: time.Now()}); err != nil {
				t.Fatal(err)
			}
			project := &Project{ID: "activity-project", TeamID: team.ID, Name: "project", DefaultBranch: "main", CreatedBy: admin.ID, CreatedAt: time.Now(), UpdatedAt: time.Now()}
			if err := store.SaveProject(project); err != nil {
				t.Fatal(err)
			}
			activityUser := admin
			if test.member {
				activityUser = member
			}
			store.arm()
			result := make(chan error, 1)
			go func() {
				lease, acquireErr := manager.AcquireProjectActivity(activityUser.ID, team.ID, project.ID)
				if lease != nil {
					lease.Release()
				}
				result <- acquireErr
			}()
			<-store.entered
			if err := test.mutate(manager, admin, member, team, project); err != nil {
				t.Fatal(err)
			}
			close(store.release)
			if err := <-result; err == nil {
				t.Fatal("stale authorization created an activity lease after deletion")
			}
		})
	}
}

func TestTeamDeletionRejectsProjectDeletionInProgress(t *testing.T) {
	manager, admin, team, project := testProjectLifecycleManager(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- manager.DeleteProjectTransaction(admin.ID, team.ID, project.ID, func() error {
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	if err := manager.DeleteTeamTransaction(admin.ID, team.ID, nil); err == nil {
		t.Fatal("team deletion entered while a project deletion was active")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
