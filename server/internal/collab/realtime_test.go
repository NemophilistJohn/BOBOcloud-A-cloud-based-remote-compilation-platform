package collab

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
)

type realtimeFixture struct {
	m                          *Manager
	team, project, epoch, file string
	root                       string
	leave                      []func()
}

func newRealtimeFixture(t *testing.T) *realtimeFixture {
	t.Helper()
	users := auth.NewMemoryUserStore()
	for _, id := range []string{"admin", "alice", "bob"} {
		if err := users.Create(testUser(id, "u_"+id, id)); err != nil {
			t.Fatal(err)
		}
	}
	m := NewManager(NewMemoryStore(), users, t.TempDir())
	team, err := m.CreateTeam("admin", "realtime", "", 1024)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"alice", "bob"} {
		addTeamMember(t, m.store, team.ID, id)
	}
	p := &Project{ID: "project", TeamID: team.ID, DefaultBranch: "main"}
	if err = m.store.SaveProject(p); err != nil {
		t.Fatal(err)
	}
	m.realtimeMu.Lock()
	room, err := m.roomLocked(team.ID, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	f := seedRealtimeFile("main.txt", []byte("ab😀"), false)
	room.State = RealtimeState{Enabled: true, Epoch: "epoch", Branch: "main", Files: []*RealtimeFile{f}, Deletions: []*RealtimeDeletion{}}
	err = m.persistRoomLocked(team.ID, p.ID, room)
	m.realtimeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	fixture := &realtimeFixture{m: m, team: team.ID, project: p.ID, epoch: "epoch", file: f.ID, root: m.root}
	t.Cleanup(func() {
		for _, leave := range fixture.leave {
			leave()
		}
	})
	return fixture
}
func (f *realtimeFixture) join(t *testing.T, user, session string) {
	t.Helper()
	_, _, leave, err := f.m.JoinRealtime(user, user, f.team, f.project, f.epoch, session)
	if err != nil {
		t.Fatal(err)
	}
	f.leave = append(f.leave, leave)
}
func (f *realtimeFixture) apply(t *testing.T, user, session string, op RealtimeOperation) any {
	t.Helper()
	op.Epoch = f.epoch
	value, err := f.m.ApplyRealtime(user, session, f.team, f.project, op)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
func (f *realtimeFixture) state(t *testing.T) RealtimeState {
	t.Helper()
	s, err := f.m.GetRealtimeState("admin", f.team, f.project)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func (f *realtimeFixture) document(t *testing.T, user, session string) *RealtimeFile {
	t.Helper()
	v := f.apply(t, user, session, RealtimeOperation{Type: "open", FileID: f.file})
	return v.(map[string]any)["file"].(*RealtimeFile)
}

func TestRealtimeConcurrentRGAEditsConvergeAndPersist(t *testing.T) {
	f := newRealtimeFixture(t)
	f.join(t, "alice", "session-alice")
	f.join(t, "bob", "session-bobby")
	doc := f.document(t, "alice", "session-alice")
	parent := doc.Nodes[0].ID
	ops := []RealtimeOperation{{Type: "edit", Epoch: f.epoch, RequestID: "alice-edit", FileID: f.file, Insert: []RealtimeNode{{ID: "0000000000000001:session-alice:00000001", After: parent, Value: "X"}}}, {Type: "edit", Epoch: f.epoch, RequestID: "bob-edit", FileID: f.file, Insert: []RealtimeNode{{ID: "0000000000000001:session-bobby:00000001", After: parent, Value: "Y"}}, Delete: []string{doc.Nodes[1].ID}}}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i, user := range []string{"alice", "bob"} {
		session := []string{"session-alice", "session-bobby"}[i]
		op := ops[i]
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.m.ApplyRealtime(user, session, f.team, f.project, op)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := f.document(t, "alice", "session-alice").Content; got != "aYX😀" {
		t.Fatalf("merged content=%q", got)
	}
	// Replays are idempotent, even when a request's acknowledgement was lost.
	f.apply(t, "alice", "session-alice", ops[0])
	if got := f.document(t, "alice", "session-alice").Content; got != "aYX😀" {
		t.Fatal(got)
	}
	restarted := NewManager(f.m.store, f.m.users, f.root)
	snapshot, err := restarted.GetRealtimeSnapshot("alice", f.team, f.project, f.epoch)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Files[0].Content != "aYX😀" || len(snapshot.Presence) != 0 {
		t.Fatalf("restart snapshot=%+v", snapshot)
	}
	// Independent event delivery orders produce the same deterministic RGA.
	nodes := append([]RealtimeNode{}, doc.Nodes...)
	nodes = append(nodes, ops[1].Insert...)
	nodes = append(nodes, ops[0].Insert...)
	for i := range nodes {
		if nodes[i].ID == doc.Nodes[1].ID {
			nodes[i].Deleted = true
		}
	}
	text, err := renderRealtime(nodes)
	if err != nil || text != "aYX😀" {
		t.Fatalf("op order %q %v", text, err)
	}
}

func TestRealtimeInvalidBatchIsAtomicAndPathsAreBounded(t *testing.T) {
	f := newRealtimeFixture(t)
	f.join(t, "alice", "session-alice")
	before := f.document(t, "alice", "session-alice")
	_, err := f.m.ApplyRealtime("alice", "session-alice", f.team, f.project, RealtimeOperation{Type: "edit", Epoch: f.epoch, FileID: f.file, Insert: []RealtimeNode{{ID: "0000000000000001:session-alice:00000001", Value: "x"}, {ID: "0000000000000002:session-alice:00000002", After: "missing", Value: "y"}}})
	if err == nil {
		t.Fatal("accepted missing parent")
	}
	if after := f.document(t, "alice", "session-alice"); after.Content != before.Content || len(after.Nodes) != len(before.Nodes) {
		t.Fatal("invalid edit partially applied")
	}
	for _, p := range []string{"../escape", "/root/escape", "a\\b", "a/.git/config", "a:b", "a/../b"} {
		_, err = f.m.ApplyRealtime("alice", "session-alice", f.team, f.project, RealtimeOperation{Type: "create", Epoch: f.epoch, Path: p})
		if err == nil {
			t.Fatalf("accepted path %q", p)
		}
	}
	if _, err = f.m.GetRealtimeState("outsider", f.team, f.project); err == nil {
		t.Fatal("unauthorized room read")
	}
	if _, err = f.m.ApplyRealtime("alice", "session-alice", f.team, f.project, RealtimeOperation{Type: "create", Epoch: "old", Path: "old.txt"}); err == nil {
		t.Fatal("accepted stale epoch")
	}
}

func TestRealtimeRestartRecovery(t *testing.T) {
	f := newRealtimeFixture(t)
	f.join(t, "alice", "session-alice")
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "create", RequestID: "durable-create", Path: "empty.txt"})
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "presence", Panes: []RealtimePane{{PaneID: "main", FileID: f.file, Editing: true}}})
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "deleteRequest", FileID: f.file})
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := f.m.BeginRealtimeRun("alice", f.team, f.project, f.epoch, "crashed-run", cancel, nil); err != nil {
		t.Fatal(err)
	}
	workspace, err := f.m.MaterializeRealtimeRun("alice", f.team, f.project, f.epoch, "crashed-run")
	if err != nil {
		t.Fatal(err)
	}
	restarted := NewManager(f.m.store, f.m.users, f.root)
	if err = restarted.RecoverRealtimeState(context.Background()); err != nil {
		t.Fatal(err)
	}
	state, err := restarted.GetRealtimeState("alice", f.team, f.project)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Files) != 2 || len(state.Deletions) != 0 || state.Run == nil || state.Run.Status != "interrupted" {
		t.Fatalf("unsafe recovery: %+v", state)
	}
	if _, err = os.Stat(workspace); !os.IsNotExist(err) {
		t.Fatal("recovery retained process snapshot")
	}
	_, _, leave, err := restarted.JoinRealtime("alice", "Alice", f.team, f.project, f.epoch, "session-alice")
	if err != nil {
		t.Fatal(err)
	}
	defer leave()
	if _, err = restarted.ApplyRealtime("alice", "session-alice", f.team, f.project, RealtimeOperation{Type: "create", Epoch: f.epoch, RequestID: "durable-create", Path: "empty.txt"}); err != nil {
		t.Fatal("lost durable mutation receipt:", err)
	}
	for _, file := range state.Files {
		if file.Path == "empty.txt" {
			reply, e := restarted.ApplyRealtime("alice", "session-alice", f.team, f.project, RealtimeOperation{Type: "open", Epoch: f.epoch, FileID: file.ID})
			if e != nil {
				t.Fatal(e)
			}
			encoded, e := json.Marshal(reply)
			if e != nil || !strings.Contains(string(encoded), `"nodes":[]`) {
				t.Fatalf("empty document omitted RGA array: %s %v", encoded, e)
			}
		}
	}
	snapshot, err := restarted.GetRealtimeSnapshot("alice", f.team, f.project, f.epoch)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(snapshot)
	if err != nil || !strings.Contains(string(data), `"content":""`) {
		t.Fatalf("empty text omitted in full snapshot: %s %v", data, err)
	}
	if _, err = restarted.ApplyRealtime("alice", "session-alice", f.team, f.project, RealtimeOperation{Type: "create", Epoch: f.epoch, Path: "oversize.txt", Content: strings.Repeat("x", realtimeTextBytes+1)}); err == nil {
		t.Fatal("accepted text over quota")
	}
}

func TestRealtimeEditingHeldUntilSwitch(t *testing.T) {
	f := newRealtimeFixture(t)
	f.join(t, "alice", "session-alice")
	f.join(t, "bob", "session-bobby")
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "presence", Panes: []RealtimePane{{PaneID: "main", FileID: f.file}}})
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "edit", FileID: f.file, Insert: []RealtimeNode{{ID: "0000000000000001:session-alice:00000001", Value: "x"}}})
	// A saved/undone state cannot release an edited file while its pane remains.
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "presence", Panes: []RealtimePane{{PaneID: "main", FileID: f.file, Editing: false}}})
	f.apply(t, "bob", "session-bobby", RealtimeOperation{Type: "deleteRequest", FileID: f.file})
	state := f.state(t)
	if len(state.Deletions) != 1 || len(state.Deletions[0].Electorate) != 1 || state.Deletions[0].Electorate[0] != "alice" {
		t.Fatalf("accepted edit failed to hold editor: %+v", state.Deletions)
	}
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "presence", Panes: []RealtimePane{}})
	state = f.state(t)
	held := false
	for _, p := range state.Presence {
		if p.UserID == "alice" && p.Held[f.file].After(time.Now()) {
			held = true
		}
	}
	if !held {
		t.Fatal("switch-out did not start editing grace")
	}
}

func TestRealtimeDeleteElectorateMultiSessionGraceAndConsent(t *testing.T) {
	f := newRealtimeFixture(t)
	f.join(t, "alice", "session-alice")
	f.join(t, "alice", "session-alice2")
	f.join(t, "bob", "session-bobby")
	for _, v := range []struct{ u, s string }{{"alice", "session-alice"}, {"alice", "session-alice2"}, {"bob", "session-bobby"}} {
		f.apply(t, v.u, v.s, RealtimeOperation{Type: "presence", Panes: []RealtimePane{{PaneID: "main", FileID: f.file, Editing: true}}})
	}
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "deleteRequest", FileID: f.file})
	state := f.state(t)
	if len(state.Deletions) != 1 || len(state.Deletions[0].Electorate) != 2 {
		t.Fatalf("electorate=%+v", state.Deletions)
	}
	id := state.Deletions[0].ID
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "deleteVote", DeleteID: id, Decision: "consent"})
	if len(f.state(t).Files) != 1 {
		t.Fatal("deleted before all editor users consented")
	}
	// Consent never makes existing editors read-only.
	doc := f.document(t, "alice", "session-alice")
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "edit", FileID: f.file, Insert: []RealtimeNode{{ID: "0000000000000001:session-alice:00000001", After: doc.Nodes[0].ID, Value: "x"}}})
	// Switch-out holds the vote for ten seconds; a disconnected application is
	// retained until its independently expiring 60-second heartbeat deadline.
	f.apply(t, "bob", "session-bobby", RealtimeOperation{Type: "presence", Panes: []RealtimePane{}})
	f.m.SweepRealtime(f.team, f.project)
	if len(f.state(t).Files) != 1 {
		t.Fatal("ignored switch-out grace")
	}
	f.m.realtimeMu.Lock()
	room, _ := f.m.roomLocked(f.team, f.project)
	room.sessions["bob:session-bobby"].Held[f.file] = time.Now().Add(-time.Second)
	f.m.realtimeMu.Unlock()
	f.m.SweepRealtime(f.team, f.project)
	if len(f.state(t).Files) != 0 {
		t.Fatal("unconsented released user did not unblock delete")
	}
	if _, err := f.m.ApplyRealtime("alice", "session-alice", f.team, f.project, RealtimeOperation{Type: "open", Epoch: f.epoch, FileID: f.file}); err == nil {
		t.Fatal("deleted document reopened")
	}
}

func TestRealtimeDeleteVetoExpiryOfflineAndNewOpen(t *testing.T) {
	f := newRealtimeFixture(t)
	f.join(t, "alice", "session-alice")
	f.join(t, "bob", "session-bobby")
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "presence", Panes: []RealtimePane{{PaneID: "main", FileID: f.file, Editing: true}}})
	f.apply(t, "bob", "session-bobby", RealtimeOperation{Type: "deleteRequest", FileID: f.file})
	if _, err := f.m.ApplyRealtime("bob", "session-bobby", f.team, f.project, RealtimeOperation{Type: "open", Epoch: f.epoch, FileID: f.file}); err == nil {
		t.Fatal("new open accepted while deletion pending")
	}
	id := f.state(t).Deletions[0].ID
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "deleteVote", DeleteID: id, Decision: "veto"})
	if len(f.state(t).Files) != 1 || len(f.state(t).Deletions) != 0 {
		t.Fatal("veto did not cancel")
	}
	f.apply(t, "bob", "session-bobby", RealtimeOperation{Type: "deleteRequest", FileID: f.file})
	f.m.realtimeMu.Lock()
	room, _ := f.m.roomLocked(f.team, f.project)
	room.State.Deletions[0].ExpiresAt = time.Now().Add(-time.Second)
	f.m.realtimeMu.Unlock()
	f.m.SweepRealtime(f.team, f.project)
	if len(f.state(t).Files) != 1 || len(f.state(t).Deletions) != 0 {
		t.Fatal("expired request must cancel")
	}
	f.apply(t, "bob", "session-bobby", RealtimeOperation{Type: "deleteRequest", FileID: f.file})
	f.m.realtimeMu.Lock()
	room, _ = f.m.roomLocked(f.team, f.project)
	room.sessions["alice:session-alice"].LastSeen = time.Now().Add(-61 * time.Second)
	f.m.realtimeMu.Unlock()
	f.m.SweepRealtime(f.team, f.project)
	if len(f.state(t).Files) != 0 {
		t.Fatal("offline editor did not release vote")
	}
}

func TestRealtimeRenameDirectoryAndRunSnapshots(t *testing.T) {
	f := newRealtimeFixture(t)
	f.join(t, "alice", "session-alice")
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "create", Path: "src", Directory: true})
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "create", Path: "src/main.go", Content: "package main"})
	var dir string
	for _, file := range f.state(t).Files {
		if file.Path == "src" {
			dir = file.ID
		}
	}
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "rename", FileID: dir, Path: "lib"})
	found := false
	for _, file := range f.state(t).Files {
		if file.Path == "lib/main.go" {
			found = true
		}
	}
	if !found {
		t.Fatal("directory children did not rename")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := f.m.BeginRealtimeRun("alice", f.team, f.project, f.epoch, "run1", cancel, func(string) error { return nil }, RealtimeRunTarget{FilePath: "main.txt", Runtime: "python:3.11"}); err != nil {
		t.Fatal(err)
	}
	if err := f.m.BeginRealtimeRun("bob", f.team, f.project, f.epoch, "run2", cancel, nil); err == nil {
		t.Fatal("second shared run admitted")
	}
	doc := f.document(t, "alice", "session-alice")
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "edit", FileID: f.file, Delete: []string{doc.Nodes[0].ID}})
	snapshot, err := f.m.MaterializeRealtimeRun("alice", f.team, f.project, f.epoch, "run1")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(snapshot, "main.txt"))
	if err != nil || string(data) != "ab😀" {
		t.Fatalf("run used mutated source: %q %v", data, err)
	}
	for i := 0; i < 100; i++ {
		f.m.PublishRealtimeRunEvent(f.team, f.project, "run1", map[string]any{"type": "stdout", "line": strings.Repeat("x", 4096)})
	}
	state := f.state(t)
	if !state.Run.Omitted || len(state.Run.Events) >= 100 {
		t.Fatal("run replay not bounded")
	}
	if err = f.m.ControlRealtimeRun("bob", f.team, f.project, f.epoch, "cancelRun", ""); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("member could not cancel shared run")
	}
	f.m.FinishRealtimeRun(f.team, f.project, "run1", "cancelled")
	if _, err = os.Stat(snapshot); !os.IsNotExist(err) {
		t.Fatal("run snapshot leaked")
	}
	if err = f.m.BeginRealtimeRun("bob", f.team, f.project, f.epoch, "run2", cancel, nil, RealtimeRunTarget{TaskLabel: "Smoke task", TaskKind: "run"}); err != nil {
		t.Fatal(err)
	}
	f.m.FinishRealtimeRun(f.team, f.project, "run2", "completed")
	restarted := NewManager(f.m.store, f.m.users, f.root)
	state, err = restarted.GetRealtimeState("alice", f.team, f.project)
	if err != nil || state.Run == nil || state.Run.TaskLabel != "Smoke task" || state.Run.CompletedAt == nil || len(state.Runs) != 1 {
		t.Fatalf("shared history did not survive reconnect/restart: %+v %v", state, err)
	}
	record := state.Runs[0]
	if record.ID != "run1" || record.Status != "cancelled" || record.FilePath != "main.txt" || record.Runtime != "python:3.11" || record.Sequence != 100 || !record.Omitted || len(record.Events) >= 8 || record.CreatedAt == nil || record.CompletedAt == nil {
		t.Fatalf("archived run metadata or retention is incorrect: id=%s status=%s sequence=%d events=%d", record.ID, record.Status, record.Sequence, len(record.Events))
	}
}

func TestRealtimeTreeRequiresExplicitParents(t *testing.T) {
	f := newRealtimeFixture(t)
	f.join(t, "alice", "session-alice")
	reject := func(op RealtimeOperation) {
		t.Helper()
		before := f.state(t)
		op.Epoch = f.epoch
		if _, err := f.m.ApplyRealtime("alice", "session-alice", f.team, f.project, op); err == nil || !strings.Contains(err.Error(), "parent_directory_missing") {
			t.Fatalf("missing parent accepted: %+v, error=%v", op, err)
		}
		after := f.state(t)
		if after.Revision != before.Revision || len(after.Files) != len(before.Files) {
			t.Fatal("rejected operation changed tree")
		}
		for i, file := range before.Files {
			if after.Files[i].ID != file.ID || after.Files[i].Path != file.Path {
				t.Fatal("rejected operation renamed files")
			}
		}
	}
	reject(RealtimeOperation{Type: "create", Path: "missing/main.py", Content: "print(1)"})
	reject(RealtimeOperation{Type: "create", Path: "missing/child", Directory: true})
	reject(RealtimeOperation{Type: "create", Path: "main.txt/child"})
	reject(RealtimeOperation{Type: "rename", FileID: f.file, Path: "missing/moved.txt"})
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "create", Path: "src", Directory: true})
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "create", Path: "src/main.py", Content: "print(1)"})
	var directory string
	for _, file := range f.state(t).Files {
		if file.Path == "src" {
			directory = file.ID
		}
	}
	reject(RealtimeOperation{Type: "rename", FileID: directory, Path: "missing/moved"})
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "create", Path: "dest", Directory: true})
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "rename", FileID: directory, Path: "dest/src"})
	f.apply(t, "alice", "session-alice", RealtimeOperation{Type: "rename", FileID: f.file, Path: "dest/moved.txt"})
	paths := map[string]bool{}
	for _, file := range f.state(t).Files {
		paths[file.Path] = true
	}
	for _, expected := range []string{"dest", "dest/src", "dest/src/main.py", "dest/moved.txt"} {
		if !paths[expected] {
			t.Fatalf("valid explicit parent operation omitted %s", expected)
		}
	}
}

func TestRealtimeModeCleanBaselineExportAndEpoch(t *testing.T) {
	users := auth.NewMemoryUserStore()
	_ = users.Create(testUser("admin", "u_admin", "Admin"))
	m := NewManager(NewMemoryStore(), users, t.TempDir())
	team, err := m.CreateTeam("admin", "test", "", 1024)
	if err != nil {
		t.Fatal(err)
	}
	project, err := m.CreateProject(context.Background(), "admin", team.ID, "project", "")
	if err != nil {
		t.Fatal(err)
	}
	info, err := m.EnsureWorktree(context.Background(), "admin", team.ID, project.ID, "main", false)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(filepath.FromSlash(info.RemotePath), "dirty.txt")
	if err = os.WriteFile(file, []byte("draft"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = m.SetRealtimeMode(context.Background(), "admin", team.ID, project.ID, "main", "", true); err == nil {
		t.Fatal("dirty baseline accepted")
	}
	_ = os.Remove(file)
	s, err := m.SetRealtimeMode(context.Background(), "admin", team.ID, project.ID, "main", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.ResolveWorktree(context.Background(), "admin", team.ID, project.ID, "main"); err == nil {
		t.Fatal("legacy worktree allowed in realtime mode")
	}
	_, _, leave, err := m.JoinRealtime("admin", "Admin", team.ID, project.ID, s.Epoch, "session-admin")
	if err != nil {
		t.Fatal(err)
	}
	defer leave()
	_, err = m.ApplyRealtime("admin", "session-admin", team.ID, project.ID, RealtimeOperation{Type: "create", Epoch: s.Epoch, RequestID: "create-shared", Path: "shared.txt", Content: "saved collaboratively"})
	if err != nil {
		t.Fatal(err)
	}
	_, cancelRun := context.WithCancel(context.Background())
	if err = m.BeginRealtimeRun("admin", team.ID, project.ID, s.Epoch, "completed-run", cancelRun, nil); err != nil {
		cancelRun()
		t.Fatal(err)
	}
	m.PublishRealtimeRunEvent(team.ID, project.ID, "completed-run", map[string]any{"type": "stdout", "line": "old run output"})
	m.FinishRealtimeRun(team.ID, project.ID, "completed-run", "completed")
	cancelRun()
	off, err := m.SetRealtimeMode(context.Background(), "admin", team.ID, project.ID, "main", s.Epoch, false)
	if err != nil {
		t.Fatal(err)
	}
	if off.Enabled || off.Epoch == s.Epoch {
		t.Fatal("mode epoch not advanced")
	}
	if len(off.Files) != 0 || off.Run != nil || len(off.AppliedRequests) != 0 {
		t.Fatal("disabled room retained source or run state")
	}
	persisted, err := os.ReadFile(m.realtimePath(team.ID, project.ID))
	if err != nil {
		t.Fatal(err)
	}
	var disabled RealtimeState
	if err = json.Unmarshal(persisted, &disabled); err != nil {
		t.Fatal(err)
	}
	if disabled.Enabled || disabled.Epoch != off.Epoch || disabled.Branch != "main" || disabled.Revision != off.Revision || len(disabled.Files) != 0 || disabled.Run != nil || len(disabled.AppliedRequests) != 0 {
		t.Fatalf("disabled snapshot retained authority state: %s", persisted)
	}
	for _, retained := range []string{"saved collaboratively", "old run output", `"nodes"`, `"_appliedRequests"`} {
		if strings.Contains(string(persisted), retained) {
			t.Fatalf("disabled snapshot retained %q", retained)
		}
	}
	if err = m.GuardLegacyProject("admin", team.ID, project.ID, s.Epoch); err == nil {
		t.Fatal("old epoch admitted after disabling")
	}
	if err = m.GuardLegacyProject("admin", team.ID, project.ID, off.Epoch); err != nil {
		t.Fatal(err)
	}
	content, err := gitRun(context.Background(), "", "--git-dir", m.repoPath(team.ID, project.ID), "show", "main:shared.txt")
	if err != nil || content != "saved collaboratively" {
		t.Fatal(fmt.Sprintf("export=%q %v", content, err))
	}
	// An old SFTP grant may still target the old member worktree. The new mode
	// epoch resolves a different directory, so that upload cannot enter runs.
	if err = os.WriteFile(filepath.Join(filepath.FromSlash(info.RemotePath), "stale-upload.txt"), []byte("old client"), 0644); err != nil {
		t.Fatal(err)
	}
	current, err := m.ResolveWorktree(context.Background(), "admin", team.ID, project.ID, "main")
	if err != nil {
		t.Fatal(err)
	}
	if current == filepath.FromSlash(info.RemotePath) {
		t.Fatal("mode transition reused stale upload target")
	}
	if _, err = os.Stat(filepath.Join(current, "stale-upload.txt")); !os.IsNotExist(err) {
		t.Fatal("stale upload entered current workspace")
	}
	if _, err = os.Stat(filepath.Join(current, "shared.txt")); err != nil {
		t.Fatal("current workspace omitted canonical export")
	}
}
