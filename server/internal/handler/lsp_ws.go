package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/buildcache"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"

	"github.com/gorilla/websocket"
)

var lspUpgrader = websocket.Upgrader{
	ReadBufferSize:    8192,
	WriteBufferSize:   8192,
	EnableCompression: true,
	CheckOrigin:       func(_ *http.Request) bool { return true },
}

type lspWorkspaceStart struct {
	Kind       string `json:"kind"`
	TeamID     string `json:"teamId,omitempty"`
	ProjectID  string `json:"projectId,omitempty"`
	Branch     string `json:"branch,omitempty"`
	FolderName string `json:"folderName,omitempty"`
	FolderKey  string `json:"folderKey,omitempty"`
}

type lspStartMessage struct {
	Type          string            `json:"type"`
	Token         string            `json:"token"`
	Mode          string            `json:"mode"`
	LanguageID    string            `json:"languageId"`
	RuntimeID     string            `json:"runtimeId"`
	Workspace     lspWorkspaceStart `json:"workspace"`
	SetupCommands []string          `json:"setupCommands,omitempty"`
}

type lspControlMessage struct {
	Type         string `json:"type"`
	Scope        string `json:"scope,omitempty"`
	ProjectID    string `json:"projectId,omitempty"`
	NamespaceKey string `json:"namespaceKey,omitempty"`
	RequestID    string `json:"requestId,omitempty"`
	Cursor       string `json:"cursor,omitempty"`
	MaxBytes     int    `json:"maxBytes,omitempty"`
}

func validLSPSetupCommands(commands []string) bool {
	return validateRunArgs(commands) == nil
}

type byteWindow struct {
	mu      sync.Mutex
	limit   int64
	used    int64
	started time.Time
}

type dependencyIndexRequestGate struct {
	mu        sync.Mutex
	active    int
	used      int
	started   time.Time
	maxActive int
	maxPerMin int
}

func newDependencyIndexRequestGate() *dependencyIndexRequestGate {
	// A durable index is capped at 5 MiB. At the advertised 64 KiB minimum
	// page size it still fits within the published 128-page envelope. Keep the
	// same request bound so a client is never silently left with a partial
	// index merely because it selected a valid smaller page size. Concurrency
	// remains tightly bounded, including cache hits.
	return &dependencyIndexRequestGate{started: time.Now(), maxActive: 2, maxPerMin: lsp.DependencyAPIIndexMaxPages}
}

func (g *dependencyIndexRequestGate) acquire() (bool, int64) {
	if g == nil {
		return false, 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	if now.Sub(g.started) >= time.Minute {
		g.started, g.used = now, 0
	}
	if g.active >= g.maxActive {
		return false, 200
	}
	if g.used >= g.maxPerMin {
		return false, maxInt64(1, (time.Minute - now.Sub(g.started)).Milliseconds())
	}
	g.active++
	g.used++
	return true, 0
}

func (g *dependencyIndexRequestGate) release() {
	if g == nil {
		return
	}
	g.mu.Lock()
	if g.active > 0 {
		g.active--
	}
	g.mu.Unlock()
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func newByteWindow(limit int64) *byteWindow {
	return &byteWindow{limit: limit, started: time.Now()}
}

func (w *byteWindow) allow(size int) bool {
	if w.limit <= 0 {
		return true
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	now := time.Now()
	if now.Sub(w.started) >= time.Minute {
		w.started, w.used = now, 0
	}
	if int64(size) > w.limit-w.used {
		return false
	}
	w.used += int64(size)
	return true
}

func (h *WSHandler) authenticateLSP(token string) (*auth.User, error) {
	if !h.AuthEnabled {
		return &auth.User{ID: "default", Username: "default", Name: "Default User", Role: auth.RoleRoot}, nil
	}
	token = strings.TrimSpace(strings.TrimPrefix(token, "Bearer "))
	if token == "" {
		return nil, fmt.Errorf("authentication required")
	}
	if h.AuthSessions != nil {
		if session, err := h.AuthSessions.Validate(token, h.Config.SessionTokenTTL()); err == nil {
			if user, getErr := h.UserStore.Get(session.UserID); getErr == nil && !user.Disabled {
				return user, nil
			}
		}
	}
	if h.Authenticator != nil {
		if user, err := h.Authenticator.Validate(token); err == nil && !user.Disabled {
			return user, nil
		}
	}
	return nil, fmt.Errorf("invalid or expired credential")
}

func canonicalRuntimeLanguage(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "javascript", "typescript", "javascriptreact", "typescriptreact", "node", "js", "ts":
		return "node"
	case "c++":
		return "cpp"
	case "py":
		return "python"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func compatibleRuntimeLanguage(requested, runtime string) bool {
	requested, runtime = canonicalRuntimeLanguage(requested), canonicalRuntimeLanguage(runtime)
	return requested == runtime || (requested == "cpp" && runtime == "c") || (requested == "c" && runtime == "cpp")
}

func appendExistingDependencyRoot(roots []string, value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return roots
	}
	abs, err := filepath.Abs(value)
	if err != nil {
		return roots
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return roots
	}
	for _, root := range roots {
		if filepath.Clean(root) == filepath.Clean(abs) {
			return roots
		}
	}
	return append(roots, abs)
}

func trustedDependencyChild(base, child string) (string, error) {
	base, err := filepath.Abs(base)
	if err != nil {
		return "", err
	}
	candidate, err := filepath.Abs(filepath.Join(base, child))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(base, candidate)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("dependency path is outside the user data root")
	}
	return candidate, nil
}

type personalProjectDependencyView struct {
	Root       string
	Generation string
	Extra      map[string][]string
	Release    func()
}

func projectLockDependencyLanguage(languageID string) bool {
	switch canonicalRuntimeLanguage(languageID) {
	case "python", "node", "go", "rust", "java":
		return true
	default:
		return false
	}
}

func (h *WSHandler) resolveAnalysisDependencies(userID, teamID, runtimeID, languageID, remoteRoot, workspaceID, sharedHost, snapshotRoot, generation string, project personalProjectDependencyView) (lsp.AnalysisDependencyRequest, lsp.AnalysisDependencyView, bool) {
	ownerKind, ownerID := "user", userID
	if teamID != "" {
		ownerKind, ownerID = "team", teamID
	}
	projectScoped := teamID == "" && h.PersonalCache != nil && h.PersonalCache.ScopeMode() == "project-lock" && projectLockDependencyLanguage(languageID)
	if projectScoped {
		// Project-lock is the source of truth for personal dependencies. The old
		// personal snapshot store remains CRUD-visible, but must never repopulate
		// a deleted or changed project digest through an analyzer fallback.
		snapshotRoot = ""
	}
	request := lsp.AnalysisDependencyRequest{
		OwnerKind: ownerKind, OwnerID: ownerID, UserID: userID,
		WorkspaceID: workspaceID, RuntimeID: runtimeID, LanguageID: languageID, Generation: generation,
		Paths: lsp.AnalysisDependencyPaths{WorkspaceRoot: remoteRoot, SnapshotRoot: snapshotRoot},
	}
	if h.Config != nil {
		userBase := filepath.Join(h.Config.DataDir, "users")
		if userRoot, err := trustedDependencyChild(userBase, userID); err == nil {
			if !projectScoped {
				request.Paths.UserPersistRoot = filepath.Join(userRoot, "persist")
			}
			request.Paths.AllowedRoots = appendExistingDependencyRoot(request.Paths.AllowedRoots, userRoot)
		}
	}
	request.Paths.SharedCacheRoot = sharedHost
	if project.Root != "" {
		request.Paths.Extra = project.Extra
		request.Paths.AllowedRoots = appendExistingDependencyRoot(request.Paths.AllowedRoots, project.Root)
	}
	request.Paths.AllowedRoots = appendExistingDependencyRoot(request.Paths.AllowedRoots, sharedHost)
	request.Paths.AllowedRoots = appendExistingDependencyRoot(request.Paths.AllowedRoots, snapshotRoot)
	request.Paths.AllowedRoots = appendExistingDependencyRoot(request.Paths.AllowedRoots, remoteRoot)
	if h.DependencyViews == nil {
		return request, lsp.AnalysisDependencyView{}, false
	}
	view, err := h.DependencyViews.Resolve(request)
	if err != nil {
		slog.Warn("LSP dependency view unavailable", "user_id", userID, "team_id", teamID, "runtime", runtimeID, "language", languageID, "error", err)
		return request, lsp.AnalysisDependencyView{}, false
	}
	return request, view, true
}

func (h *WSHandler) resolvePersonalProjectDependencies(userID, workspaceID, workspaceName, runtimeID, runtimeImage, languageID, remoteRoot string, setupCommands []string) personalProjectDependencyView {
	if h == nil || h.PersonalCache == nil || h.PersonalCache.ScopeMode() != "project-lock" || runtimeID == "" || runtimeID == "local" || !projectLockDependencyLanguage(languageID) {
		return personalProjectDependencyView{}
	}
	language := canonicalRuntimeLanguage(languageID)
	request := personalcache.Request{
		UserID: userID, WorkspaceID: workspaceID, WorkspaceName: workspaceName,
		RuntimeID: runtimeID, RuntimeFingerprint: personalCacheRuntimeFingerprint(runtimeID, runtimeImage), Language: language, WorkspaceRoot: remoteRoot,
		SetupCommands: setupCommands, QuotaBytes: userQuotaBytes(h.UserStore, userID),
	}
	var reader *personalcache.ReadLease
	var entry personalcache.Entry
	if language == "python" {
		var inventory personalcache.InventoryInspection
		reader, entry, inventory = h.PersonalCache.AcquirePackageInventoryRead(request)
		if reader == nil || inventory.State != "ready" || !inventory.Exact {
			return personalProjectDependencyView{}
		}
		root := filepath.Join(entry.HostPath, "python")
		if !realDependencyDirectory(root) {
			reader.Release()
			return personalProjectDependencyView{}
		}
		return personalProjectDependencyView{
			Root: entry.HostPath, Generation: "project-lock:" + entry.Digest + ":" + inventory.Revision,
			Extra: map[string][]string{lsp.DependencyRolePythonPackages: {root}}, Release: reader.Release,
		}
	}
	var exists bool
	var err error
	reader, entry, exists, err = h.PersonalCache.AcquireRead(request)
	if err != nil || !exists || reader == nil {
		return personalProjectDependencyView{}
	}
	extra := personalProjectDependencyPaths(entry.HostPath, language)
	if len(extra) == 0 {
		reader.Release()
		return personalProjectDependencyView{}
	}
	return personalProjectDependencyView{Root: entry.HostPath, Generation: "project-lock:" + entry.Digest, Extra: extra, Release: reader.Release}
}

func personalProjectDependencyPaths(root, language string) map[string][]string {
	result := make(map[string][]string)
	add := func(role string, parts ...string) {
		candidate := filepath.Join(append([]string{root}, parts...)...)
		if realDependencyDirectory(candidate) {
			result[role] = append(result[role], candidate)
		}
	}
	switch language {
	case "node":
		add(lsp.DependencyRoleNodeModules, "node_modules")
	case "go":
		add(lsp.DependencyRoleGoModules, "go", "pkg", "mod")
	case "rust":
		add(lsp.DependencyRoleRustCargoHome, "cargo")
	case "java":
		add(lsp.DependencyRoleJavaMaven, "maven")
		add(lsp.DependencyRoleJavaGradle, "gradle")
	}
	return result
}

func realDependencyDirectory(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0
}

func sameDependencyRoot(left, right string) bool {
	if strings.TrimSpace(left) == "" || strings.TrimSpace(right) == "" {
		return false
	}
	leftResolved, leftErr := filepath.EvalSymlinks(left)
	rightResolved, rightErr := filepath.EvalSymlinks(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	leftResolved, leftErr = filepath.Abs(leftResolved)
	rightResolved, rightErr = filepath.Abs(rightResolved)
	return leftErr == nil && rightErr == nil && filepath.Clean(leftResolved) == filepath.Clean(rightResolved)
}

func retainResolvedTeamDependencies(lease *buildcache.SharedDependencies, view lsp.AnalysisDependencyView, snapshotRoot string) *lsp.SharedDependencies {
	if lease == nil {
		return nil
	}
	usesShared := view.UsesHostRoot(lease.SharedHost)
	// SnapshotRoot contributes the O(1) dependency generation to Revision even
	// when this language has no project dependency mount. Keep that root pinned
	// until Process.Wait so Clear/Enforce cannot invalidate refresh decisions.
	usesProject := view.UsesHostRoot(lease.DependencyHost) || sameDependencyRoot(snapshotRoot, lease.DependencyHost)
	if !usesShared {
		lease.ReleaseSharedCache()
	}
	if !usesProject {
		lease.ReleaseProjectDependencies()
	}
	if !usesShared && !usesProject {
		return nil
	}
	return &lsp.SharedDependencies{Release: lease.Release}
}

func combineLSPResourceReleases(releases ...func()) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			for _, release := range releases {
				if release != nil {
					release()
				}
			}
		})
	}
}

func requestedLSPWorkspaceActivityKey(request lspWorkspaceStart) (string, error) {
	switch request.Kind {
	case "team":
		return "", nil
	case "personal":
		key := strings.TrimSpace(request.FolderKey)
		if key == "" {
			key = strings.TrimSpace(request.FolderName)
		}
		if key == "" {
			return "", fmt.Errorf("folderName or folderKey is required")
		}
		return key, nil
	default:
		return "", fmt.Errorf("workspace kind must be team or personal")
	}
}

func (h *WSHandler) acquireLSPActivity(userID, workspaceKey string) (func(), error) {
	if h.Lifecycle == nil {
		return func() {}, nil
	}
	activity, err := h.Lifecycle.AcquireActivity(userID, workspaceKey)
	if err != nil {
		return nil, err
	}
	return activity.Release, nil
}

func (h *WSHandler) acquireLSPProjectActivity(userID, teamID, projectID string) (func(), error) {
	if h.Collaboration == nil {
		return nil, fmt.Errorf("team workspace is unavailable")
	}
	activity, err := h.Collaboration.AcquireProjectActivity(userID, teamID, projectID)
	if err != nil {
		return nil, err
	}
	return activity.Release, nil
}

func (h *WSHandler) revalidateLSPWorkspace(remoteRoot, teamID, projectID string) error {
	info, err := os.Lstat(remoteRoot)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("workspace no longer exists")
	}
	if teamID == "" {
		return nil
	}
	if h.Collaboration == nil {
		return fmt.Errorf("team project not found")
	}
	project, err := h.Collaboration.Store().GetProject(projectID)
	if err != nil || project.TeamID != teamID {
		return fmt.Errorf("team project not found")
	}
	return nil
}

func (h *WSHandler) resolveLSPWorkspace(ctx context.Context, user *auth.User, request lspWorkspaceStart) (root, folderKey, teamID, projectID, branch string, err error) {
	switch request.Kind {
	case "team":
		if h.Collaboration == nil || request.TeamID == "" || request.ProjectID == "" {
			return "", "", "", "", "", fmt.Errorf("teamId and projectId are required")
		}
		root, err = h.Collaboration.ResolveWorktree(ctx, user.ID, request.TeamID, request.ProjectID, request.Branch)
		if err != nil {
			return "", "", "", "", "", err
		}
		project, projectErr := h.Collaboration.Store().GetProject(request.ProjectID)
		if projectErr != nil || project.TeamID != request.TeamID {
			return "", "", "", "", "", fmt.Errorf("team project not found")
		}
		branch = request.Branch
		if branch == "" {
			branch = project.DefaultBranch
		}
		return root, "", request.TeamID, request.ProjectID, branch, nil
	case "personal":
		key := strings.TrimSpace(request.FolderKey)
		if key == "" {
			key = strings.TrimSpace(request.FolderName)
		}
		if key == "" {
			return "", "", "", "", "", fmt.Errorf("folderName or folderKey is required")
		}
		base := h.Config.ServerRoot
		if h.AuthEnabled {
			base = filepath.Join(h.Config.DataDir, "users", user.ID, "workspaces")
		}
		root, err = safePath(base, key)
		if err != nil {
			return "", "", "", "", "", err
		}
		if info, statErr := os.Stat(root); statErr != nil || !info.IsDir() {
			return "", "", "", "", "", fmt.Errorf("workspace does not exist")
		}
		return root, key, "", "", "", nil
	default:
		return "", "", "", "", "", fmt.Errorf("workspace kind must be team or personal")
	}
}

func writeLSPError(conn *websocket.Conn, code, message string) {
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	defer conn.SetWriteDeadline(time.Time{})
	_ = conn.WriteJSON(map[string]any{"type": "lsp.error", "code": code, "message": message})
}

func rpcError(id json.RawMessage, code int, message string) []byte {
	if len(id) == 0 {
		return nil
	}
	value := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "error": map[string]any{"code": code, "message": message}}
	data, _ := json.Marshal(value)
	return data
}

func rpcMethodAndURI(raw []byte) (method, uri string) {
	var value struct {
		Method string `json:"method"`
		Params struct {
			TextDocument struct {
				URI string `json:"uri"`
			} `json:"textDocument"`
			URI string `json:"uri"`
		} `json:"params"`
	}
	if json.Unmarshal(raw, &value) != nil {
		return "", ""
	}
	uri = value.Params.TextDocument.URI
	if uri == "" {
		uri = value.Params.URI
	}
	return value.Method, uri
}

const maxPendingWorkspaceConfigurations = 64

const workspaceConfigurationResponseTimeout = 15 * time.Second

var (
	errPendingWorkspaceConfigurationClosed    = errors.New("workspace configuration queue is closed")
	errPendingWorkspaceConfigurationDuplicate = errors.New("workspace configuration request id is already pending")
	errPendingWorkspaceConfigurationFull      = errors.New("too many workspace configuration requests are pending")
)

type pendingWorkspaceConfiguration struct {
	proxy *lsp.WorkspaceConfigurationProxy
	timer *time.Timer
}

type pendingWorkspaceConfigurations struct {
	mu        sync.Mutex
	entries   map[string]*pendingWorkspaceConfiguration
	timeout   time.Duration
	callbacks sync.WaitGroup
	closed    bool
}

func newPendingWorkspaceConfigurations() *pendingWorkspaceConfigurations {
	return newPendingWorkspaceConfigurationsWithTimeout(workspaceConfigurationResponseTimeout)
}

func newPendingWorkspaceConfigurationsWithTimeout(timeout time.Duration) *pendingWorkspaceConfigurations {
	if timeout <= 0 {
		timeout = workspaceConfigurationResponseTimeout
	}
	return &pendingWorkspaceConfigurations{
		entries: make(map[string]*pendingWorkspaceConfiguration),
		timeout: timeout,
	}
}

func (p *pendingWorkspaceConfigurations) add(proxy *lsp.WorkspaceConfigurationProxy, onExpire func(*lsp.WorkspaceConfigurationProxy)) error {
	if p == nil || proxy == nil || proxy.IDKey() == "" {
		return fmt.Errorf("workspace configuration proxy is required")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return errPendingWorkspaceConfigurationClosed
	}
	if _, exists := p.entries[proxy.IDKey()]; exists {
		return errPendingWorkspaceConfigurationDuplicate
	}
	if len(p.entries) >= maxPendingWorkspaceConfigurations {
		return errPendingWorkspaceConfigurationFull
	}
	key := proxy.IDKey()
	entry := &pendingWorkspaceConfiguration{proxy: proxy}
	p.entries[key] = entry
	p.callbacks.Add(1)
	entry.timer = time.AfterFunc(p.timeout, func() {
		defer p.callbacks.Done()
		p.mu.Lock()
		current, exists := p.entries[key]
		if !exists || current != entry || p.closed {
			p.mu.Unlock()
			return
		}
		delete(p.entries, key)
		p.mu.Unlock()
		if onExpire != nil {
			onExpire(proxy)
		}
	})
	return nil
}

func (p *pendingWorkspaceConfigurations) take(payload []byte) (*lsp.WorkspaceConfigurationProxy, bool, error) {
	if p == nil {
		return nil, false, fmt.Errorf("workspace configuration queue is required")
	}
	key, err := lsp.WorkspaceConfigurationResponseKey(payload)
	if err != nil {
		return nil, false, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	entry, exists := p.entries[key]
	if exists {
		delete(p.entries, key)
		if entry.timer.Stop() {
			p.callbacks.Done()
		}
	}
	if !exists {
		return nil, false, nil
	}
	return entry.proxy, true, nil
}

func (p *pendingWorkspaceConfigurations) discard(key string) {
	if p == nil || key == "" {
		return
	}
	p.mu.Lock()
	if entry, exists := p.entries[key]; exists {
		delete(p.entries, key)
		if entry.timer.Stop() {
			p.callbacks.Done()
		}
	}
	p.mu.Unlock()
}

func (p *pendingWorkspaceConfigurations) clear() {
	if p == nil {
		return
	}
	p.mu.Lock()
	if !p.closed {
		p.closed = true
		for key, entry := range p.entries {
			delete(p.entries, key)
			if entry.timer.Stop() {
				p.callbacks.Done()
			}
		}
	}
	p.mu.Unlock()
	p.callbacks.Wait()
}

func (p *pendingWorkspaceConfigurations) count() int {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.entries)
}

// HandleLSPWebSocket bridges virtual-URI JSON-RPC messages to an isolated
// stdio language server process.
func (h *WSHandler) HandleLSPWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := lspUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.EnableWriteCompression(true)
	maxMessage := h.Config.LSPMaxMessageBytes
	if maxMessage <= 0 {
		maxMessage = 1 << 20
	}
	conn.SetReadLimit(int64(maxMessage))
	conn.SetReadDeadline(time.Now().Add(15 * time.Second))

	_, rawStart, err := conn.ReadMessage()
	if err != nil {
		return
	}
	var start lspStartMessage
	if json.Unmarshal(rawStart, &start) != nil || start.Type != "lsp.start" {
		writeLSPError(conn, "invalid_start", "first message must be type lsp.start")
		return
	}
	if !validLSPSetupCommands(start.SetupCommands) {
		writeLSPError(conn, "invalid_start", "dependency setup command fingerprint is invalid")
		return
	}
	mode, err := lsp.ParseMode(start.Mode)
	if err != nil {
		writeLSPError(conn, "invalid_mode", err.Error())
		return
	}
	user, err := h.authenticateLSP(start.Token)
	if err != nil {
		writeLSPError(conn, "unauthorized", err.Error())
		return
	}
	if mode == lsp.ModeLocal {
		_ = conn.WriteJSON(map[string]any{"type": "lsp.ready", "sessionId": "", "capabilities": map[string]any{"mode": mode, "remote": false, "methods": []string{}}, "cache": nil})
		return
	}
	if h.LSP == nil || !h.Config.LSPEnabled {
		writeLSPError(conn, "unavailable", "remote LSP is disabled")
		return
	}
	workspaceActivityKey, err := requestedLSPWorkspaceActivityKey(start.Workspace)
	if err != nil {
		writeLSPError(conn, "workspace_denied", err.Error())
		return
	}
	activityRelease, err := h.acquireLSPActivity(user.ID, workspaceActivityKey)
	if err != nil {
		writeLSPError(conn, "resources_in_use", err.Error())
		return
	}
	pendingResourceRelease := combineLSPResourceReleases(activityRelease)
	defer func() {
		if pendingResourceRelease != nil {
			pendingResourceRelease()
		}
	}()
	if start.Workspace.Kind == "team" {
		projectActivityRelease, activityErr := h.acquireLSPProjectActivity(user.ID, start.Workspace.TeamID, start.Workspace.ProjectID)
		if activityErr != nil {
			writeLSPError(conn, "workspace_denied", activityErr.Error())
			return
		}
		pendingResourceRelease = combineLSPResourceReleases(projectActivityRelease, activityRelease)
	}
	setupCtx, cancelSetup := context.WithTimeout(r.Context(), 30*time.Second)
	remoteRoot, folderKey, teamID, projectID, branch, err := h.resolveLSPWorkspace(setupCtx, user, start.Workspace)
	cancelSetup()
	if err != nil {
		writeLSPError(conn, "workspace_denied", err.Error())
		return
	}
	runtimeID := strings.TrimSpace(start.RuntimeID)
	runtimeImage := ""
	if runtimeID == "" || runtimeID == "local" {
		runtimeID = "local"
	} else {
		runtime := model.GetRuntimeDef(runtimeID)
		if runtime == nil {
			writeLSPError(conn, "invalid_runtime", "unknown runtime: "+runtimeID)
			return
		}
		if !compatibleRuntimeLanguage(start.LanguageID, runtime.Language) {
			writeLSPError(conn, "runtime_mismatch", "runtime language does not match the editor language")
			return
		}
		runtimeImage = runtime.DockerImage
	}
	var teamDependencies *buildcache.SharedDependencies
	sharedHost, snapshotRoot, dependencyGeneration := "", "", ""
	if teamID != "" && h.BuildCache != nil {
		cacheRuntime := "local"
		if runtimeID != "local" {
			cacheRuntime = "docker-" + runtimeID
		}
		dependencyLease, dependencyErr := h.BuildCache.SharedDependencies(buildcache.BuildContext{TeamID: teamID, ProjectID: projectID, Branch: branch, Runtime: cacheRuntime, Language: canonicalRuntimeLanguage(start.LanguageID)})
		if dependencyErr != nil {
			writeLSPError(conn, "cache_error", dependencyErr.Error())
			return
		}
		sharedHost, dependencyGeneration = dependencyLease.SharedHost, dependencyLease.ContainerKey
		snapshotRoot = dependencyLease.DependencyHost
		teamDependencies = dependencyLease
	} else if teamID == "" {
		dependencyLease, dependencyErr := lsp.AcquirePersonalDependencyStore(h.Config.DataDir, user.ID)
		if dependencyErr != nil {
			writeLSPError(conn, "cache_error", dependencyErr.Error())
			return
		}
		snapshotRoot = dependencyLease.Root
		pendingResourceRelease = combineLSPResourceReleases(dependencyLease.Release, activityRelease)
	}
	workspaceID := lsp.StableWorkspaceIdentity(user.ID, teamID, projectID, branch, folderKey)
	projectDependencies := personalProjectDependencyView{}
	if teamID == "" {
		projectDependencies = h.resolvePersonalProjectDependencies(
			user.ID, workspaceID, start.Workspace.FolderName, runtimeID, runtimeImage, start.LanguageID, remoteRoot, start.SetupCommands,
		)
		if projectDependencies.Generation != "" {
			dependencyGeneration = projectDependencies.Generation
		}
		if projectDependencies.Release != nil {
			pendingResourceRelease = combineLSPResourceReleases(projectDependencies.Release, pendingResourceRelease)
		}
	}
	dependencyRequest, dependencyView, dependencyResolved := h.resolveAnalysisDependencies(user.ID, teamID, runtimeID, start.LanguageID, remoteRoot, workspaceID, sharedHost, snapshotRoot, dependencyGeneration, projectDependencies)
	if projectDependencies.Release != nil && (!dependencyResolved || !dependencyView.UsesHostRoot(projectDependencies.Root)) {
		projectDependencies.Release()
	}
	if err := h.revalidateLSPWorkspace(remoteRoot, teamID, projectID); err != nil {
		if teamDependencies != nil {
			teamDependencies.Release()
		}
		writeLSPError(conn, "workspace_denied", err.Error())
		return
	}
	shared := retainResolvedTeamDependencies(teamDependencies, dependencyView, dependencyRequest.Paths.SnapshotRoot)
	sessionResourceRelease := pendingResourceRelease
	pendingResourceRelease = nil
	session, err := h.LSP.Start(lsp.SessionContext{UserID: user.ID, WorkspaceKind: start.Workspace.Kind, TeamID: teamID, ProjectID: projectID, Branch: branch, FolderKey: folderKey, RuntimeID: runtimeID, RuntimeImage: runtimeImage, LanguageID: start.LanguageID, Mode: mode, RemoteRoot: remoteRoot, DependencyRequest: dependencyRequest, DependencyView: dependencyView, DependencyResolved: dependencyResolved, SharedDependencies: shared, DependencyStoreRelease: sessionResourceRelease})
	if err != nil {
		writeLSPError(conn, "start_failed", err.Error())
		return
	}
	if teamID != "" && h.Collaboration != nil && !h.Collaboration.IsMember(user.ID, teamID) {
		session.Stop()
		writeLSPError(conn, "forbidden", "team membership changed while the analysis service was starting")
		return
	}
	defer session.Stop()
	mapper := session.URIMapper()
	if mapper == nil {
		writeLSPError(conn, "workspace_error", "language server workspace mapper is unavailable")
		return
	}
	conn.SetReadDeadline(time.Time{})

	budget := newByteWindow(h.Config.LSPBandwidthPerMinuteBytes)
	var writeMu sync.Mutex
	writeWait := h.Config.WSWriteWaitDuration()
	if writeWait <= 0 {
		writeWait = 10 * time.Second
	}
	writeJSON := func(value any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
			return err
		}
		return conn.WriteJSON(value)
	}
	writeRaw := func(payload []byte) error {
		if !budget.allow(len(payload)) {
			return fmt.Errorf("LSP bandwidth limit exceeded")
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
			return err
		}
		return conn.WriteMessage(websocket.TextMessage, payload)
	}
	writeBoundedControlJSON := func(value any) error {
		payload, err := json.Marshal(value)
		if err != nil {
			return err
		}
		if !budget.allow(len(payload)) {
			return fmt.Errorf("LSP bandwidth limit exceeded")
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
			return err
		}
		return conn.WriteMessage(websocket.TextMessage, payload)
	}
	writeJSONAndClose := func(value any, code int, reason string) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
			return err
		}
		if err := conn.WriteJSON(value); err != nil {
			return err
		}
		return conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(code, reason),
			time.Now().Add(writeWait),
		)
	}
	ownerKind, ownerID := session.Context.Owner()
	dependencySettings := session.DependencySettings()
	dependencyInitializationOptions := session.DependencyInitializationOptions()
	pendingConfigurations := newPendingWorkspaceConfigurations()
	defer func() {
		// Stop first so a timeout callback blocked on analyzer stdin is released
		// before clear waits for every registered callback to finish.
		session.Stop()
		pendingConfigurations.clear()
	}()
	if err := writeJSON(map[string]any{"type": "lsp.ready", "sessionId": session.ID, "capabilities": map[string]any{"mode": mode, "remote": true, "methods": lsp.AllowedMethods(mode), "virtualRootUri": lsp.VirtualRootURI, "languageId": strings.ToLower(start.LanguageID), "serverLanguageId": canonicalRuntimeLanguage(start.LanguageID), "dependencyApiIndex": session.DependencyAPIIndexCapability()}, "cache": session.Cache, "dependency": session.DependencyStatus()}); err != nil {
		return
	}

	opened := make(map[string]bool)
	var openedMu sync.RWMutex
	var closing atomic.Bool
	serverDone := make(chan struct{})
	closeBridge := func() {
		if closing.CompareAndSwap(false, true) {
			session.Stop()
			_ = conn.Close()
		}
	}
	resolveConfigurationFallback := func(proxy *lsp.WorkspaceConfigurationProxy) error {
		response, fallbackErr := proxy.FallbackResponse()
		if fallbackErr != nil {
			return fallbackErr
		}
		return session.Send(response)
	}
	go func() {
		defer func() {
			close(serverDone)
			if dependency, restart := session.DependencyRestartStatus(); restart && closing.CompareAndSwap(false, true) {
				closeErr := writeJSONAndClose(map[string]any{
					"type": "lsp.dependency", "success": true, "changed": true,
					"restartRequired": true, "dependency": dependency,
				}, websocket.CloseNormalClosure, "analysis dependencies changed")
				if closeErr != nil {
					_ = conn.Close()
				} else {
					_ = conn.SetReadDeadline(time.Now().Add(time.Second))
					time.AfterFunc(time.Second, func() { _ = conn.Close() })
				}
				return
			}
			if !closing.Load() {
				_ = writeJSON(map[string]any{"type": "lsp.error", "code": "process_exited", "message": "language server process exited"})
				_ = conn.Close()
			}
		}()
		for payload := range session.Messages() {
			if closing.Load() {
				return
			}
			env, validateErr := lsp.ValidateServerRPC(payload)
			if validateErr != nil {
				if env.Method != "" && len(env.ID) > 0 {
					if response := rpcError(env.ID, -32601, validateErr.Error()); response != nil {
						if session.Send(response) != nil {
							closeBridge()
							return
						}
					}
				}
				continue
			}
			var configurationProxy *lsp.WorkspaceConfigurationProxy
			if env.Method == "workspace/configuration" {
				if lsp.WorkspaceConfigurationOwnedByDependencySettings(payload, dependencySettings) {
					response, configErr := lsp.WorkspaceConfigurationResponse(payload, dependencySettings)
					if configErr != nil {
						response = rpcError(env.ID, -32602, "gateway could not resolve language server configuration")
					}
					if response != nil && session.Send(response) != nil {
						closeBridge()
						return
					}
					continue
				}
				configurationProxy, validateErr = lsp.NewWorkspaceConfigurationProxy(payload, dependencySettings)
				if validateErr != nil {
					if response := rpcError(env.ID, -32602, "gateway could not proxy language server configuration"); response != nil && session.Send(response) != nil {
						closeBridge()
						return
					}
					continue
				}
			}
			rewritten, rewriteErr := mapper.RewriteOutbound(payload)
			if rewriteErr != nil {
				if len(env.ID) > 0 {
					response := rpcError(env.ID, -32603, "gateway could not safely rewrite language server URIs")
					if env.Method != "" {
						if session.Send(response) != nil {
							closeBridge()
							return
						}
					} else if writeRaw(response) != nil {
						closeBridge()
						return
					}
				}
				continue
			}
			if mode == lsp.ModeStandard && env.Method == "textDocument/publishDiagnostics" {
				_, uri := rpcMethodAndURI(rewritten)
				openedMu.RLock()
				isOpen := opened[uri]
				openedMu.RUnlock()
				if !isOpen {
					continue
				}
			}
			if configurationProxy != nil {
				pendingErr := pendingConfigurations.add(configurationProxy, func(expired *lsp.WorkspaceConfigurationProxy) {
					if resolveConfigurationFallback(expired) != nil {
						closeBridge()
					}
				})
				if errors.Is(pendingErr, errPendingWorkspaceConfigurationFull) {
					if resolveConfigurationFallback(configurationProxy) != nil {
						closeBridge()
						return
					}
					continue
				}
				if pendingErr != nil {
					if response := rpcError(env.ID, -32000, "gateway could not track language server configuration"); response != nil && session.Send(response) != nil {
						closeBridge()
						return
					}
					continue
				}
			}
			if writeRaw(rewritten) != nil {
				if configurationProxy != nil {
					pendingConfigurations.discard(configurationProxy.IDKey())
				}
				closeBridge()
				return
			}
		}
	}()

	slog.Info("LSP session attached", "session_id", session.ID, "user_id", user.ID, "language", start.LanguageID, "mode", mode, "runtime", runtimeID)
	initializeSent := false
	var lastDependencyRefresh time.Time
	dependencyIndexRequests := newDependencyIndexRequestGate()

clientLoop:
	for {
		_, payload, readErr := conn.ReadMessage()
		if readErr != nil {
			closing.Store(true)
			break
		}
		if !budget.allow(len(payload)) {
			if writeJSON(map[string]any{"type": "lsp.error", "code": "bandwidth_limit", "message": "LSP bandwidth limit exceeded"}) != nil {
				closing.Store(true)
			}
			break clientLoop
		}
		var control lspControlMessage
		if json.Unmarshal(payload, &control) == nil && strings.HasPrefix(control.Type, "lsp.") {
			switch control.Type {
			case "lsp.ping":
				if writeJSON(map[string]any{"type": "lsp.pong"}) != nil {
					closing.Store(true)
					break clientLoop
				}
			case "lsp.stop":
				closing.Store(true)
				break clientLoop
			case "lsp.dependency.refresh":
				now := time.Now()
				if !lastDependencyRefresh.IsZero() && now.Sub(lastDependencyRefresh) < 2*time.Second {
					if writeJSON(map[string]any{
						"type": "lsp.dependency", "success": false, "changed": false,
						"restartRequired": false, "message": "dependency refresh is rate limited",
						"retryAfterMs": 2000 - now.Sub(lastDependencyRefresh).Milliseconds(),
						"dependency":   session.DependencyStatus(),
					}) != nil {
						closing.Store(true)
						break clientLoop
					}
					continue
				}
				lastDependencyRefresh = now
				if h.DependencyViews == nil {
					if writeJSON(map[string]any{"type": "lsp.dependency", "success": false, "changed": false, "restartRequired": false, "message": "dependency resolver is unavailable", "dependency": session.DependencyStatus()}) != nil {
						closing.Store(true)
						break clientLoop
					}
					continue
				}
				nextView, resolveErr := h.DependencyViews.Resolve(session.Context.DependencyRequest)
				if resolveErr != nil {
					slog.Warn("Failed to refresh LSP dependency view", "session_id", session.ID, "error", resolveErr)
					if writeJSON(map[string]any{"type": "lsp.dependency", "success": false, "changed": false, "restartRequired": false, "message": "dependency view could not be refreshed", "dependency": session.DependencyStatus()}) != nil {
						closing.Store(true)
						break clientLoop
					}
					continue
				}
				changed := !session.Context.DependencyResolved || nextView.Revision != session.Context.DependencyView.Revision
				nextStatus := nextView.PublicStatus(session.Docker, ownerKind)
				if !changed {
					if writeJSON(map[string]any{"type": "lsp.dependency", "success": true, "changed": false, "restartRequired": false, "dependency": nextStatus}) != nil {
						closing.Store(true)
						break clientLoop
					}
					continue
				}
				closing.Store(true)
				session.Stop()
				select {
				case <-session.Done():
				case <-time.After(3 * time.Second):
				}
				select {
				case <-serverDone:
				case <-time.After(2 * time.Second):
				}
				result := map[string]any{"type": "lsp.dependency", "success": true, "changed": true, "restartRequired": true, "dependency": nextStatus}
				if writeJSONAndClose(result, websocket.CloseNormalClosure, "analysis dependencies changed") != nil {
					closing.Store(true)
				} else {
					_ = conn.SetReadDeadline(time.Now().Add(time.Second))
					_, _, _ = conn.ReadMessage()
				}
				break clientLoop
			case "lsp.dependency.index.request":
				if !validDependencyIndexRequestID(control.RequestID) || len(control.Cursor) > 128 || lsp.ValidateDependencyAPIIndexPageBytes(control.MaxBytes) != nil {
					if writeBoundedControlJSON(dependencyIndexControlError("", "invalid_request", "dependency API index request is invalid", 0)) != nil {
						closing.Store(true)
						break clientLoop
					}
					continue
				}
				if accepted, retryAfterMS := dependencyIndexRequests.acquire(); !accepted {
					if writeBoundedControlJSON(dependencyIndexControlError(control.RequestID, "rate_limited", "dependency API index request is rate limited", retryAfterMS)) != nil {
						closing.Store(true)
						break clientLoop
					}
					continue
				}
				requestID, cursor, maxBytes := control.RequestID, control.Cursor, control.MaxBytes
				go func() {
					defer dependencyIndexRequests.release()
					page, indexErr := session.DependencyAPIIndexPage(cursor, maxBytes)
					if indexErr != nil {
						code, message := dependencyIndexError(indexErr)
						if writeBoundedControlJSON(dependencyIndexControlError(requestID, code, message, 0)) != nil {
							closeBridge()
						}
						return
					}
					if err := writeBoundedControlJSON(map[string]any{"type": "lsp.dependency.index", "requestId": requestID, "success": true, "page": page}); err != nil {
						if strings.Contains(err.Error(), "bandwidth limit") {
							_ = writeJSON(map[string]any{"type": "lsp.error", "code": "bandwidth_limit", "message": "LSP bandwidth limit exceeded"})
						}
						closeBridge()
					}
				}()
			case "lsp.cache.clear":
				if (control.Scope != "" && control.Scope != "namespace") ||
					(control.NamespaceKey != "" && control.NamespaceKey != session.Cache.Key) ||
					(control.ProjectID != "" && control.ProjectID != session.Context.ProjectID) {
					if writeJSON(map[string]any{
						"type":    "lsp.cache",
						"success": false,
						"message": "a WebSocket session may only clear its current analysis cache namespace",
						"cache":   session.Cache,
					}) != nil {
						closing.Store(true)
						break clientLoop
					}
					continue
				}
				closing.Store(true)
				session.Stop()
				select {
				case <-session.Done():
				case <-time.After(3 * time.Second):
				}
				select {
				case <-serverDone:
				case <-time.After(2 * time.Second):
				}
				info, clearErr := h.LSP.ClearCache(ownerKind, ownerID, "namespace", session.Context.ProjectID, session.Cache.Key)
				result := map[string]any{"type": "lsp.cache", "success": clearErr == nil, "message": errorMessage(clearErr), "cache": info, "restartRequired": true}
				if writeJSONAndClose(result, websocket.CloseNormalClosure, "analysis cache cleared") != nil {
					closing.Store(true)
				} else {
					_ = conn.SetReadDeadline(time.Now().Add(time.Second))
					_, _, _ = conn.ReadMessage()
				}
				break clientLoop
			}
			continue
		}
		env, validateErr := lsp.ValidateClientRPC(mode, payload)
		if validateErr != nil {
			if response := rpcError(env.ID, -32601, validateErr.Error()); response != nil {
				if writeRaw(response) != nil {
					closing.Store(true)
					break clientLoop
				}
			}
			continue
		}
		configurationResponse := false
		if env.Method == "" {
			configurationProxy, found, pendingErr := pendingConfigurations.take(payload)
			if pendingErr == nil && found {
				configurationResponse = true
				payload, err = configurationProxy.MergeResponse(payload)
				if err != nil {
					payload, err = configurationProxy.FallbackResponse()
					if err != nil {
						if response := rpcError(env.ID, -32603, "gateway could not merge language server configuration"); response != nil {
							if sendErr := session.Send(response); sendErr != nil {
								break clientLoop
							}
						}
						continue
					}
				}
			}
		}
		isInitialize := env.Method == "initialize"
		if env.Method != "" {
			if !initializeSent && env.Method != "initialize" {
				if response := rpcError(env.ID, -32002, "initialize must be the first JSON-RPC request"); response != nil {
					if writeRaw(response) != nil {
						closing.Store(true)
						break clientLoop
					}
				}
				continue
			}
			if isInitialize {
				if initializeSent {
					if response := rpcError(env.ID, -32600, "initialize was already sent"); response != nil {
						if writeRaw(response) != nil {
							closing.Store(true)
							break clientLoop
						}
					}
					continue
				}
			}
		}
		var rewritten []byte
		if isInitialize {
			rewritten, err = mapper.RewriteInitialize(payload)
			if err == nil {
				rewritten, err = lsp.MergeDependencyInitializationOptions(rewritten, dependencyInitializationOptions)
			}
		} else {
			rewritten, err = mapper.RewriteInbound(payload)
		}
		if err != nil {
			if response := rpcError(env.ID, -32602, err.Error()); response != nil {
				if configurationResponse {
					if sendErr := session.Send(response); sendErr != nil {
						break clientLoop
					}
				} else {
					if writeRaw(response) != nil {
						closing.Store(true)
						break clientLoop
					}
				}
			}
			continue
		}
		if err := session.Send(rewritten); err != nil {
			break
		}
		if env.Method == "initialized" {
			notification, configErr := lsp.DidChangeConfigurationNotification(dependencySettings)
			if configErr != nil {
				slog.Warn("Failed to encode LSP dependency configuration", "session_id", session.ID, "error", configErr)
			} else if len(notification) > 0 {
				if err := session.Send(notification); err != nil {
					break
				}
			}
		}
		if isInitialize {
			initializeSent = true
		}
		if env.Method == "exit" {
			closing.Store(true)
			_ = conn.SetReadDeadline(time.Now().Add(time.Second))
			continue
		}
		method, uri := rpcMethodAndURI(payload)
		if method == "textDocument/didOpen" && uri != "" {
			openedMu.Lock()
			opened[uri] = true
			openedMu.Unlock()
		} else if method == "textDocument/didClose" && uri != "" {
			openedMu.Lock()
			delete(opened, uri)
			openedMu.Unlock()
		}
	}
	closing.Store(true)
	select {
	case <-session.Done():
	case <-time.After(time.Second):
		session.Stop()
		select {
		case <-session.Done():
		case <-time.After(2 * time.Second):
		}
	}
	select {
	case <-serverDone:
	case <-time.After(time.Second):
	}
	slog.Info("LSP session detached", "session_id", session.ID, "user_id", user.ID)
}

func errorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func validDependencyIndexRequestID(value string) bool {
	if value == "" || len(value) > 96 {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' {
			continue
		}
		return false
	}
	return true
}

func dependencyIndexControlError(requestID, code, message string, retryAfterMS int64) map[string]any {
	result := map[string]any{"type": "lsp.dependency.index", "requestId": requestID, "success": false, "code": code, "message": message}
	if retryAfterMS > 0 {
		result["retryAfterMs"] = retryAfterMS
	}
	return result
}

func dependencyIndexError(err error) (string, string) {
	switch {
	case errors.Is(err, lsp.ErrDependencyAPIIndexUnsupported):
		return "unsupported", "dependency API index is unavailable for this language"
	case errors.Is(err, lsp.ErrDependencyAPIIndexCursor):
		return "invalid_cursor", "dependency API index cursor is invalid"
	case errors.Is(err, lsp.ErrDependencyAPIIndexPageSize):
		return "invalid_page_size", "dependency API index page size is invalid"
	default:
		return "unavailable", "dependency API index is unavailable"
	}
}
