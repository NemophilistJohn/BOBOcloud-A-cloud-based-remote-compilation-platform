package runner

import (
	"fmt"
	"strings"
)

// ============================================================
// plugin_rust.go — Rust 语言插件（Cargo 感知）
//
// 两种模式：
//   - Cargo 模式：从入口目录向上找到 Cargo.toml → `cargo build` 后运行产物，
//     支持完整 crate（src/main.rs、src/bin/*.rs、examples/*.rs、依赖）；
//   - 单文件模式：无 Cargo.toml → `rustc entry.rs`，`mod foo;` 声明的多文件
//     由 rustc 自动解析（无需特殊处理）。
// target/ 目录会被产物同步忽略，不会回传到工作区。
// ============================================================

// RustPlugin Rust 语言插件
type RustPlugin struct{}

func (RustPlugin) Language() string     { return "rust" }
func (RustPlugin) Extensions() []string { return []string{".rs"} }

func (RustPlugin) Plan(req *PlanRequest) (*Plan, error) {
	entryDir := DirOf(req.EntryRelPath)

	if cargoDir, ok := FindUpward(req.ProjectFiles, entryDir, "Cargo.toml"); ok {
		return cargoPlan(req, cargoDir)
	}
	return singleFilePlan(req)
}

// cargoPlan Cargo 项目：cargo build + 运行目标二进制
func cargoPlan(req *PlanRequest, cargoDir string) (*Plan, error) {
	// 入口相对 crate 根的路径
	entryInCrate := req.EntryRelPath
	if cargoDir != "" {
		entryInCrate = strings.TrimPrefix(req.EntryRelPath, cargoDir+"/")
	}

	profile := "debug"
	if ContainsFlag(req.CompileArgs, "--release") {
		profile = "release"
	}

	buildCmd := []string{"cargo", "build"}
	var binPath string
	var note string

	if strings.HasPrefix(entryInCrate, "examples/") && strings.HasSuffix(entryInCrate, ".rs") {
		// examples/foo.rs → cargo build --example foo
		name := strings.TrimSuffix(BaseOf(entryInCrate), ".rs")
		buildCmd = append(buildCmd, "--example", name)
		binPath = "target/" + profile + "/examples/" + name
		note = fmt.Sprintf("Cargo example target: %s (profile: %s)", name, profile)
	} else {
		binName := ""
		if strings.HasPrefix(entryInCrate, "src/bin/") && strings.HasSuffix(entryInCrate, ".rs") {
			binName = strings.TrimSuffix(BaseOf(entryInCrate), ".rs")
			buildCmd = append(buildCmd, "--bin", binName)
		} else {
			binName = ParseCargoBinaryName(req.HostWorkDir, cargoDir)
		}
		if binName == "" {
			return nil, fmt.Errorf("cannot determine binary name from Cargo.toml")
		}
		binPath = "target/" + profile + "/" + binName
		note = fmt.Sprintf("Cargo project (crate root: %s), binary: %s (profile: %s)",
			displayDir(cargoDir), binName, profile)
	}

	buildCmd = append(buildCmd, req.CompileArgs...)
	runCmd := append([]string{"./" + binPath}, req.RunArgs...)

	// 首次 cargo build 可能拉取依赖，给足时间（CARGO_HOME=/persist 有缓存，后续很快）
	cargoTimeout := req.Timeouts.RustCompileSec * 4
	if cargoTimeout < 240 {
		cargoTimeout = 240
	}

	return &Plan{
		Steps: []Step{
			{Stage: "compile:rust", Cmd: buildCmd, WorkDir: cargoDir, TimeoutSec: cargoTimeout},
			{Stage: "run:rust", Cmd: runCmd, WorkDir: cargoDir, TimeoutSec: req.Timeouts.RunSec},
		},
		Note: note,
	}, nil
}

// singleFilePlan 单文件 rustc 模式（mod 多文件自动解析）
func singleFilePlan(req *PlanRequest) (*Plan, error) {
	const output = ".bobocloud/output"

	compileCmd := []string{"rustc", req.EntryRelPath, "-o", output}
	compileCmd = append(compileCmd, req.CompileArgs...)
	runCmd := append([]string{output}, req.RunArgs...)

	return &Plan{
		Steps: []Step{
			{Stage: "setup", Cmd: []string{"mkdir", "-p", ".bobocloud"}, TimeoutSec: 10},
			{Stage: "compile:rust", Cmd: compileCmd, TimeoutSec: req.Timeouts.RustCompileSec},
			{Stage: "run:rust", Cmd: runCmd, TimeoutSec: req.Timeouts.RunSec},
		},
		Note: "Rust single-file mode (no Cargo.toml found)",
	}, nil
}
