package runner

import (
	"fmt"
	"path/filepath"
	"strings"

	"bobocloud-server/internal/model"
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
	target := req.BuildTarget
	if target.ID == "" {
		var ok bool
		target, ok = model.ResolveBuildTarget("go", "linux-x86_64")
		if !ok {
			return nil, fmt.Errorf("native Go build target is unavailable")
		}
	}
	if !target.Runnable {
		return (GoPlugin{}).crossPlan(req, target)
	}

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

// crossPlan builds a pure-Go executable for another hosted operating system.
// The official Go toolchain has first-class GOOS/GOARCH support, so it needs
// no C cross compiler as long as CGO stays disabled.
func (GoPlugin) crossPlan(req *PlanRequest, target model.BuildTarget) (*Plan, error) {
	if target.GoOS == "" || target.GoARCH == "" {
		return nil, fmt.Errorf("Go target %q has no GOOS/GOARCH mapping", target.ID)
	}
	entryDir := DirOf(req.EntryRelPath)
	output := filepath.ToSlash(filepath.Join(req.ProjectRoot, filepath.FromSlash(target.OutputPath)))
	env := map[string]string{"GOOS": target.GoOS, "GOARCH": target.GoARCH, "CGO_ENABLED": "0"}
	buildCmd := []string{"go", "build"}
	buildCmd = append(buildCmd, req.CompileArgs...)
	buildCmd = append(buildCmd, "-o", output)

	if _, ok := FindUpward(req.ProjectFiles, entryDir, "go.mod"); ok {
		buildCmd = append(buildCmd, ".")
	} else {
		var files []string
		for _, file := range CollectSources(req.ProjectFiles, []string{".go"}) {
			if DirOf(file) == entryDir && !strings.HasSuffix(BaseOf(file), "_test.go") {
				files = append(files, BaseOf(file))
			}
		}
		if len(files) == 0 {
			return nil, ErrNoSources("go")
		}
		buildCmd = append(buildCmd, files...)
	}

	note := fmt.Sprintf("Go: cross-compiling for %s/%s (artifact: %s)", target.OS, target.Architecture, target.OutputPath)
	return &Plan{
		Steps: []Step{
			{Stage: "setup", Cmd: []string{"mkdir", "-p", ".bobocloud", "artifacts"}, TimeoutSec: 10},
			{Stage: "compile:go", Cmd: buildCmd, WorkDir: entryDir, Env: env, TimeoutSec: req.Timeouts.CompileSec},
		},
		Note: note,
	}, nil
}
