package handler

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/collab"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/session"
)

type realtimeWireMessage struct {
	collab.RealtimeOperation
	Token     string         `json:"token,omitempty"`
	TeamID    string         `json:"teamId,omitempty"`
	ProjectID string         `json:"projectId,omitempty"`
	SessionID string         `json:"sessionId,omitempty"`
	Data      string         `json:"data,omitempty"`
	Run       *model.Request `json:"run,omitempty"`
}

// HandleCollaborationWebSocket authenticates the socket itself. Native clients
// put credentials in the first bounded frame, never a logged URL query.
func (h *WSHandler) HandleCollaborationWebSocket(w http.ResponseWriter, r *http.Request) {
	release, ok := acquireLongLivedWork(w, h.Accepting, h.AcquireWork, "collaboration-websocket")
	if !ok {
		return
	}
	defer release()
	if h.Collaboration == nil {
		http.Error(w, "collaboration unavailable", http.StatusServiceUnavailable)
		return
	}
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	stop := closeWebSocketOnContext(r.Context(), conn)
	defer stop()
	conn.SetReadLimit(4 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	var join realtimeWireMessage
	if err = conn.ReadJSON(&join); err != nil || join.Type != "join" {
		_ = conn.WriteJSON(map[string]any{"type": "error", "code": "invalid_join", "message": "first message must be join"})
		return
	}
	user, err := h.authenticateTerminal(join.Token)
	if err != nil {
		_ = conn.WriteJSON(map[string]any{"type": "error", "code": "unauthorized", "message": err.Error()})
		return
	}
	operationStore := h.UserStore
	if !h.AuthEnabled {
		operationStore = nil
	}
	ctx, operationRelease, err := bindUserOperation(r.Context(), h.Lifecycle, operationStore, user.ID)
	if err != nil {
		return
	}
	defer operationRelease()
	stopAccess := closeWebSocketOnContext(ctx, conn)
	defer stopAccess()
	state, events, leave, err := h.Collaboration.JoinRealtime(user.ID, user.Name, join.TeamID, join.ProjectID, join.Epoch, join.SessionID)
	if err != nil {
		_ = conn.WriteJSON(map[string]any{"type": "error", "code": "join_rejected", "message": err.Error()})
		return
	}
	defer leave()
	var writer sync.Mutex
	write := func(v any) error {
		writer.Lock()
		defer writer.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteJSON(v)
	}
	if err = write(map[string]any{"type": "state", "state": state}); err != nil {
		return
	}
	conn.SetReadLimit(64 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(65 * time.Second))
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				_ = conn.Close()
				return
			case event, open := <-events:
				if !open {
					_ = conn.Close()
					return
				}
				if write(event) != nil {
					_ = conn.Close()
					return
				}
			}
		}
	}()
	for {
		var msg realtimeWireMessage
		if err = conn.ReadJSON(&msg); err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(65 * time.Second))
		if len(msg.RequestID) > 128 {
			return
		}
		var reply any
		switch msg.Type {
		case "run":
			err = h.startRealtimeRun(ctx, user, join.TeamID, join.ProjectID, msg.Epoch, msg.Run)
			if err == nil {
				reply = map[string]any{"type": "ack", "requestId": msg.RequestID}
			}
		case "stdin", "cancelRun":
			err = h.Collaboration.ControlRealtimeRun(user.ID, join.TeamID, join.ProjectID, msg.Epoch, msg.Type, msg.Data)
			if err == nil {
				reply = map[string]any{"type": "ack", "requestId": msg.RequestID}
			}
		default:
			reply, err = h.Collaboration.ApplyRealtime(user.ID, join.SessionID, join.TeamID, join.ProjectID, msg.RealtimeOperation)
		}
		if err != nil {
			code := "operation_rejected"
			if part := strings.SplitN(err.Error(), ":", 2); len(part) > 1 {
				code = part[0]
			}
			reply = map[string]any{"type": "error", "requestId": msg.RequestID, "code": code, "message": err.Error()}
		}
		if write(reply) != nil {
			return
		}
	}
}

func (h *WSHandler) startRealtimeRun(socketCtx context.Context, user *auth.User, teamID, projectID, epoch string, request *model.Request) error {
	if request == nil || h.Config == nil || h.Sessions == nil || h.Channels == nil {
		return fmt.Errorf("run request/configuration missing")
	}
	if h.AuthEnabled && request.Runtime == "" {
		return fmt.Errorf("select a Docker runtime")
	}
	if request.Runtime != "" && model.GetRuntimeDef(request.Runtime) == nil {
		return fmt.Errorf("unknown runtime")
	}
	if request.Task != nil {
		if request.Runtime == "" {
			return fmt.Errorf("task requires Docker runtime")
		}
		if err := validateTaskExecution(request.Task); err != nil {
			return err
		}
	} else if request.FilePath == "" {
		return fmt.Errorf("filePath is required")
	}
	for _, args := range [][]string{request.CompileArgs, request.RunArgs, request.SetupCommands} {
		if err := validateRunArgs(args); err != nil {
			return err
		}
	}
	folderName, folderKey := request.FolderName, request.FolderKey
	if len(folderName) > 256 || strings.ContainsAny(folderName, "\x00\r\n") {
		return fmt.Errorf("invalid folderName")
	}
	if folderName == "" {
		folderName = projectID
	}
	if folderKey == "" {
		folderKey = projectID
	}
	if _, err := safeWorkspaceKey(folderName, folderKey); err != nil {
		return err
	}
	// The room, rather than one transport, owns the run. User revocation and
	// server drain still cancel it through their normal lifecycle binding.
	base := context.WithoutCancel(socketCtx)
	operationStore := h.UserStore
	if !h.AuthEnabled {
		operationStore = nil
	}
	base, releaseOperation, err := bindUserOperation(base, h.Lifecycle, operationStore, user.ID)
	if err != nil {
		return err
	}
	runCtx, cancel := context.WithTimeout(base, h.Config.ExecutionMaxSessionDuration())
	releaseWork := func() {}
	if h.AcquireWork != nil {
		releaseWork, err = h.AcquireWork("collaboration-run")
		if err != nil {
			cancel()
			releaseOperation()
			return err
		}
	}
	cleanup := func() { cancel(); releaseOperation(); releaseWork() }
	read, write, err := os.Pipe()
	if err != nil {
		cleanup()
		return err
	}
	queue := newStdinWriteQueue(write, stdinQueueMaxMessages, stdinQueueMaxBytes, func(error) { cancel() })
	runID := auth.GenerateUUID()
	state, err := h.Collaboration.GetRealtimeState(user.ID, teamID, projectID)
	if err != nil {
		queue.Stop()
		_ = read.Close()
		cleanup()
		return err
	}
	if request.Task == nil {
		entry := strings.ReplaceAll(request.FilePath, "\\", "/")
		found := false
		for _, file := range state.Files {
			if file.Path == entry && !file.Directory {
				found = true
				break
			}
		}
		if !found {
			queue.Stop()
			_ = read.Close()
			cleanup()
			return fmt.Errorf("entry file is not in the canonical workspace")
		}
	}
	sess := &model.RunSession{RunID: runID, RealtimeEpoch: epoch, Token: auth.GenerateToken(), FolderName: folderName, FolderKey: folderKey, FilePath: strings.ReplaceAll(request.FilePath, "\\", "/"), Runtime: request.Runtime, Task: request.Task, SetupCommands: request.SetupCommands, CompileArgs: request.CompileArgs, RunArgs: request.RunArgs, BuildTarget: request.BuildTarget, UserID: user.ID, TeamID: teamID, ProjectID: projectID, Branch: state.Branch}
	if _, err = h.Sessions.Create(sess); err != nil {
		queue.Stop()
		_ = read.Close()
		cleanup()
		return err
	}
	if err = h.Collaboration.BeginRealtimeRun(user.ID, teamID, projectID, epoch, runID, cancel, func(data string) error {
		if !queue.Enqueue(data) {
			return fmt.Errorf("shared stdin queue full")
		}
		return nil
	}); err != nil {
		_ = h.Sessions.Delete(runID)
		queue.Stop()
		_ = read.Close()
		cleanup()
		return err
	}
	channel := session.NewBroadcastRunChannel(runID, func(event any) bool {
		h.Collaboration.PublishRealtimeRunEvent(teamID, projectID, runID, event)
		return true
	})
	go func() {
		defer cleanup()
		defer queue.Stop()
		defer read.Close()
		defer channel.Close()
		status := "failed"
		defer func() {
			if recover() != nil {
				h.Collaboration.PublishRealtimeRunEvent(teamID, projectID, runID, map[string]any{"type": "error", "message": "shared run stopped unexpectedly"})
			}
			h.Collaboration.FinishRealtimeRun(teamID, projectID, runID, status)
			_ = h.Sessions.Delete(runID)
		}()
		var result *model.RunResult
		if sess.Task != nil {
			result = h.runProjectTask(runCtx, runID, sess, channel, read)
		} else {
			result = h.runCodeTask(runCtx, runID, sess, channel, read)
		}
		if result != nil {
			status = runHistoryStatus(result)
		}
	}()
	return nil
}
