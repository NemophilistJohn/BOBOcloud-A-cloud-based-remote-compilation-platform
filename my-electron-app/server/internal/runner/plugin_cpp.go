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

	const output = ".bobocloud/output"

	compileCmd := []string{"g++", "-std=gnu++11"}
	compileCmd = append(compileCmd, sources...)
	compileCmd = append(compileCmd, "-o", output, "-Wall")
	compileCmd = append(compileCmd, compiler.CollectCompileFlags(req.HostWorkDir, "g++")...)
	compileCmd = append(compileCmd, req.CompileArgs...)

	runCmd := append([]string{output}, req.RunArgs...)

	note := fmt.Sprintf("C++: compiling %d source file(s) under %s", len(sources), displayDir(entryDir))
	return &Plan{
		Steps: []Step{
			{Stage: "setup", Cmd: []string{"mkdir", "-p", ".bobocloud"}, TimeoutSec: 10},
			{Stage: "compile:cpp", Cmd: compileCmd, TimeoutSec: req.Timeouts.CompileSec},
			{Stage: "run:cpp", Cmd: runCmd, TimeoutSec: req.Timeouts.RunSec},
		},
		Note: note,
	}, nil
}
