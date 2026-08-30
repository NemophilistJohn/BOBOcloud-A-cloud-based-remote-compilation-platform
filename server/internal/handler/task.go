package handler

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"bobocloud-server/internal/files"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/resourcecontrol"
	"bobocloud-server/internal/runner"
	"bobocloud-server/internal/session"
)

func (h *WSHandler) runProjectTask(ctx context.Context, runID string, sess *model.RunSession, channel *session.RunChannel, stdinReader io.Reader) (runResult *model.RunResult) {
	output := session.NewWebSocketWriter(channel, h.Config.ChunkSize)
	started := time.Now()
	output.WriteStatus("setup", "Validating task request")
	defer func() {
		channel.Close()
		if err := h.Channels.CleanupRun(runID, channel, h.Sessions); err != nil {
			slog.Error("Failed to clean project task session", "run_id", runID, "error", err)
		}
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
	runtimeDef := model.GetRuntimeDef(sess.Runtime)
	if runtimeDef == nil || sess.Runtime == "" {
		fail("Project tasks require a known Docker runtime")
		return
	}
	resourceLease, resourceErr := acquireHandlerRuntimeResource(
		ctx, h.Resources, resourcecontrol.WorkloadTask, sess.UserID, runSessionResourceScope(sess), runID,
		runtimeDef.RuntimeID, runtimeDef.Language, runtimeDef.DockerImage, true,
	)
	if resourceErr != nil {
		fail(resourcePressureMessage)
		return
	}
	defer releaseHandlerResource(resourceLease)
	output.WriteStatus("setup", "Task accepted; resolving cloud workspace")
	output.WriteStatus("setup", fmt.Sprintf("Using Docker runtime: %s (%s)", runtimeDef.DisplayName, runtimeDef.DockerImage))
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
	workspaceKey := strings.TrimSpace(sess.FolderKey)
	if workspaceKey == "" {
		workspaceKey = strings.TrimSpace(sess.FolderName)
	}
	runtimeFingerprint := resolvedRuntimeFingerprint(ctx, h.RuntimeMetadata, runtimeDef.RuntimeID, runtimeDef.DockerImage, runtimeDef.Version)
	var toolchainLease *personalcache.ToolchainLease
	if personalLease != nil && personalLease.Writable() {
		tool := ""
		switch runtimeDef.Language {
		case "python":
			tool = "pip"
		case "node":
			tool = "npm"
		}
		if tool != "" {
			toolchainLease, err = h.PersonalCache.PrepareToolchainCache(executionCtx, personalcache.ToolchainRequest{
				UserID: sess.UserID, RuntimeID: runtimeDef.RuntimeID, RuntimeFingerprint: runtimeFingerprint,
				Language: runtimeDef.Language, Tool: tool,
				SourcePolicyDigest: packageSourcePolicyDigest("task-setup", strings.Join(sess.SetupCommands, "\x00")),
				QuotaBytes:         userQuotaBytes(h.UserStore, sess.UserID),
			})
			if err != nil {
				fail("Failed to prepare task tool download cache: " + err.Error())
				return
			}
			if toolchainLease != nil {
				defer toolchainLease.Release()
			}
		}
	}
	var buildLease *personalcache.BuildLease
	if sess.TeamID == "" && h.PersonalCache != nil && h.Config.PersonalBuildCacheEnabled {
		switch runtimeDef.Language {
		case "c", "cpp", "go", "rust", "java":
			dependencyDigest := ""
			if personalLease != nil {
				dependencyDigest = personalLease.Fingerprint.Digest
			}
			buildLease, err = h.PersonalCache.PrepareBuild(executionCtx, personalcache.BuildRequest{
				UserID: sess.UserID, WorkspaceID: lsp.StableWorkspaceIdentity(sess.UserID, "", "", "", workspaceKey), WorkspaceName: sess.FolderName,
				RuntimeID: runtimeDef.RuntimeID, RuntimeFingerprint: runtimeFingerprint, Language: runtimeDef.Language,
				DependencyDigest: dependencyDigest, Target: "task:" + strings.TrimSpace(sess.Task.Label),
			})
			if err != nil {
				fail("Failed to prepare task build cache: " + err.Error())
				return
			}
			if buildLease != nil {
				defer buildLease.Release()
			}
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
	if personalLease != nil || toolchainLease != nil || buildLease != nil {
		keys := make([]string, 0, 3)
		mounts := make(map[string]string)
		environment := make(map[string]string)
		writable := false
		if personalLease != nil {
			keys = append(keys, personalLease.ContainerKey)
			mounts = mergeCacheContext(mounts, personalLease.DockerMounts)
			environment = mergeCacheContext(environment, personalLease.DockerEnv)
			writable = personalLease.Writable()
		}
		if toolchainLease != nil {
			keys = append(keys, toolchainLease.ContainerKey)
			mounts = mergeCacheContext(mounts, toolchainLease.DockerMounts)
			environment = mergeCacheContext(environment, toolchainLease.DockerEnv)
			writable = true
		}
		if buildLease != nil {
			keys = append(keys, buildLease.ContainerKey)
			mounts = mergeCacheContext(mounts, buildLease.DockerMounts)
			environment = mergeCacheContext(environment, buildLease.DockerEnv)
			writable = true
		}
		dockerRunner.SetPersonalCacheContext(strings.Join(keys, "+"), mounts, environment, writable)
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
