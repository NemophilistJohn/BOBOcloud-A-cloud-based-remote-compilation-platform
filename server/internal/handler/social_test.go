package handler

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/collab"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/lifecycle"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/snapshot"
	"bobocloud-server/internal/social"

	bolt "go.etcd.io/bbolt"
)

func newSocialHandler(t *testing.T) (*HTTPHandler, map[string]*auth.User) {
	t.Helper()
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	cfg.ServerRoot = filepath.Join(cfg.DataDir, "workspaces")
	users := auth.NewMemoryUserStore()
	identities := make(map[string]*auth.User)
	for _, id := range []string{"alice", "bob", "carol"} {
		user := &auth.User{ID: id, UID: "u_" + id, Username: "private-" + id, Name: id,
			Avatar: "ocean", Email: id + "@private.invalid", APIKey: "private-key-" + id}
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
		identities[id] = user
	}
	db, err := bolt.Open(filepath.Join(cfg.DataDir, "social.db"), 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	inbox, err := social.NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	snapshots, err := snapshot.New(filepath.Join(cfg.DataDir, "snapshots"), 8<<20, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHTTPHandler(cfg, nil, nil, true, auth.NewAPIKeyAuth(users), users, nil, nil, nil)
	h.Social, h.ProjectSnapshots, h.Lifecycle = inbox, snapshots, lifecycle.NewManager()
	h.Collaboration = collab.NewManager(collab.NewMemoryStore(), users, filepath.Join(cfg.DataDir, "teams"))
	return h, identities
}

func socialRequest(t *testing.T, h *HTTPHandler, user *auth.User, request model.Request) (*httptest.ResponseRecorder, model.Response) {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	if user != nil {
		r.Header.Set("Authorization", "Bearer "+user.APIKey)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var response model.Response
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode %s response: %s, %v", request.Action, w.Body.String(), err)
	}
	return w, response
}

func sendSocial(t *testing.T, h *HTTPHandler, sender *auth.User, request model.Request) social.Message {
	t.Helper()
	request.Action = "sendInbox"
	w, result := socialRequest(t, h, sender, request)
	if w.Code != http.StatusOK || !result.Success {
		t.Fatalf("send failed: %d %s", w.Code, w.Body.String())
	}
	value, _ := json.Marshal(result.Data)
	var message social.Message
	if err := json.Unmarshal(value, &message); err != nil {
		t.Fatal(err)
	}
	return message
}

func sourceProject(t *testing.T, h *HTTPHandler, owner, key, contents string) string {
	t.Helper()
	root, err := h.ensureUserDir(owner)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "workspaces", key)
	if err := os.MkdirAll(source, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "main.py"), []byte(contents), 0644); err != nil {
		t.Fatal(err)
	}
	if err := h.writeWorkspaceDisplayName(owner, key, "Shared project"); err != nil {
		t.Fatal(err)
	}
	return source
}

func TestSocialDirectoryOnlyExposesPublicProfilesAndRecordedSync(t *testing.T) {
	h, users := newSocialHandler(t)
	if _, response := socialRequest(t, h, users["bob"], model.Request{Action: "recordWorkspaceSync"}); !response.Success {
		t.Fatal(response.Error)
	}
	w, response := socialRequest(t, h, users["alice"], model.Request{Action: "listFriends"})
	if !response.Success || w.Code != http.StatusOK {
		t.Fatalf("list friends failed: %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "private") || strings.Contains(w.Body.String(), "api_key") ||
		strings.Contains(w.Body.String(), "username") || strings.Contains(w.Body.String(), "email") {
		t.Fatalf("public directory disclosed private fields: %s", w.Body.String())
	}
	var contacts []social.Contact
	raw, _ := json.Marshal(response.Data)
	if err := json.Unmarshal(raw, &contacts); err != nil {
		t.Fatal(err)
	}
	if len(contacts) != 2 || contacts[0].UID != "u_bob" || contacts[0].LastSyncAt == nil || contacts[1].LastSyncAt != nil {
		t.Fatalf("unexpected public contacts: %+v", contacts)
	}
	if _, err := h.UserStore.MutateExisting("carol", func(user *auth.User) error { user.Disabled = true; return nil }); err != nil {
		t.Fatal(err)
	}
	_, response = socialRequest(t, h, users["alice"], model.Request{Action: "listFriends"})
	raw, _ = json.Marshal(response.Data)
	contacts = nil
	_ = json.Unmarshal(raw, &contacts)
	if len(contacts) != 1 {
		t.Fatalf("disabled accounts remained discoverable: %s", raw)
	}
}

func TestSocialProjectSnapshotsAreImmutableSharedAndRecipientScoped(t *testing.T) {
	h, users := newSocialHandler(t)
	source := sourceProject(t, h, "alice", "original", "print('before')\n")
	message := sendSocial(t, h, users["alice"], model.Request{RecipientID: "u_bob", Kind: "project", ProjectKey: "original"})
	other := sendSocial(t, h, users["alice"], model.Request{RecipientID: "u_carol", Kind: "project", ProjectKey: "original"})
	firstEntry, _ := h.Social.Get("bob", message.ID, time.Now())
	secondEntry, _ := h.Social.Get("carol", other.ID, time.Now())
	if firstEntry.SnapshotID == "" || firstEntry.SnapshotID != secondEntry.SnapshotID {
		t.Fatal("sending identical content made separate snapshots")
	}
	if err := os.WriteFile(filepath.Join(source, "main.py"), []byte("print('after')\n"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, principal := range []string{"", "alice", "carol"} {
		r := httptest.NewRequest(http.MethodGet, inboxProjectPath+message.ID, nil)
		if principal != "" {
			r.Header.Set("Authorization", "Bearer "+users[principal].APIKey)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized && w.Code != http.StatusNotFound {
			t.Fatalf("%s could download another inbox: %d %s", principal, w.Code, w.Body.String())
		}
	}
	r := httptest.NewRequest(http.MethodGet, inboxProjectPath+message.ID, nil)
	r.Header.Set("Authorization", "Bearer "+users["bob"].APIKey)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("download failed: %d %s", w.Code, w.Body.String())
	}
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.File) != 1 || archive.File[0].Name != "main.py" {
		t.Fatalf("unexpected archive files: %+v", archive.File)
	}
	file, _ := archive.File[0].Open()
	content, _ := io.ReadAll(file)
	_ = file.Close()
	if string(content) != "print('before')\n" {
		t.Fatalf("snapshot changed with source: %q", content)
	}
	entry, _ := h.Social.Get("bob", message.ID, time.Now())
	if entry.Status != "pending" {
		t.Fatal("download archived message before client extraction acknowledgement")
	}
	_, response := socialRequest(t, h, users["bob"], model.Request{Action: "respondInbox", MessageID: message.ID, Decision: "local"})
	if !response.Success {
		t.Fatal(response.Error)
	}
	entry, _ = h.Social.Get("bob", message.ID, time.Now())
	if entry.Status != "accepted" || entry.Decision != "local" {
		t.Fatalf("successful download acknowledgement = %+v", entry)
	}
	if err := h.CleanupSocial(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, release, err := h.ProjectSnapshots.Open(secondEntry.SnapshotID); err != nil {
		t.Fatalf("one recipient's acceptance removed another recipient's snapshot: %v", err)
	} else {
		release()
	}
}

func TestSocialCloudAcceptanceCreatesPersonalProjectOnceAndChecksQuota(t *testing.T) {
	h, users := newSocialHandler(t)
	sourceProject(t, h, "alice", "original", "value = 42\n")
	message := sendSocial(t, h, users["alice"], model.Request{RecipientID: "u_bob", Kind: "project", ProjectKey: "original"})
	request := model.Request{Action: "respondInbox", MessageID: message.ID, Decision: "cloud"}
	w, response := socialRequest(t, h, users["bob"], request)
	if !response.Success {
		t.Fatalf("cloud import failed: %s", w.Body.String())
	}
	data := response.Data.(map[string]any)
	key := data["projectKey"].(string)
	target := filepath.Join(h.Config.DataDir, "users", "bob", "workspaces", key, "main.py")
	if content, err := os.ReadFile(target); err != nil || string(content) != "value = 42\n" {
		t.Fatalf("personal cloud content %q, %v", content, err)
	}
	if err := os.WriteFile(target, []byte("changed by recipient"), 0644); err != nil {
		t.Fatal(err)
	}
	_, response = socialRequest(t, h, users["bob"], request)
	if !response.Success {
		t.Fatal(response.Error)
	}
	if content, _ := os.ReadFile(target); string(content) != "changed by recipient" {
		t.Fatal("idempotent acceptance overwrote recipient changes")
	}
	sourceProject(t, h, "alice", "too-large", strings.Repeat("z", 2<<20))
	oversize := sendSocial(t, h, users["alice"], model.Request{RecipientID: "u_carol", Kind: "project", ProjectKey: "too-large"})
	if _, err := h.UserStore.MutateExisting("carol", func(user *auth.User) error { user.DiskQuotaMB = 1; return nil }); err != nil {
		t.Fatal(err)
	}
	_, response = socialRequest(t, h, users["carol"], model.Request{Action: "respondInbox", MessageID: oversize.ID, Decision: "cloud"})
	if response.Success || !strings.Contains(response.Error, "quota") {
		t.Fatalf("cloud import ignored quota: %+v", response)
	}
	inbox, _ := h.Social.List("carol", time.Now())
	if len(inbox.Pending) != 1 {
		t.Fatal("failed import consumed the offer")
	}
}

func TestSocialCloudImportRecoversLostAcknowledgementWithoutOverwritingTarget(t *testing.T) {
	h, users := newSocialHandler(t)
	sourceProject(t, h, "alice", "original", "value = 42\n")
	message := sendSocial(t, h, users["alice"], model.Request{RecipientID: "u_bob", Kind: "project", ProjectKey: "original"})
	started := time.Now().UTC()
	entry, err := h.Social.Get("bob", message.ID, started)
	if err != nil {
		t.Fatal(err)
	}
	key, err := h.importInboxProject(context.Background(), users["bob"], entry, started)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(h.Config.DataDir, "users", "bob", "workspaces", key, "main.py")
	if err := os.WriteFile(target, []byte("recipient edit"), 0644); err != nil {
		t.Fatal(err)
	}
	// Simulate a process/connection ending after publication but before the
	// decision record was archived, and independent display metadata cleanup.
	if err := h.deleteWorkspaceDisplayName("bob", key); err != nil {
		t.Fatal(err)
	}
	_, response := socialRequest(t, h, users["bob"], model.Request{Action: "respondInbox", MessageID: message.ID, Decision: "cloud"})
	if !response.Success {
		t.Fatalf("uncertain import could not recover: %+v", response)
	}
	if content, _ := os.ReadFile(target); string(content) != "recipient edit" {
		t.Fatal("recovery overwrote recipient changes")
	}
}

func TestSocialNotesAndDirectedInvitationsValidateInputAndCurrentAuthority(t *testing.T) {
	h, users := newSocialHandler(t)
	message := sendSocial(t, h, users["alice"], model.Request{RecipientID: "u_bob", Kind: "note", Note: strings.Repeat("你", 150)})
	_, response := socialRequest(t, h, users["alice"], model.Request{Action: "sendInbox", RecipientID: "u_bob", Kind: "note", Note: strings.Repeat("你", 151)})
	if response.Success {
		t.Fatal("oversized note accepted")
	}
	_, response = socialRequest(t, h, users["carol"], model.Request{Action: "respondInbox", MessageID: message.ID, Decision: "read"})
	if response.Success {
		t.Fatal("another user could mark a note read")
	}
	_, response = socialRequest(t, h, users["bob"], model.Request{Action: "respondInbox", MessageID: message.ID, Decision: "read"})
	if !response.Success {
		t.Fatal(response.Error)
	}
	inbox, _ := h.Social.List("bob", time.Now())
	if len(inbox.Pending) != 0 || len(inbox.Archived) != 1 || inbox.Archived[0].Status != "read" {
		t.Fatalf("note did not archive after reading: %+v", inbox)
	}
	team, err := h.Collaboration.CreateTeam("alice", "Test team", "", 1024)
	if err != nil {
		t.Fatal(err)
	}
	invite := sendSocial(t, h, users["alice"], model.Request{RecipientID: "u_bob", Kind: "invite", TeamID: team.ID})
	_, response = socialRequest(t, h, users["bob"], model.Request{Action: "respondInbox", MessageID: invite.ID, Decision: "invite"})
	if !response.Success || !h.Collaboration.IsMember("bob", team.ID) {
		t.Fatalf("direct invite acceptance failed: %+v", response)
	}
	_, response = socialRequest(t, h, users["bob"], model.Request{Action: "sendInbox", RecipientID: "u_carol", Kind: "invite", TeamID: team.ID})
	if response.Success {
		t.Fatal("ordinary team member could invite someone")
	}
	stale := sendSocial(t, h, users["alice"], model.Request{RecipientID: "u_carol", Kind: "invite", TeamID: team.ID})
	if _, err := h.UserStore.MutateExisting("alice", func(user *auth.User) error { user.Disabled = true; return nil }); err != nil {
		t.Fatal(err)
	}
	_, response = socialRequest(t, h, users["carol"], model.Request{Action: "respondInbox", MessageID: stale.ID, Decision: "invite"})
	if response.Success || h.Collaboration.IsMember("carol", team.ID) {
		t.Fatal("disabled inviter retained invitation authority")
	}
}

func TestSocialStartupRecoveryRemovesOnlyPrivatePartialsUnderUserFence(t *testing.T) {
	h, _ := newSocialHandler(t)
	userDir, err := h.ensureUserDir("alice")
	if err != nil {
		t.Fatal(err)
	}
	id := auth.GenerateToken()
	partial := filepath.Join(userDir, ".inbox-import-"+id)
	published := filepath.Join(userDir, "workspaces", "received-"+id)
	unrelated := filepath.Join(userDir, ".inbox-import-my-project")
	for _, dir := range []string{partial, published, unrelated} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "main.py"), []byte("preserve published content"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	activity, err := h.Lifecycle.AcquireActivity("alice", "project")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.RecoverSocialImports(context.Background()); err == nil {
		t.Fatal("recovery ignored active user work")
	}
	activity.Release()
	if _, err := os.Stat(partial); err != nil {
		t.Fatalf("busy recovery touched partial tree: %v", err)
	}
	if err := h.RecoverSocialImports(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(partial); !os.IsNotExist(err) {
		t.Fatalf("crash partial remained after recovery: %v", err)
	}
	for _, dir := range []string{published, unrelated} {
		if _, err := os.Stat(filepath.Join(dir, "main.py")); err != nil {
			t.Fatalf("recovery removed a completed or unrelated directory: %s %v", dir, err)
		}
	}
}

type socialRevalidationStore struct {
	auth.UserStore
	onGet func(string)
}

func (s socialRevalidationStore) Get(id string) (*auth.User, error) {
	s.onGet(id)
	return s.UserStore.Get(id)
}

func TestSocialSendFencesRecipientDeletionUntilPublication(t *testing.T) {
	h, users := newSocialHandler(t)
	checked := false
	h.UserStore = socialRevalidationStore{UserStore: h.UserStore, onGet: func(id string) {
		if id != "bob" {
			return
		}
		checked = true
		lease, err := h.Lifecycle.BeginUserDeletion(id)
		if err == nil {
			lease.Release()
			t.Fatal("recipient deletion could overtake inbox publication")
		}
		if !errors.Is(err, lifecycle.ErrResourcesInUse) {
			t.Fatalf("unexpected deletion fence error: %v", err)
		}
	}}
	sendSocial(t, h, users["alice"], model.Request{RecipientID: "u_bob", Kind: "note", Note: "hello"})
	if !checked {
		t.Fatal("recipient identity was not revalidated")
	}
	deletion, err := h.Lifecycle.BeginUserDeletion("bob")
	if err != nil {
		t.Fatalf("completed message retained a recipient request lease: %v", err)
	}
	deletion.Release()
}
