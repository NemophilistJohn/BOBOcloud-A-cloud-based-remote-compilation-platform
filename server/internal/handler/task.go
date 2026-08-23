package handler

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"bobocloud-server/internal/files"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/runner"
	"bobocloud-server/internal/session"
)

func (h *WSHandler) runProjectTask(ctx context.Context, runID string, sess *model.RunSession, channel *session.RunChannel, stdinReader io.Reader) (runResult *model.RunResult) {
	output := session.NewWebSocketWriter(channel, h.Config.ChunkSize)
	started := time.Now()
	output.WriteStatus("setup", "Task accepted; resolving cloud workspace")
	defer func() {
		channel.Close()
		h.Channels.CleanupRun(runID, h.Sessions)
	}()
	defer func() {
		if runResult != nil && ctx.Err() == context.Canceled {
			runResult.Cancelled = true
		}
	}()

	fail := func(message string) {
		output.WriteError(message)
		output.WriteArtifactEnd()
		output.WriteResult(false, 1)
		runResult = &model.RunResult{Success: false, ReturnCode: 1, Stderr: message}
	}

	if sess.Task == nil {
		fail("Task execution data is missing")
		return
	}
	if h.Lifecycle != nil && sess.UserID != "" {
		workspaceKey := ""
		if sess.TeamID == "" {
			workspaceKey = sess.FolderKey
			if workspaceKey == "" {
				workspaceKey = sess.FolderName
			}
		}
		activity, err := h.Lifecycle.AcquireActivity(sess.UserID, workspaceKey)
		if err != nil {
			fail(err.Error())
			return
		}
		defer activity.Release()
	}
	if sess.TeamID != "" && sess.ProjectID != "" && h.Collaboration != nil {
		activity, err := h.Collaboration.AcquireProjectActivity(sess.UserID, sess.TeamID, sess.ProjectID)
		if err != nil {
			fail(err.Error())
			return
		}
		defer activity.Release()
	}

	projectPath, err := h.resolveWorkspace(ctx, sess)
	if err != nil {
		fail("Invalid workspace path: " + err.Error())
		return
	}
	runtimeDef := model.GetRuntimeDef(sess.Runtime)
	if runtimeDef == nil || sess.Runtime == "" {
		fail("Project tasks require a known Docker runtime")
		return
	}
	output.WriteStatus("setup", fmt.Sprintf("Using Docker runtime: %s (%s)", runtimeDef.DisplayName, runtimeDef.DockerImage))
	personalLease, err := h.prepareRunPersonalCache(ctx, sess, *runtimeDef, runtimeDef.Language, projectPath)
	if err != nil {
		fail("Failed to prepare project dependency cache: " + err.Error())
		return
	}
	executionCtx := ctx
	if personalLease != nil {
		folderKey := sess.FolderKey
		if folderKey == "" {
			folderKey = sess.FolderName
		}
		defer h.releasePersonalCacheLease(personalLease, personalDependencyRefreshScope(sess.UserID, folderKey, runtimeDef.RuntimeID, runtimeDef.Language))
		guard := personalLease.StartGuard(ctx)
		if guard != nil {
			executionCtx = guard.Context
		}
		output.WriteStatus("cache", fmt.Sprintf("Project dependency cache %s (%s:%s)", map[bool]string{true: "hit", false: "miss"}[personalLease.Hit], personalLease.Fingerprint.Source, personalLease.Fingerprint.Digest[:12]))
	}
	var persistOperation *personalcache.Operation
	if personalLease == nil && h.PersonalCache != nil {
		persistOperation, err = h.PersonalCache.BeginOperation(ctx, sess.UserID, userQuotaBytes(h.UserStore, sess.UserID))
		if err != nil {
			fail("Failed to reserve personal persistent storage: " + err.Error())
			return
		}
		if persistOperation != nil {
			defer persistOperation.Release()
			executionCtx = persistOperation.Context()
		}
	}

	tempDir, err := os.MkdirTemp("", fmt.Sprintf("task-%s-", runID[:min(8, len(runID))]))
	if err != nil {
		fail(fmt.Sprintf("Failed to create isolated task workspace: %v", err))
		return
	}
	defer os.RemoveAll(tempDir)
	copyStarted := time.Now()
	copyErr := files.CopyProjectToTemp(projectPath, tempDir)
	if h.Metrics != nil {
		h.Metrics.Observe("workspace.copy.host", time.Since(copyStarted))
	}
	if copyErr != nil {
		fail(fmt.Sprintf("Failed to copy project for task: %v", copyErr))
		return
	}
	output.WriteStatus("setup", fmt.Sprintf("Isolated task workspace ready in %d ms", time.Since(copyStarted).Milliseconds()))
	beforeSnapshot := files.SnapshotFiles(tempDir)

	dockerRunner := runner.NewDockerRunner(*runtimeDef, h.DockerPool, h.Security)
	dockerRunner.SetUserID(sess.UserID)
	dockerRunner.SetSetupCommands(sess.SetupCommands)
	dockerRunner.SetMetrics(h.Metrics)
	if personalLease != nil {
		dockerRunner.SetPersonalCacheContext(personalLease.ContainerKey, personalLease.DockerMounts, personalLease.DockerEnv, personalLease.Writable())
	}
	result := dockerRunner.RunTaskExecution(executionCtx, sess.Task, tempDir, output, stdinReader)
	if personalLease != nil && personalLease.Writable() && !dockerRunner.SetupPassed() {
		personalLease.Abort()
	}
	if result == nil {
		fail("Task execution returned no result")
		return
	}
	if personalCacheLeaseError(personalLease, ctx) != nil {
		personalLease.Abort()
		output.WriteError("Personal storage quota was exceeded while writing project dependencies")
		result.Success = false
		result.ReturnCode = 1
		result.Stderr = "personal storage quota exceeded"
	}
	if persistOperation != nil && persistOperation.Err() != nil {
		output.WriteError("Personal storage quota was exceeded while running the task")
		result.Success = false
		result.ReturnCode = 1
		result.Stderr = "personal storage quota exceeded"
	}
	if shouldPublishRunArtifacts(ctx, result) {
		changedFiles := files.SyncGeneratedArtifacts(tempDir, projectPath, beforeSnapshot, "")
		if shouldPublishRunArtifacts(ctx, result) {
			files.SendArtifacts(channel, tempDir, changedFiles, h.Config.ChunkSize)
		}
	}
	output.WriteArtifactEnd()
	output.WriteResult(result.Success, result.ReturnCode)
	slog.Info("Project task completed", "run_id", runID, "task", sess.Task.Label,
		"duration_ms", time.Since(started).Milliseconds(), "success", result.Success)
	runResult = result
	return
}
