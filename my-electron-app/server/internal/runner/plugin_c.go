package runner

import (
	"fmt"

	"bobocloud-server/internal/compiler"
)

// ============================================================
// plugin_c.go — C 语言插件（GCC，多文件链接）
//
// 多文件规则：编译入口文件所在目录（递归子目录）下的全部 .c 文件一起链接，
// 支持 main.c + utils.c 这类典型多文件项目；构建目录/依赖目录自动跳过。
// 编译产物写到项目内 .bobocloud/（产物同步会忽略该目录）。
// ============================================================

// CPlugin C 语言插件
type CPlugin struct{}

func (CPlugin) Language() string     { return "c" }
func (CPlugin) Extensions() []string { return []string{".c"} }

func (CPlugin) Plan(req *PlanRequest) (*Plan, error) {
	// 入口所在目录子树内的全部 .c（入口在项目根时 = 全项目）
	entryDir := DirOf(req.EntryRelPath)
	sources := CollectSources(FilterUnderDir(req.ProjectFiles, entryDir), []string{".c"})
	sources = SelectCFamilyProgram(req.HostWorkDir, req.EntryRelPath, sources)
	if len(sources) == 0 {
		return nil, ErrNoSources("c")
	}

	const output = ".bobocloud/output"

	compileCmd := []string{"gcc", "-std=gnu11"}
	compileCmd = append(compileCmd, sources...)
	compileCmd = append(compileCmd, "-o", output, "-Wall")
	// 自动检测规则（#include <pthread.h> → -pthread 等），全项目扫描
	compileCmd = append(compileCmd, compiler.CollectCompileFlags(req.HostWorkDir, "gcc")...)
	// 用户编译参数（如 -O2 -std=c17 -lm）
	compileCmd = append(compileCmd, req.CompileArgs...)

	runCmd := append([]string{output}, req.RunArgs...)

	note := fmt.Sprintf("C: compiling %d source file(s) under %s", len(sources), displayDir(entryDir))
	return &Plan{
		Steps: []Step{
			{Stage: "setup", Cmd: []string{"mkdir", "-p", ".bobocloud"}, TimeoutSec: 10},
			{Stage: "compile:c", Cmd: compileCmd, TimeoutSec: req.Timeouts.CompileSec},
			{Stage: "run:c", Cmd: runCmd, TimeoutSec: req.Timeouts.RunSec},
		},
		Note: note,
	}, nil
}

// displayDir 把内部目录表示转成用户可读形式
func displayDir(dir string) string {
	if dir == "" {
		return "project root"
	}
	return "'" + dir + "/'"
}
