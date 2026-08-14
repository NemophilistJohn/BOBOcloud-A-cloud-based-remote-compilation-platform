package runner

import (
	"fmt"
	"strings"
)

// ============================================================
// plugin_go.go — Go 语言插件（模块感知）
//
// 两种模式：
//   - 模块模式：从入口目录向上找到 go.mod → `go run .`（在入口目录执行，
//     同包多文件、本地子包导入都可用）；
//   - 单包模式：无 go.mod → `go run file1.go file2.go ...`（入口同目录全部
//     非测试 .go 文件，无需 go.mod 也能跑多文件 package main）。
// 编译参数作为 go build flags 传递（如 -race），运行参数传给程序本身。
// ============================================================

// GoPlugin Go 语言插件
type GoPlugin struct{}

func (GoPlugin) Language() string     { return "go" }
func (GoPlugin) Extensions() []string { return []string{".go"} }

func (GoPlugin) Plan(req *PlanRequest) (*Plan, error) {
	entryDir := DirOf(req.EntryRelPath)

	// go run 编译+运行一步完成，超时取 编译+运行 之和
	stepTimeout := req.Timeouts.CompileSec + req.Timeouts.RunSec

	if modDir, ok := FindUpward(req.ProjectFiles, entryDir, "go.mod"); ok {
		runCmd := []string{"go", "run"}
		runCmd = append(runCmd, req.CompileArgs...)
		runCmd = append(runCmd, ".")
		runCmd = append(runCmd, req.RunArgs...)
		note := fmt.Sprintf("Go module mode (go.mod at %s): go run . in %s",
			displayDir(modDir), displayDir(entryDir))
		return &Plan{
			Steps: []Step{
				{Stage: "run:go", Cmd: runCmd, WorkDir: entryDir, TimeoutSec: stepTimeout},
			},
			Note: note,
		}, nil
	}

	// 无 go.mod：入口同目录（不含子目录）全部非测试 .go
	var files []string
	for _, f := range CollectSources(req.ProjectFiles, []string{".go"}) {
		if DirOf(f) != entryDir {
			continue
		}
		if strings.HasSuffix(BaseOf(f), "_test.go") {
			continue
		}
		files = append(files, BaseOf(f))
	}
	if len(files) == 0 {
		return nil, ErrNoSources("go")
	}

	runCmd := []string{"go", "run"}
	runCmd = append(runCmd, req.CompileArgs...)
	runCmd = append(runCmd, files...)
	runCmd = append(runCmd, req.RunArgs...)

	note := fmt.Sprintf("Go single-package mode (no go.mod): %d file(s) in %s",
		len(files), displayDir(entryDir))
	return &Plan{
		Steps: []Step{
			{Stage: "run:go", Cmd: runCmd, WorkDir: entryDir, TimeoutSec: stepTimeout},
		},
		Note: note,
	}, nil
}
