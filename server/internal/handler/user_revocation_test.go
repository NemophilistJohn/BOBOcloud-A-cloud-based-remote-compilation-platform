package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/lifecycle"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/rootbootstrap"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
)

type accountRevocationFixture struct {
	handler      *HTTPHandler
	users        *auth.MemoryUserStore
	root         *auth.User
	target       *auth.User
	operationCtx context.Context
	runID        string
}

func newAccountRevocationFixture(t *testing.T) *accountRevocationFixture {
	t.Helper()
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root", Username: "root", Role: auth.RoleRoot}
	passwordHash, err := auth.HashPassword("old-password")
	if err != nil {
		t.Fatal(err)
	}
	target := &auth.User{ID: "target", Username: "target", Role: auth.RoleMember, PasswordHash: passwordHash}
	for _, user := range []*auth.User{root, target} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	lifecycles := lifecycle.NewManager()
	operationCtx, operation, err := lifecycles.BindOperation(context.Background(), target.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(operation.Release)
	store := storage.NewMemorySessionStore()
	channels := session.NewChannelManager()
	runID := "pending-security-mutation"
	if _, err := store.Create(&model.RunSession{RunID: runID, UserID: target.ID}); err != nil {
		t.Fatal(err)
	}
	channels.GetOrCreate(runID, true)
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	return &accountRevocationFixture{
		handler: &HTTPHandler{
			Config: cfg, UserStore: users, Lifecycle: lifecycles,
			Sessions: store, Channels: channels, authEnabled: true,
		},
		users: users, root: root, target: target, operationCtx: operationCtx, runID: runID,
	}
}

func accountRequest(user *auth.User) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	return request.WithContext(context.WithValue(request.Context(), auth.ContextUser, user))
}

func assertAccountWorkRevoked(t *testing.T, fixture *accountRevocationFixture, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if !errors.Is(context.Cause(fixture.operationCtx), lifecycle.ErrUserRevoked) {
		t.Fatalf("operation context cause = %v", context.Cause(fixture.operationCtx))
	}
	if _, exists, err := fixture.handler.Sessions.Lookup(fixture.runID); err != nil || exists {
		t.Fatalf("pending run after account mutation: exists=%v err=%v", exists, err)
	}
}

func TestDisablingUserCancelsBoundWorkAndPendingRuns(t *testing.T) {
	users := auth.NewMemoryUserStore()
	root := &auth.User{ID: "root", Username: "root", Role: auth.RoleRoot}
	target := &auth.User{ID: "target", Username: "target", Role: auth.RoleMember}
	for _, user := range []*auth.User{root, target} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	lifecycles := lifecycle.NewManager()
	operationCtx, operation, err := lifecycles.BindOperation(context.Background(), target.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer operation.Release()
	store := storage.NewMemorySessionStore()
	channels := session.NewChannelManager()
	if _, err := store.Create(&model.RunSession{RunID: "pending", UserID: target.ID}); err != nil {
		t.Fatal(err)
	}
	channels.GetOrCreate("pending", true)
	handler := &HTTPHandler{UserStore: users, Lifecycle: lifecycles, Sessions: store, Channels: channels, authEnabled: true}
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	request = request.WithContext(context.WithValue(request.Context(), auth.ContextUser, root))
	disabled := true
	recorder := httptest.NewRecorder()
	handler.handleSetUserDisabled(recorder, request, &model.Request{UserID: target.ID, Disabled: &disabled})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if !errors.Is(context.Cause(operationCtx), lifecycle.ErrUserRevoked) {
		t.Fatalf("operation context cause = %v", context.Cause(operationCtx))
	}
	if _, exists, err := store.Lookup("pending"); err != nil || exists {
		t.Fatalf("pending run after disable: exists=%v err=%v", exists, err)
	}
}

func TestChangePasswordRevokesBoundWorkAndPendingRuns(t *testing.T) {
	fixture := newAccountRevocationFixture(t)
	recorder := httptest.NewRecorder()
	fixture.handler.handleChangePassword(recorder, accountRequest(fixture.target), &model.Request{
		OldPassword: "old-password", NewPassword: "changed-password",
	})
	assertAccountWorkRevoked(t, fixture, recorder)
	updated, err := fixture.users.Get(fixture.target.ID)
	if err != nil || !auth.CheckPassword(updated.PasswordHash, "changed-password") {
		t.Fatalf("changed password was not committed: user=%v err=%v", updated, err)
	}
}

func TestResetPasswordRevokesBoundWorkAndPendingRuns(t *testing.T) {
	fixture := newAccountRevocationFixture(t)
	recorder := httptest.NewRecorder()
	fixture.handler.handleResetUserPassword(recorder, accountRequest(fixture.root), &model.Request{
		UserID: fixture.target.ID, NewPassword: "reset-password",
	})
	assertAccountWorkRevoked(t, fixture, recorder)
	updated, err := fixture.users.Get(fixture.target.ID)
	if err != nil || !auth.CheckPassword(updated.PasswordHash, "reset-password") {
		t.Fatalf("reset password was not committed: user=%v err=%v", updated, err)
	}
}

func TestDeleteUserRevokesBoundWorkAndPendingRuns(t *testing.T) {
	fixture := newAccountRevocationFixture(t)
	recorder := httptest.NewRecorder()
	fixture.handler.handleDeleteUser(recorder, accountRequest(fixture.root), &model.Request{UserID: fixture.target.ID})
	assertAccountWorkRevoked(t, fixture, recorder)
	if _, err := fixture.users.Get(fixture.target.ID); err == nil {
		t.Fatal("deleted user record survived")
	}
}

func TestRootPasswordChangeRemovesOneTimeBootstrapCredential(t *testing.T) {
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	cfg.RootUser.Username = "root"
	cfg.RootUser.Password = ""
	users := auth.NewMemoryUserStore()
	root, err := rootbootstrap.Ensure(cfg, users)
	if err != nil || root == nil {
		t.Fatalf("root bootstrap: root=%v err=%v", root, err)
	}
	credentialPath := rootbootstrap.CredentialPath(cfg.DataDir)
	data, err := os.ReadFile(credentialPath)
	if err != nil {
		t.Fatal(err)
	}
	var credential struct {
		Password string `json:"password"`
	}
	if err := json.Unmarshal(data, &credential); err != nil || credential.Password == "" {
		t.Fatalf("decode bootstrap credential: password_set=%v err=%v", credential.Password != "", err)
	}
	handler := &HTTPHandler{Config: cfg, UserStore: users, authEnabled: true}
	recorder := httptest.NewRecorder()
	handler.handleChangePassword(recorder, accountRequest(root), &model.Request{
		OldPassword: credential.Password, NewPassword: "changed-root-password",
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := os.Stat(credentialPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("one-time root credential file survived password change: %v", err)
	}
	updated, err := users.Get(root.ID)
	if err != nil || !auth.CheckPassword(updated.PasswordHash, "changed-root-password") {
		t.Fatalf("root password was not committed: user=%v err=%v", updated, err)
	}
}

func TestSanitizedUserNeverIncludesLongLivedAPIKey(t *testing.T) {
	user := &auth.User{ID: "user", Username: "user", APIKey: "bobo-secret"}
	if got := sanitizeUser(user); got.APIKey != "" {
		t.Fatalf("sanitized user exposed API key %q", got.APIKey)
	}
}
