package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/buildcache"
	"bobocloud-server/internal/collab"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/runner"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
	"github.com/gorilla/websocket"
)

func TestRealtimeWSRoundTrip(t *testing.T) {
	h, users := newSocialHandler(t)
	m := h.Collaboration
	team, err := m.CreateTeam("alice", "shared", "", 1024)
	if err != nil {
		t.Fatal(err)
	}
	if err = m.Store().SaveMember(&collab.Member{TeamID: team.ID, UserID: "bob"}); err != nil {
		t.Fatal(err)
	}
	project, err := m.CreateProject(context.Background(), "alice", team.ID, "Realtime", "")
	if err != nil {
		t.Fatal(err)
	}
	state, err := m.SetRealtimeMode(context.Background(), "alice", team.ID, project.ID, "main", "", true)
	if err != nil {
		t.Fatal(err)
	}
	handler := &WSHandler{Config: h.Config, Collaboration: m, AuthEnabled: true, UserStore: h.UserStore, Authenticator: auth.NewAPIKeyAuth(h.UserStore), Lifecycle: h.Lifecycle}
	server := httptest.NewServer(http.HandlerFunc(handler.HandleCollaborationWebSocket))
	defer server.Close()
	dial := func(user *auth.User, session string) *websocket.Conn {
		t.Helper()
		conn, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { _ = conn.Close() })
		if e = conn.WriteJSON(map[string]any{"type": "join", "token": user.APIKey, "teamId": team.ID, "projectId": project.ID, "epoch": state.Epoch, "sessionId": session}); e != nil {
			t.Fatal(e)
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		return conn
	}
	readUntil := func(conn *websocket.Conn, kind, request string) map[string]any {
		t.Helper()
		for i := 0; i < 20; i++ {
			var msg map[string]any
			if e := conn.ReadJSON(&msg); e != nil {
				t.Fatal(e)
			}
			if msg["type"] == kind && (request == "" || msg["requestId"] == request) {
				return msg
			}
		}
		t.Fatalf("missing message %s %s", kind, request)
		return nil
	}
	alice := dial(users["alice"], "session-alice")
	readUntil(alice, "state", "")
	bob := dial(users["bob"], "session-bobby")
	readUntil(bob, "state", "")
	fileID := state.Files[0].ID
	if err = alice.WriteJSON(map[string]any{"type": "open", "epoch": state.Epoch, "fileId": fileID, "requestId": "open1"}); err != nil {
		t.Fatal(err)
	}
	doc := readUntil(alice, "document", "open1")["file"].(map[string]any)
	nodes := doc["nodes"].([]any)
	parent := nodes[0].(map[string]any)["id"].(string)
	if err = alice.WriteJSON(map[string]any{"type": "edit", "epoch": state.Epoch, "fileId": fileID, "requestId": "edit1", "insert": []collab.RealtimeNode{{ID: "0000000000000001:session-alice:00000001", After: parent, Value: "X"}}}); err != nil {
		t.Fatal(err)
	}
	readUntil(alice, "ack", "edit1")
	op := readUntil(bob, "operation", "edit1")
	if op["fileId"] != fileID {
		t.Fatal("broadcast file identity lost")
	}
	if err = bob.WriteJSON(map[string]any{"type": "create", "epoch": "stale", "path": "bad.txt", "requestId": "stale1"}); err != nil {
		t.Fatal(err)
	}
	readUntil(bob, "error", "stale1")
	// The personal cloud copy is a manual immutable canonical snapshot; retries
	// never overwrite later independent changes in that personal workspace.
	request := &model.Request{TeamID: team.ID, ProjectID: project.ID, Epoch: state.Epoch}
	value, err := h.snapshotRealtimePersonal(context.Background(), users["bob"], request)
	if err != nil {
		t.Fatal(err)
	}
	result := value.(map[string]any)
	key := result["projectKey"].(string)
	root, err := auth.UserDataRoot(h.Config.DataDir, "bob")
	if err != nil {
		t.Fatal(err)
	}
	personal := filepath.Join(root, "workspaces", key, "README.md")
	content, err := os.ReadFile(personal)
	if err != nil || !strings.HasPrefix(string(content), "#X") {
		t.Fatalf("private snapshot did not use canonical edits: %q %v", content, err)
	}
	if err = os.WriteFile(personal, []byte("personal only"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = h.snapshotRealtimePersonal(context.Background(), users["bob"], request); err != nil {
		t.Fatal(err)
	}
	content, _ = os.ReadFile(personal)
	if string(content) != "personal only" {
		t.Fatal("snapshot retry overwrote personal edits")
	}
	snapshot, err := m.GetRealtimeSnapshot("alice", team.ID, project.ID, state.Epoch)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(snapshot.Files[0].Content, "personal only") {
		t.Fatal("personal edit leaked to room")
	}
	if _, err = h.snapshotRealtimePersonal(context.Background(), users["carol"], request); err == nil {
		t.Fatal("nonmember imported private room")
	}
	// A member checkpoint includes room edits without changing collaboration mode.
	checkpoint, err := h.checkpointRealtime(context.Background(), users["bob"], &model.Request{TeamID: team.ID, ProjectID: project.ID, Epoch: state.Epoch, CommitMessage: "Shared version"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(checkpoint)
	if !strings.Contains(string(encoded), "commit") {
		t.Fatal("missing checkpoint receipt")
	}
	after, err := m.GetRealtimeState("bob", team.ID, project.ID)
	if err != nil || !after.Enabled || after.Epoch != state.Epoch {
		t.Fatal("checkpoint changed room mode")
	}
}

func TestRealtimeDisabledSnapshot(t *testing.T) {
	h, users := newSocialHandler(t)
	m := h.Collaboration
	team, err := m.CreateTeam("alice", "Exit snapshot", "", 1024)
	if err != nil {
		t.Fatal(err)
	}
	project, err := m.CreateProject(context.Background(), "alice", team.ID, "Snapshot", "")
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := m.EnsureWorktree(context.Background(), "alice", team.ID, project.ID, "main", false)
	if err != nil {
		t.Fatal(err)
	}
	binary := []byte{0, 1, 255}
	if err = os.WriteFile(filepath.Join(filepath.FromSlash(worktree.RemotePath), "image.bin"), binary, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Commit(context.Background(), users["alice"], team.ID, project.ID, "main", "Add binary baseline"); err != nil {
		t.Fatal(err)
	}
	decode := func(response model.Response) collab.RealtimeState {
		t.Helper()
		if !response.Success {
			t.Fatal(response.Error)
		}
		data, e := json.Marshal(response.Data)
		if e != nil {
			t.Fatal(e)
		}
		var state collab.RealtimeState
		if e = json.Unmarshal(data, &state); e != nil {
			t.Fatal(e)
		}
		return state
	}
	_, response := socialRequest(t, h, users["alice"], model.Request{Action: "setRealtimeMode", TeamID: team.ID, ProjectID: project.ID, Branch: "main", Enabled: true})
	enabled := decode(response)
	_, _, leave, err := m.JoinRealtime("alice", "Alice", team.ID, project.ID, enabled.Epoch, "session-exit")
	if err != nil {
		t.Fatal(err)
	}
	defer leave()
	for _, op := range []collab.RealtimeOperation{{Type: "create", Path: "unopened.txt", Content: "CANONICAL_FINAL"}, {Type: "create", Path: "empty.txt"}} {
		op.Epoch = enabled.Epoch
		if _, err = m.ApplyRealtime("alice", "session-exit", team.ID, project.ID, op); err != nil {
			t.Fatal(err)
		}
	}
	_, response = socialRequest(t, h, users["alice"], model.Request{Action: "setRealtimeMode", TeamID: team.ID, ProjectID: project.ID, Branch: "main", Epoch: enabled.Epoch, Enabled: false})
	disabled := decode(response)
	if disabled.Enabled || len(disabled.Files) != 0 {
		t.Fatal("disable retained canonical snapshot")
	}
	request := model.Request{Action: "getRealtimeSnapshot", TeamID: team.ID, ProjectID: project.ID, Epoch: disabled.Epoch}
	assertSnapshot := func() {
		t.Helper()
		_, response := socialRequest(t, h, users["alice"], request)
		snapshot := decode(response)
		if snapshot.Enabled || snapshot.Epoch != disabled.Epoch || snapshot.Branch != "main" {
			t.Fatalf("wrong disabled snapshot metadata: %+v", snapshot)
		}
		files := map[string]*collab.RealtimeFile{}
		for _, file := range snapshot.Files {
			files[file.Path] = file
			if len(file.Nodes) != 0 {
				t.Fatal("Git recovery rebuilt CRDT nodes")
			}
		}
		if files["unopened.txt"] == nil || files["unopened.txt"].Content != "CANONICAL_FINAL" || files["empty.txt"] == nil || files["empty.txt"].Content != "" || files["image.bin"] == nil || string(files["image.bin"].Data) != string(binary) {
			t.Fatalf("disabled recovery omitted final text/binary/empty contents: %+v", files)
		}
	}
	assertSnapshot()
	stale := request
	stale.Epoch = enabled.Epoch
	_, response = socialRequest(t, h, users["alice"], stale)
	if response.Success || !strings.Contains(response.Error, "realtime_epoch_stale") {
		t.Fatal("disabled snapshot accepted old epoch")
	}
	_, response = socialRequest(t, h, users["carol"], request)
	if response.Success {
		t.Fatal("disabled snapshot leaked to nonmember")
	}
	projectRoot := filepath.Join(h.Config.DataDir, "teams", team.ID, "projects", project.ID)
	persisted, err := os.ReadFile(filepath.Join(projectRoot, "realtime.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(persisted), "CANONICAL_FINAL") || strings.Contains(string(persisted), `"nodes"`) {
		t.Fatal("disabled snapshot download repersisted canonical data")
	}
	remaining, err := filepath.Glob(filepath.Join(projectRoot, ".realtime-snapshot-*"))
	if err != nil || len(remaining) != 0 {
		t.Fatalf("temporary Git snapshot leaked: %v %v", remaining, err)
	}
	h.Collaboration = collab.NewManager(m.Store(), h.UserStore, filepath.Join(h.Config.DataDir, "teams"))
	if err = h.Collaboration.RecoverRealtimeState(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertSnapshot()
	_, response = socialRequest(t, h, users["alice"], model.Request{Action: "getRealtimeState", TeamID: team.ID, ProjectID: project.ID})
	state := decode(response)
	if len(state.Files) != 0 || state.Run != nil {
		t.Fatal("disabled authority was recreated after restart")
	}
}

type realtimeTestPlugin struct{}

func (realtimeTestPlugin) Language() string     { return "python" }
func (realtimeTestPlugin) Extensions() []string { return []string{".py"} }
func (realtimeTestPlugin) Plan(*runner.PlanRequest) (*runner.Plan, error) {
	return &runner.Plan{Steps: []runner.Step{{Stage: "run:python", Cmd: []string{os.Args[0], "-test.run=^TestRealtimeProcessHelper$"}, Env: map[string]string{"BOBO_REALTIME_HELPER": "1"}, TimeoutSec: 20}}}, nil
}
func TestRealtimeProcessHelper(t *testing.T) {
	if os.Getenv("BOBO_REALTIME_HELPER") != "1" {
		return
	}
	content, err := os.ReadFile("main.py")
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("ready:%s\n", content)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		fmt.Printf("input:%s\n", scanner.Text())
	}
}

func TestRealtimeSharedRun(t *testing.T) {
	h, _ := newSocialHandler(t)
	user := &auth.User{ID: "default", UID: "u_default", Name: "Default", APIKey: "default-key"}
	if err := h.UserStore.Create(user); err != nil {
		t.Fatal(err)
	}
	m := h.Collaboration
	team, err := m.CreateTeam(user.ID, "shared", "", 1024)
	if err != nil {
		t.Fatal(err)
	}
	project, err := m.CreateProject(context.Background(), user.ID, team.ID, "Shared", "")
	if err != nil {
		t.Fatal(err)
	}
	state, err := m.SetRealtimeMode(context.Background(), user.ID, team.ID, project.ID, "main", "", true)
	if err != nil {
		t.Fatal(err)
	}
	_, _, leave, err := m.JoinRealtime(user.ID, user.Name, team.ID, project.ID, state.Epoch, "session-setup")
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.ApplyRealtime(user.ID, "session-setup", team.ID, project.ID, collab.RealtimeOperation{Type: "create", Epoch: state.Epoch, Path: "main.py", Content: "CANONICAL"})
	leave()
	if err != nil {
		t.Fatal(err)
	}
	plugins := runner.NewPluginRegistry()
	plugins.Register(realtimeTestPlugin{})
	handler := &WSHandler{Config: h.Config, Collaboration: m, UserStore: h.UserStore, Lifecycle: h.Lifecycle, Plugins: plugins, Sessions: storage.NewMemorySessionStore(), Channels: session.NewChannelManager(), BuildCache: buildcache.NewManager(filepath.Join(h.Config.DataDir, "buildcache"), 1024)}
	server := httptest.NewServer(http.HandlerFunc(handler.HandleCollaborationWebSocket))
	defer server.Close()
	readUntil := func(conn *websocket.Conn, predicate func(map[string]any) bool) map[string]any {
		t.Helper()
		_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
		for i := 0; i < 100; i++ {
			var msg map[string]any
			if e := conn.ReadJSON(&msg); e != nil {
				t.Fatal(e)
			}
			if predicate(msg) {
				return msg
			}
		}
		t.Fatal("expected run event missing")
		return nil
	}
	dial := func(id string) *websocket.Conn {
		t.Helper()
		conn, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { _ = conn.Close() })
		if e = conn.WriteJSON(map[string]any{"type": "join", "teamId": team.ID, "projectId": project.ID, "epoch": state.Epoch, "sessionId": id}); e != nil {
			t.Fatal(e)
		}
		readUntil(conn, func(msg map[string]any) bool { return msg["type"] == "state" })
		return conn
	}
	first, second := dial("session-first"), dial("session-second")
	if err = first.WriteJSON(map[string]any{"type": "run", "epoch": state.Epoch, "requestId": "run-request", "run": map[string]any{"filePath": "main.py", "folderKey": "personal-key", "folderName": "Shared"}}); err != nil {
		t.Fatal(err)
	}
	line := func(want string) func(map[string]any) bool {
		return func(msg map[string]any) bool {
			if msg["type"] != "runEvent" {
				return false
			}
			event, ok := msg["event"].(map[string]any)
			return ok && event["type"] == "stdout" && strings.Contains(fmt.Sprint(event["line"]), want)
		}
	}
	readUntil(second, line("ready:CANONICAL"))
	if err = second.WriteJSON(map[string]any{"type": "stdin", "epoch": state.Epoch, "data": "from-second\n", "requestId": "input"}); err != nil {
		t.Fatal(err)
	}
	readUntil(second, line("input:from-second"))
	_ = first.Close()
	// Loss of the initiating transport leaves the room-owned process alive.
	reconnect := dial("session-first")
	if err = reconnect.WriteJSON(map[string]any{"type": "open", "epoch": state.Epoch, "fileId": state.Files[0].ID, "requestId": "alive"}); err != nil {
		t.Fatal(err)
	}
	readUntil(reconnect, func(msg map[string]any) bool { return msg["type"] == "document" })
	replay, err := m.GetRealtimeState(user.ID, team.ID, project.ID)
	if err != nil || replay.Run == nil || replay.Run.Status != "running" {
		t.Fatalf("initiator disconnect stopped run: %+v %v", replay.Run, err)
	}
	encoded, _ := json.Marshal(replay.Run.Events)
	if !strings.Contains(string(encoded), "ready:CANONICAL") || !strings.Contains(string(encoded), "input:from-second") {
		t.Fatalf("missing replay: %s", encoded)
	}
	if err = second.WriteJSON(map[string]any{"type": "cancelRun", "epoch": state.Epoch, "requestId": "cancel"}); err != nil {
		t.Fatal(err)
	}
	readUntil(second, func(msg map[string]any) bool {
		if msg["type"] != "state" {
			return false
		}
		s, _ := msg["state"].(map[string]any)
		run, _ := s["run"].(map[string]any)
		return run["status"] == "cancelled"
	})
}
