package runner

import (
	"fmt"

	"bobocloud-server/internal/compiler"
)

// ============================================================
// plugin_cpp.go — C++ 语言插件（G++，多文件链接）
//
// 规则同 C 插件：入口目录子树内全部 .cpp/.cc/.cxx 一起编译链接。
// ============================================================

// CppPlugin C++ 语言插件
type CppPlugin struct{}

func (CppPlugin) Language() string     { return "cpp" }
func (CppPlugin) Extensions() []string { return []string{".cpp", ".cc", ".cxx"} }

func (CppPlugin) Plan(req *PlanRequest) (*Plan, error) {
	entryDir := DirOf(req.EntryRelPath)
	sources := CollectSources(FilterUnderDir(req.ProjectFiles, entryDir), []string{".cpp", ".cc", ".cxx"})
	sources = SelectCFamilyProgram(req.HostWorkDir, req.EntryRelPath, sources)
	if len(sources) == 0 {
		return nil, ErrNoSources("cpp")
	}

	target := req.BuildTarget
	if target.ID == "" {
		target = nativeBuildTarget()
	}
	output := target.OutputPath
	compilerName := target.CppCompiler
	if compilerName == "" {
		compilerName = "g++"
	}

	compileCmd := []string{compilerName, "-std=gnu++11"}
	compileCmd = append(compileCmd, sources...)
	compileCmd = append(compileCmd, "-o", output, "-Wall")
	compileCmd = append(compileCmd, compiler.CollectCompileFlags(req.HostWorkDir, compilerName)...)
	compileCmd = append(compileCmd, target.DefaultCompileArgs...)
	compileCmd = append(compileCmd, req.CompileArgs...)

	note := fmt.Sprintf("C++: compiling %d source file(s) under %s", len(sources), displayDir(entryDir))
	if !target.Runnable {
		note += fmt.Sprintf(" for %s/%s (artifact: %s)", target.OS, target.Architecture, output)
	}
	steps := []Step{
		{Stage: "setup", Cmd: []string{"mkdir", "-p", ".bobocloud", "artifacts"}, TimeoutSec: 10},
		{Stage: "compile:cpp", Cmd: compileCmd, TimeoutSec: req.Timeouts.CompileSec},
	}
	if target.Runnable {
		steps = append(steps, Step{Stage: "run:cpp", Cmd: append([]string{output}, req.RunArgs...), TimeoutSec: req.Timeouts.RunSec})
	}
	return &Plan{
		Steps: steps,
		Note:  note,
	}, nil
}
