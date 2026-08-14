package runner

import (
	"fmt"
	"strings"
)

// ============================================================
// plugin_java.go — Java 语言插件（全项目编译 + package 感知）
//
// 多文件规则：编译项目内全部 .java 到 .bobocloud/classes，
// 主类名由入口文件的 package 声明 + 文件名推导（支持 package a.b; 的项目结构）。
// ============================================================

// JavaPlugin Java 语言插件
type JavaPlugin struct{}

func (JavaPlugin) Language() string     { return "java" }
func (JavaPlugin) Extensions() []string { return []string{".java"} }

func (JavaPlugin) Plan(req *PlanRequest) (*Plan, error) {
	sources := CollectSources(req.ProjectFiles, []string{".java"})
	if len(sources) == 0 {
		return nil, ErrNoSources("java")
	}

	const classesDir = ".bobocloud/classes"

	compileCmd := []string{"javac", "-encoding", "UTF-8", "-d", classesDir}
	compileCmd = append(compileCmd, sources...)
	compileCmd = append(compileCmd, req.CompileArgs...)

	// 主类：package 声明 + 入口文件名（javac 本身要求 目录结构==包名，
	// 因此 package 声明即主类的包前缀）
	className := strings.TrimSuffix(BaseOf(req.EntryRelPath), ".java")
	if pkg := ParseJavaPackage(req.HostWorkDir, req.EntryRelPath); pkg != "" {
		className = pkg + "." + className
	}

	runCmd := []string{"java", "-cp", classesDir, className}
	runCmd = append(runCmd, req.RunArgs...)

	note := fmt.Sprintf("Java: compiling %d source file(s), main class: %s", len(sources), className)
	return &Plan{
		Steps: []Step{
			{Stage: "compile:java", Cmd: compileCmd, TimeoutSec: req.Timeouts.CompileSec},
			{Stage: "run:java", Cmd: runCmd, TimeoutSec: req.Timeouts.RunSec},
		},
		Note: note,
	}, nil
}
