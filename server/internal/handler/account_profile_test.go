package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/collab"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/dap"
	"bobocloud-server/internal/lifecycle"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
)

type failingCompileActivityDeleteStore struct {
	storage.CompileActivityStore
	err error
}

func (s failingCompileActivityDeleteStore) DeleteByUser(string) error { return s.err }

type failingUserDeleteStore struct {
	auth.UserStore
	err error
}

func (s failingUserDeleteStore) Delete(string) error                  { return s.err }
func (s failingUserDeleteStore) DeleteWithCleanupMarker(string) error { return s.err }

type deleteAfterAuthenticationStore struct {
	auth.UserStore
	mu       sync.Mutex
	targetID string
	reads    int
}

func (s *deleteAfterAuthenticationStore) GetByAPIKey(key string) (*auth.User, error) {
	user, err := s.UserStore.GetByAPIKey(key)
	if err == nil {
		s.mu.Lock()
		s.reads++
		shouldDelete := s.reads == 1 && user.ID == s.targetID
		s.mu.Unlock()
		if shouldDelete {
			if deleteErr := s.UserStore.DeleteWithCleanupMarker(user.ID); deleteErr != nil {
				return nil, deleteErr
			}
		}
	}
	return user, err
}

type recordingAuthSessionStore struct {
	auth.AuthSessionStore
	mu       sync.Mutex
	deleted  []string
	err      error
	failures int
}

func (s *recordingAuthSessionStore) DeleteByUser(userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleted = append(s.deleted, userID)
	if s.failures > 0 {
		s.failures--
		return s.err
	}
	return nil
}

func (s *recordingAuthSessionStore) deleteCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.deleted)
}

type recordingRunHistoryStore struct {
	storage.RunHistoryStore
	mu       sync.Mutex
	deleted  []string
	err      error
	failures int
}

func (s *recordingRunHistoryStore) DeleteByUser(userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleted = append(s.deleted, userID)
	if s.failures > 0 {
		s.failures--
		return s.err
	}
	return nil
}

func (s *recordingRunHistoryStore) deleteCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.deleted)
}

func TestValidateAvatarChecksTypeSizeAndSignature(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), []byte("fixture")...)
	validPNG := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	for _, avatar := range []string{"ocean", validPNG} {
		if err := validateAvatar(avatar); err != nil {
			t.Fatalf("valid avatar rejected: %v", err)
		}
	}
	invalid := []string{
		"data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte("<svg/>")),
		"data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("not a png")),
		"data:image/png;base64,not-base64",
		"data:image/png;base64," + base64.StdEncoding.EncodeToString(make([]byte, maxAvatarBytes+1)),
	}
	for _, avatar := range invalid {
		if err := validateAvatar(avatar); err == nil {
			t.Fatalf("invalid avatar accepted: %.40s", avatar)
		}
	}
}

func TestUpdateProfileUsesLatestStoredAdministrativeFields(t *testing.T) {
	users := auth.NewMemoryUserStore()
	base := &auth.User{
		ID: "profile-user", UID: "u_profile", Username: "profile", Email: "profile@example.com",
		Name: "Before", Avatar: "ocean", Role: auth.RoleMember,
		ContainerLimit: 1, RateLimit: 10, DiskQuotaMB: 100,
	}
	if err := users.Create(base); err != nil {
		t.Fatal(err)
	}
	staleRequestUser, err := users.Get(base.ID)
	if err != nil {
		t.Fatal(err)
	}
	latest, err := users.Get(base.ID)
	if err != nil {
		t.Fatal(err)
	}
	latest.Role = auth.RoleAdmin
	latest.Disabled = true
	latest.ContainerLimit = 8
	latest.RateLimit = 88
	latest.DiskQuotaMB = 4096
	if err := users.Create(latest); err != nil {
		t.Fatal(err)
	}

	handler := &HTTPHandler{UserStore: users}
	request := httptest.NewRequest(http.MethodPost, "/api", nil)
	request = request.WithContext(context.WithValue(request.Context(), auth.ContextUser, staleRequestUser))
	recorder := httptest.NewRecorder()
	handler.handleUpdateProfile(recorder, request, &model.Request{Name: "After", Avatar: "forest"})
	if recorder.Code != http.StatusOK {
		t.Fatalf("update failed: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var response model.Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.User == nil || response.User.Name != "After" || response.User.Avatar != "forest" ||
		response.User.Role != auth.RoleAdmin || !response.User.Disabled || response.User.ContainerLimit != 8 ||
		response.User.RateLimit != 88 || response.User.DiskQuotaMB != 4096 {
		t.Fatalf("response was not built from the latest patched user: %+v", response.User)
	}
}

func TestAcceptedRunCodeHandshakeCountsOnce(t *testing.T) {
	handler, _, _ := newRunLifecycleHTTPHandler(t)
	activity := storage.NewMemoryCompileActivityStore()
	handler.CompileActivity = activity

	firstRecorder, first := callRunCode(t, handler, "counted-run")
	if firstRecorder.Code != http.StatusOK || !first.Success {
		t.Fatalf("initial run rejected: %s", firstRecorder.Body.String())
	}
	duplicateRecorder, duplicate := callRunCode(t, handler, "counted-run")
	if duplicateRecorder.Code != http.StatusConflict || duplicate.Success {
		t.Fatalf("duplicate run unexpectedly accepted: %s", duplicateRecorder.Body.String())
	}
	missingBody, err := json.Marshal(map[string]string{
		"action": "runCode", "runId": "missing-file-run",
		"folderName": "project", "filePath": "missing.go",
	})
	if err != nil {
		t.Fatal(err)
	}
	missingRecorder := httptest.NewRecorder()
	handler.ServeHTTP(missingRecorder, httptest.NewRequest(http.MethodPost, "/api", strings.NewReader(string(missingBody))))
	if missingRecorder.Code != http.StatusNotFound {
		t.Fatalf("missing file unexpectedly accepted: %s", missingRecorder.Body.String())
	}

	days, err := activity.List("default", time.Now().UTC().Add(-24*time.Hour), time.Now().UTC().Add(24*time.Hour))
	if err != nil || len(days) != 1 || days[0].Count != 1 {
		t.Fatalf("accepted handshake count mismatch: days=%+v err=%v", days, err)
	}
}

func TestInvalidRunCodeDoesNotCountActivity(t *testing.T) {
	handler, _, _ := newRunLifecycleHTTPHandler(t)
	activity := storage.NewMemoryCompileActivityStore()
	handler.CompileActivity = activity

	body := strings.NewReader(`{"action":"runCode","runId":"invalid/run","folderName":"project","filePath":"main.go"}`)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api", body))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid run status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	days, err := activity.List("default", time.Now().Add(-24*time.Hour), time.Now().Add(24*time.Hour))
	if err != nil || len(days) != 0 {
		t.Fatalf("invalid run changed activity: days=%+v err=%v", days, err)
	}
}

func TestCancelledBeforeCreateDoesNotCountActivity(t *testing.T) {
	handler, _, _ := newRunLifecycleHTTPHandler(t)
	activity := storage.NewMemoryCompileActivityStore()
	handler.CompileActivity = activity

	_, cancellation := callCancelRun(t, handler, "cancelled-before-count")
	if !cancellation.Success {
		t.Fatalf("pre-cancel failed: %+v", cancellation)
	}
	recorder, creation := callRunCode(t, handler, "cancelled-before-count")
	if recorder.Code != http.StatusConflict || creation.Success {
		t.Fatalf("pre-cancelled run unexpectedly accepted: %s", recorder.Body.String())
	}
	days, err := activity.List("default", time.Now().Add(-24*time.Hour), time.Now().Add(24*time.Hour))
	if err != nil || len(days) != 0 {
		t.Fatalf("pre-cancelled run changed activity: days=%+v err=%v", days, err)
	}
}

func TestDeleteUserClearsCompileActivity(t *testing.T) {
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root", Username: "root", Role: auth.RoleRoot}
	target := &auth.User{ID: "target", Username: "target", Role: auth.RoleMember, Avatar: "ocean"}
	if err := users.Create(root); err != nil {
		t.Fatal(err)
	}
	if err := users.Create(target); err != nil {
		t.Fatal(err)
	}
	activity := storage.NewMemoryCompileActivityStore()
	if err := activity.Increment(target.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	handler := &HTTPHandler{UserStore: users, CompileActivity: activity, authEnabled: true}
	request := httptest.NewRequest(http.MethodPost, "/api", nil)
	ctx := context.WithValue(request.Context(), auth.ContextUser, root)
	request = request.WithContext(ctx)
	recorder := httptest.NewRecorder()
	handler.handleDeleteUser(recorder, request, &model.Request{UserID: target.ID})
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete failed: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := users.Get(target.ID); err == nil {
		t.Fatal("target user and persisted avatar survived deletion")
	}
	days, err := activity.List(target.ID, time.Now().Add(-24*time.Hour), time.Now().Add(24*time.Hour))
	if err != nil || len(days) != 0 {
		t.Fatalf("target activity survived deletion: days=%+v err=%v", days, err)
	}
}

func TestDeleteUserQueuesRetryWhenCompileActivityCleanupFails(t *testing.T) {
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root", Username: "root", Role: auth.RoleRoot}
	target := &auth.User{ID: "target-cleanup-failure", Username: "target", Role: auth.RoleMember}
	if err := users.Create(root); err != nil {
		t.Fatal(err)
	}
	if err := users.Create(target); err != nil {
		t.Fatal(err)
	}
	want := errors.New("activity cleanup failed")
	activity := storage.NewMemoryCompileActivityStore()
	if err := activity.Increment(target.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	handler := &HTTPHandler{
		UserStore:       users,
		CompileActivity: failingCompileActivityDeleteStore{CompileActivityStore: activity, err: want},
		authEnabled:     true,
	}
	request := httptest.NewRequest(http.MethodPost, "/api", nil)
	request = request.WithContext(context.WithValue(request.Context(), auth.ContextUser, root))
	recorder := httptest.NewRecorder()
	handler.handleDeleteUser(recorder, request, &model.Request{UserID: target.ID})

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := users.Get(target.ID); err == nil {
		t.Fatal("account survived its atomic deletion commit")
	}
	pending, err := users.ListDeletionCleanup()
	if err != nil || len(pending) != 1 || pending[0] != target.ID {
		t.Fatalf("failed cleanup marker = %v, err=%v", pending, err)
	}

	handler.CompileActivity = activity
	if err := handler.RetryPendingUserDeletionsContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	pending, err = users.ListDeletionCleanup()
	if err != nil || len(pending) != 0 {
		t.Fatalf("successful retry retained cleanup marker: %v, err=%v", pending, err)
	}
	days, err := activity.List(target.ID, time.Now().Add(-24*time.Hour), time.Now().Add(24*time.Hour))
	if err != nil || len(days) != 0 {
		t.Fatalf("successful retry retained compile activity: %v, err=%v", days, err)
	}
}

func TestDeleteUserStoreFailureHasNoDestructiveSideEffects(t *testing.T) {
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root-delete-failure", Username: "root", Role: auth.RoleRoot}
	target := &auth.User{ID: "target-delete-failure", Username: "target", Role: auth.RoleMember}
	for _, user := range []*auth.User{root, target} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	collabStore := collab.NewMemoryStore()
	team := &collab.Team{ID: "team-delete-failure", Name: "Delete failure", AdminUserID: root.ID, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := collabStore.SaveTeam(team); err != nil {
		t.Fatal(err)
	}
	if err := collabStore.SaveMember(&collab.Member{TeamID: team.ID, UserID: root.ID, JoinedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if err := collabStore.SaveMember(&collab.Member{TeamID: team.ID, UserID: target.ID, JoinedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	sessions := &recordingAuthSessionStore{AuthSessionStore: auth.NewMemoryAuthSessionStore()}
	history := &recordingRunHistoryStore{}
	resourceCleanupCalls := 0
	handler := &HTTPHandler{
		UserStore:     failingUserDeleteStore{UserStore: users, err: errors.New("user delete failed")},
		AuthSessions:  sessions,
		RunHistory:    history,
		Collaboration: collab.NewManager(collabStore, users, t.TempDir()),
		OnUserDeleted: func(string) error {
			resourceCleanupCalls++
			return nil
		},
		authEnabled: true,
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api", nil)
	request = request.WithContext(context.WithValue(request.Context(), auth.ContextUser, root))
	handler.handleDeleteUser(recorder, request, &model.Request{UserID: target.ID})

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := users.Get(target.ID); err != nil {
		t.Fatalf("user record changed on delete failure: %v", err)
	}
	if !handler.Collaboration.IsMember(target.ID, team.ID) {
		t.Fatal("team membership changed before the user delete commit point")
	}
	if sessions.deleteCount() != 0 || history.deleteCount() != 0 || resourceCleanupCalls != 0 {
		t.Fatalf("destructive cleanup ran before commit: sessions=%d history=%d resources=%d", sessions.deleteCount(), history.deleteCount(), resourceCleanupCalls)
	}
}

func TestDeleteUserSuccessRunsEveryCleanup(t *testing.T) {
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root-delete-success", Username: "root", Role: auth.RoleRoot}
	target := &auth.User{ID: "target-delete-success", Username: "target", Role: auth.RoleMember}
	for _, user := range []*auth.User{root, target} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	collabStore := collab.NewMemoryStore()
	team := &collab.Team{ID: "team-delete-success", Name: "Delete success", AdminUserID: root.ID, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	for _, save := range []func() error{
		func() error { return collabStore.SaveTeam(team) },
		func() error {
			return collabStore.SaveMember(&collab.Member{TeamID: team.ID, UserID: root.ID, JoinedAt: time.Now()})
		},
		func() error {
			return collabStore.SaveMember(&collab.Member{TeamID: team.ID, UserID: target.ID, JoinedAt: time.Now()})
		},
	} {
		if err := save(); err != nil {
			t.Fatal(err)
		}
	}
	activity := storage.NewMemoryCompileActivityStore()
	if err := activity.Increment(target.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	sessions := &recordingAuthSessionStore{AuthSessionStore: auth.NewMemoryAuthSessionStore()}
	history := &recordingRunHistoryStore{}
	resourceCleanupCalls := 0
	handler := &HTTPHandler{
		UserStore:       users,
		AuthSessions:    sessions,
		RunHistory:      history,
		CompileActivity: activity,
		Collaboration:   collab.NewManager(collabStore, users, t.TempDir()),
		OnUserDeleted: func(userID string) error {
			resourceCleanupCalls++
			if userID != target.ID {
				t.Fatalf("resource cleanup user=%q", userID)
			}
			return nil
		},
		authEnabled: true,
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api", nil)
	request = request.WithContext(context.WithValue(request.Context(), auth.ContextUser, root))
	handler.handleDeleteUser(recorder, request, &model.Request{UserID: target.ID})

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := users.Get(target.ID); err == nil {
		t.Fatal("user survived successful deletion")
	}
	if handler.Collaboration.IsMember(target.ID, team.ID) {
		t.Fatal("team membership survived successful deletion")
	}
	if sessions.deleteCount() != 1 || history.deleteCount() != 1 || resourceCleanupCalls != 1 {
		t.Fatalf("cleanup counts: sessions=%d history=%d resources=%d", sessions.deleteCount(), history.deleteCount(), resourceCleanupCalls)
	}
	days, err := activity.List(target.ID, time.Now().Add(-24*time.Hour), time.Now().Add(24*time.Hour))
	if err != nil || len(days) != 0 {
		t.Fatalf("compile activity survived deletion: days=%+v err=%v", days, err)
	}
}

func TestDeleteUserPostCommitCleanupFailureStillReportsDeleted(t *testing.T) {
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root-cleanup-pending", Username: "root", Role: auth.RoleRoot}
	target := &auth.User{ID: "target-cleanup-pending", Username: "target", Role: auth.RoleMember}
	for _, user := range []*auth.User{root, target} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	sessions := &recordingAuthSessionStore{AuthSessionStore: auth.NewMemoryAuthSessionStore(), err: errors.New("session cleanup failed"), failures: 1}
	history := &recordingRunHistoryStore{err: errors.New("history cleanup failed"), failures: 1}
	resourceCleanupCalls := 0
	resourceCleanupFailures := 1
	handler := &HTTPHandler{
		UserStore:    users,
		AuthSessions: sessions,
		RunHistory:   history,
		OnUserDeleted: func(string) error {
			resourceCleanupCalls++
			if resourceCleanupFailures > 0 {
				resourceCleanupFailures--
				return errors.New("resource cleanup failed")
			}
			return nil
		},
		authEnabled: true,
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api", nil)
	request = request.WithContext(context.WithValue(request.Context(), auth.ContextUser, root))
	handler.handleDeleteUser(recorder, request, &model.Request{UserID: target.ID})

	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "cleanup is pending") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := users.Get(target.ID); err == nil {
		t.Fatal("post-commit cleanup failure restored a deleted account")
	}
	if sessions.deleteCount() != 1 || history.deleteCount() != 1 || resourceCleanupCalls != 1 {
		t.Fatalf("cleanup did not continue after a component failed: sessions=%d history=%d resources=%d", sessions.deleteCount(), history.deleteCount(), resourceCleanupCalls)
	}

	retryRecorder := httptest.NewRecorder()
	retryRequest := httptest.NewRequest(http.MethodPost, "/api", nil)
	retryRequest = retryRequest.WithContext(context.WithValue(retryRequest.Context(), auth.ContextUser, root))
	handler.handleDeleteUser(retryRecorder, retryRequest, &model.Request{UserID: target.ID})
	if retryRecorder.Code != http.StatusOK || !strings.Contains(retryRecorder.Body.String(), "cleanup completed") {
		t.Fatalf("retry status=%d body=%s", retryRecorder.Code, retryRecorder.Body.String())
	}
	if sessions.deleteCount() != 2 || history.deleteCount() != 2 || resourceCleanupCalls != 2 {
		t.Fatalf("retry cleanup counts: sessions=%d history=%d resources=%d", sessions.deleteCount(), history.deleteCount(), resourceCleanupCalls)
	}
}

func TestRetryPendingUserDeletionsCompletesPersistedJobAfterRestart(t *testing.T) {
	users := auth.NewMemoryUserStore()
	if err := users.SaveDeletionCleanup("restart-cleanup-user"); err != nil {
		t.Fatal(err)
	}
	sessions := &recordingAuthSessionStore{AuthSessionStore: auth.NewMemoryAuthSessionStore()}
	history := &recordingRunHistoryStore{}
	activity := storage.NewMemoryCompileActivityStore()
	if err := activity.Increment("restart-cleanup-user", time.Now()); err != nil {
		t.Fatal(err)
	}
	resourceCleanupCalls := 0
	restarted := &HTTPHandler{
		UserStore:       users,
		AuthSessions:    sessions,
		RunHistory:      history,
		CompileActivity: activity,
		OnUserDeleted: func(userID string) error {
			resourceCleanupCalls++
			if userID != "restart-cleanup-user" {
				t.Fatalf("cleanup user=%q", userID)
			}
			return nil
		},
	}
	restarted.RetryPendingUserDeletions()
	pending, err := users.ListDeletionCleanup()
	if err != nil || len(pending) != 0 {
		t.Fatalf("persisted cleanup marker survived successful startup retry: %v, err=%v", pending, err)
	}
	if sessions.deleteCount() != 1 || history.deleteCount() != 1 || resourceCleanupCalls != 1 {
		t.Fatalf("startup cleanup counts: sessions=%d history=%d resources=%d", sessions.deleteCount(), history.deleteCount(), resourceCleanupCalls)
	}
	days, err := activity.List("restart-cleanup-user", time.Now().Add(-24*time.Hour), time.Now().Add(24*time.Hour))
	if err != nil || len(days) != 0 {
		t.Fatalf("startup retry retained compile activity: days=%v err=%v", days, err)
	}
}

func TestRetryPendingUserDeletionsKeepsMarkerUntilCleanupSucceeds(t *testing.T) {
	users := auth.NewMemoryUserStore()
	if err := users.SaveDeletionCleanup("retry-cleanup-user"); err != nil {
		t.Fatal(err)
	}
	history := &recordingRunHistoryStore{err: errors.New("temporary cleanup failure"), failures: 1}
	handler := &HTTPHandler{UserStore: users, RunHistory: history}
	handler.RetryPendingUserDeletions()
	pending, err := users.ListDeletionCleanup()
	if err != nil || len(pending) != 1 || pending[0] != "retry-cleanup-user" {
		t.Fatalf("failed startup retry cleared marker: %v, err=%v", pending, err)
	}
	handler.RetryPendingUserDeletions()
	pending, err = users.ListDeletionCleanup()
	if err != nil || len(pending) != 0 {
		t.Fatalf("successful retry retained marker: %v, err=%v", pending, err)
	}
}

func TestPendingUserDeletionCleanupLoopCompletesDeferredJob(t *testing.T) {
	users := auth.NewMemoryUserStore()
	const userID = "background-cleanup-user"
	if err := users.SaveDeletionCleanup(userID); err != nil {
		t.Fatal(err)
	}
	attempts := 0
	handler := &HTTPHandler{
		UserStore: users,
		OnUserDeleted: func(string) error {
			attempts++
			if attempts == 1 {
				return errors.New("resources are still draining")
			}
			return nil
		},
	}
	handler.RetryPendingUserDeletions()
	pending, err := users.ListDeletionCleanup()
	if err != nil || len(pending) != 1 {
		t.Fatalf("initial deferred cleanup marker = %v, err=%v", pending, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		handler.RunPendingUserDeletionCleanup(ctx, time.Millisecond)
		close(done)
	}()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		pending, err = users.ListDeletionCleanup()
		if err == nil && len(pending) == 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if err != nil || len(pending) != 0 {
		cancel()
		t.Fatalf("background cleanup retained marker: pending=%v err=%v", pending, err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("background cleanup loop ignored cancellation")
	}
	if attempts < 2 {
		t.Fatalf("cleanup attempts = %d, want at least 2", attempts)
	}
}

func TestRetryPendingUserDeletionsContextKeepsMarkerWhenInterrupted(t *testing.T) {
	users := auth.NewMemoryUserStore()
	const userID = "cancelled-cleanup-user"
	if err := users.SaveDeletionCleanup(userID); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	handler := &HTTPHandler{
		UserStore: users,
		OnUserDeletedContext: func(ctx context.Context, gotUserID string) error {
			if gotUserID != userID {
				t.Fatalf("cleanup user = %q, want %q", gotUserID, userID)
			}
			close(started)
			<-ctx.Done()
			return ctx.Err()
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- handler.RetryPendingUserDeletionsContext(ctx) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("pending cleanup did not reach the context-aware resource hook")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("RetryPendingUserDeletionsContext() error = %v, want cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("pending cleanup ignored cancellation")
	}
	pending, err := users.ListDeletionCleanup()
	if err != nil || len(pending) != 1 || pending[0] != userID {
		t.Fatalf("interrupted cleanup cleared its durable marker: pending=%v err=%v", pending, err)
	}

	handler.OnUserDeletedContext = func(context.Context, string) error { return nil }
	if err := handler.RetryPendingUserDeletionsContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	pending, err = users.ListDeletionCleanup()
	if err != nil || len(pending) != 0 {
		t.Fatalf("successful retry retained cleanup marker: pending=%v err=%v", pending, err)
	}
}

func TestDeleteUserRetainsMarkerUntilDAPDownloadCacheCleanupSucceeds(t *testing.T) {
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root-dap-cleanup", Username: "root", Role: auth.RoleRoot}
	target := &auth.User{ID: "target-dap-cleanup", Username: "target", Role: auth.RoleMember}
	for _, user := range []*auth.User{root, target} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	dataDir := t.TempDir()
	cacheFile := filepath.Join(dataDir, "dap-cache", "downloads", target.ID, "runtime", "adapter.zip")
	if err := os.MkdirAll(filepath.Dir(cacheFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cacheFile, []byte("adapter"), 0o600); err != nil {
		t.Fatal(err)
	}
	attempts := 0
	handler := &HTTPHandler{
		UserStore: users,
		OnUserDeletedContext: func(ctx context.Context, userID string) error {
			attempts++
			if attempts == 1 {
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				return dap.CleanupUserDownloadCacheContext(cancelled, dataDir, userID)
			}
			return dap.CleanupUserDownloadCacheContext(ctx, dataDir, userID)
		},
		authEnabled: true,
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api", nil)
	request = request.WithContext(context.WithValue(request.Context(), auth.ContextUser, root))
	handler.handleDeleteUser(recorder, request, &model.Request{UserID: target.ID})

	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "cleanup is pending") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := users.Get(target.ID); err == nil {
		t.Fatal("account survived its deletion commit")
	}
	if _, err := os.Stat(cacheFile); err != nil {
		t.Fatalf("failed DAP cleanup removed cache: %v", err)
	}
	pending, err := users.ListDeletionCleanup()
	if err != nil || len(pending) != 1 || pending[0] != target.ID {
		t.Fatalf("failed cleanup marker = %v, err=%v", pending, err)
	}

	if err := handler.RetryPendingUserDeletionsContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "dap-cache", "downloads", target.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("successful retry retained DAP cache: %v", err)
	}
	pending, err = users.ListDeletionCleanup()
	if err != nil || len(pending) != 0 {
		t.Fatalf("successful retry retained cleanup marker: pending=%v err=%v", pending, err)
	}
	if attempts != 2 {
		t.Fatalf("cleanup attempts = %d, want 2", attempts)
	}
}

type failingDeletionCleanupListStore struct {
	auth.UserStore
	err error
}

func (store *failingDeletionCleanupListStore) ListDeletionCleanup() ([]string, error) {
	return nil, store.err
}

func TestRetryPendingUserDeletionsContextFailsClosedWhenQueueCannotBeRead(t *testing.T) {
	listErr := errors.New("deletion queue unavailable")
	handler := &HTTPHandler{UserStore: &failingDeletionCleanupListStore{
		UserStore: auth.NewMemoryUserStore(),
		err:       listErr,
	}}
	err := handler.RetryPendingUserDeletionsContext(context.Background())
	if !errors.Is(err, listErr) {
		t.Fatalf("RetryPendingUserDeletionsContext() error = %v, want queue failure", err)
	}
}

type observingExistingUserMutationStore struct {
	auth.UserStore
	mu                    sync.Mutex
	mutationCount         int
	secondMutationEntered chan struct{}
}

func (store *observingExistingUserMutationStore) MutateExisting(id string, mutate func(*auth.User) error) (*auth.User, error) {
	store.mu.Lock()
	store.mutationCount++
	if store.mutationCount == 2 {
		close(store.secondMutationEntered)
	}
	store.mu.Unlock()
	return store.UserStore.MutateExisting(id, mutate)
}

func TestQuotaUpdateAndDeleteShareSerializationBarrier(t *testing.T) {
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root-stale-quota", Username: "root", Role: auth.RoleRoot}
	target := &auth.User{ID: "target-stale-quota", Username: "target", Role: auth.RoleMember, ContainerLimit: 1}
	for _, user := range []*auth.User{root, target} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	limitStarted := make(chan struct{})
	releaseLimit := make(chan struct{})
	setLimitCalls := 0
	handler := &HTTPHandler{
		UserStore:   users,
		authEnabled: true,
		SetUserLimit: func(string, int) {
			setLimitCalls++
			close(limitStarted)
			<-releaseLimit
		},
	}
	rootRequest := func() *http.Request {
		request := httptest.NewRequest(http.MethodPost, "/api", nil)
		return request.WithContext(context.WithValue(request.Context(), auth.ContextUser, root))
	}

	quotaRecorder := httptest.NewRecorder()
	quotaDone := make(chan struct{})
	go func() {
		handler.handleUpdateUserQuota(quotaRecorder, rootRequest(), &model.Request{UserID: target.ID, ContainerLimit: 8})
		close(quotaDone)
	}()
	select {
	case <-limitStarted:
	case <-time.After(time.Second):
		t.Fatal("quota update did not reach Docker admission")
	}

	deleteRecorder := httptest.NewRecorder()
	deleteDone := make(chan struct{})
	go func() {
		handler.handleDeleteUser(deleteRecorder, rootRequest(), &model.Request{UserID: target.ID})
		close(deleteDone)
	}()
	deletedBeforeQuotaSideEffect := false
	select {
	case <-deleteDone:
		deletedBeforeQuotaSideEffect = true
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseLimit)
	select {
	case <-quotaDone:
	case <-time.After(time.Second):
		t.Fatal("quota update did not finish")
	}
	select {
	case <-deleteDone:
	case <-time.After(time.Second):
		t.Fatal("delete did not finish after quota side effect")
	}
	if deletedBeforeQuotaSideEffect {
		t.Fatal("delete completed while quota mutation and Docker side effect were still in progress")
	}
	if quotaRecorder.Code != http.StatusOK {
		t.Fatalf("quota status=%d body=%s", quotaRecorder.Code, quotaRecorder.Body.String())
	}
	if deleteRecorder.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", deleteRecorder.Code, deleteRecorder.Body.String())
	}
	if _, err := users.Get(target.ID); err == nil {
		t.Fatal("serialized quota request left the deleted account behind")
	}
	if setLimitCalls != 1 {
		t.Fatalf("quota request changed Docker admission %d time(s)", setLimitCalls)
	}
}

func TestConcurrentQuotaUpdatesKeepDockerLimitInSyncWithStoredUser(t *testing.T) {
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root-concurrent-quota", Username: "root", Role: auth.RoleRoot}
	target := &auth.User{ID: "target-concurrent-quota", Username: "target", Role: auth.RoleMember, ContainerLimit: 1}
	for _, user := range []*auth.User{root, target} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	observed := &observingExistingUserMutationStore{
		UserStore:             users,
		secondMutationEntered: make(chan struct{}),
	}
	firstLimitStarted := make(chan struct{})
	releaseFirstLimit := make(chan struct{})
	var runtimeLimitMu sync.Mutex
	runtimeLimit := target.ContainerLimit
	handler := &HTTPHandler{
		UserStore:   observed,
		authEnabled: true,
		SetUserLimit: func(_ string, limit int) {
			if limit == 8 {
				close(firstLimitStarted)
				<-releaseFirstLimit
			}
			runtimeLimitMu.Lock()
			runtimeLimit = limit
			runtimeLimitMu.Unlock()
		},
	}
	rootRequest := func() *http.Request {
		request := httptest.NewRequest(http.MethodPost, "/api", nil)
		return request.WithContext(context.WithValue(request.Context(), auth.ContextUser, root))
	}

	firstRecorder := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() {
		handler.handleUpdateUserQuota(firstRecorder, rootRequest(), &model.Request{UserID: target.ID, ContainerLimit: 8})
		close(firstDone)
	}()
	select {
	case <-firstLimitStarted:
	case <-time.After(time.Second):
		t.Fatal("first quota update did not reach Docker admission")
	}

	secondRecorder := httptest.NewRecorder()
	secondDone := make(chan struct{})
	go func() {
		handler.handleUpdateUserQuota(secondRecorder, rootRequest(), &model.Request{UserID: target.ID, ContainerLimit: 11})
		close(secondDone)
	}()
	secondEnteredBeforeFirstFinished := false
	select {
	case <-observed.secondMutationEntered:
		secondEnteredBeforeFirstFinished = true
		select {
		case <-secondDone:
		case <-time.After(time.Second):
			t.Fatal("second quota update entered but did not finish")
		}
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseFirstLimit)
	for label, done := range map[string]<-chan struct{}{"first": firstDone, "second": secondDone} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatalf("%s quota update did not finish", label)
		}
	}
	if secondEnteredBeforeFirstFinished {
		t.Fatal("newer quota mutation entered before the older Docker side effect completed")
	}
	if firstRecorder.Code != http.StatusOK || secondRecorder.Code != http.StatusOK {
		t.Fatalf("quota statuses: first=%d body=%s second=%d body=%s", firstRecorder.Code, firstRecorder.Body.String(), secondRecorder.Code, secondRecorder.Body.String())
	}
	stored, err := users.Get(target.ID)
	if err != nil {
		t.Fatal(err)
	}
	runtimeLimitMu.Lock()
	gotRuntimeLimit := runtimeLimit
	runtimeLimitMu.Unlock()
	if stored.ContainerLimit != 11 || gotRuntimeLimit != stored.ContainerLimit {
		t.Fatalf("quota drift: stored=%d runtime=%d", stored.ContainerLimit, gotRuntimeLimit)
	}
}

func TestDeleteUserRequestCancellationKeepsCleanupMarker(t *testing.T) {
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root-cancelled-delete", Username: "root", Role: auth.RoleRoot}
	target := &auth.User{ID: "target-cancelled-delete", Username: "target", Role: auth.RoleMember}
	for _, user := range []*auth.User{root, target} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	resourceCleanupCalled := false
	handler := &HTTPHandler{
		UserStore:   users,
		authEnabled: true,
		OnUserDeletedContext: func(context.Context, string) error {
			resourceCleanupCalled = true
			return nil
		},
	}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), auth.ContextUser, root))
	cancel()
	request := httptest.NewRequest(http.MethodPost, "/api", nil).WithContext(ctx)
	recorder := httptest.NewRecorder()
	handler.handleDeleteUser(recorder, request, &model.Request{UserID: target.ID})

	if recorder.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := users.Get(target.ID); err == nil {
		t.Fatal("cancelled post-commit cleanup restored a deleted account")
	}
	pending, err := users.ListDeletionCleanup()
	if err != nil || len(pending) != 1 || pending[0] != target.ID {
		t.Fatalf("cancelled cleanup marker = %v, err=%v", pending, err)
	}
	if resourceCleanupCalled {
		t.Fatal("resource cleanup ran after the request context was cancelled")
	}
}

func newAuthenticatedLifecycleHandler(t *testing.T) (*HTTPHandler, *auth.MemoryUserStore, *auth.User) {
	t.Helper()
	users := auth.NewMemoryUserStore()
	user := &auth.User{ID: "lifecycle-user", UID: "u_lifecycle", Username: "lifecycle", APIKey: "lifecycle-key", Role: auth.RoleMember}
	if err := users.Create(user); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	handler := NewHTTPHandler(cfg, storage.NewMemorySessionStore(), session.NewChannelManager(), true, auth.NewAPIKeyAuth(users), users, nil, nil, nil)
	handler.Lifecycle = lifecycle.NewManager()
	return handler, users, user
}

func serveAuthenticatedAction(t *testing.T, handler http.Handler, apiKey, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+apiKey)
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestServeHTTPRejectsAccountDeletedBetweenAuthenticationAndRequestLease(t *testing.T) {
	handler, users, user := newAuthenticatedLifecycleHandler(t)
	raceStore := &deleteAfterAuthenticationStore{UserStore: users, targetID: user.ID}
	handler.authenticator = auth.NewAPIKeyAuth(raceStore)
	handler.UserStore = raceStore
	handler.Collaboration = collab.NewManager(collab.NewMemoryStore(), raceStore, t.TempDir())
	recorder := serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"createTeam","name":"Too late"}`)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("stale authenticated request status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	teams, err := handler.Collaboration.ListTeams(user.ID)
	if err == nil && len(teams) != 0 {
		t.Fatalf("stale authenticated request created teams: %+v", teams)
	}
}

func TestServeHTTPDeletionBarrierRejectsTeamWritesAndReleasesCleanly(t *testing.T) {
	for _, action := range []string{
		`{"action":"createTeam","name":"Blocked team"}`,
		`{"action":"joinTeam","inviteCode":"INVITE"}`,
	} {
		t.Run(action, func(t *testing.T) {
			handler, _, user := newAuthenticatedLifecycleHandler(t)
			handler.Collaboration = collab.NewManager(collab.NewMemoryStore(), handler.UserStore, t.TempDir())
			deletion, err := handler.Lifecycle.BeginUserDeletion(user.ID)
			if err != nil {
				t.Fatal(err)
			}
			recorder := serveAuthenticatedAction(t, handler, user.APIKey, action)
			if recorder.Code != http.StatusConflict {
				t.Fatalf("team write during deletion status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			deletion.Release()
			recorder = serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"createTeam","name":"Allowed team"}`)
			if recorder.Code != http.StatusOK {
				t.Fatalf("request remained blocked after deletion lease: status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestServeHTTPResourceMutationsDoNotSelfConflictWithRequestLease(t *testing.T) {
	t.Run("delete project", func(t *testing.T) {
		handler, _, user := newAuthenticatedLifecycleHandler(t)
		project := filepath.Join(handler.Config.DataDir, "users", user.ID, "workspaces", "project")
		if err := os.MkdirAll(project, 0o755); err != nil {
			t.Fatal(err)
		}
		recorder := serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"deleteProject","folderKey":"project"}`)
		if recorder.Code != http.StatusOK {
			t.Fatalf("deleteProject self-conflicted: status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		if _, err := os.Stat(project); !os.IsNotExist(err) {
			t.Fatalf("project still exists: %v", err)
		}
	})

	t.Run("clear cache scope", func(t *testing.T) {
		handler, _, user := newAuthenticatedLifecycleHandler(t)
		handler.PersonalCache = personalcache.NewManager(handler.Config.DataDir, personalcache.Options{})
		inventory := personalCacheV2Inventory(t, handler, user.APIKey)
		payload, _ := json.Marshal(map[string]any{"action": "clearCacheScope", "scope": "owner", "expectedRevision": inventory.Revision})
		recorder := serveAuthenticatedAction(t, handler, user.APIKey, string(payload))
		if recorder.Code != http.StatusOK {
			t.Fatalf("clearCacheScope self-conflicted: status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
}
