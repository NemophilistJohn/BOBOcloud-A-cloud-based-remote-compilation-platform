package handler

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/buildcache"
	"bobocloud-server/internal/containercleanup"
	"bobocloud-server/internal/docker"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/resourcecontrol"
	"bobocloud-server/internal/safefile"

	"github.com/gorilla/websocket"
)

//go:embed notebook_kernel.py
var notebookKernelPython string

//go:embed notebook_seed_pip.py
var notebookSeedPipPython string

const (
	notebookProtocol    = 1
	notebookCodeBytes   = 256 << 10
	notebookResultBytes = 8 << 20
	notebookIdle        = 3 * time.Minute
	notebookLifetime    = 30 * time.Minute
)

var notebookUpgrader = websocket.Upgrader{CheckOrigin: websocketOriginAllowed}

type notebookRequest struct {
	Type string `json:"type"`
	ID   int    `json:"id"`
	Code string `json:"code"`
}

type notebookStart struct {
	Type          string                   `json:"type"`
	Protocol      int                      `json:"protocol"`
	Token         string                   `json:"token"`
	RuntimeID     string                   `json:"runtimeId"`
	Workspace     terminalWorkspaceRequest `json:"workspace"`
	SetupCommands []string                 `json:"setupCommands"`
	DocumentDir   string                   `json:"documentDir"`
}

type notebookResult struct {
	Ready   bool              `json:"ready,omitempty"`
	Count   int               `json:"executionCount"`
	OK      bool              `json:"ok"`
	Outputs []json.RawMessage `json:"outputs"`
}

type notebookProcess struct {
	input   io.WriteCloser
	replies chan notebookResult
	done    chan struct{}
	cancel  context.CancelFunc
}

func startNotebookProcess(ctx context.Context, name string, args ...string) (*notebookProcess, error) {
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = 2 * time.Second
	input, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		input.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		input.Close()
		output.Close()
		return nil, err
	}
	p := &notebookProcess{input: input, replies: make(chan notebookResult), done: make(chan struct{}), cancel: cancel}
	go func() {
		defer close(p.done)
		defer close(p.replies)
		defer cmd.Wait()
		defer cancel()
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 4096), notebookResultBytes)
		for scanner.Scan() {
			var response notebookResult
			if json.Unmarshal(scanner.Bytes(), &response) != nil {
				return
			}
			select {
			case p.replies <- response:
			case <-ctx.Done():
				return
			}
		}
	}()
	return p, nil
}

func (p *notebookProcess) close() {
	p.cancel()
	_ = p.input.Close()
	<-p.done
}

func (p *notebookProcess) receive(ctx context.Context) (notebookResult, error) {
	select {
	case result, ok := <-p.replies:
		if ok {
			return result, nil
		}
		return notebookResult{}, io.EOF
	case <-ctx.Done():
		return notebookResult{}, ctx.Err()
	}
}

func (p *notebookProcess) execute(ctx context.Context, code string) (notebookResult, error) {
	// A dead interpreter can leave its stdin pipe full. Cancel the whole
	// interpreter when the cell deadline expires, including during the write.
	stop := context.AfterFunc(ctx, p.cancel)
	defer func() {
		stop()
		// The deadline may be observed by receive before the AfterFunc callback
		// starts. Stopping that pending callback must not leave the kernel alive.
		if ctx.Err() != nil {
			p.cancel()
		}
	}()
	if err := json.NewEncoder(p.input).Encode(notebookRequest{Code: code}); err != nil {
		if ctx.Err() != nil {
			return notebookResult{}, ctx.Err()
		}
		return notebookResult{}, err
	}
	return p.receive(ctx)
}

func validNotebookPath(value string) bool {
	if value == "" || value == "." {
		return true
	}
	if len(value) > 1024 || strings.ContainsAny(value, "\\\x00") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if safefile.ValidateChildName(part) != nil {
			return false
		}
	}
	return true
}

func (h *WSHandler) HandleNotebookWebSocket(w http.ResponseWriter, r *http.Request) {
	releaseWork, accepted := acquireLongLivedWork(w, h.Accepting, h.AcquireWork, "notebook-websocket")
	if !accepted {
		return
	}
	defer releaseWork()
	conn, err := notebookUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	stopClose := closeWebSocketOnContext(r.Context(), conn)
	defer stopClose()
	write := func(value any) error {
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteJSON(value)
	}
	fail := func(code string) {
		slog.Debug("Notebook request failed", "code", code)
		_ = write(map[string]any{"type": "notebook.error", "code": code})
	}
	if h.Config == nil || h.DockerPool == nil || !h.Config.DockerHardening {
		fail("disabled")
		return
	}
	conn.SetReadLimit(64 << 10)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var start notebookStart
	if conn.ReadJSON(&start) != nil || start.Type != "notebook.start" || start.Protocol != notebookProtocol ||
		!validNotebookPath(start.DocumentDir) || validateRunArgs(start.SetupCommands) != nil {
		fail("invalid_start")
		return
	}
	user, err := h.authenticateTerminal(start.Token)
	if err != nil {
		fail("unauthorized")
		return
	}
	runtime := model.GetRuntimeDef(start.RuntimeID)
	if runtime == nil || runtime.Language != "python" {
		fail("invalid_runtime")
		return
	}
	key, team, project, err := terminalWorkspaceAdmissionIdentity(start.Workspace)
	if err != nil || (team == "" && safefile.ValidateChildName(key) != nil) ||
		(team != "" && (h.Collaboration == nil || !h.Collaboration.IsMember(user.ID, team))) {
		fail("workspace_denied")
		return
	}
	ctx, stop := context.WithTimeout(r.Context(), notebookLifetime)
	defer stop()
	var userStore auth.UserStore
	if h.AuthEnabled {
		userStore = h.UserStore
	}
	ctx, releaseOperation, err := bindUserOperation(ctx, h.Lifecycle, userStore, user.ID)
	if err != nil {
		fail("unauthorized")
		return
	}
	defer releaseOperation()
	stopRevocation := closeWebSocketOnContext(ctx, conn)
	defer stopRevocation()
	ctx, cancelExecution := context.WithCancel(ctx)
	defer cancelExecution()
	var shuttingDown atomic.Bool
	defer func() {
		if shuttingDown.Load() {
			_ = write(map[string]any{"type": "notebook.stopped"})
		}
	}()
	ctx, cleanup := containercleanup.WithReleaseGate(ctx)
	defer cleanup.Finalize()

	// Read while admission and execution are in progress so disconnects cancel
	// queued requests immediately. Pipelining is intentionally unsupported.
	conn.SetReadLimit(6*notebookCodeBytes + 1024)
	_ = conn.SetReadDeadline(time.Time{})
	incoming := make(chan notebookRequest, 1)
	go func() {
		defer cancelExecution()
		for {
			var request notebookRequest
			if conn.ReadJSON(&request) != nil {
				return
			}
			if request.Type == "notebook.shutdown" {
				shuttingDown.Store(true)
				cancelExecution()
				return
			}
			if request.Type != "notebook.execute" || request.ID < 1 ||
				len(request.Code) > notebookCodeBytes || !utf8.ValidString(request.Code) {
				return
			}
			select {
			case incoming <- request:
			default:
				return
			}
		}
	}()
	// Authentication alone does not allocate a kernel. Only a cell can trigger it.
	firstTimer := time.NewTimer(10 * time.Second)
	defer firstTimer.Stop()
	var request notebookRequest
	select {
	case request = <-incoming:
	case <-ctx.Done():
		return
	case <-firstTimer.C:
		return
	}
	// Leave a container slot available to ordinary workloads on multi-slot
	// hosts. The existing fair queue still handles actual node admission.
	if h.notebookContainers.Add(1) > int32(max(1, h.Config.DockerMaxContainers-1)) {
		h.notebookContainers.Add(-1)
		fail(resourcePressureErrorCode)
		return
	}
	cleanup.Add(func() { h.notebookContainers.Add(-1) })
	lease, err := acquireHandlerRuntimeResource(ctx, h.Resources, resourcecontrol.WorkloadNotebook,
		user.ID, projectResourceScope(key, team, project), "notebook:"+auth.GenerateToken(),
		runtime.RuntimeID, "python", runtime.DockerImage, true)
	if err != nil {
		fail(resourcePressureErrorCode)
		return
	}
	cleanup.Add(func() { releaseHandlerResource(lease) })
	if h.Lifecycle != nil {
		activity, err := h.Lifecycle.AcquireActivity(user.ID, key)
		if err != nil {
			fail("workspace_in_use")
			return
		}
		cleanup.Add(activity.Release)
	}
	if team != "" {
		activity, err := h.Collaboration.AcquireProjectActivity(user.ID, team, project)
		if err != nil {
			fail("workspace_denied")
			return
		}
		cleanup.Add(activity.Release)
	}
	setupCtx, endSetup := context.WithTimeout(ctx, 100*time.Second)
	defer endSetup()
	workspace, err := h.resolveTerminalWorkspace(setupCtx, user.ID, start.Workspace)
	if err != nil {
		fail("workspace_missing")
		return
	}
	env := map[string]string{"MPLCONFIGDIR": "/tmp/notebook-matplotlib", "MPLBACKEND": "Agg",
		"PYTHONPATH": "/workspace", "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"}
	mounts := map[string]string{}
	if team == "" && h.PersonalCache != nil {
		deps, err := h.PersonalCache.PrepareReadOnly(setupCtx, personalcache.Request{
			UserID: user.ID, WorkspaceID: lsp.StableWorkspaceIdentity(user.ID, "", "", "", key),
			WorkspaceName: start.Workspace.FolderName, RuntimeID: runtime.RuntimeID,
			RuntimeFingerprint: resolvedRuntimeFingerprint(setupCtx, h.RuntimeMetadata, runtime.RuntimeID, runtime.DockerImage, runtime.Version),
			Language:           "python", WorkspaceRoot: workspace.root, SetupCommands: start.SetupCommands,
			QuotaBytes: userQuotaBytes(h.UserStore, user.ID),
		})
		if err != nil {
			fail("dependencies_unavailable")
			return
		}
		if deps != nil {
			cleanup.Add(deps.Release)
			if deps.Hit {
				mounts = deps.DockerMounts
				env["PYTHONPATH"] = "/project-deps/python:/workspace"
			}
		}
		if deps == nil || !deps.Hit {
			fingerprint, err := personalcache.DependencyFingerprint(workspace.root, "python", start.SetupCommands)
			if err != nil || fingerprint.Source != "empty" {
				fail("dependencies_unavailable")
				return
			}
		}
	}
	if team != "" {
		if h.BuildCache == nil {
			fail("dependencies_unavailable")
			return
		}
		branch := strings.TrimSpace(start.Workspace.Branch)
		if branch == "" {
			teamProject, err := h.Collaboration.Store().GetProject(project)
			if err != nil || teamProject == nil || teamProject.TeamID != team {
				fail("workspace_denied")
				return
			}
			branch = teamProject.DefaultBranch
		}
		shared, err := h.BuildCache.SharedDependencies(buildcache.BuildContext{
			TeamID: team, ProjectID: project, Branch: branch,
			Runtime: "docker-" + runtime.RuntimeID, Language: "python",
		})
		if err != nil {
			fail("dependencies_unavailable")
			return
		}
		cleanup.Add(shared.Release)
		if pip, err := safefile.ResolveDirectoryBeneath(shared.SharedHost, "pip"); err == nil {
			mounts[pip] = "/team-pip-cache:ro"
		}
		env["PIP_TARGET"] = "/tmp/notebook-deps"
		env["PIP_CACHE_DIR"] = "/tmp/notebook-pip-cache"
		env["PIP_NO_INPUT"] = "1"
		env["PYTHONPATH"] = "/tmp/notebook-deps:/workspace"
	}
	container, err := h.DockerPool.AcquireForUserRuntimeWithContext(docker.WithIsolatedKernel(setupCtx), user.ID, runtime.RuntimeID,
		runtime.DockerImage, "notebook-ephemeral/"+auth.GenerateToken(), mounts, env, nil)
	if err != nil {
		fail("container_unavailable")
		return
	}
	defer func() {
		if err := h.DockerPool.DiscardForUserAndWait(container, user.ID); err != nil {
			slog.Warn("Notebook container cleanup pending", "container", container, "error", err)
			containercleanup.Retain(ctx, func(done func()) { h.DockerPool.DiscardForUserRetained(container, user.ID, done) })
		}
	}()
	tempDir, err := copyTerminalWorkspaceWithReset(setupCtx, workspace.root, container, terminalProtocolLimits(h.Config),
		func(ctx context.Context, id string) error {
			return resetTerminalWorkspaceWithPool(ctx, id, h.DockerPool)
		})
	if err != nil {
		fail("workspace_copy_failed")
		return
	}
	_ = os.RemoveAll(tempDir)
	if team != "" && !h.prepareNotebookTeamDependencies(setupCtx, container, workspace.root, start.SetupCommands) {
		fail("dependencies_unavailable")
		return
	}
	workDir := "/workspace"
	if start.DocumentDir != "" && start.DocumentDir != "." {
		workDir += "/" + start.DocumentDir
	}
	process, err := startNotebookProcess(ctx, "docker", "exec", "-i", "-w", workDir, container, "python3", "-u", "-c", notebookKernelPython)
	if err != nil {
		fail("kernel_failed")
		return
	}
	defer process.close()
	ready, err := process.receive(setupCtx)
	endSetup()
	if err != nil || !ready.Ready {
		fail("kernel_failed")
		return
	}

	timeout := h.Config.RunTimeoutDuration()
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	for count := 1; ; count++ {
		cellCtx, cancel := context.WithTimeout(ctx, timeout)
		result, err := process.execute(cellCtx, request.Code)
		cancel()
		if err != nil || result.Count != count || len(result.Outputs) > 8 {
			if errors.Is(err, context.DeadlineExceeded) {
				fail("cell_timeout")
			} else {
				fail("kernel_failed")
			}
			return
		}
		if write(map[string]any{"type": "notebook.result", "id": request.ID, "result": result}) != nil {
			return
		}
		idle := time.NewTimer(notebookIdle)
		select {
		case request = <-incoming:
			idle.Stop()
		case <-idle.C:
			return
		case <-process.done:
			idle.Stop()
			return
		case <-ctx.Done():
			idle.Stop()
			return
		}
	}
}

func (h *WSHandler) prepareNotebookTeamDependencies(ctx context.Context, container, root string, setup []string) bool {
	// Team setup is project-scoped, like ordinary team runs, while pip installs
	// go to a private target inherited from the kernel container environment.
	if len(setup) == 0 {
		info, err := os.Lstat(filepath.Join(root, "requirements.txt"))
		if errors.Is(err, os.ErrNotExist) {
			return true
		}
		if err != nil || !info.Mode().IsRegular() {
			return false
		}
		seedNotebookPip(ctx, container)
		return exec.CommandContext(ctx, "docker", "exec", "-w", "/workspace", container, "python3", "-m", "pip", "install",
			"--disable-pip-version-check", "-r", "requirements.txt").Run() == nil
	}
	seedNotebookPip(ctx, container)
	for _, command := range setup {
		command = strings.TrimSpace(command)
		if command == "" {
			continue
		}
		if h.Security == nil || !h.Security.AllowCommand(command) {
			return false
		}
		if exec.CommandContext(ctx, "docker", "exec", "-w", "/workspace", container, "sh", "-c",
			h.Security.FilterCommand(command)).Run() != nil {
			return false
		}
	}
	return true
}

func seedNotebookPip(ctx context.Context, container string) {
	seedCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	// Optional acceleration. Pip disables a read-only cache for the sandbox UID.
	_ = exec.CommandContext(seedCtx, "docker", "exec", "-w", "/", container, "python3", "-I", "-c", notebookSeedPipPython).Run()
}
