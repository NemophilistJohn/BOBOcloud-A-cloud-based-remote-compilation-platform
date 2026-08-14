package runner

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/session"
)

// ============================================================
// plugin.go — 插件化语言执行架构
//
//   LanguagePlugin  每种语言一个插件：把"这个项目怎么编译/运行"翻译成 Plan。
//   Plan / Step     与执行环境无关的执行计划（Docker 容器与宿主机共用同一份）。
//   StepExecutor    执行环境抽象：localStepExecutor（宿主机进程）与
//                   dockerStepExecutor（docker exec）两种实现。
//   ExecutePlan     统一调度：按序执行步骤，任一步失败即中止。
//
// 新增一种语言只需三步：
//   1. 新建 plugin_<lang>.go，实现 LanguagePlugin 接口（3 个方法）；
//   2. 在 RegisterAllPlugins 中注册一行；
//   3. 在 model/lang.go 的 SupportedRuntimes 中声明 Docker 镜像与扩展名。
// ============================================================

// TimeoutConfig 各类阶段的默认超时（秒），来自服务端配置
type TimeoutConfig struct {
	CompileSec     int // 编译超时（C/C++/Java/Go）
	RustCompileSec int // Rust 编译超时（较慢，单独配置）
	RunSec         int // 运行超时
}

// PlanRequest 一次运行请求的完整上下文（规划期）
type PlanRequest struct {
	EntryRelPath string   // 入口文件相对项目根的路径（slash 分隔），如 "src/main.c"
	ProjectFiles []string // 项目内全部文件的相对路径（slash 分隔）
	HostWorkDir  string   // 宿主机上的项目临时目录（仅规划期读文件用：解析 go.mod / package 等）
	ProjectRoot  string   // 执行侧项目根：Docker 为 "/workspace"，本地等于 HostWorkDir
	CompileArgs  []string // 用户编译参数（argv 元素，不经 shell 解析）
	RunArgs      []string // 用户程序参数（传给被运行程序）
	Timeouts     TimeoutConfig
}

// Step 一条执行步骤。Cmd 是 argv 数组（不经过 shell，无注入面）。
type Step struct {
	Stage      string            // 阶段标识："compile:c" / "run:c" 等（输出面板着色用）
	Cmd        []string          // argv
	WorkDir    string            // 相对项目根的子目录（slash，"" = 项目根）
	Env        map[string]string // 额外环境变量；值支持 {{projectRoot}} 占位符
	TimeoutSec int               // 步骤超时；0 = 由执行器给默认值
	Stdin      io.Reader         // 可选：该步骤的 stdin 数据源（由 ExecutePlan 设为最后一步）
}

// Plan 执行计划：一组按序执行的步骤
type Plan struct {
	Steps []Step
	Note  string // 计划说明（非空则以 status 消息展示给用户，如 "检测到 Cargo 项目"）
}

// LanguagePlugin 语言插件接口
type LanguagePlugin interface {
	Language() string     // 语言标识："c" / "cpp" / "java" / "go" / "rust" / "python" / "node"
	Extensions() []string // 可作为入口文件的扩展名（小写、带点），如 [".c"]
	Plan(req *PlanRequest) (*Plan, error)
}

// ---------- 插件注册表 ----------

// PluginRegistry 管理所有已注册的语言插件
type PluginRegistry struct {
	plugins []LanguagePlugin
	byLang  map[string]LanguagePlugin
}

// NewPluginRegistry 创建插件注册表
func NewPluginRegistry() *PluginRegistry {
	return &PluginRegistry{byLang: make(map[string]LanguagePlugin)}
}

// Register 注册一个语言插件
func (r *PluginRegistry) Register(p LanguagePlugin) {
	r.plugins = append(r.plugins, p)
	r.byLang[p.Language()] = p
}

// ForLanguage 按语言标识查找插件
func (r *PluginRegistry) ForLanguage(lang string) LanguagePlugin {
	return r.byLang[lang]
}

// ForExtension 按入口文件扩展名查找插件（大小写不敏感）
func (r *PluginRegistry) ForExtension(ext string) LanguagePlugin {
	ext = strings.ToLower(ext)
	for _, p := range r.plugins {
		for _, e := range p.Extensions() {
			if e == ext {
				return p
			}
		}
	}
	return nil
}

// RegisterAllPlugins 注册全部内置语言插件
func RegisterAllPlugins(r *PluginRegistry) {
	r.Register(CPlugin{})
	r.Register(CppPlugin{})
	r.Register(JavaPlugin{})
	r.Register(GoPlugin{})
	r.Register(RustPlugin{})
	r.Register(PythonPlugin{})
	r.Register(NodePlugin{})
}

// ---------- 计划执行 ----------

// StepExecutor 执行环境抽象：在项目根下执行单个步骤
type StepExecutor interface {
	ExecStep(ctx context.Context, step Step, output session.OutputWriter) *model.RunResult
}

// substituteEnv 展开环境变量值中的 {{projectRoot}} 占位符
func substituteEnv(env map[string]string, projectRootAbs string) map[string]string {
	if len(env) == 0 {
		return nil
	}
	out := make(map[string]string, len(env))
	for k, v := range env {
		out[k] = strings.ReplaceAll(v, "{{projectRoot}}", projectRootAbs)
	}
	return out
}

// joinWorkDir 把相对子目录拼到执行侧项目根下（统一为 slash 路径）
func joinWorkDir(projectRoot, rel string) string {
	rel = strings.Trim(rel, "/")
	if rel == "" {
		return projectRoot
	}
	return strings.TrimSuffix(projectRoot, "/") + "/" + rel
}

const defaultStepTimeoutSec = 30

// ExecutePlan 按序执行计划中的步骤；任一步骤失败（或上下文取消）即中止并返回该结果。
// stdinReader 非空时，仅传入最后一步（run 步骤），编译步骤不受影响。
func ExecutePlan(ctx context.Context, plan *Plan, executor StepExecutor, output session.OutputWriter, stdinReader io.Reader) *model.RunResult {
	if plan.Note != "" {
		output.WriteStatus("plan", plan.Note)
	}
	var result *model.RunResult
	for i, step := range plan.Steps {
		if ctx.Err() != nil {
			output.WriteStderr("[plan] Run cancelled", "plan")
			return &model.RunResult{Success: false, ReturnCode: 130}
		}
		if len(step.Cmd) == 0 {
			continue
		}
		// 仅最后一步接入 stdin（run 步骤），编译步骤不需要交互输入
		if i == len(plan.Steps)-1 && stdinReader != nil {
			step.Stdin = stdinReader
		}
		result = executor.ExecStep(ctx, step, output)
		if result == nil {
			return &model.RunResult{Success: false, ReturnCode: 1, Stderr: "internal: nil step result"}
		}
		if !result.Success {
			return result
		}
		// 中间步骤成功但没有更多步骤时，以最后一步结果为准
		if i == len(plan.Steps)-1 {
			return result
		}
	}
	if result == nil {
		return &model.RunResult{Success: true, ReturnCode: 0}
	}
	return result
}

// ---------- 宿主机执行器（Local 模式） ----------

type localStepExecutor struct {
	projectRoot string // 宿主机项目临时目录（绝对路径）
}

// NewLocalStepExecutor 创建宿主机步骤执行器
func NewLocalStepExecutor(projectRoot string) StepExecutor {
	return &localStepExecutor{projectRoot: projectRoot}
}

func (e *localStepExecutor) ExecStep(ctx context.Context, step Step, output session.OutputWriter) *model.RunResult {
	timeout := step.TimeoutSec
	if timeout <= 0 {
		timeout = defaultStepTimeoutSec
	}
	stepCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()
	workDir := joinWorkDir(e.projectRoot, step.WorkDir)
	env := substituteEnv(step.Env, e.projectRoot)
	return StreamProcess(stepCtx, step.Cmd, workDir, output, step.Stage, env, step.Stdin)
}

// ---------- Docker 执行器 ----------

// DockerStepPool 是 dockerStepExecutor 需要的容器池能力（由 *docker.Pool 实现）
type DockerStepPool interface {
	ExecStreamingEnv(ctx context.Context, containerID string, cmd []string, workDir string, output session.OutputWriter, stage string, env map[string]string, stdin io.Reader) *model.RunResult
}

type dockerStepExecutor struct {
	pool        DockerStepPool
	containerID string
	projectRoot string // 容器内项目根，固定 "/workspace"
}

// NewDockerStepExecutor 创建容器步骤执行器
func NewDockerStepExecutor(pool DockerStepPool, containerID, projectRoot string) StepExecutor {
	return &dockerStepExecutor{pool: pool, containerID: containerID, projectRoot: projectRoot}
}

func (e *dockerStepExecutor) ExecStep(ctx context.Context, step Step, output session.OutputWriter) *model.RunResult {
	timeout := step.TimeoutSec
	if timeout <= 0 {
		timeout = defaultStepTimeoutSec
	}
	stepCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()
	workDir := joinWorkDir(e.projectRoot, step.WorkDir)
	env := substituteEnv(step.Env, e.projectRoot)
	return e.pool.ExecStreamingEnv(stepCtx, e.containerID, step.Cmd, workDir, output, step.Stage, env, step.Stdin)
}

// ---------- 规划期辅助错误 ----------

// ErrNoSources 在找不到任何源文件时返回
func ErrNoSources(language string) error {
	return fmt.Errorf("no %s source files found in project", language)
}
