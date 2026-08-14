package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bobocloud-server/internal/collab"
	"bobocloud-server/internal/model"
)

func TestCollabErrorWritesStableOperationContract(t *testing.T) {
	recorder := httptest.NewRecorder()
	err := &collab.OperationError{
		Code:    collab.ErrorCodePushConflict,
		Message: "The commit remains pending.",
		Details: collab.ErrorDetails{
			Retryable:       true,
			SuggestedAction: collab.SuggestedActionRetryCommit,
			PendingCommit:   "abc123",
		},
	}
	collabError(recorder, err)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusConflict)
	}
	var response model.Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Error != "The commit remains pending." || response.ErrorCode != collab.ErrorCodePushConflict {
		t.Fatalf("response = %+v", response)
	}
	details, ok := response.Details.(map[string]any)
	if !ok || details["retryable"] != true || details["suggestedAction"] != collab.SuggestedActionRetryCommit || details["pendingCommit"] != "abc123" {
		t.Fatalf("details = %#v", response.Details)
	}
}

func TestCollabErrorDoesNotExposeWrappedGitDiagnostic(t *testing.T) {
	recorder := httptest.NewRecorder()
	cause := errors.New("git push: fatal: private transport details")
	err := &collab.OperationError{
		Code:    collab.ErrorCodePushFailed,
		Message: "The commit could not be published. Retry the commit action.",
		Details: collab.ErrorDetails{Retryable: true, SuggestedAction: collab.SuggestedActionRetryCommit, PendingCommit: "def456"},
	}
	wrapped := errors.Join(err, cause)
	collabError(recorder, wrapped)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
	if strings.Contains(recorder.Body.String(), "private transport details") || strings.Contains(recorder.Body.String(), "git push") {
		t.Fatalf("response exposed Git diagnostic: %s", recorder.Body.String())
	}
}

func TestCollabErrorMapsLockStaleDetails(t *testing.T) {
	recorder := httptest.NewRecorder()
	err := &collab.OperationError{
		Code:    collab.ErrorCodeLockStale,
		Message: "This file lock has been replaced.",
		Details: collab.ErrorDetails{
			Retryable:       true,
			SuggestedAction: collab.SuggestedActionRefreshLock,
			Lock:            &collab.FileLock{Path: "src/main.go", LeaseID: "lock-current"},
		},
	}
	collabError(recorder, err)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusConflict)
	}
	var wire map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &wire); err != nil {
		t.Fatal(err)
	}
	details := wire["details"].(map[string]any)
	lock := details["lock"].(map[string]any)
	if wire["errorCode"] != collab.ErrorCodeLockStale || lock["lease_id"] != "lock-current" {
		t.Fatalf("wire response = %#v", wire)
	}
}

func TestDeleteTeamInviteRoutesThroughServeHTTP(t *testing.T) {
	store := collab.NewMemoryStore()
	manager := collab.NewManager(store, nil, t.TempDir())
	team, err := manager.CreateTeam("default", "Route test", "", 1024)
	if err != nil {
		t.Fatal(err)
	}
	invite, err := manager.CreateInvite("default", team.ID, 1, 1)
	if err != nil {
		t.Fatal(err)
	}

	body, err := json.Marshal(model.Request{Action: "deleteTeamInvite", TeamID: team.ID, InviteCode: invite.Code})
	if err != nil {
		t.Fatal(err)
	}
	handler := &HTTPHandler{Collaboration: manager}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api", strings.NewReader(string(body))))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := store.GetInvite(invite.Code); err == nil {
		t.Fatal("invite still exists after routed deleteTeamInvite request")
	}
}
