package runner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"time"

	"bobocloud-server/internal/metrics"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/security"
	"bobocloud-server/internal/session"
)

// ============================================================
// docker.go — DockerRunner：在 Docker 容器内执行语言插件生成的 Plan
//
// 职责边界：
//   - DockerRunner 只管容器生命周期（获取/拷贝/前置命令/释放）；
//   - "编译什么、运行什么"完全由 LanguagePlugin 生成的 Plan 决定，
//     通过 dockerStepExecutor 逐步执行（与本地模式共用 ExecutePlan）。
// ============================================================

// DockerRunner 在 Docker 容器内执行代码
type DockerRunner struct {
	runtime         model.RuntimeDef
	pool            DockerPoolClient
	sec             security.Policy
	setupCmds       []string
	userID          string // Phase 2: 所属用户（用于配额检查）
	cacheKey        string
	cacheMounts     map[string]string
	cacheEnv        map[string]string
	discardCached   bool
	setupPassed     bool
	workspaceCopier containerWorkspaceCopier
	metrics         *metrics.Registry
}

type containerWorkspaceCopier interface {
	CopyTo(ctx context.Context, containerID, hostDir, containerDir string) error
	CopyFrom(ctx context.Context, containerID, hostDir, containerDir string) error
}

type dockerCLIWorkspaceCopier struct{}

func (dockerCLIWorkspaceCopier) CopyTo(ctx context.Context, containerID, hostDir, containerDir string) error {
	cpCmd := exec.CommandContext(ctx, "docker", "cp", hostDir+"/.", containerID+":"+containerDir)
	if out, err := cpCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %w", string(out), err)
	}
	return nil
}

func (dockerCLIWorkspaceCopier) CopyFrom(ctx context.Context, containerID, hostDir, containerDir string) error {
	cpCmd := exec.CommandContext(ctx, "docker", "cp", containerID+":"+containerDir+"/.", hostDir)
	if out, err := cpCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %w", string(out), err)
	}
	return nil
}

// DockerPoolClient 是 DockerRunner 需要的容器池接口
type DockerPoolClient interface {
	Acquire(ctx context.Context, image string, output session.OutputWriter) (string, error)
	AcquireForUser(ctx context.Context, userID, image string, output session.OutputWriter) (string, error)
	AcquireForUserWithContext(ctx context.Context, userID, image, cacheKey string, volumes, env map[string]string, output session.OutputWriter) (string, error)
	Release(containerID string)
	ReleaseForUser(containerID, userID string)
	DiscardForUser(containerID, userID string)
	Exec(ctx context.Context, containerID string, cmd []string, workDir string) (stdout, stderr string, exitCode int, err error)
	ExecStreamingEnv(ctx context.Context, containerID string, cmd []string, workDir string, output session.OutputWriter, stage string, env map[string]string, stdin io.Reader) *model.RunResult
}

// SetUserID 设置用户 ID（Phase 2: 用于配额追踪）
func (r *DockerRunner) SetUserID(userID string) {
	r.userID = userID
}

func (r *DockerRunner) SetBuildCacheContext(key string, mounts, env map[string]string) {
	r.cacheKey = key
	r.cacheMounts = mounts
	r.cacheEnv = env
	r.discardCached = false
}

// SetPersonalCacheContext keeps read-only published generations reusable, but
// destroys containers attached to a writable staging generation before that
// generation is atomically published.
func (r *DockerRunner) SetPersonalCacheContext(key string, mounts, env map[string]string, writable bool) {
	r.cacheKey = key
	r.cacheMounts = mounts
	r.cacheEnv = env
	r.discardCached = writable
}

func (r *DockerRunner) SetMetrics(registry *metrics.Registry) { r.metrics = registry }

// NewDockerRunner 创建 Docker 运行器
func NewDockerRunner(runtime model.RuntimeDef, pool DockerPoolClient, sec security.Policy) *DockerRunner {
	return &DockerRunner{
		runtime:         runtime,
		pool:            pool,
		sec:             sec,
		workspaceCopier: dockerCLIWorkspaceCopier{},
	}
}

func (r *DockerRunner) Language() string { return r.runtime.Language }

func (r *DockerRunner) SetSetupCommands(cmds []string) {
	r.setupCmds = cmds
}

// SetupPassed distinguishes a successful dependency setup followed by a user
// program failure from a setup command that only left a partial package tree.
func (r *DockerRunner) SetupPassed() bool { return r.setupPassed }

// containerWorkDir 容器内项目根（与 PlanRequest.ProjectRoot 对应）
const containerWorkDir = "/workspace"

// RunPlan 在 Docker 容器内执行 Plan：获取容器 → 拷入项目 → 前置命令 → 逐步执行
func (r *DockerRunner) RunPlan(ctx context.Context, plan *Plan, hostWorkDir string, output session.OutputWriter, stdinReader io.Reader) *model.RunResult {
	r.setupPassed = false
	image := r.runtime.DockerImage
	acquireStarted := time.Now()
	output.WriteStatus("docker", "Acquiring execution container")

	// Phase 2: 使用用户感知的 Acquire，支持配额和排队
	var containerID string
	var err error
	if r.cacheKey != "" {
		containerID, err = r.pool.AcquireForUserWithContext(ctx, r.userID, image, r.cacheKey, r.cacheMounts, r.cacheEnv, output)
	} else {
		containerID, err = r.pool.AcquireForUser(ctx, r.userID, image, output)
	}
	if err != nil {
		output.WriteError(fmt.Sprintf("Failed to acquire container: %v", err))
		return &model.RunResult{Success: false, ReturnCode: 1}
	}
	output.WriteStatus("docker", fmt.Sprintf("Container acquired in %d ms", time.Since(acquireStarted).Milliseconds()))
	defer func() {
		cleanupStarted := time.Now()
		copyBackStarted := time.Now()
		if copyErr := r.copyFromContainer(ctx, containerID, hostWorkDir, containerWorkDir); copyErr != nil {
			output.WriteStderr(fmt.Sprintf("Warning: failed to copy artifacts from container: %v", copyErr), "setup")
		}
		if r.metrics != nil {
			r.metrics.Observe("workspace.copy.from_container", time.Since(copyBackStarted))
		}
		if r.discardCached || errors.Is(context.Cause(ctx), personalcache.ErrQuotaExceeded) {
			r.pool.DiscardForUser(containerID, r.userID)
		} else {
			r.pool.ReleaseForUser(containerID, r.userID)
		}
		output.WriteStatus("docker", fmt.Sprintf("Artifacts collected and container recycled in %d ms", time.Since(cleanupStarted).Milliseconds()))
	}()

	copyStarted := time.Now()
	copyErr := r.copyToContainer(ctx, containerID, hostWorkDir, containerWorkDir)
	if r.metrics != nil {
		r.metrics.Observe("workspace.copy.to_container", time.Since(copyStarted))
	}
	if copyErr != nil {
		output.WriteError(fmt.Sprintf("Failed to copy files to container: %v", copyErr))
		return &model.RunResult{Success: false, ReturnCode: 1}
	}
	if nodeModules := r.cacheEnv["BOBOCLOUD_NODE_MODULES"]; nodeModules != "" {
		if _, stderr, code, linkErr := r.pool.Exec(ctx, containerID, []string{"ln", "-sfn", nodeModules, containerWorkDir + "/node_modules"}, "/"); linkErr != nil || code != 0 {
			output.WriteError(fmt.Sprintf("Failed to attach project dependency directory: %s %v", stderr, linkErr))
			return &model.RunResult{Success: false, ReturnCode: 1}
		}
	}
	output.WriteStatus("docker", fmt.Sprintf("Workspace copied in %d ms", time.Since(copyStarted).Milliseconds()))

	dependencyStarted := time.Now()
	setupResult := func() *model.RunResult {
		for _, cmd := range r.setupCmds {
			if !r.sec.AllowCommand(cmd) {
				output.WriteStderr(fmt.Sprintf("Command blocked by security policy: %s", cmd), "setup")
				continue
			}
			filteredCmd := r.sec.FilterCommand(cmd)
			filteredCmd = autoPersistPip(filteredCmd)
			output.WriteStatus("setup", fmt.Sprintf("$ %s", filteredCmd))
			setupCtx, setupCancel := context.WithTimeout(ctx, time.Duration(300)*time.Second)
			stdout, stderr, exitCode, execErr := r.pool.Exec(setupCtx, containerID,
				[]string{"sh", "-c", filteredCmd}, containerWorkDir)
			setupCancel()
			if execErr != nil {
				output.WriteError(fmt.Sprintf("Setup command failed: %v", execErr))
				return &model.RunResult{Success: false, ReturnCode: 1}
			}
			if stdout != "" {
				output.WriteStdout(stdout, "setup")
			}
			if stderr != "" {
				output.WriteStderr(stderr, "setup")
			}
			if exitCode != 0 {
				output.WriteError(fmt.Sprintf("Setup command exited with code %d", exitCode))
				return &model.RunResult{Success: false, ReturnCode: exitCode}
			}
		}
		return nil
	}()
	if r.metrics != nil && len(r.setupCmds) > 0 {
		r.metrics.Observe("dependency.resolve", time.Since(dependencyStarted))
	}
	if setupResult != nil {
		return setupResult
	}
	r.setupPassed = true
	switch r.runtime.Language {
	case "python":
		plan = withDockerPythonRuntimeBootstrap(plan)
	case "rust":
		plan = withDockerRustRuntimeBootstrap(plan)
	}

	executor := NewDockerStepExecutor(r.pool, containerID, containerWorkDir)
	return ExecutePlanWithMetrics(ctx, plan, executor, output, stdinReader, r.metrics)
}

// ---------- 文件拷贝 ----------

func (r *DockerRunner) copyToContainer(ctx context.Context, containerID, hostDir, containerDir string) error {
	ctx2, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	if _, _, _, err := r.pool.Exec(ctx2, containerID, []string{"mkdir", "-p", containerDir}, "/"); err != nil {
		// 忽略 mkdir 错误（目录可能已存在）
	}

	return r.workspaceCopier.CopyTo(ctx2, containerID, hostDir, containerDir)
}

func (r *DockerRunner) copyFromContainer(ctx context.Context, containerID, hostDir, containerDir string) error {
	ctx2, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return r.workspaceCopier.CopyFrom(ctx2, containerID, hostDir, containerDir)
}

// AutoPersistPip preserves the user command. The Docker pool sets PIP_TARGET
// to a runtime-scoped persistent directory, which pip honors unless the user
// intentionally supplies a target of their own.
func AutoPersistPip(cmd string) string {
	return autoPersistPip(cmd)
}

// autoPersistPip must not append a fixed --target: command line targets take
// precedence over PIP_TARGET and would send new packages back to legacy flat
// storage.
func autoPersistPip(cmd string) string {
	return cmd
}
