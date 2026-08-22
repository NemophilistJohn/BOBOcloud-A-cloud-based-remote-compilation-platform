package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/buildcache"
	"bobocloud-server/internal/collab"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/docker"
	"bobocloud-server/internal/files"
	"bobocloud-server/internal/lifecycle"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/metrics"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/ringbuffer"
	"bobocloud-server/internal/runner"
	"bobocloud-server/internal/security"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"

	"github.com/gorilla/websocket"
)

// ============================================================
// ws.go — WebSocket 处理器（端口 3101）
//   Phase 2: 用户隔离工作区 + 用户配额感知
// ============================================================

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// WSHandler 处理 WebSocket 连接
type WSHandler struct {
	Config          *config.Config
	Sessions        storage.SessionStore
	Channels        *session.ChannelManager
	DockerPool      *docker.Pool
	Plugins         *runner.PluginRegistry // 语言插件注册表（编译/运行计划由插件生成）
	Security        security.Policy
	AuthEnabled     bool
	RunHistory      storage.RunHistoryStore // BoltDB 运行历史（nil 时不保存）
	Authenticator   auth.Authenticator      // 终端 WebSocket 认证（可为 nil）
	UserStore       auth.UserStore          // 终端 WebSocket 用户查找（可为 nil）
	AuthSessions    auth.AuthSessionStore   // 终端 WebSocket 会话验证（可为 nil）
	Collaboration   *collab.Manager
	BuildCache      *buildcache.Manager
	LSP             *lsp.Manager
	DependencyViews *lsp.DependencyRegistry
	Lifecycle       *lifecycle.Manager
	PersonalCache   *personalcache.Manager
	Metrics         *metrics.Registry
}

// HandleWebSocket 处理 WebSocket 连接
func (h *WSHandler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("WebSocket upgrade failed", "error", err)
		return
	}

	conn.SetReadLimit(int64(h.Config.WSReadLimit))
	conn.SetReadDeadline(time.Now().Add(15 * time.Second))

	_, rawMsg, err := conn.ReadMessage()
	if err != nil {
		sendWSErrorAndClose(conn, "Failed to read attach message")
		return
	}

	var msg model.WSMessage
	if err := json.Unmarshal(rawMsg, &msg); err != nil {
		sendWSErrorAndClose(conn, "Invalid attach payload")
		return
	}

	if msg.Type != "attach" {
		sendWSErrorAndClose(conn, "First message must be attach")
		return
	}

	if msg.Token == "" {
		sendWSErrorAndClose(conn, "Missing runId or token")
		return
	}
	runID, err := normalizeRunID(msg.RunID)
	if err != nil {
		sendWSErrorAndClose(conn, err.Error())
		return
	}
	msg.RunID = runID

	runSessionLifecycleMu.Lock()
	channel := h.Channels.GetOrCreate(msg.RunID, false)
	if channel == nil {
		runSessionLifecycleMu.Unlock()
		sendWSErrorAndClose(conn, "Unknown runId")
		slog.Error("WS attach rejected: unknown runId", "runId", msg.RunID)
		return
	}

	sess, ok := h.Sessions.Get(msg.RunID)
	if !ok {
		h.Channels.CleanupRun(msg.RunID, h.Sessions)
		runSessionLifecycleMu.Unlock()
		sendWSErrorAndClose(conn, "Unknown runId")
		slog.Error("WS attach rejected: no session", "runId", msg.RunID)
		return
	}

	if sess.Token != msg.Token {
		runSessionLifecycleMu.Unlock()
		sendWSErrorAndClose(conn, "Invalid token")
		slog.Error("WS attach rejected: invalid token", "runId", msg.RunID)
		return
	}

	if !h.Sessions.MarkStarted(msg.RunID) {
		runSessionLifecycleMu.Unlock()
		sendWSErrorAndClose(conn, "Run already started")
		slog.Error("WS attach rejected: already started", "runId", msg.RunID)
		return
	}

	channel.Attach(conn)
	runSessionLifecycleMu.Unlock()
	conn.SetReadDeadline(time.Time{})
	slog.Info("WS attached",
		"runId", msg.RunID,
		"user_id", sess.UserID,
		"file", sess.FilePath,
	)

	// 可取消的运行上下文：客户端发 {type:"cancel"} 即可中止运行
	runCtx, cancelRun := context.WithCancel(context.Background())
	defer cancelRun()

	// stdin 管道：客户端发 {type:"stdin", data:"..."} 时写入 stdinWrite，
	// 进程从 stdinRead 读取（Python input() / C scanf 等交互式输入）。
	// 使用 os.Pipe 而非 io.Pipe：io.Pipe 会导致 exec 包启动 copy goroutine，
	// 进程退出时 cmd.Wait() 会等该 goroutine，但它阻塞在 pipeReader.Read() 上
	// 造成死锁。os.Pipe 作为 *os.File 直接传给 cmd.Stdin，无 copy goroutine。
	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		slog.Error("Failed to create stdin pipe", "error", err)
		stdinRead, stdinWrite = nil, nil
	}
	if stdinRead != nil {
		defer stdinRead.Close()
	}
	var stdinQueue *stdinWriteQueue
	if stdinWrite != nil {
		stdinQueue = newStdinWriteQueue(stdinWrite, stdinQueueMaxMessages, stdinQueueMaxBytes, func(writeErr error) {
			slog.Warn("Failed to write process stdin", "runId", msg.RunID, "error", writeErr)
			cancelRun()
		})
		defer stdinQueue.Stop()
	}

	// 后台读取客户端消息：
	//   - cancel -> 取消运行上下文
	//   - stdin  -> 写入 stdinWrite 转发给进程 stdin
	// 连接关闭时 ReadMessage 报错自动退出，defer 关闭 stdinWrite。
	go readRunMessages(conn, msg.RunID, stdinQueue, cancelRun)

	var stdinReader io.Reader
	if stdinRead != nil {
		stdinReader = stdinRead
	}

	var runResult *model.RunResult
	if sess.Task != nil {
		runResult = h.runProjectTask(runCtx, msg.RunID, sess, channel, stdinReader)
	} else {
		runResult = h.runCodeTask(runCtx, msg.RunID, sess, channel, stdinReader)
	}
	if stdinQueue != nil {
		stdinQueue.Stop()
	}

	channel.WaitUntilClosed()
	h.Channels.CleanupRun(msg.RunID, h.Sessions)

	// ── 保存运行历史（仅 BoltDB 模式）──
	if h.RunHistory != nil && runResult != nil {
		status := runHistoryStatus(runResult)
		summary, outputTruncated := runHistorySummary(runResult)

		displayTarget, targetType, taskLabel, taskKind := runHistoryTarget(sess)
		record := &model.RunRecord{
			RunID:           msg.RunID,
			UserID:          sess.UserID,
			FolderName:      sess.FolderName,
			FilePath:        displayTarget,
			TargetType:      targetType,
			TaskLabel:       taskLabel,
			TaskKind:        taskKind,
			Runtime:         sess.Runtime,
			BuildTarget:     sess.BuildTarget,
			Status:          status,
			ExitCode:        runResult.ReturnCode,
			DurationMs:      time.Since(sess.CreatedAt).Milliseconds(),
			CreatedAt:       sess.CreatedAt,
			OutputSummary:   summary,
			OutputTruncated: outputTruncated,
		}
		if err := h.RunHistory.Save(record); err != nil {
			slog.Error("Failed to save run history", "run_id", msg.RunID, "error", err)
		}
	}
}

const runHistoryOutputLimit = 64 << 10

func runHistorySummary(result *model.RunResult) (string, bool) {
	if result == nil {
		return "", false
	}
	output := ringbuffer.New(runHistoryOutputLimit)
	_, _ = output.Write([]byte(result.Stdout))
	if result.Stderr != "" {
		if result.Stdout != "" {
			_, _ = output.Write([]byte("\n"))
		}
		_, _ = output.Write([]byte(result.Stderr))
	}
	return output.String(), result.StdoutTruncated || result.StderrTruncated || output.Truncated()
}

func runHistoryTarget(sess *model.RunSession) (displayTarget, targetType, taskLabel, taskKind string) {
	if sess == nil || sess.Task == nil {
		if sess != nil {
			displayTarget = sess.FilePath
		}
		return displayTarget, "file", "", ""
	}
	taskLabel = sess.Task.Label
	taskKind = sess.Task.Kind
	return fmt.Sprintf("Task [%s]: %s", taskKind, taskLabel), "task", taskLabel, taskKind
}

func runHistoryStatus(result *model.RunResult) string {
	if result == nil {
		return "failed"
	}
	if result.Cancelled {
		return "cancelled"
	}
	if result.TimedOut {
		return "timed_out"
	}
	if !result.Success {
		return "failed"
	}
	return "completed"
}

func readRunMessages(conn *websocket.Conn, runID string, stdinQueue *stdinWriteQueue, cancelRun context.CancelFunc) {
	if stdinQueue != nil {
		defer stdinQueue.Stop()
	}
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			// A disconnected client can no longer consume output or provide
			// stdin, so stop the process and release its container promptly.
			cancelRun()
			return
		}
		var message model.WSMessage
		if json.Unmarshal(raw, &message) != nil {
			continue
		}
		switch message.Type {
		case "cancel":
			slog.Info("Run cancelled by client", "runId", runID)
			cancelRun()
			return
		case "stdin":
			if stdinQueue != nil && !stdinQueue.Enqueue(message.Data) {
				slog.Warn("Process stdin queue is full; cancelling run", "runId", runID)
				cancelRun()
				return
			}
		}
	}
}

// runCodeTask 在 Channel 上执行代码，返回运行结果
func (h *WSHandler) runCodeTask(ctx context.Context, runID string, sess *model.RunSession, channel *session.RunChannel, stdinReader io.Reader) (runResult *model.RunResult) {
	output := session.NewWebSocketWriter(channel, h.Config.ChunkSize)
	taskStarted := time.Now()
	output.WriteStatus("setup", "Run accepted; resolving workspace")

	defer func() {
		channel.Close()
		h.Channels.CleanupRun(runID, h.Sessions)
	}()
	defer func() {
		if runResult != nil && ctx.Err() == context.Canceled {
			runResult.Cancelled = true
		}
	}()

	// 辅助：在错误流程中设置失败结果并返回
	fail := func(msg string) {
		output.WriteError(msg)
		output.WriteResult(false, 1)
		runResult = &model.RunResult{Success: false, ReturnCode: 1}
	}

	if h.Lifecycle != nil && sess.UserID != "" {
		workspaceKey := ""
		if sess.TeamID == "" {
			workspaceKey = sess.FolderKey
			if workspaceKey == "" {
				workspaceKey = sess.FolderName
			}
		}
		activity, leaseErr := h.Lifecycle.AcquireActivity(sess.UserID, workspaceKey)
		if leaseErr != nil {
			fail(leaseErr.Error())
			return
		}
		defer activity.Release()
	}
	if sess.TeamID != "" && sess.ProjectID != "" && h.Collaboration != nil {
		projectActivity, leaseErr := h.Collaboration.AcquireProjectActivity(sess.UserID, sess.TeamID, sess.ProjectID)
		if leaseErr != nil {
			fail(leaseErr.Error())
			return
		}
		defer projectActivity.Release()
	}

	// Phase 2: 使用用户隔离的工作区路径
	projectPath, err := h.resolveWorkspace(ctx, sess)
	if err != nil {
		fail("Invalid workspace path: " + err.Error())
		return
	}

	// 入口文件统一为 slash 相对路径（Windows 客户端会发反斜杠路径）
	entryRel := strings.ReplaceAll(sess.FilePath, "\\", "/")
	ext := strings.ToLower(filepath.Ext(entryRel))

	// ── 语言插件查找：入口扩展名 → 插件 ──
	plugin := h.Plugins.ForExtension(ext)
	if plugin == nil {
		fail(fmt.Sprintf("Unsupported file extension: %s (supported: .py .java .c .cpp .cc .cxx .go .rs .js .mjs .cjs)", ext))
		return
	}

	// ── 运行时选择 + 语言一致性校验 ──
	useDocker := sess.Runtime != ""
	var rt *model.RuntimeDef
	if useDocker {
		rt = model.GetRuntimeDef(sess.Runtime)
		if rt == nil {
			fail(fmt.Sprintf("Unknown runtime: %s", sess.Runtime))
			return
		}
		if rt.Language != plugin.Language() {
			fail(fmt.Sprintf("Runtime \"%s\" (%s) cannot run %s files. Please select a %s runtime (or Local).",
				sess.Runtime, rt.Language, ext, plugin.Language()))
			return
		}
		output.WriteStatus("setup", fmt.Sprintf("Using Docker runtime: %s (%s) [user=%s]",
			rt.DisplayName, rt.DockerImage, sess.UserID))
	} else {
		output.WriteStatus("setup", fmt.Sprintf("Using local executor for %s (runs on server host, no sandbox)", plugin.Language()))
	}

	// A client selects a catalog ID, never an arbitrary compiler or image.
	// Resolve it only after the language/runtime checks above.
	var buildTarget model.BuildTarget
	if plugin.Language() == "c" || plugin.Language() == "cpp" || plugin.Language() == "rust" || plugin.Language() == "go" {
		var targetOK bool
		buildTarget, targetOK = model.ResolveBuildTarget(plugin.Language(), sess.BuildTarget)
		if !targetOK {
			fail(fmt.Sprintf("Unsupported build target %q for %s", sess.BuildTarget, plugin.Language()))
			return
		}
		if model.IsCrossBuildTarget(buildTarget) {
			if !useDocker || rt == nil {
				fail("Cross-compilation requires a Docker runtime")
				return
			}
			image := model.CrossBuildImage(*rt, buildTarget)
			if image == "" {
				fail(fmt.Sprintf("No cross toolchain is available for %s", plugin.Language()))
				return
			}
			runtimeCopy := *rt
			runtimeCopy.DockerImage = image
			rt = &runtimeCopy
			output.WriteStatus("target", fmt.Sprintf("Cross-compiling for %s/%s; artifact: %s", buildTarget.OS, buildTarget.Architecture, buildTarget.OutputPath))
		}
	} else if sess.BuildTarget != "" {
		fail(fmt.Sprintf("Build targets are not supported for %s files", plugin.Language()))
		return
	}

	// Team builds use an exclusive branch/runtime cache namespace. This allows
	// every member to reuse previous dependency and incremental compiler output
	// without concurrent writers corrupting a Cargo/Go target directory.
	var preparedCache *buildcache.Prepared
	teamCacheQuotaMB := 0
	if sess.TeamID != "" && sess.ProjectID != "" {
		if h.BuildCache == nil || h.Collaboration == nil {
			fail("Team build cache is not configured")
			return
		}
		runtimeKey := "local"
		if useDocker {
			runtimeKey = "docker-" + sess.Runtime
			if buildTarget.ID != "" {
				runtimeKey += "-" + buildTarget.ID
			}
		}
		cacheStarted := time.Now()
		output.WriteStatus("cache", "Waiting for exclusive team cache lease")
		preparedCache, err = h.BuildCache.Prepare(ctx, buildcache.BuildContext{
			TeamID: sess.TeamID, ProjectID: sess.ProjectID, Branch: sess.Branch,
			Runtime: runtimeKey, Language: plugin.Language(),
		})
		if err != nil {
			fail("Failed to prepare team build cache: " + err.Error())
			return
		}
		output.WriteStatus("cache", fmt.Sprintf("Team cache lease acquired in %d ms", time.Since(cacheStarted).Milliseconds()))
		if team, teamErr := h.Collaboration.Store().GetTeam(sess.TeamID); teamErr == nil {
			teamCacheQuotaMB = team.CacheQuotaMB
		}
		defer func() {
			_ = os.RemoveAll(preparedCache.Buildspace)
			preparedCache.Release()
			h.BuildCache.RequestEnforce(sess.TeamID, teamCacheQuotaMB)
		}()
		output.WriteStatus("cache", fmt.Sprintf("Team cache namespace ready: %s / %s / %s", sess.Branch, runtimeKey, plugin.Language()))
	}
	var personalLease *personalcache.Lease
	executionCtx := ctx
	if useDocker && preparedCache == nil {
		personalLease, err = h.prepareRunPersonalCache(ctx, sess, *rt, plugin.Language(), projectPath)
		if err != nil {
			fail("Failed to prepare project dependency cache: " + err.Error())
			return
		}
		if personalLease != nil {
			defer personalLease.Release()
			guard := personalLease.StartGuard(ctx)
			if guard != nil {
				executionCtx = guard.Context
			}
			output.WriteStatus("cache", fmt.Sprintf("Project dependency cache %s (%s:%s)", map[bool]string{true: "hit", false: "miss"}[personalLease.Hit], personalLease.Fingerprint.Source, personalLease.Fingerprint.Digest[:12]))
		}
	}
	var persistOperation *personalcache.Operation
	if useDocker && personalLease == nil && h.PersonalCache != nil {
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

	var tempDir string
	if preparedCache != nil {
		tempDir = preparedCache.Buildspace
		// Keep the path stable for compilers that hash absolute source paths, but
		// replace its contents under the exclusive lease for each build.
		err = os.RemoveAll(tempDir)
		if err == nil {
			err = os.MkdirAll(tempDir, 0755)
		}
	} else {
		tempDir, err = os.MkdirTemp("", fmt.Sprintf("run-%s-", runID[:min(8, len(runID))]))
		if err == nil {
			defer os.RemoveAll(tempDir)
		}
	}
	if err != nil {
		fail(fmt.Sprintf("Failed to create isolated build directory: %v", err))
		return
	}

	copyStarted := time.Now()
	output.WriteStatus("setup", fmt.Sprintf("Preparing isolated workspace for %s", entryRel))
	copyErr := files.CopyProjectToTemp(projectPath, tempDir)
	if h.Metrics != nil {
		h.Metrics.Observe("workspace.copy.host", time.Since(copyStarted))
	}
	if copyErr != nil {
		fail(fmt.Sprintf("Failed to copy project: %v", copyErr))
		return
	}
	output.WriteStatus("setup", fmt.Sprintf("Isolated workspace ready in %d ms", time.Since(copyStarted).Milliseconds()))

	beforeSnapshot := files.SnapshotFiles(tempDir)

	tempFilePath := filepath.Join(tempDir, filepath.FromSlash(entryRel))
	if _, err := os.Stat(tempFilePath); os.IsNotExist(err) {
		fail(fmt.Sprintf("File missing in isolated workspace: %s", entryRel))
		return
	}

	// ── 生成执行计划（Docker 与本地共用同一份 Plan）──
	projectFiles := make([]string, 0, len(beforeSnapshot))
	for rel := range beforeSnapshot {
		projectFiles = append(projectFiles, rel)
	}

	projectRoot := tempDir
	if useDocker {
		projectRoot = "/workspace"
	}
	plan, err := plugin.Plan(&runner.PlanRequest{
		EntryRelPath: entryRel,
		ProjectFiles: projectFiles,
		HostWorkDir:  tempDir,
		ProjectRoot:  projectRoot,
		CompileArgs:  sess.CompileArgs,
		RunArgs:      sess.RunArgs,
		BuildTarget:  buildTarget,
		Timeouts: runner.TimeoutConfig{
			CompileSec:     h.Config.DefaultCompileTimeout,
			RustCompileSec: h.Config.RustCompileTimeout,
			RunSec:         h.Config.DefaultRunTimeout,
		},
	})
	if err != nil {
		fail("Failed to build run plan: " + err.Error())
		return
	}
	if preparedCache != nil {
		env := preparedCache.LocalEnv
		if useDocker {
			env = preparedCache.DockerEnv
		}
		for i := range plan.Steps {
			plan.Steps[i].Env = buildcache.MergeEnv(plan.Steps[i].Env, env)
		}
	}

	// ── 执行计划 ──
	var result *model.RunResult
	dependencySetupPassed := false
	gradleSetupPassed := false
	if useDocker {
		dr := runner.NewDockerRunner(*rt, h.DockerPool, h.Security)
		dr.SetSetupCommands(sess.SetupCommands)
		dr.SetUserID(sess.UserID) // Phase 2: 传入用户 ID
		dr.SetMetrics(h.Metrics)
		if preparedCache != nil {
			dr.SetBuildCacheContext(preparedCache.ContainerKey, preparedCache.DockerMounts, preparedCache.DockerEnv)
		} else if personalLease != nil {
			dr.SetBuildCacheContext(personalLease.ContainerKey, personalLease.DockerMounts, personalLease.DockerEnv)
		}
		result = dr.RunPlan(executionCtx, plan, tempDir, output, stdinReader)
		if dr.SetupPassed() {
			for _, command := range sess.SetupCommands {
				if h.Security != nil && !h.Security.AllowCommand(command) {
					continue
				}
				if dependencyCommandLikelyChangesEnvironment(command) {
					dependencySetupPassed = true
					if dependencyCommandUsesGradle(command) {
						gradleSetupPassed = true
					}
				}
			}
		}
	} else {
		result = runner.ExecutePlanWithMetrics(ctx, plan, runner.NewLocalStepExecutor(tempDir), output, stdinReader, h.Metrics)
	}

	if result == nil {
		fail("Execution returned no result")
		return
	}
	if personalLease != nil && personalLease.StartGuard(ctx).Err() != nil {
		output.WriteError("Personal storage quota was exceeded while writing project dependencies")
		result.Success = false
		result.ReturnCode = 1
		result.Stderr = "personal storage quota exceeded"
	}
	if persistOperation != nil && persistOperation.Err() != nil {
		output.WriteError("Personal storage quota was exceeded while running the project")
		result.Success = false
		result.ReturnCode = 1
		result.Stderr = "personal storage quota exceeded"
	}

	runtimeID := sess.Runtime
	if runtimeID == "" {
		runtimeID = "local"
	}
	if plugin.Language() == "node" && dependencySetupPassed && h.LSP != nil && h.DependencyViews != nil && (preparedCache != nil || personalLease == nil) {
		snapshotRoot, releaseSnapshotRoot, snapshotRootErr := h.dependencySnapshotRoot(sess.UserID, preparedCache)
		if snapshotRootErr != nil {
			output.WriteStderr("Analysis dependency snapshot skipped: "+snapshotRootErr.Error(), "analysis")
		} else if snapshotRoot != "" {
			folderKey := sess.FolderKey
			if folderKey == "" {
				folderKey = sess.FolderName
			}
			workspaceID := lsp.StableWorkspaceIdentity(sess.UserID, sess.TeamID, sess.ProjectID, sess.Branch, folderKey)
			runtimeFingerprint := runtimeID
			if rt != nil {
				runtimeFingerprint += "\x00" + rt.DockerImage
			}
			var published lsp.DependencySnapshotResult
			publish := func(policy lsp.DependencySnapshotPolicy) error {
				var publishErr error
				published, publishErr = lsp.PublishNodeDependencySnapshotWithPolicy(
					snapshotRoot, workspaceID, tempDir, runtimeID, runtimeFingerprint,
					filepath.Join(tempDir, "node_modules"), policy,
				)
				return publishErr
			}
			var publishErr error
			if preparedCache != nil && h.BuildCache != nil {
				publishErr = h.BuildCache.WithQuotaGuard(sess.TeamID, teamCacheQuotaMB, func(info buildcache.Info) error {
					// Scratch contains the source node_modules tree that is moved into
					// the immutable store, so it is not part of steady-state usage.
					nodeBytes := dirSizeOnDisk(filepath.Join(snapshotRoot, "node"))
					otherBytes := info.TotalBytes - info.ScratchBytes - nodeBytes
					return publish(nodeDependencySnapshotPolicy(info.QuotaBytes, otherBytes))
				})
			} else {
				quotaBytes := int64(0)
				if h.UserStore != nil {
					if user, userErr := h.UserStore.Get(sess.UserID); userErr == nil && user.DiskQuotaMB > 0 {
						quotaBytes = int64(user.DiskQuotaMB) * 1_000_000
					}
				}
				userRoot := filepath.Join(h.Config.DataDir, "users", sess.UserID)
				nodeBytes := dirSizeOnDisk(filepath.Join(snapshotRoot, "node"))
				otherBytes := dirSizeOnDisk(userRoot) - nodeBytes
				publishErr = publish(nodeDependencySnapshotPolicy(quotaBytes, otherBytes))
			}
			releaseSnapshotRoot()
			if publishErr != nil {
				output.WriteStderr("Analysis dependency snapshot skipped: "+publishErr.Error(), "analysis")
			} else if published.Changed {
				output.WriteStatus("analysis", fmt.Sprintf("Node dependency view published (%d MiB)", published.Size/(1<<20)))
			}
		}
	}
	if plugin.Language() == "java" && gradleSetupPassed && h.LSP != nil && h.DependencyViews != nil && (preparedCache != nil || personalLease == nil) {
		snapshotRoot, releaseSnapshotRoot, snapshotRootErr := h.dependencySnapshotRoot(sess.UserID, preparedCache)
		if snapshotRootErr != nil {
			output.WriteStderr("Gradle analysis dependency snapshot skipped: "+snapshotRootErr.Error(), "analysis")
		} else {
			gradleHome := filepath.Join(h.Config.DataDir, "users", sess.UserID, "persist", "gradle")
			if preparedCache != nil {
				gradleHome = filepath.Join(preparedCache.SharedHost, "gradle")
			}
			modulesRoot := filepath.Join(gradleHome, "caches", "modules-2")
			publish := func(policy lsp.DependencySnapshotPolicy) error {
				published, publishErr := lsp.PublishGradleDependencySnapshotWithPolicy(snapshotRoot, runtimeID, modulesRoot, policy)
				if publishErr == nil && published.Changed {
					output.WriteStatus("analysis", fmt.Sprintf("Gradle dependency view published (%d MiB)", published.Size/(1<<20)))
				}
				return publishErr
			}
			var publishErr error
			if preparedCache != nil && h.BuildCache != nil {
				publishErr = h.BuildCache.WithQuotaGuard(sess.TeamID, teamCacheQuotaMB, func(info buildcache.Info) error {
					gradleBytes := dirSizeOnDisk(filepath.Join(snapshotRoot, "gradle"))
					otherBytes := info.TotalBytes - info.ScratchBytes - gradleBytes
					return publish(gradleDependencySnapshotPolicy(info.QuotaBytes, otherBytes))
				})
			} else {
				quotaBytes := int64(0)
				if h.UserStore != nil {
					if user, userErr := h.UserStore.Get(sess.UserID); userErr == nil && user.DiskQuotaMB > 0 {
						quotaBytes = int64(user.DiskQuotaMB) * 1_000_000
					}
				}
				userRoot := filepath.Join(h.Config.DataDir, "users", sess.UserID)
				gradleBytes := dirSizeOnDisk(filepath.Join(snapshotRoot, "gradle"))
				otherBytes := dirSizeOnDisk(userRoot) - gradleBytes
				publishErr = publish(gradleDependencySnapshotPolicy(quotaBytes, otherBytes))
			}
			releaseSnapshotRoot()
			if publishErr != nil {
				output.WriteStderr("Gradle analysis dependency snapshot skipped: "+publishErr.Error(), "analysis")
			}
		}
	}
	if shouldPublishRunArtifacts(ctx, result) {
		changedFiles := files.SyncGeneratedArtifacts(tempDir, projectPath, beforeSnapshot, entryRel)
		if shouldPublishRunArtifacts(ctx, result) {
			files.SendArtifacts(channel, tempDir, changedFiles, h.Config.ChunkSize)
		}
	}
	output.WriteArtifactEnd()

	output.WriteResult(result.Success, result.ReturnCode)
	slog.Info("Run completed", "run_id", runID, "duration_ms", time.Since(taskStarted).Milliseconds(), "success", result.Success)
	if dependencySetupPassed && h.LSP != nil && h.DependencyViews != nil {
		scope := lsp.DependencyRefreshScope{
			ProjectID: sess.ProjectID, Branch: sess.Branch,
			RuntimeID: runtimeID, LanguageID: plugin.Language(),
		}
		if sess.TeamID != "" {
			scope.OwnerKind, scope.OwnerID = "team", sess.TeamID
		} else {
			scope.UserID, scope.OwnerKind, scope.OwnerID = sess.UserID, "user", sess.UserID
			scope.FolderKey = sess.FolderKey
			if scope.FolderKey == "" {
				scope.FolderKey = sess.FolderName
			}
		}
		go h.LSP.RefreshDependencyViews(h.DependencyViews, scope)
	}
	runResult = result
	return
}

func shouldPublishRunArtifacts(ctx context.Context, result *model.RunResult) bool {
	return ctx.Err() == nil && result != nil && !result.TimedOut
}

func nodeDependencySnapshotPolicy(quotaBytes, otherBytes int64) lsp.DependencySnapshotPolicy {
	return dependencySnapshotPolicy(lsp.DefaultNodeDependencyStoreBytes, quotaBytes, otherBytes)
}

func gradleDependencySnapshotPolicy(quotaBytes, otherBytes int64) lsp.DependencySnapshotPolicy {
	return dependencySnapshotPolicy(lsp.DefaultGradleDependencyStoreBytes, quotaBytes, otherBytes)
}

func dependencySnapshotPolicy(defaultBytes, quotaBytes, otherBytes int64) lsp.DependencySnapshotPolicy {
	policy := lsp.DependencySnapshotPolicy{
		MaxStoreBytes:      defaultBytes,
		MaxAdditionalBytes: -1,
	}
	if quotaBytes <= 0 {
		return policy
	}
	if otherBytes < 0 {
		otherBytes = 0
	}
	available := quotaBytes - otherBytes
	if available <= 0 {
		// Same-revision reuse can still succeed, but exhausted storage cannot
		// materialize another immutable generation.
		policy.MaxStoreBytes = 1
		policy.MaxAdditionalBytes = 0
		return policy
	}
	if available < policy.MaxStoreBytes {
		policy.MaxStoreBytes = available
	}
	return policy
}

func (h *WSHandler) dependencySnapshotRoot(userID string, prepared *buildcache.Prepared) (string, func(), error) {
	if prepared != nil {
		if strings.TrimSpace(prepared.DependencyHost) == "" {
			return "", func() {}, fmt.Errorf("team analysis dependency store is unavailable")
		}
		return prepared.DependencyHost, func() {}, nil
	}
	if h == nil || h.Config == nil || strings.TrimSpace(userID) == "" {
		return "", func() {}, fmt.Errorf("personal analysis dependency store is unavailable")
	}
	lease, err := lsp.AcquirePersonalDependencyStore(h.Config.DataDir, userID)
	if err != nil {
		return "", func() {}, err
	}
	return lease.Root, lease.Release, nil
}

func (h *WSHandler) bumpAnalysisDependencyGeneration(userID string, prepared *buildcache.Prepared) error {
	root, release, err := h.dependencySnapshotRoot(userID, prepared)
	if err != nil {
		return err
	}
	defer release()
	_, snapshotErr := lsp.BumpAnalysisDependencyGeneration(root)
	if prepared == nil || strings.TrimSpace(prepared.SharedHost) == "" {
		return snapshotErr
	}
	// Go, Rust, Maven, and other download caches are runtime-wide team data.
	// Bump their root as well so sessions on another branch/project do not rely
	// on a bounded directory sample to notice a newly downloaded deep package.
	_, sharedErr := lsp.BumpAnalysisDependencyGeneration(prepared.SharedHost)
	return errors.Join(snapshotErr, sharedErr)
}

// resolveWorkspace 返回用户隔离的工作区路径（已校验路径穿越）。
// 优先使用 folderKey（路径哈希，避免同名项目冲突），为空时回退 folderName。
func (h *WSHandler) resolveWorkspace(ctx context.Context, sess *model.RunSession) (string, error) {
	if sess.TeamID != "" || sess.ProjectID != "" {
		if h.Collaboration == nil || sess.TeamID == "" || sess.ProjectID == "" {
			return "", fmt.Errorf("invalid team project context")
		}
		return h.Collaboration.ResolveWorktree(ctx, sess.UserID, sess.TeamID, sess.ProjectID, sess.Branch)
	}
	var root string
	if h.AuthEnabled && sess.UserID != "" {
		root = filepath.Join(h.Config.DataDir, "users", sess.UserID, "workspaces")
	} else {
		root = h.Config.ServerRoot
	}
	key := sess.FolderKey
	if key == "" {
		key = sess.FolderName
	}
	return safePath(root, key)
}

func sendWSErrorAndClose(conn *websocket.Conn, msg string) {
	_ = conn.WriteJSON(session.MakeError(msg))
	conn.Close()
}
