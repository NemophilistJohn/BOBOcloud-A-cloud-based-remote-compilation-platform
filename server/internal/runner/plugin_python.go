package runner

// ============================================================
// plugin_python.go — Python 语言插件
//
// 解释型语言无编译步骤；PYTHONPATH 指向项目根，保证入口在子目录时
// 项目内 import 仍然可用（修复子目录入口只能 import 同目录文件的问题）。
// 编译参数对 Python 无意义（忽略），运行参数原样传给脚本。
// ============================================================

// The Docker-only bootstrap chooses the runtime-scoped package tree after setup
// commands have run. Read-only project generations expose only PYTHONPATH, so
// preserve that container-provided value and explicitly recognize their mount.
// The entry path and run arguments remain argv items rather than being
// interpolated into shell source.
const pythonRuntimeBootstrap = `project_root=$PWD; inherited_pythonpath=${PYTHONPATH:-}; package_root=; preserve_pythonpath=; if [ -n "${PIP_TARGET:-}" ] && [ -d "$PIP_TARGET" ]; then package_root=$PIP_TARGET; elif [ -d /project-deps/python ]; then package_root=/project-deps/python; preserve_pythonpath=$inherited_pythonpath; elif [ -d /persist/pip-packages ]; then package_root=/persist/pip-packages; else preserve_pythonpath=$inherited_pythonpath; fi; if [ -n "$package_root" ] && [ -n "$preserve_pythonpath" ] && [ "$preserve_pythonpath" != "$package_root" ]; then export PYTHONPATH="$package_root:$preserve_pythonpath:$project_root"; elif [ -n "$package_root" ]; then export PYTHONPATH="$package_root:$project_root"; elif [ -n "$preserve_pythonpath" ]; then export PYTHONPATH="$preserve_pythonpath:$project_root"; else export PYTHONPATH="$project_root"; fi; exec python3 "$@"`

// PythonPlugin Python 语言插件
type PythonPlugin struct{}

func (PythonPlugin) Language() string     { return "python" }
func (PythonPlugin) Extensions() []string { return []string{".py"} }

func (PythonPlugin) Plan(req *PlanRequest) (*Plan, error) {
	runCmd := []string{"python3", req.EntryRelPath}
	runCmd = append(runCmd, req.RunArgs...)

	return &Plan{
		Steps: []Step{
			{
				Stage:      "run:python",
				Cmd:        runCmd,
				Env:        map[string]string{"PYTHONPATH": "{{projectRoot}}", "PYTHONUNBUFFERED": "1"},
				TimeoutSec: req.Timeouts.RunSec,
			},
		},
	}, nil
}

// withDockerPythonRuntimeBootstrap converts only Python run steps for Docker.
// Local execution retains the direct python3 command and its project-root
// environment, so it does not gain a shell dependency.
func withDockerPythonRuntimeBootstrap(plan *Plan) *Plan {
	if plan == nil {
		return nil
	}
	copyPlan := *plan
	copyPlan.Steps = append([]Step(nil), plan.Steps...)
	for index := range copyPlan.Steps {
		step := copyPlan.Steps[index]
		if step.Stage != "run:python" || len(step.Cmd) == 0 || step.Cmd[0] != "python3" {
			continue
		}
		step.Cmd = append([]string{"sh", "-c", pythonRuntimeBootstrap, "python-runtime"}, step.Cmd[1:]...)
		if len(step.Env) > 0 {
			step.Env = make(map[string]string, len(step.Env)-1)
			for key, value := range copyPlan.Steps[index].Env {
				if key != "PYTHONPATH" {
					step.Env[key] = value
				}
			}
		}
		copyPlan.Steps[index] = step
	}
	return &copyPlan
}
