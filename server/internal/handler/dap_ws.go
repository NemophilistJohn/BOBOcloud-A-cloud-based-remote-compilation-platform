package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/collab"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/dap"
	"bobocloud-server/internal/lifecycle"
	"bobocloud-server/internal/model"

	"github.com/gorilla/websocket"
)

var dapUpgrader = websocket.Upgrader{
	ReadBufferSize: 4096, WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		// Electron has no Origin header. Browser clients must be same-origin;
		// authentication and TLS still protect both cases.
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin == "" {
			return true
		}
		parsed, err := url.Parse(origin)
		return err == nil && strings.EqualFold(parsed.Host, r.Host)
	},
}

type DAPHandler struct {
	Config        *config.Config
	Manager       *dap.Manager
	AuthEnabled   bool
	Authenticator auth.Authenticator
	UserStore     auth.UserStore
	AuthSessions  auth.AuthSessionStore
	Collaboration *collab.Manager
	Lifecycle     *lifecycle.Manager
	ChildTickets  *dap.ChildTicketBroker
}

type dapWorkspaceStart struct {
	Kind       string `json:"kind"`
	FolderName string `json:"folderName,omitempty"`
	FolderKey  string `json:"folderKey,omitempty"`
	TeamID     string `json:"teamId,omitempty"`
	ProjectID  string `json:"projectId,omitempty"`
	Branch     string `json:"branch,omitempty"`
}

type dapStartMessage struct {
	Type       string            `json:"type"`
	Token      string            `json:"token"`
	RuntimeID  string            `json:"runtimeId"`
	LanguageID string            `json:"languageId"`
	Workspace  dapWorkspaceStart `json:"workspace"`
}

type dapChildAttachMessage struct {
	Type   string `json:"type"`
	Token  string `json:"token"`
	Ticket string `json:"ticket"`
}

type dapByteWindow struct {
	mu      sync.Mutex
	limit   int64
	used    int64
	started time.Time
}

func newDAPByteWindow(limit int64) *dapByteWindow {
	return &dapByteWindow{limit: limit, started: time.Now()}
}

func (window *dapByteWindow) allow(size int) bool {
	if window == nil || window.limit <= 0 {
		return true
	}
	window.mu.Lock()
	defer window.mu.Unlock()
	if time.Since(window.started) >= time.Minute {
		window.started, window.used = time.Now(), 0
	}
	if size < 0 || window.used+int64(size) > window.limit {
		return false
	}
	window.used += int64(size)
	return true
}

func (h *DAPHandler) authenticate(token string) (*auth.User, error) {
	if !h.AuthEnabled {
		return &auth.User{ID: "default", Username: "default", Name: "Default User", Role: auth.RoleRoot}, nil
	}
	token = strings.TrimSpace(strings.TrimPrefix(token, "Bearer "))
	if token == "" {
		return nil, fmt.Errorf("authentication required")
	}
	if h.AuthSessions != nil {
		if session, err := h.AuthSessions.Validate(token, h.Config.SessionTokenTTL()); err == nil {
			if user, userErr := h.UserStore.Get(session.UserID); userErr == nil && !user.Disabled {
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

func canonicalDAPLanguage(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "javascript", "typescript", "javascriptreact", "typescriptreact", "node", "nodejs":
		return "node"
	case "py", "python":
		return "python"
	case "golang", "go":
		return "go"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func requestedDAPActivityKey(workspace dapWorkspaceStart) (string, error) {
	switch workspace.Kind {
	case "team":
		return "", nil
	case "personal":
		key := strings.TrimSpace(workspace.FolderKey)
		if key == "" {
			key = strings.TrimSpace(workspace.FolderName)
		}
		if key == "" {
			return "", fmt.Errorf("folderName or folderKey is required")
		}
		return key, nil
	default:
		return "", fmt.Errorf("workspace kind must be team or personal")
	}
}

func (h *DAPHandler) resolveWorkspace(ctx context.Context, user *auth.User, request dapWorkspaceStart) (root, folderKey, teamID, projectID, branch string, err error) {
	switch request.Kind {
	case "team":
		if h.Collaboration == nil || strings.TrimSpace(request.TeamID) == "" || strings.TrimSpace(request.ProjectID) == "" {
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
		branch = strings.TrimSpace(request.Branch)
		if branch == "" {
			branch = project.DefaultBranch
		}
		return root, "", request.TeamID, request.ProjectID, branch, nil
	case "personal":
		key, keyErr := requestedDAPActivityKey(request)
		if keyErr != nil {
			return "", "", "", "", "", keyErr
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

func combineDAPReleases(releases ...func()) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			for index := len(releases) - 1; index >= 0; index-- {
				if releases[index] != nil {
					releases[index]()
				}
			}
		})
	}
}

func writeDAPControlError(conn *websocket.Conn, code, message string) {
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_ = conn.WriteJSON(map[string]any{"type": "dap.error", "code": code, "message": message})
	_ = conn.SetWriteDeadline(time.Time{})
}

func (h *DAPHandler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := dapUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("DAP WebSocket upgrade failed", "error", err)
		return
	}
	defer conn.Close()
	if h.Manager == nil || h.Config == nil || !h.Config.DAPEnabled {
		writeDAPControlError(conn, "disabled", "remote debugging is disabled")
		return
	}
	maxMessage := h.Config.DAPMaxMessageBytes
	if maxMessage <= 0 {
		maxMessage = 1 << 20
	}
	conn.SetReadLimit(int64(maxMessage))
	handshakeTimeout := time.Duration(h.Config.DAPHandshakeTimeoutSeconds) * time.Second
	if handshakeTimeout <= 0 {
		handshakeTimeout = 10 * time.Second
	}
	_ = conn.SetReadDeadline(time.Now().Add(handshakeTimeout))
	_, rawStart, err := conn.ReadMessage()
	if err != nil {
		return
	}
	var start dapStartMessage
	if err := json.Unmarshal(rawStart, &start); err != nil || start.Type != "dap.start" {
		writeDAPControlError(conn, "invalid_start", "the first message must be dap.start")
		return
	}
	user, err := h.authenticate(start.Token)
	if err != nil {
		writeDAPControlError(conn, "unauthorized", err.Error())
		return
	}
	languageID := canonicalDAPLanguage(start.LanguageID)
	runtime := model.GetRuntimeDef(strings.TrimSpace(start.RuntimeID))
	if runtime == nil {
		writeDAPControlError(conn, "invalid_runtime", "unknown runtime: "+strings.TrimSpace(start.RuntimeID))
		return
	}
	if canonicalDAPLanguage(runtime.Language) != languageID {
		writeDAPControlError(conn, "runtime_mismatch", "runtime language does not match the editor language")
		return
	}
	workspaceKey, err := requestedDAPActivityKey(start.Workspace)
	if err != nil {
		writeDAPControlError(conn, "workspace_denied", err.Error())
		return
	}
	pendingRelease := combineDAPReleases()
	if h.Lifecycle != nil {
		activity, acquireErr := h.Lifecycle.AcquireActivity(user.ID, workspaceKey)
		if acquireErr != nil {
			writeDAPControlError(conn, "workspace_in_use", acquireErr.Error())
			return
		}
		pendingRelease = combineDAPReleases(activity.Release)
	}
	defer func() { pendingRelease() }()
	if start.Workspace.Kind == "team" {
		if h.Collaboration == nil {
			writeDAPControlError(conn, "workspace_denied", "team workspace is unavailable")
			return
		}
		activity, acquireErr := h.Collaboration.AcquireProjectActivity(user.ID, start.Workspace.TeamID, start.Workspace.ProjectID)
		if acquireErr != nil {
			writeDAPControlError(conn, "workspace_in_use", acquireErr.Error())
			return
		}
		pendingRelease = combineDAPReleases(activity.Release, pendingRelease)
	}
	setupCtx, cancelSetup := context.WithTimeout(r.Context(), 30*time.Second)
	root, folderKey, teamID, projectID, branch, err := h.resolveWorkspace(setupCtx, user, start.Workspace)
	cancelSetup()
	if err != nil {
		writeDAPControlError(conn, "workspace_denied", err.Error())
		return
	}
	tempRoot, err := os.MkdirTemp("", "bobocloud-dap-")
	if err != nil {
		writeDAPControlError(conn, "workspace_copy_failed", "could not create an isolated debug workspace")
		return
	}
	copyTimeout := time.Duration(h.Config.DAPWorkspaceCopyTimeoutSeconds) * time.Second
	if copyTimeout <= 0 {
		copyTimeout = 30 * time.Second
	}
	copyCtx, cancelCopy := context.WithTimeout(r.Context(), copyTimeout)
	copyErr := dap.CopyWorkspace(copyCtx, root, tempRoot, h.Config.DAPWorkspaceCopyMaxBytes)
	cancelCopy()
	if copyErr != nil {
		_ = os.RemoveAll(tempRoot)
		writeDAPControlError(conn, "workspace_copy_failed", copyErr.Error())
		return
	}
	cleanupTemp := func() {
		if removeErr := os.RemoveAll(tempRoot); removeErr != nil {
			slog.Warn("Failed to remove isolated DAP workspace", "path", tempRoot, "error", removeErr)
		}
	}
	sessionRelease := pendingRelease
	sessionRelease = combineDAPReleases(sessionRelease, cleanupTemp)
	pendingRelease = func() {}
	session, err := h.Manager.Start(dap.SessionContext{
		UserID: user.ID, WorkspaceKind: start.Workspace.Kind, TeamID: teamID, ProjectID: projectID,
		Branch: branch, FolderKey: folderKey, RuntimeID: runtime.RuntimeID, LanguageID: languageID,
		RemoteRoot: tempRoot, PersistDir: filepath.Join(h.Config.DataDir, "users", user.ID, "persist"), Release: sessionRelease,
	})
	if err != nil {
		sessionRelease()
		writeDAPControlError(conn, "start_failed", err.Error())
		return
	}
	defer session.Stop()
	if teamID != "" && (h.Collaboration == nil || !h.Collaboration.IsMember(user.ID, teamID)) {
		writeDAPControlError(conn, "forbidden", "team membership changed while the debugger was starting")
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	writeWait := h.Config.WSWriteWaitDuration()
	if writeWait <= 0 {
		writeWait = 10 * time.Second
	}
	budget := newDAPByteWindow(h.Config.DAPBandwidthPerMinuteBytes)
	var writeMu sync.Mutex
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
			return fmt.Errorf("DAP bandwidth limit exceeded")
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
			return err
		}
		return conn.WriteMessage(websocket.TextMessage, payload)
	}
	capability := map[string]any{
		"id": session.Adapter.ID, "label": session.Adapter.Label, "languageId": session.Adapter.LanguageID,
		"runtimeId": session.Adapter.RuntimeID, "adapterVersion": session.Adapter.AdapterVersion,
		"supportsLaunch": session.Adapter.SupportsLaunch, "supportsAttach": session.Adapter.SupportsAttach,
		"transport": session.Adapter.Transport, "supportsChildSessions": session.Adapter.SupportsChildSessions,
		"requiresPtrace": session.Adapter.RequiresPtrace, "launchDefaults": session.Adapter.LaunchDefaults,
		"dependencyMode": session.Adapter.DependencyMode, "constraints": session.Adapter.Constraints,
	}
	if err := writeJSON(map[string]any{"type": "dap.ready", "sessionId": session.ID, "catalogVersion": h.Manager.CatalogVersion(), "virtualRootUri": dap.VirtualRootURI, "adapter": capability}); err != nil {
		return
	}
	gateway := dap.NewGateway(session.Adapter)
	closing := make(chan struct{})
	var closeOnce sync.Once
	closeBridge := func() {
		closeOnce.Do(func() {
			close(closing)
			session.Stop()
			_ = conn.Close()
		})
	}
	go func() {
		defer closeBridge()
		for payload := range session.Messages() {
			rewritten, gatewayErr := gateway.HandleServer(payload)
			if gatewayErr != nil {
				slog.Warn("Managed debug adapter emitted invalid DAP", "session_id", session.ID, "error", gatewayErr)
				_ = writeJSON(map[string]any{"type": "dap.error", "code": "adapter_protocol_error", "message": gatewayErr.Error()})
				return
			}
			if _, isChildStart := dap.IsChildStartRequest(payload); isChildStart {
				if h.ChildTickets == nil {
					_ = writeJSON(map[string]any{"type": "dap.error", "code": "child_session_unavailable", "message": "The debug adapter requires a child session, but this server has not enabled it."})
					return
				}
				ticket, ticketErr := h.ChildTickets.Offer(user.ID, session, rewritten)
				if ticketErr != nil {
					_ = writeJSON(map[string]any{"type": "dap.error", "code": "child_session_failed", "message": ticketErr.Error()})
					return
				}
				if writeJSON(map[string]any{"type": "dap.child", "ticket": ticket, "request": json.RawMessage(rewritten)}) != nil {
					return
				}
				continue
			}
			if writeRaw(rewritten) != nil {
				return
			}
		}
		if sessionErr := session.Err(); sessionErr != nil && !gateway.SessionEnded() {
			_ = writeJSON(map[string]any{
				"type": "dap.error", "code": "adapter_exited",
				"message": "The debug adapter stopped unexpectedly.",
				"details": map[string]any{"reason": sessionErr.Error()},
			})
		}
	}()
	pingPeriod := h.Config.WSPingDuration()
	if pingPeriod <= 0 {
		pingPeriod = 30 * time.Second
	}
	pongWait := pingPeriod * 3
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(_ string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-closing:
				return
			case <-session.Done():
				return
			case <-ticker.C:
				writeMu.Lock()
				err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait))
				writeMu.Unlock()
				if err != nil {
					closeBridge()
					return
				}
			}
		}
	}()
	slog.Info("DAP session attached", "session_id", session.ID, "user_id", user.ID, "language", languageID, "runtime", runtime.RuntimeID)
	for {
		_, payload, readErr := conn.ReadMessage()
		if readErr != nil {
			return
		}
		if !budget.allow(len(payload)) {
			_ = writeJSON(map[string]any{"type": "dap.error", "code": "bandwidth_limit", "message": "DAP bandwidth limit exceeded"})
			return
		}
		result, gatewayErr := gateway.HandleClient(payload)
		if gatewayErr != nil {
			_ = writeJSON(map[string]any{"type": "dap.error", "code": "protocol_error", "message": gatewayErr.Error()})
			return
		}
		if len(result.LocalResponse) > 0 {
			if writeRaw(result.LocalResponse) != nil {
				return
			}
			continue
		}
		if err := session.Send(result.Payload); err != nil {
			return
		}
		if result.Disconnect {
			time.AfterFunc(3*time.Second, session.Stop)
		}
		select {
		case <-closing:
			return
		default:
		}
	}
}

// HandleChildWebSocket brokers one js-debug child session. It is intentionally
// a separate listener from the root DAP endpoint: the child ticket is bound to
// an authenticated parent user and expires after a few seconds.
func (h *DAPHandler) HandleChildWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := dapUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	if h.Manager == nil || h.Config == nil || !h.Config.DAPEnabled || h.ChildTickets == nil {
		writeDAPControlError(conn, "child_session_unavailable", "debug child sessions are unavailable")
		return
	}
	maxMessage := h.Config.DAPMaxMessageBytes
	if maxMessage <= 0 {
		maxMessage = 1 << 20
	}
	conn.SetReadLimit(int64(maxMessage))
	deadline := time.Duration(h.Config.DAPHandshakeTimeoutSeconds) * time.Second
	if deadline <= 0 {
		deadline = 10 * time.Second
	}
	_ = conn.SetReadDeadline(time.Now().Add(deadline))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		return
	}
	var attach dapChildAttachMessage
	if err := json.Unmarshal(raw, &attach); err != nil || attach.Type != "dap.child.attach" {
		writeDAPControlError(conn, "invalid_child_start", "the first message must be dap.child.attach")
		return
	}
	user, err := h.authenticate(attach.Token)
	if err != nil {
		writeDAPControlError(conn, "unauthorized", err.Error())
		return
	}
	claimed, err := h.ChildTickets.Claim(user.ID, attach.Ticket)
	if err != nil {
		writeDAPControlError(conn, "child_ticket_invalid", err.Error())
		return
	}
	connectCtx, cancel := context.WithTimeout(r.Context(), deadline)
	child, err := claimed.Parent.OpenChild(connectCtx)
	cancel()
	if err != nil {
		writeDAPControlError(conn, "child_connect_failed", err.Error())
		return
	}
	defer child.Stop()
	_ = conn.SetReadDeadline(time.Time{})
	writeWait := h.Config.WSWriteWaitDuration()
	if writeWait <= 0 {
		writeWait = 10 * time.Second
	}
	var writeMu sync.Mutex
	writeJSON := func(value any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
		return conn.WriteJSON(value)
	}
	writeRaw := func(payload []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
		return conn.WriteMessage(websocket.TextMessage, payload)
	}
	if err := writeJSON(map[string]any{"type": "dap.child.ready", "parentSessionId": claimed.Parent.ID, "request": claimed.Request}); err != nil {
		return
	}
	gateway := dap.NewGateway(claimed.Parent.Adapter)
	closing := make(chan struct{})
	var closeOnce sync.Once
	closeBridge := func() {
		closeOnce.Do(func() {
			close(closing)
			child.Stop()
			_ = conn.Close()
		})
	}
	defer closeBridge()
	go func() {
		defer closeBridge()
		for payload := range child.Messages() {
			rewritten, gatewayErr := gateway.HandleServer(payload)
			if gatewayErr != nil {
				_ = writeJSON(map[string]any{"type": "dap.error", "code": "adapter_protocol_error", "message": gatewayErr.Error()})
				return
			}
			if writeRaw(rewritten) != nil {
				return
			}
		}
		if child.Err() != nil && !gateway.SessionEnded() {
			_ = writeJSON(map[string]any{"type": "dap.error", "code": "adapter_exited", "message": "The debug adapter stopped unexpectedly."})
		}
	}()
	for {
		_, payload, readErr := conn.ReadMessage()
		if readErr != nil {
			return
		}
		result, gatewayErr := gateway.HandleClient(payload)
		if gatewayErr != nil {
			_ = writeJSON(map[string]any{"type": "dap.error", "code": "protocol_error", "message": gatewayErr.Error()})
			return
		}
		if len(result.LocalResponse) > 0 {
			if writeRaw(result.LocalResponse) != nil {
				return
			}
			continue
		}
		if err := child.Send(result.Payload); err != nil {
			return
		}
		if result.Disconnect {
			return
		}
		select {
		case <-closing:
			return
		default:
		}
	}
}
