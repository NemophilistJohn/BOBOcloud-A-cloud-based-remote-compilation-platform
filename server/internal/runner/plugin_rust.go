package runner

import (
	"fmt"
	"path/filepath"
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
	target := req.BuildTarget
	if target.ID == "" {
		target = nativeBuildTarget()
	}
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
	if target.RustTarget != "" {
		buildCmd = append(buildCmd, "--target", target.RustTarget)
		binPath = "target/" + target.RustTarget + "/" + profile + "/" + strings.TrimPrefix(binPath, "target/"+profile+"/")
	}

	buildCmd = append(buildCmd, req.CompileArgs...)
	buildEnv := map[string]string(nil)
	if target.RustLinkerEnv != "" && target.RustLinker != "" {
		buildEnv = map[string]string{target.RustLinkerEnv: target.RustLinker}
	}

	// 首次 cargo build 可能拉取依赖，给足时间（CARGO_HOME=/persist 有缓存，后续很快）
	cargoTimeout := req.Timeouts.RustCompileSec * 4
	if cargoTimeout < 240 {
		cargoTimeout = 240
	}

	steps := []Step{{Stage: "compile:rust", Cmd: buildCmd, WorkDir: cargoDir, Env: buildEnv, TimeoutSec: cargoTimeout}}
	if target.Runnable {
		steps = append(steps, Step{Stage: "run:rust", Cmd: append([]string{"./" + binPath}, req.RunArgs...), WorkDir: cargoDir, TimeoutSec: req.Timeouts.RunSec})
	} else {
		artifactRel, relErr := filepath.Rel(filepath.FromSlash(cargoDir), filepath.FromSlash(target.OutputPath))
		if relErr != nil {
			return nil, fmt.Errorf("cannot locate cross-build artifact: %w", relErr)
		}
		artifactRel = filepath.ToSlash(artifactRel)
		steps = append(steps, Step{Stage: "artifact:rust", Cmd: []string{"mkdir", "-p", filepath.ToSlash(filepath.Dir(artifactRel))}, WorkDir: cargoDir, TimeoutSec: 10})
		steps = append(steps, Step{Stage: "artifact:rust", Cmd: []string{"cp", binPath, artifactRel}, WorkDir: cargoDir, TimeoutSec: 20})
		note += fmt.Sprintf("; cross target %s/%s, artifact: %s", target.OS, target.Architecture, target.OutputPath)
	}
	return &Plan{Steps: steps, Note: note}, nil
}

// singleFilePlan 单文件 rustc 模式（mod 多文件自动解析）
func singleFilePlan(req *PlanRequest) (*Plan, error) {
	target := req.BuildTarget
	if target.ID == "" {
		target = nativeBuildTarget()
	}
	output := target.OutputPath

	compileCmd := []string{"rustc", req.EntryRelPath, "-o", output}
	if target.RustTarget != "" {
		compileCmd = append(compileCmd, "--target", target.RustTarget)
	}
	compileCmd = append(compileCmd, req.CompileArgs...)
	compileEnv := map[string]string(nil)
	if target.RustLinkerEnv != "" && target.RustLinker != "" {
		compileEnv = map[string]string{target.RustLinkerEnv: target.RustLinker}
	}
	steps := []Step{
		{Stage: "setup", Cmd: []string{"mkdir", "-p", ".bobocloud", "artifacts"}, TimeoutSec: 10},
		{Stage: "compile:rust", Cmd: compileCmd, Env: compileEnv, TimeoutSec: req.Timeouts.RustCompileSec},
	}
	if target.Runnable {
		steps = append(steps, Step{Stage: "run:rust", Cmd: append([]string{output}, req.RunArgs...), TimeoutSec: req.Timeouts.RunSec})
	}
	note := "Rust single-file mode (no Cargo.toml found)"
	if !target.Runnable {
		note += fmt.Sprintf("; cross target %s/%s, artifact: %s", target.OS, target.Architecture, output)
	}
	return &Plan{Steps: steps, Note: note}, nil
}
