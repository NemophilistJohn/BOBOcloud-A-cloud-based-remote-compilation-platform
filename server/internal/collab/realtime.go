package collab

// Realtime rooms own text and tree state. Member Git worktrees are never a
// write-through cache for a room. Each durable edit is committed before its
// acknowledgement; ephemeral presence is deliberately not restored on restart.
import (
	"bobocloud-server/internal/safefile"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	realtimeFileBytes = 1 << 20
	realtimeTextBytes = 128 << 10
	realtimeRoomBytes = 16 << 20
	realtimeMaxFiles  = 4096
	realtimeMaxNodes  = 500000
	realtimeRunBytes  = 256 << 10
)

type RealtimeNode struct {
	ID      string `json:"id"`
	After   string `json:"after"`
	Value   string `json:"value"`
	Deleted bool   `json:"deleted,omitempty"`
}
type RealtimeFile struct {
	ID        string         `json:"id"`
	Path      string         `json:"path"`
	Binary    bool           `json:"binary,omitempty"`
	Directory bool           `json:"directory,omitempty"`
	Revision  uint64         `json:"revision"`
	Content   string         `json:"content,omitempty"`
	Nodes     []RealtimeNode `json:"nodes,omitempty"`
	Data      []byte         `json:"base64,omitempty"`
	Full      bool           `json:"-"`
}

func (f RealtimeFile) MarshalJSON() ([]byte, error) {
	type fileJSON RealtimeFile
	if f.Full && !f.Binary && !f.Directory {
		if f.Nodes != nil {
			return json.Marshal(struct {
				fileJSON
				Content string         `json:"content"`
				Nodes   []RealtimeNode `json:"nodes"`
			}{fileJSON: fileJSON(f), Content: f.Content, Nodes: f.Nodes})
		}
		return json.Marshal(struct {
			fileJSON
			Content string `json:"content"`
		}{fileJSON: fileJSON(f), Content: f.Content})
	}
	return json.Marshal(fileJSON(f))
}

type RealtimeCursor struct {
	Anchor string `json:"anchor,omitempty"`
	Focus  string `json:"focus,omitempty"`
}
type RealtimePane struct {
	PaneID  string          `json:"paneId"`
	FileID  string          `json:"fileId"`
	Editing bool            `json:"editing"`
	Cursor  *RealtimeCursor `json:"cursor,omitempty"`
}
type RealtimePresence struct {
	UserID    string               `json:"userId"`
	SessionID string               `json:"sessionId"`
	Name      string               `json:"name"`
	Avatar    string               `json:"avatar,omitempty"`
	Panes     []RealtimePane       `json:"panes"`
	Held      map[string]time.Time `json:"held,omitempty"`
	LastSeen  time.Time            `json:"lastSeen"`
}
type RealtimeDeletion struct {
	ID          string          `json:"id"`
	FileID      string          `json:"fileId"`
	RequestedBy string          `json:"requestedBy"`
	Electorate  []string        `json:"electorate"`
	Consents    map[string]bool `json:"consents"`
	ExpiresAt   time.Time       `json:"expiresAt"`
}
type RealtimeRun struct {
	ID            string `json:"id"`
	Status        string `json:"status"`
	StarterUserID string `json:"starterUserId"`
	Events        []any  `json:"events"`
	Omitted       bool   `json:"omitted"`
}
type RealtimeState struct {
	Enabled         bool                `json:"enabled"`
	Epoch           string              `json:"epoch"`
	Branch          string              `json:"branch"`
	Revision        uint64              `json:"revision"`
	Files           []*RealtimeFile     `json:"files"`
	Presence        []*RealtimePresence `json:"presence"`
	Deletions       []*RealtimeDeletion `json:"deletions"`
	Run             *RealtimeRun        `json:"run,omitempty"`
	AppliedRequests []string            `json:"_appliedRequests,omitempty"`
}
type RealtimeOperation struct {
	Type      string         `json:"type"`
	Epoch     string         `json:"epoch"`
	RequestID string         `json:"requestId,omitempty"`
	FileID    string         `json:"fileId,omitempty"`
	Path      string         `json:"path,omitempty"`
	Content   string         `json:"content,omitempty"`
	Directory bool           `json:"directory,omitempty"`
	Insert    []RealtimeNode `json:"insert,omitempty"`
	Delete    []string       `json:"delete,omitempty"`
	Panes     []RealtimePane `json:"panes,omitempty"`
	DeleteID  string         `json:"deleteId,omitempty"`
	Decision  string         `json:"decision,omitempty"`
}
type realtimeRoom struct {
	State         RealtimeState
	sessions      map[string]*RealtimePresence
	subscribers   map[string]chan any
	requests      map[string]bool
	runFiles      []*RealtimeFile
	runCancel     context.CancelFunc
	runInput      func(string) error
	runEventBytes int
}

func (m *Manager) realtimePath(teamID, projectID string) string {
	return filepath.Join(m.repoRoot(teamID, projectID), "realtime.json")
}
func (m *Manager) roomLocked(teamID, projectID string) (*realtimeRoom, error) {
	key := projectResourceKey(teamID, projectID)
	if room := m.realtimeRooms[key]; room != nil {
		return room, nil
	}
	room := &realtimeRoom{sessions: map[string]*RealtimePresence{}, subscribers: map[string]chan any{}, requests: map[string]bool{}}
	data, err := os.ReadFile(m.realtimePath(teamID, projectID))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err == nil {
		if err = json.Unmarshal(data, &room.State); err != nil {
			return nil, fmt.Errorf("realtime state recovery failed: %w", err)
		}
	}
	if room.State.Files == nil {
		room.State.Files = []*RealtimeFile{}
	}
	for _, request := range room.State.AppliedRequests {
		room.requests[request] = true
	}
	room.State.Presence = []*RealtimePresence{}
	room.State.Deletions = []*RealtimeDeletion{}
	if room.State.Run != nil {
		if room.State.Run.Status == "running" {
			room.State.Run.Status = "interrupted"
		}
		for _, event := range room.State.Run.Events {
			encoded, _ := json.Marshal(event)
			room.runEventBytes += len(encoded)
		}
	}
	m.realtimeRooms[key] = room
	return room, nil
}
func (m *Manager) persistRoomLocked(teamID, projectID string, room *realtimeRoom) error {
	data, err := json.Marshal(room.State)
	if err != nil {
		return err
	}
	if len(data) > 64<<20 {
		return fmt.Errorf("realtime serialized state quota exceeded")
	}
	target := m.realtimePath(teamID, projectID)
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(target), ".realtime-*")
	if err != nil {
		return err
	}
	tmp := file.Name()
	defer os.Remove(tmp)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp, target)
	}
	return err
}
func copyRealtimeFile(file *RealtimeFile, document bool) *RealtimeFile {
	cp := *file
	cp.Full = document
	if document {
		cp.Nodes = append([]RealtimeNode{}, file.Nodes...)
		cp.Data = append([]byte(nil), file.Data...)
	} else {
		cp.Content = ""
		cp.Nodes = nil
		cp.Data = nil
	}
	return &cp
}
func stateView(room *realtimeRoom) RealtimeState {
	s := room.State
	s.AppliedRequests = nil
	s.Files = make([]*RealtimeFile, 0, len(s.Files))
	for _, f := range room.State.Files {
		s.Files = append(s.Files, copyRealtimeFile(f, false))
	}
	sort.Slice(s.Files, func(i, j int) bool { return s.Files[i].Path < s.Files[j].Path })
	s.Presence = make([]*RealtimePresence, 0, len(room.sessions))
	for _, p := range room.sessions {
		v := *p
		v.Panes = append([]RealtimePane{}, p.Panes...)
		v.Held = map[string]time.Time{}
		for k, t := range p.Held {
			v.Held[k] = t
		}
		s.Presence = append(s.Presence, &v)
	}
	s.Deletions = make([]*RealtimeDeletion, 0, len(room.State.Deletions))
	for _, d := range room.State.Deletions {
		v := *d
		v.Electorate = append([]string{}, d.Electorate...)
		v.Consents = map[string]bool{}
		for k, b := range d.Consents {
			v.Consents[k] = b
		}
		s.Deletions = append(s.Deletions, &v)
	}
	if s.Run != nil {
		r := *s.Run
		r.Events = append([]any{}, s.Run.Events...)
		s.Run = &r
	}
	return s
}
func publishRealtime(room *realtimeRoom, event any) {
	for key, ch := range room.subscribers {
		select {
		case ch <- event:
		default:
			close(ch)
			delete(room.subscribers, key)
		}
	}
}
func publishRealtimeState(room *realtimeRoom) {
	publishRealtime(room, map[string]any{"type": "state", "state": stateView(room)})
}
func (m *Manager) GetRealtimeState(userID, teamID, projectID string) (RealtimeState, error) {
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return RealtimeState{}, err
	}
	m.realtimeMu.Lock()
	defer m.realtimeMu.Unlock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil {
		return RealtimeState{}, err
	}
	return stateView(room), nil
}
func (m *Manager) GuardLegacyProject(userID, teamID, projectID, epoch string) error {
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return err
	}
	m.realtimeMu.Lock()
	defer m.realtimeMu.Unlock()
	r, err := m.roomLocked(teamID, projectID)
	if err != nil {
		return err
	}
	if r.State.Enabled {
		return fmt.Errorf("realtime_mode_enabled: use the collaboration room")
	}
	if epoch != "*" && epoch != r.State.Epoch {
		return fmt.Errorf("realtime_epoch_stale: refresh project mode")
	}
	return nil
}
func realtimePathValid(p string) bool {
	if p == "" || len(p) > 512 || strings.ContainsAny(p, "\\\x00:\r\n<>|\"?*") || strings.HasPrefix(p, "/") || path.Clean(p) != p || p == "." || p == ".." || strings.HasPrefix(p, "../") {
		return false
	}
	if strings.EqualFold(p, ".bobocloud-team.json") {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if strings.EqualFold(part, ".git") || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return false
		}
		for _, r := range part {
			if r < 32 {
				return false
			}
		}
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9' {
			return false
		}
	}
	return true
}
func seedRealtimeFile(p string, data []byte, directory bool) *RealtimeFile {
	f := &RealtimeFile{ID: generatedID("file"), Path: p, Directory: directory, Revision: 1}
	if directory {
		return f
	}
	if len(data) > realtimeTextBytes || !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		f.Binary = true
		f.Data = append([]byte{}, data...)
		return f
	}
	f.Content = string(data)
	after := ""
	for i, r := range f.Content {
		id := fmt.Sprintf("0000000000000000:base:%08d", i)
		f.Nodes = append(f.Nodes, RealtimeNode{ID: id, After: after, Value: string(r)})
		after = id
	}
	return f
}
func roomSize(files []*RealtimeFile) (int, int) {
	bytes, nodes := 0, 0
	for _, f := range files {
		bytes += len(f.Content) + len(f.Data)
		nodes += len(f.Nodes)
	}
	return bytes, nodes
}

func (m *Manager) GetRealtimeSnapshot(userID, teamID, projectID, epoch string) (RealtimeState, error) {
	return m.GetRealtimeSnapshotContext(context.Background(), userID, teamID, projectID, epoch)
}

// GetRealtimeSnapshotContext also reconstructs a disabled room's final branch
// from Git. The caller owns resource admission and a project activity lease;
// no authority snapshot or CRDT is recreated in durable room state.
func (m *Manager) GetRealtimeSnapshotContext(ctx context.Context, userID, teamID, projectID, epoch string) (RealtimeState, error) {
	project, err := m.projectForMember(userID, teamID, projectID)
	if err != nil {
		return RealtimeState{}, err
	}
	m.realtimeMu.Lock()
	defer m.realtimeMu.Unlock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil {
		return RealtimeState{}, err
	}
	if room.State.Epoch != epoch {
		return RealtimeState{}, fmt.Errorf("realtime_epoch_stale")
	}
	state := stateView(room)
	if !room.State.Enabled {
		branch := state.Branch
		if branch == "" {
			branch = project.DefaultBranch
		}
		state.Branch = branch
		temp, e := os.MkdirTemp(m.repoRoot(teamID, projectID), ".realtime-snapshot-")
		if e != nil {
			return RealtimeState{}, e
		}
		defer os.RemoveAll(temp)
		if _, e = gitRun(ctx, "", "clone", "--branch", branch, m.repoPath(teamID, projectID), temp); e != nil {
			return RealtimeState{}, e
		}
		files := []*RealtimeFile{}
		total := 0
		e = filepath.WalkDir(temp, func(pth string, d os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if e := ctx.Err(); e != nil {
				return e
			}
			rel, _ := filepath.Rel(temp, pth)
			rel = filepath.ToSlash(rel)
			if rel == "." {
				return nil
			}
			if d.Name() == ".git" {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if !realtimePathValid(rel) || d.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("unsupported snapshot path or symbolic link")
			}
			if len(files) >= realtimeMaxFiles {
				return fmt.Errorf("realtime file quota exceeded")
			}
			file := &RealtimeFile{ID: generatedID("snapshot"), Path: rel, Directory: d.IsDir(), Revision: state.Revision, Full: true}
			if !d.IsDir() {
				info, e := d.Info()
				if e != nil {
					return e
				}
				if !info.Mode().IsRegular() || info.Size() > realtimeFileBytes {
					return fmt.Errorf("realtime file size/type unsupported")
				}
				data, e := os.ReadFile(pth)
				if e != nil {
					return e
				}
				total += len(data)
				if total > realtimeRoomBytes {
					return fmt.Errorf("realtime room quota exceeded")
				}
				if len(data) > realtimeTextBytes || !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
					file.Binary = true
					file.Data = data
				} else {
					file.Content = string(data)
				}
			}
			files = append(files, file)
			return nil
		})
		if e != nil {
			return RealtimeState{}, e
		}
		if _, e = m.projectForMember(userID, teamID, projectID); e != nil {
			return RealtimeState{}, e
		}
		state.Files = files
		return state, nil
	}
	for i, file := range room.State.Files {
		full := copyRealtimeFile(file, true)
		full.Nodes = nil
		state.Files[i] = full
	}
	return state, nil
}

// ResolveAnalysisWorktree gives analysis/debug consumers a private copy. Their
// process writes and source synchronization cannot modify the canonical room.
// Callers already hold their normal resource and project activity leases.
func (m *Manager) ResolveAnalysisWorktree(ctx context.Context, userID, teamID, projectID, branch, kind string) (string, error) {
	if kind != "lsp" && kind != "dap" && kind != "environment" {
		return "", fmt.Errorf("unsupported analysis workspace")
	}
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return "", err
	}
	m.realtimeMu.Lock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil {
		m.realtimeMu.Unlock()
		return "", err
	}
	if !room.State.Enabled {
		m.realtimeMu.Unlock()
		return m.ResolveWorktree(ctx, userID, teamID, projectID, branch)
	}
	defer m.realtimeMu.Unlock()
	if branch != "" && branch != room.State.Branch {
		return "", fmt.Errorf("realtime project is pinned to branch %s", room.State.Branch)
	}
	parent := filepath.Join(m.repoRoot(teamID, projectID), "realtime-analysis", safeFSName(userID))
	if err = os.MkdirAll(parent, 0700); err != nil {
		return "", err
	}
	if _, err = safefile.RealDirectory(parent); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(parent, ".stage-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	if err = writeRealtimeFiles(stage, room.State.Files); err != nil {
		return "", err
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	target := filepath.Join(parent, kind)
	old := stage + "-old"
	if _, e := os.Lstat(target); e == nil {
		if _, e = safefile.RealDirectory(target); e != nil {
			return "", e
		}
		if err = os.Rename(target, old); err != nil {
			return "", err
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return "", e
	}
	if err = os.Rename(stage, target); err != nil {
		_ = os.Rename(old, target)
		return "", err
	}
	_ = os.RemoveAll(old)
	return target, nil
}

func (m *Manager) RunRealtimeMaintenance(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			m.realtimeMu.Lock()
			for _, room := range m.realtimeRooms {
				if room.runCancel != nil {
					room.runCancel()
				}
			}
			m.realtimeMu.Unlock()
			return
		case <-ticker.C:
			m.realtimeMu.Lock()
			keys := make([]string, 0, len(m.realtimeRooms))
			for key := range m.realtimeRooms {
				keys = append(keys, key)
			}
			m.realtimeMu.Unlock()
			for _, key := range keys {
				parts := strings.SplitN(key, "\x00", 2)
				if len(parts) == 2 {
					m.SweepRealtime(parts[0], parts[1])
				}
			}
		}
	}
}

// RecoverRealtimeState runs after orphaned processes/containers/mounts have
// been confirmed removed. It cancels old ballots, marks interrupted runs, and
// removes only process-bound snapshots; acknowledged documents remain intact.
func (m *Manager) RecoverRealtimeState(ctx context.Context) error {
	teams, err := m.store.ListTeams()
	if err != nil {
		return err
	}
	for _, team := range teams {
		projects, e := m.store.ListProjects(team.ID)
		if e != nil {
			return e
		}
		for _, project := range projects {
			if e = ctx.Err(); e != nil {
				return e
			}
			root := m.repoRoot(team.ID, project.ID)
			if _, e = safefile.RealDirectory(root); errors.Is(e, os.ErrNotExist) {
				continue
			} else if e != nil {
				return e
			}
			entries, e := os.ReadDir(root)
			if e != nil {
				return e
			}
			hasState := false
			for _, entry := range entries {
				name := entry.Name()
				if name == "realtime.json" {
					hasState = true
				}
				if name == "realtime-runs" || name == "realtime-analysis" || strings.HasPrefix(name, ".realtime-enable-") || strings.HasPrefix(name, ".realtime-version-") || strings.HasPrefix(name, ".realtime-export-") || strings.HasPrefix(name, ".realtime-snapshot-") {
					if e = os.RemoveAll(filepath.Join(root, name)); e != nil {
						return e
					}
				}
			}
			if hasState {
				m.realtimeMu.Lock()
				room, e := m.roomLocked(team.ID, project.ID)
				if e == nil {
					e = m.persistRoomLocked(team.ID, project.ID, room)
				}
				m.realtimeMu.Unlock()
				if e != nil {
					return e
				}
			}
		}
	}
	return nil
}
func (m *Manager) SetRealtimeMode(ctx context.Context, userID, teamID, projectID, branch, epoch string, enabled bool) (RealtimeState, error) {
	if _, err := m.requireAdmin(userID, teamID); err != nil {
		return RealtimeState{}, err
	}
	p, err := m.projectForMember(userID, teamID, projectID)
	if err != nil {
		return RealtimeState{}, err
	}
	if branch == "" {
		branch = p.DefaultBranch
	}
	if err = checkBranch(ctx, branch); err != nil {
		return RealtimeState{}, err
	}
	m.realtimeMu.Lock()
	defer m.realtimeMu.Unlock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil {
		return RealtimeState{}, err
	}
	if epoch != room.State.Epoch {
		return RealtimeState{}, fmt.Errorf("realtime_epoch_stale: refresh project mode")
	}
	if room.State.Enabled == enabled {
		return stateView(room), nil
	}
	if room.runCancel != nil {
		return RealtimeState{}, fmt.Errorf("shared run is currently in use; cancel or wait before switching mode")
	}
	// A mode transition cannot race a run/analyzer holding a project lease.
	m.resourceMu.Lock()
	key := projectResourceKey(teamID, projectID)
	active := m.projectActive[key]
	if active > 0 {
		m.resourceMu.Unlock()
		return RealtimeState{}, fmt.Errorf("project resources are currently in use")
	}
	m.realtimeChanging[key] = true
	m.projectActive[key]++
	memberKey := memberResourceKey(teamID, userID)
	m.memberActive[memberKey]++
	m.resourceMu.Unlock()
	defer func() {
		m.resourceMu.Lock()
		delete(m.realtimeChanging, key)
		delete(m.projectActive, key)
		if m.memberActive[memberKey] > 1 {
			m.memberActive[memberKey]--
		} else {
			delete(m.memberActive, memberKey)
		}
		m.resourceMu.Unlock()
	}()
	persistTransition := func(previous RealtimeState) error {
		previousProject := *p
		p.WorktreeGeneration = room.State.Epoch
		if e := m.store.SaveProject(p); e != nil {
			*p = previousProject
			room.State = previous
			return e
		}
		if e := m.persistRoomLocked(teamID, projectID, room); e != nil {
			*p = previousProject
			_ = m.store.SaveProject(p)
			room.State = previous
			return e
		}
		return nil
	}

	if enabled {
		// Only current-generation worktrees can supply the selected branch's
		// baseline. Detached upload grants from old epochs remain quarantined.
		members, e := m.store.ListMembers(teamID)
		if e != nil {
			return RealtimeState{}, e
		}
		for _, member := range members {
			worktree := m.worktreePath(teamID, projectID, member.UserID, branch)
			if _, e = os.Stat(filepath.Join(worktree, ".git")); errors.Is(e, os.ErrNotExist) {
				continue
			} else if e != nil {
				return RealtimeState{}, e
			}
			status, e := gitRun(ctx, worktree, "status", "--porcelain")
			if e != nil {
				return RealtimeState{}, e
			}
			if strings.TrimSpace(status) != "" {
				return RealtimeState{}, fmt.Errorf("all member worktrees require a clean conflict-free baseline")
			}
			ahead, e := gitRun(ctx, worktree, "rev-list", "--count", "HEAD", "--not", "--remotes=origin")
			if e != nil {
				return RealtimeState{}, e
			}
			if strings.TrimSpace(ahead) != "0" {
				return RealtimeState{}, fmt.Errorf("all member worktrees must publish pending commits before enabling realtime")
			}
		}
		info, e := m.ensureWorktreeUnchecked(ctx, p, userID, branch, true)
		if e != nil {
			return RealtimeState{}, e
		}
		if info.Dirty || len(info.Conflicts) > 0 {
			return RealtimeState{}, fmt.Errorf("clean conflict-free baseline required")
		}
		baseline, e := os.MkdirTemp(m.repoRoot(teamID, projectID), ".realtime-enable-")
		if e != nil {
			return RealtimeState{}, e
		}
		defer os.RemoveAll(baseline)
		if _, e = gitRun(ctx, "", "clone", "--branch", branch, m.repoPath(teamID, projectID), baseline); e != nil {
			return RealtimeState{}, e
		}
		files := []*RealtimeFile{}
		total := 0
		err = filepath.WalkDir(baseline, func(pth string, d os.DirEntry, e error) error {
			if e != nil {
				return e
			}
			rel, _ := filepath.Rel(baseline, pth)
			rel = filepath.ToSlash(rel)
			if rel == "." {
				return nil
			}
			if d.Name() == ".git" {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if !realtimePathValid(rel) {
				return fmt.Errorf("unsupported realtime path")
			}
			if d.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("realtime baseline cannot contain symbolic links")
			}
			if len(files) >= realtimeMaxFiles {
				return fmt.Errorf("realtime file quota exceeded")
			}
			var data []byte
			if !d.IsDir() {
				stat, e := d.Info()
				if e != nil {
					return e
				}
				if !stat.Mode().IsRegular() || stat.Size() > realtimeFileBytes {
					return fmt.Errorf("realtime file size/type unsupported")
				}
				data, e = os.ReadFile(pth)
				if e != nil {
					return e
				}
				total += len(data)
				if total > realtimeRoomBytes {
					return fmt.Errorf("realtime room quota exceeded")
				}
			}
			files = append(files, seedRealtimeFile(rel, data, d.IsDir()))
			return nil
		})
		if err != nil {
			return RealtimeState{}, err
		}
		_, nodes := roomSize(files)
		if nodes > realtimeMaxNodes {
			return RealtimeState{}, fmt.Errorf("realtime node quota exceeded")
		}
		previous := room.State
		room.State = RealtimeState{Enabled: true, Epoch: generatedID("epoch"), Branch: branch, Revision: previous.Revision + 1, Files: files, Deletions: []*RealtimeDeletion{}}
		if err = persistTransition(previous); err != nil {
			return RealtimeState{}, err
		}
	} else {
		// Export into a fresh clone and push atomically; a failed export leaves the
		// enabled room and all documents intact and retryable.
		temp, e := os.MkdirTemp(m.repoRoot(teamID, projectID), ".realtime-export-")
		if e != nil {
			return RealtimeState{}, e
		}
		defer os.RemoveAll(temp)
		if _, e = gitRun(ctx, "", "clone", "--branch", room.State.Branch, m.repoPath(teamID, projectID), temp); e != nil {
			return RealtimeState{}, e
		}
		entries, e := os.ReadDir(temp)
		if e != nil {
			return RealtimeState{}, e
		}
		for _, entry := range entries {
			if entry.Name() != ".git" {
				if e = os.RemoveAll(filepath.Join(temp, entry.Name())); e != nil {
					return RealtimeState{}, e
				}
			}
		}
		if e = writeRealtimeFiles(temp, room.State.Files); e != nil {
			return RealtimeState{}, e
		}
		if _, e = gitRun(ctx, temp, "add", "-A"); e != nil {
			return RealtimeState{}, e
		}
		status, e := gitRun(ctx, temp, "status", "--porcelain")
		if e != nil {
			return RealtimeState{}, e
		}
		if strings.TrimSpace(status) != "" {
			if _, e = gitRun(ctx, temp, "-c", "user.name=BoboCloud", "-c", "user.email=system@bobocloud.local", "commit", "-m", "Save realtime collaboration workspace"); e != nil {
				return RealtimeState{}, e
			}
			if _, e = gitRun(ctx, temp, "push", "origin", "HEAD:refs/heads/"+room.State.Branch); e != nil {
				return RealtimeState{}, e
			}
		}
		previous := room.State
		room.State.Enabled = false
		room.State.Epoch = generatedID("epoch")
		room.State.Revision++
		room.State.Files = []*RealtimeFile{}
		room.State.Run = nil
		room.State.AppliedRequests = nil
		room.State.Deletions = []*RealtimeDeletion{}
		if err = persistTransition(previous); err != nil {
			return RealtimeState{}, err
		}
	}
	room.sessions = map[string]*RealtimePresence{}
	room.requests = map[string]bool{}
	publishRealtimeState(room)
	if !enabled {
		for key, ch := range room.subscribers {
			close(ch)
			delete(room.subscribers, key)
		}
	}
	return stateView(room), nil
}

func (m *Manager) CheckpointRealtime(ctx context.Context, userID, teamID, projectID, epoch, message string) (any, error) {
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return nil, err
	}
	m.realtimeMu.Lock()
	defer m.realtimeMu.Unlock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil {
		return nil, err
	}
	if !room.State.Enabled || room.State.Epoch != epoch {
		return nil, fmt.Errorf("realtime_epoch_stale")
	}
	temp, err := os.MkdirTemp(m.repoRoot(teamID, projectID), ".realtime-version-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(temp)
	if _, err = gitRun(ctx, "", "clone", "--branch", room.State.Branch, m.repoPath(teamID, projectID), temp); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(temp)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.Name() != ".git" {
			if err = os.RemoveAll(filepath.Join(temp, entry.Name())); err != nil {
				return nil, err
			}
		}
	}
	if err = writeRealtimeFiles(temp, room.State.Files); err != nil {
		return nil, err
	}
	if _, err = gitRun(ctx, temp, "add", "-A"); err != nil {
		return nil, err
	}
	status, err := gitRun(ctx, temp, "status", "--porcelain")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(status) != "" {
		message = cleanText(message, 500)
		if message == "" {
			message = "Save realtime collaboration version"
		}
		name, email := "BoboCloud", "system@bobocloud.local"
		if m.users != nil {
			if user, e := m.users.Get(userID); e == nil {
				name = cleanText(user.Name, 100)
				email = user.UID + "@bobocloud.local"
			}
		}
		if _, err = gitRun(ctx, temp, "-c", "user.name="+name, "-c", "user.email="+email, "commit", "-m", message); err != nil {
			return nil, err
		}
		if _, err = gitRun(ctx, temp, "push", "origin", "HEAD:refs/heads/"+room.State.Branch); err != nil {
			return nil, err
		}
	}
	commit, err := gitRun(ctx, temp, "rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	return map[string]any{"commit": strings.TrimSpace(commit), "revision": room.State.Revision, "branch": room.State.Branch}, nil
}
func writeRealtimeFiles(root string, files []*RealtimeFile) error {
	for _, f := range files {
		if !realtimePathValid(f.Path) {
			return fmt.Errorf("invalid realtime file path")
		}
		target := filepath.Join(root, filepath.FromSlash(f.Path))
		if f.Directory {
			if err := os.MkdirAll(target, 0755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		data := []byte(f.Content)
		if f.Binary {
			data = f.Data
		}
		if err := os.WriteFile(target, data, 0644); err != nil {
			return err
		}
	}
	return nil
}

// WriteRealtimeSnapshot only accepts validated room paths and a new,
// server-owned staging directory supplied by the caller.
func WriteRealtimeSnapshot(root string, files []*RealtimeFile) error {
	return writeRealtimeFiles(root, files)
}

func (m *Manager) JoinRealtime(userID, name, teamID, projectID, epoch, sessionID string) (RealtimeState, <-chan any, func(), error) {
	if len(sessionID) < 8 || len(sessionID) > 96 || strings.ContainsAny(sessionID, ":\x00/\\") {
		return RealtimeState{}, nil, nil, fmt.Errorf("invalid sessionId")
	}
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return RealtimeState{}, nil, nil, err
	}
	m.realtimeMu.Lock()
	defer m.realtimeMu.Unlock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil {
		return RealtimeState{}, nil, nil, err
	}
	if !room.State.Enabled || room.State.Epoch != epoch {
		return RealtimeState{}, nil, nil, fmt.Errorf("realtime_epoch_stale: refresh project mode")
	}
	key := userID + ":" + sessionID
	if len(room.subscribers) >= 128 && room.subscribers[key] == nil {
		return RealtimeState{}, nil, nil, fmt.Errorf("realtime connection quota exceeded")
	}
	if previous := room.subscribers[key]; previous != nil {
		close(previous)
		delete(room.subscribers, key)
	}
	events := make(chan any, 128)
	room.subscribers[key] = events
	p := room.sessions[key]
	if p == nil {
		p = &RealtimePresence{UserID: userID, SessionID: sessionID, Name: name, Held: map[string]time.Time{}, Panes: []RealtimePane{}}
		room.sessions[key] = p
	}
	if m.users != nil {
		if user, err := m.users.Get(userID); err == nil {
			p.Name = user.Name
			p.Avatar = user.Avatar
		}
	}
	p.LastSeen = time.Now().UTC()
	view := stateView(room)
	publishRealtime(room, map[string]any{"type": "presence", "presence": view.Presence, "deletions": view.Deletions})
	leave := func() {
		m.realtimeMu.Lock()
		defer m.realtimeMu.Unlock()
		if room.subscribers[key] == events {
			delete(room.subscribers, key)
			close(events)
		}
	}
	return stateView(room), events, leave, nil
}
func realtimeFile(room *realtimeRoom, id string) *RealtimeFile {
	for _, f := range room.State.Files {
		if f.ID == id {
			return f
		}
	}
	return nil
}
func fileUnder(f, root *RealtimeFile) bool {
	return f.ID == root.ID || root.Directory && strings.HasPrefix(f.Path, root.Path+"/")
}

func requireRealtimeParents(room *realtimeRoom, target string) error {
	for parent := path.Dir(target); parent != "."; parent = path.Dir(parent) {
		var directory *RealtimeFile
		for _, file := range room.State.Files {
			if file.Path == parent {
				directory = file
				break
			}
		}
		if directory == nil || !directory.Directory {
			return fmt.Errorf("parent_directory_missing: create parent directories first")
		}
		if pendingDeletion(room, directory) != nil {
			return fmt.Errorf("deletion_pending: parent directory is pending deletion")
		}
	}
	return nil
}
func pendingDeletion(room *realtimeRoom, file *RealtimeFile) *RealtimeDeletion {
	for _, d := range room.State.Deletions {
		root := realtimeFile(room, d.FileID)
		if root != nil && fileUnder(file, root) {
			return d
		}
	}
	return nil
}
func userEditing(room *realtimeRoom, userID string, file *RealtimeFile, now time.Time) bool {
	for _, p := range room.sessions {
		if p.UserID != userID || now.Sub(p.LastSeen) >= 60*time.Second {
			continue
		}
		for _, pane := range p.Panes {
			f := realtimeFile(room, pane.FileID)
			if pane.Editing && f != nil && fileUnder(f, file) {
				return true
			}
		}
		for id, until := range p.Held {
			f := realtimeFile(room, id)
			if f != nil && fileUnder(f, file) && until.After(now) {
				return true
			}
		}
	}
	return false
}
func renderRealtime(nodes []RealtimeNode) (string, error) {
	children := map[string][]RealtimeNode{}
	seen := map[string]bool{}
	for _, n := range nodes {
		if seen[n.ID] {
			return "", fmt.Errorf("duplicate node")
		}
		seen[n.ID] = true
		children[n.After] = append(children[n.After], n)
	}
	for parent := range children {
		sort.Slice(children[parent], func(i, j int) bool { return children[parent][i].ID > children[parent][j].ID })
	}
	stack := append([]RealtimeNode{}, children[""]...)
	for i, j := 0, len(stack)-1; i < j; i, j = i+1, j-1 {
		stack[i], stack[j] = stack[j], stack[i]
	}
	var text strings.Builder
	visited := 0
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		visited++
		if !n.Deleted {
			text.WriteString(n.Value)
		}
		c := children[n.ID]
		for i := len(c) - 1; i >= 0; i-- {
			stack = append(stack, c[i])
		}
	}
	if visited != len(nodes) {
		return "", fmt.Errorf("orphan or cyclic node")
	}
	return text.String(), nil
}

func (m *Manager) ApplyRealtime(userID, sessionID, teamID, projectID string, op RealtimeOperation) (any, error) {
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return nil, err
	}
	if len(op.RequestID) > 128 {
		return nil, fmt.Errorf("requestId too long")
	}
	m.realtimeMu.Lock()
	defer m.realtimeMu.Unlock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil {
		return nil, err
	}
	if !room.State.Enabled || op.Epoch != room.State.Epoch {
		return nil, fmt.Errorf("realtime_epoch_stale: refresh project mode")
	}
	p := room.sessions[userID+":"+sessionID]
	if p == nil {
		return nil, fmt.Errorf("session expired; reconnect")
	}
	p.LastSeen = time.Now().UTC()
	ack := map[string]any{"type": "ack", "requestId": op.RequestID, "revision": room.State.Revision}
	key := userID + ":" + sessionID + ":" + op.RequestID
	if op.RequestID != "" && room.requests[key] {
		return ack, nil
	}
	file := realtimeFile(room, op.FileID)
	switch op.Type {
	case "heartbeat":
		return ack, nil
	case "close":
		return ack, nil
	case "open":
		if file == nil {
			return nil, fmt.Errorf("file_deleted: document does not exist")
		}
		if d := pendingDeletion(room, file); d != nil && !userEditing(room, userID, file, time.Now()) {
			return nil, fmt.Errorf("deletion_pending: new opens are blocked")
		}
		return map[string]any{"type": "document", "requestId": op.RequestID, "file": copyRealtimeFile(file, true)}, nil
	case "presence":
		if len(op.Panes) > 32 {
			return nil, fmt.Errorf("pane quota exceeded")
		}
		now := time.Now().UTC()
		newEditing := map[string]bool{}
		ids := map[string]bool{}
		for i := range op.Panes {
			pane := op.Panes[i]
			for _, old := range p.Panes {
				if old.PaneID == pane.PaneID && old.FileID == pane.FileID && old.Editing {
					pane.Editing = true
					op.Panes[i].Editing = true
				}
			}
			if len(pane.PaneID) == 0 || len(pane.PaneID) > 96 || ids[pane.PaneID] {
				return nil, fmt.Errorf("invalid pane id")
			}
			ids[pane.PaneID] = true
			f := realtimeFile(room, pane.FileID)
			if f == nil {
				continue
			}
			if d := pendingDeletion(room, f); d != nil && !userEditing(room, userID, f, now) {
				return nil, fmt.Errorf("deletion_pending: new opens are blocked")
			}
			if pane.Cursor != nil && (len(pane.Cursor.Anchor) > 160 || len(pane.Cursor.Focus) > 160) {
				return nil, fmt.Errorf("invalid cursor")
			}
			if pane.Editing {
				newEditing[pane.FileID] = true
			}
		}
		for _, old := range p.Panes {
			if old.Editing && !newEditing[old.FileID] {
				p.Held[old.FileID] = now.Add(10 * time.Second)
			}
		}
		for id := range newEditing {
			delete(p.Held, id)
		}
		p.Panes = append([]RealtimePane{}, op.Panes...)
		s := stateView(room)
		publishRealtime(room, map[string]any{"type": "presence", "presence": s.Presence, "deletions": s.Deletions})
		return ack, nil
	}
	// Snapshot only durable state for rollback. Ephemeral presence is independent.
	oldJSON, _ := json.Marshal(room.State)
	rollback := func() { _ = json.Unmarshal(oldJSON, &room.State) }
	switch op.Type {
	case "edit":
		if file == nil {
			return nil, fmt.Errorf("file_deleted: document does not exist")
		}
		if file.Binary || file.Directory {
			return nil, fmt.Errorf("unsupported text document")
		}
		if len(op.Insert)+len(op.Delete) > 327680 {
			return nil, fmt.Errorf("edit quota exceeded")
		}
		if pendingDeletion(room, file) != nil && !userEditing(room, userID, file, time.Now()) {
			return nil, fmt.Errorf("deletion_pending: only current editors may edit")
		}
		nodes := append([]RealtimeNode{}, file.Nodes...)
		index := map[string]int{}
		for i, n := range nodes {
			index[n.ID] = i
		}
		for _, n := range op.Insert {
			parts := strings.Split(n.ID, ":")
			if len(parts) != 3 || len(parts[0]) != 16 || parts[1] != sessionID || len(parts[2]) != 8 || len(n.ID) > 160 || !utf8.ValidString(n.Value) || utf8.RuneCountInString(n.Value) != 1 || strings.ContainsRune(n.Value, 0) || n.Deleted {
				return nil, fmt.Errorf("invalid RGA node")
			}
			for _, digit := range parts[0] + parts[2] {
				if digit < '0' || digit > '9' {
					return nil, fmt.Errorf("invalid RGA clock")
				}
			}
			if i, ok := index[n.ID]; ok {
				old := nodes[i]
				if old.After != n.After || old.Value != n.Value {
					return nil, fmt.Errorf("node identity collision")
				}
				continue
			}
			if n.After != "" {
				if _, ok := index[n.After]; !ok {
					return nil, fmt.Errorf("missing RGA parent; reopen document")
				}
			}
			index[n.ID] = len(nodes)
			nodes = append(nodes, n)
		}
		for _, id := range op.Delete {
			i, ok := index[id]
			if !ok {
				return nil, fmt.Errorf("missing RGA deletion target")
			}
			nodes[i].Deleted = true
		}
		content, e := renderRealtime(nodes)
		if e != nil {
			return nil, e
		}
		if len(content) > realtimeTextBytes || len(nodes) > 200000 {
			return nil, fmt.Errorf("text size quota exceeded")
		}
		file.Nodes = nodes
		file.Content = content
		file.Revision++
		active := false
		for i := range p.Panes {
			if p.Panes[i].FileID == file.ID {
				p.Panes[i].Editing = true
				active = true
			}
		}
		if !active {
			p.Held[file.ID] = time.Now().UTC().Add(10 * time.Second)
		}
	case "create":
		if !realtimePathValid(op.Path) || len(op.Content) > realtimeTextBytes || !utf8.ValidString(op.Content) || strings.ContainsRune(op.Content, 0) {
			return nil, fmt.Errorf("invalid file path or content")
		}
		if err := requireRealtimeParents(room, op.Path); err != nil {
			return nil, err
		}
		for _, f := range room.State.Files {
			if f.Path == op.Path || !f.Directory && strings.HasPrefix(op.Path, f.Path+"/") {
				return nil, fmt.Errorf("file path already exists")
			}
			if pendingDeletion(room, f) != nil && f.Directory && strings.HasPrefix(op.Path, f.Path+"/") {
				return nil, fmt.Errorf("deletion_pending")
			}
		}
		if len(room.State.Files) >= realtimeMaxFiles {
			return nil, fmt.Errorf("file count quota exceeded")
		}
		file = seedRealtimeFile(op.Path, []byte(op.Content), op.Directory)
		room.State.Files = append(room.State.Files, file)
	case "rename":
		if file == nil {
			return nil, fmt.Errorf("file_deleted")
		}
		if pendingDeletion(room, file) != nil {
			return nil, fmt.Errorf("deletion_pending")
		}
		if !realtimePathValid(op.Path) || file.Directory && strings.HasPrefix(op.Path, file.Path+"/") {
			return nil, fmt.Errorf("invalid rename path")
		}
		if err := requireRealtimeParents(room, op.Path); err != nil {
			return nil, err
		}
		for _, f := range room.State.Files {
			if !fileUnder(f, file) && (f.Path == op.Path || strings.HasPrefix(f.Path, op.Path+"/") || !f.Directory && strings.HasPrefix(op.Path, f.Path+"/")) {
				return nil, fmt.Errorf("rename target exists")
			}
		}
		old := file.Path
		moving := []*RealtimeFile{}
		for _, f := range room.State.Files {
			if fileUnder(f, file) {
				moving = append(moving, f)
			}
		}
		for _, f := range moving {
			suffix := strings.TrimPrefix(f.Path, old)
			f.Path = op.Path + suffix
			f.Revision++
		}
	case "deleteRequest":
		if file == nil {
			return nil, fmt.Errorf("file_deleted")
		}
		if pendingDeletion(room, file) != nil {
			return nil, fmt.Errorf("deletion_pending")
		}
		electorate := []string{}
		seen := map[string]bool{}
		for _, presence := range room.sessions {
			if !seen[presence.UserID] && userEditing(room, presence.UserID, file, time.Now()) {
				electorate = append(electorate, presence.UserID)
				seen[presence.UserID] = true
			}
		}
		d := &RealtimeDeletion{ID: generatedID("delete"), FileID: file.ID, RequestedBy: userID, Electorate: electorate, Consents: map[string]bool{}, ExpiresAt: time.Now().UTC().Add(180 * time.Second)}
		room.State.Deletions = append(room.State.Deletions, d)
	case "deleteVote":
		var d *RealtimeDeletion
		for _, candidate := range room.State.Deletions {
			if candidate.ID == op.DeleteID {
				d = candidate
				break
			}
		}
		if d == nil {
			return nil, fmt.Errorf("deletion request expired")
		}
		elector := false
		for _, id := range d.Electorate {
			if id == userID {
				elector = true
			}
		}
		if op.Decision == "cancel" {
			if d.RequestedBy != userID {
				return nil, fmt.Errorf("only requester may cancel")
			}
			removeRealtimeDeletion(room, d.ID)
		} else if !elector {
			return nil, fmt.Errorf("only current editor electorate may vote")
		} else if op.Decision == "veto" {
			removeRealtimeDeletion(room, d.ID)
		} else if op.Decision == "consent" {
			d.Consents[userID] = true
		} else {
			return nil, fmt.Errorf("invalid deletion vote")
		}
	default:
		return nil, fmt.Errorf("unknown collaboration operation")
	}
	bytes, nodes := roomSize(room.State.Files)
	if bytes > realtimeRoomBytes || nodes > realtimeMaxNodes {
		rollback()
		return nil, fmt.Errorf("realtime room quota exceeded")
	}
	deletionChanged := settleRealtimeDeletions(room, time.Now().UTC())
	room.State.Revision++
	if op.RequestID != "" {
		room.State.AppliedRequests = append(room.State.AppliedRequests, key)
		if len(room.State.AppliedRequests) > 4096 {
			room.State.AppliedRequests = room.State.AppliedRequests[len(room.State.AppliedRequests)-4096:]
		}
	}
	if err = m.persistRoomLocked(teamID, projectID, room); err != nil {
		rollback()
		return nil, err
	}
	if op.RequestID != "" {
		if len(room.requests) >= 4096 {
			room.requests = map[string]bool{}
			for _, request := range room.State.AppliedRequests {
				room.requests[request] = true
			}
		}
		room.requests[key] = true
	}
	ack["revision"] = room.State.Revision
	if op.Type == "edit" {
		publishRealtime(room, map[string]any{"type": "operation", "requestId": op.RequestID, "fileId": file.ID, "revision": file.Revision, "insert": op.Insert, "delete": op.Delete})
		s := stateView(room)
		publishRealtime(room, map[string]any{"type": "presence", "presence": s.Presence, "deletions": s.Deletions})
		if deletionChanged {
			publishRealtimeState(room)
		}
	} else {
		publishRealtimeState(room)
	}
	return ack, nil
}
func removeRealtimeDeletion(room *realtimeRoom, id string) {
	ds := []*RealtimeDeletion{}
	for _, d := range room.State.Deletions {
		if d.ID != id {
			ds = append(ds, d)
		}
	}
	room.State.Deletions = ds
}
func settleRealtimeDeletions(room *realtimeRoom, now time.Time) bool {
	changed := false
	for _, d := range append([]*RealtimeDeletion{}, room.State.Deletions...) {
		f := realtimeFile(room, d.FileID)
		if !now.Before(d.ExpiresAt) || f == nil {
			removeRealtimeDeletion(room, d.ID)
			changed = true
			continue
		}
		ready := true
		for _, user := range d.Electorate {
			if !d.Consents[user] && userEditing(room, user, f, now) {
				ready = false
				break
			}
		}
		if ready {
			files := []*RealtimeFile{}
			for _, candidate := range room.State.Files {
				if !fileUnder(candidate, f) {
					files = append(files, candidate)
				}
			}
			room.State.Files = files
			removeRealtimeDeletion(room, d.ID)
			changed = true
		}
	}
	return changed
}
func (m *Manager) SweepRealtime(teamID, projectID string) {
	m.realtimeMu.Lock()
	defer m.realtimeMu.Unlock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil {
		return
	}
	now := time.Now().UTC()
	changed := false
	for key, p := range room.sessions {
		if _, err := m.projectForMember(p.UserID, teamID, projectID); err != nil || now.Sub(p.LastSeen) >= 60*time.Second {
			delete(room.sessions, key)
			if ch := room.subscribers[key]; ch != nil {
				close(ch)
				delete(room.subscribers, key)
			}
			changed = true
			continue
		}
		for id, until := range p.Held {
			if !until.After(now) {
				delete(p.Held, id)
				changed = true
			}
		}
	}
	old, _ := json.Marshal(room.State)
	if settleRealtimeDeletions(room, now) {
		room.State.Revision++
		if err = m.persistRoomLocked(teamID, projectID, room); err != nil {
			_ = json.Unmarshal(old, &room.State)
		} else {
			changed = true
		}
	}
	if changed {
		publishRealtimeState(room)
	}
}

// BeginRealtimeRun captures the exact source generation; allocation and disk
// materialization happen later, after the normal execution resource admission.
func (m *Manager) BeginRealtimeRun(userID, teamID, projectID, epoch, runID string, cancel context.CancelFunc, input func(string) error) error {
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return err
	}
	m.realtimeMu.Lock()
	defer m.realtimeMu.Unlock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil {
		return err
	}
	if !room.State.Enabled || room.State.Epoch != epoch {
		return fmt.Errorf("realtime_epoch_stale")
	}
	if room.runCancel != nil {
		return fmt.Errorf("shared run already active")
	}
	room.runFiles = make([]*RealtimeFile, 0, len(room.State.Files))
	for _, f := range room.State.Files {
		room.runFiles = append(room.runFiles, copyRealtimeFile(f, true))
	}
	previous := room.State.Run
	room.State.Run = &RealtimeRun{ID: runID, Status: "running", StarterUserID: userID, Events: []any{}}
	if err = m.persistRoomLocked(teamID, projectID, room); err != nil {
		room.State.Run = previous
		room.runFiles = nil
		return err
	}
	room.runCancel = cancel
	room.runInput = input
	room.runEventBytes = 0
	publishRealtimeState(room)
	return nil
}
func (m *Manager) MaterializeRealtimeRun(userID, teamID, projectID, epoch, runID string) (string, error) {
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return "", err
	}
	m.realtimeMu.Lock()
	defer m.realtimeMu.Unlock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil {
		return "", err
	}
	if room.State.Epoch != epoch || room.State.Run == nil || room.State.Run.ID != runID || room.runCancel == nil {
		return "", fmt.Errorf("stale shared run")
	}
	target := filepath.Join(m.repoRoot(teamID, projectID), "realtime-runs", safeFSName(runID))
	if err = os.MkdirAll(target, 0700); err != nil {
		return "", err
	}
	if err = writeRealtimeFiles(target, room.runFiles); err != nil {
		_ = os.RemoveAll(target)
		return "", err
	}
	return target, nil
}
func (m *Manager) PublishRealtimeRunEvent(teamID, projectID, runID string, event any) {
	m.realtimeMu.Lock()
	defer m.realtimeMu.Unlock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil || room.State.Run == nil || room.State.Run.ID != runID {
		return
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return
	}
	if len(encoded) <= realtimeRunBytes {
		room.State.Run.Events = append(room.State.Run.Events, event)
		room.runEventBytes += len(encoded)
		for room.runEventBytes > realtimeRunBytes && len(room.State.Run.Events) > 0 {
			first, _ := json.Marshal(room.State.Run.Events[0])
			room.runEventBytes -= len(first)
			room.State.Run.Events = room.State.Run.Events[1:]
			room.State.Run.Omitted = true
		}
	} else {
		room.State.Run.Omitted = true
	}
	publishRealtime(room, map[string]any{"type": "runEvent", "runId": runID, "event": event})
}
func (m *Manager) FinishRealtimeRun(teamID, projectID, runID, status string) {
	m.realtimeMu.Lock()
	defer m.realtimeMu.Unlock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil || room.State.Run == nil || room.State.Run.ID != runID {
		return
	}
	room.State.Run.Status = status
	room.runCancel = nil
	room.runInput = nil
	room.runFiles = nil
	_ = m.persistRoomLocked(teamID, projectID, room)
	_ = os.RemoveAll(filepath.Join(m.repoRoot(teamID, projectID), "realtime-runs", safeFSName(runID)))
	publishRealtimeState(room)
}
func (m *Manager) ControlRealtimeRun(userID, teamID, projectID, epoch, kind, data string) error {
	if _, err := m.projectForMember(userID, teamID, projectID); err != nil {
		return err
	}
	m.realtimeMu.Lock()
	room, err := m.roomLocked(teamID, projectID)
	if err != nil {
		m.realtimeMu.Unlock()
		return err
	}
	if room.State.Epoch != epoch || !room.State.Enabled {
		m.realtimeMu.Unlock()
		return fmt.Errorf("realtime_epoch_stale")
	}
	cancel, input := room.runCancel, room.runInput
	m.realtimeMu.Unlock()
	if cancel == nil {
		return fmt.Errorf("no shared run active")
	}
	if kind == "cancelRun" {
		cancel()
		return nil
	}
	if kind == "stdin" && input != nil && len(data) <= 64<<10 {
		return input(data)
	}
	return fmt.Errorf("invalid shared run input")
}
