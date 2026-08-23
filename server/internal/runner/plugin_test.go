package runner

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"bobocloud-server/internal/model"
)

// ============================================================
// plugin_test.go — 语言插件计划生成 + 源码收集的单元测试
// ============================================================

func testTimeouts() TimeoutConfig {
	return TimeoutConfig{CompileSec: 30, RustCompileSec: 60, RunSec: 30}
}

// writeTempProject 在临时目录中创建一组文件，返回 (hostDir, 相对路径列表)
func writeTempProject(t *testing.T, files map[string]string) (string, []string) {
	t.Helper()
	dir := t.TempDir()
	var rels []string
	for rel, content := range files {
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
		rels = append(rels, rel)
	}
	return dir, rels
}

func stepCmds(plan *Plan) []string {
	var out []string
	for _, s := range plan.Steps {
		out = append(out, strings.Join(s.Cmd, " "))
	}
	return out
}

// ---------- C 插件 ----------

func TestCPlugin_MultiFile(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"main.c":        "int main(){return 0;}",
		"utils.c":       "void helper(){}",
		"utils.h":       "void helper();",
		"sub/extra.c":   "void extra(){}",
		"other/skip.md": "not source",
		"target/junk.c": "int main(){return 1;}", // 构建目录应被忽略
		".git/hook.c":   "int main(){return 1;}", // VCS 目录应被忽略
	})
	plan, err := CPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "main.c",
		ProjectFiles: files,
		HostWorkDir:  hostDir,
		CompileArgs:  []string{"-O2"},
		RunArgs:      []string{"hello", "world"},
		Timeouts:     testTimeouts(),
	})
	if err != nil {
		t.Fatalf("Plan failed: %v", err)
	}
	cmds := stepCmds(plan)
	if len(plan.Steps) != 3 {
		t.Fatalf("expected 3 steps (mkdir/compile/run), got %d: %v", len(plan.Steps), cmds)
	}
	compile := strings.Join(plan.Steps[1].Cmd, " ")
	for _, want := range []string{"gcc", "main.c", "utils.c", "sub/extra.c", "-O2", "-Wall"} {
		if !strings.Contains(compile, want) {
			t.Errorf("compile cmd missing %q: %s", want, compile)
		}
	}
	for _, notWant := range []string{"target/junk.c", ".git/hook.c", "skip.md"} {
		if strings.Contains(compile, notWant) {
			t.Errorf("compile cmd should not contain %q: %s", notWant, compile)
		}
	}
	run := strings.Join(plan.Steps[2].Cmd, " ")
	if !strings.Contains(run, "hello world") {
		t.Errorf("run cmd missing program args: %s", run)
	}
}

func TestCPlugin_EntryInSubdir(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"week1/main.c":  "int main(){return 0;}",
		"week1/utils.c": "void u(){}",
		"week2/main.c":  "int main(){return 0;}", // 另一个程序：不应被拉入链接
	})
	plan, err := CPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "week1/main.c",
		ProjectFiles: files,
		HostWorkDir:  hostDir,
		Timeouts:     testTimeouts(),
	})
	if err != nil {
		t.Fatalf("Plan failed: %v", err)
	}
	compile := strings.Join(plan.Steps[1].Cmd, " ")
	if !strings.Contains(compile, "week1/utils.c") {
		t.Errorf("should include sibling source: %s", compile)
	}
	if strings.Contains(compile, "week2/main.c") {
		t.Errorf("should NOT include other program's main: %s", compile)
	}
}

func TestCPlugin_CrossTargetBuildsArtifactWithoutRunning(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{"main.c": "int main(void){return 0;}"})
	target, ok := model.ResolveBuildTarget("c", "linux-arm64")
	if !ok {
		t.Fatal("missing arm64 target")
	}
	plan, err := CPlugin{}.Plan(&PlanRequest{EntryRelPath: "main.c", ProjectFiles: files, HostWorkDir: hostDir, BuildTarget: target, Timeouts: testTimeouts()})
	if err != nil {
		t.Fatal(err)
	}
	cmds := strings.Join(stepCmds(plan), "\n")
	if !strings.Contains(cmds, "aarch64-linux-gnu-gcc") || !strings.Contains(cmds, "artifacts/app_linux_arm64") {
		t.Fatalf("cross C plan = %s", cmds)
	}
	if strings.Contains(cmds, "run:c") || len(plan.Steps) != 2 {
		t.Fatalf("cross target must not create a run step: %#v", plan.Steps)
	}
}

func TestCPlugin_RootEntryExcludesOtherPrograms(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"main.c":        "int main(void){return helper();}",
		"helper.c":      "int helper(void){return 0;}",
		"exercise.c":    "int main(void){return 2;}",
		"nested/demo.c": "static int main(int argc, char **argv){return argc;}",
	})
	plan, err := CPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "main.c", ProjectFiles: files, HostWorkDir: hostDir, Timeouts: testTimeouts(),
	})
	if err != nil {
		t.Fatal(err)
	}
	compile := strings.Join(plan.Steps[1].Cmd, " ")
	for _, want := range []string{"main.c", "helper.c"} {
		if !strings.Contains(compile, want) {
			t.Errorf("compile command missing %s: %s", want, compile)
		}
	}
	for _, unwanted := range []string{"exercise.c", "nested/demo.c"} {
		if strings.Contains(compile, unwanted) {
			t.Errorf("other program entry %s was included: %s", unwanted, compile)
		}
	}
}

func TestCppPlugin_RootEntryExcludesOtherPrograms(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"main.cpp":      "int main(){return helper();}",
		"helper.cpp":    "int helper(){return 0;}",
		"standalone.cc": "int main(){return 1;}",
	})
	plan, err := CppPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "main.cpp", ProjectFiles: files, HostWorkDir: hostDir, Timeouts: testTimeouts(),
	})
	if err != nil {
		t.Fatal(err)
	}
	compile := strings.Join(plan.Steps[1].Cmd, " ")
	if !strings.Contains(compile, "helper.cpp") || strings.Contains(compile, "standalone.cc") {
		t.Fatalf("unexpected C++ program source selection: %s", compile)
	}
}

// ---------- Java 插件 ----------

func TestJavaPlugin_PackageMainClass(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"src/com/demo/Main.java":   "package com.demo;\npublic class Main { public static void main(String[] a){} }",
		"src/com/demo/Helper.java": "package com.demo;\nclass Helper {}",
	})
	plan, err := JavaPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "src/com/demo/Main.java",
		ProjectFiles: files,
		HostWorkDir:  hostDir,
		RunArgs:      []string{"arg1"},
		Timeouts:     testTimeouts(),
	})
	if err != nil {
		t.Fatalf("Plan failed: %v", err)
	}
	compile := strings.Join(plan.Steps[0].Cmd, " ")
	if !strings.Contains(compile, "src/com/demo/Helper.java") {
		t.Errorf("should compile all java files: %s", compile)
	}
	run := plan.Steps[1].Cmd
	// java -cp .bobocloud/classes com.demo.Main arg1
	joined := strings.Join(run, " ")
	if !strings.Contains(joined, "com.demo.Main") || !strings.Contains(joined, "arg1") {
		t.Errorf("run cmd wrong: %s", joined)
	}
}

// ---------- Go 插件 ----------

func TestGoPlugin_ModuleMode(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"go.mod":       "module demo\n\ngo 1.23\n",
		"main.go":      "package main\nfunc main(){}",
		"helper.go":    "package main\nfunc helper(){}",
		"sub/thing.go": "package sub\nfunc Thing(){}",
	})
	plan, err := GoPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "main.go",
		ProjectFiles: files,
		HostWorkDir:  hostDir,
		RunArgs:      []string{"-v"},
		Timeouts:     testTimeouts(),
	})
	if err != nil {
		t.Fatalf("Plan failed: %v", err)
	}
	if len(plan.Steps) != 1 {
		t.Fatalf("module mode should be single go run step: %v", stepCmds(plan))
	}
	cmd := strings.Join(plan.Steps[0].Cmd, " ")
	if cmd != "go run . -v" {
		t.Errorf("unexpected module mode cmd: %s", cmd)
	}
	if !strings.Contains(plan.Note, "module") {
		t.Errorf("note should mention module mode: %s", plan.Note)
	}
}

func TestGoPlugin_NoModule_MultiFile(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"main.go":        "package main\nfunc main(){}",
		"helper.go":      "package main\nfunc helper(){}",
		"main_test.go":   "package main\nfunc TestX(){})", // 测试文件应排除
		"other/thing.go": "package other",                 // 别的目录不应拉入
	})
	plan, err := GoPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "main.go",
		ProjectFiles: files,
		HostWorkDir:  hostDir,
		Timeouts:     testTimeouts(),
	})
	if err != nil {
		t.Fatalf("Plan failed: %v", err)
	}
	cmd := strings.Join(plan.Steps[0].Cmd, " ")
	if !strings.Contains(cmd, "main.go") || !strings.Contains(cmd, "helper.go") {
		t.Errorf("should include all same-dir go files: %s", cmd)
	}
	if strings.Contains(cmd, "main_test.go") || strings.Contains(cmd, "thing.go") {
		t.Errorf("should exclude test files and other dirs: %s", cmd)
	}
}

func TestGoPlugin_CrossTargetBuildsArtifactWithoutRunning(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"go.mod":  "module demo\n\ngo 1.23\n",
		"main.go": "package main\nfunc main(){}",
	})
	target, ok := model.ResolveBuildTarget("go", "windows-x86_64")
	if !ok {
		t.Fatal("missing Windows Go target")
	}
	plan, err := GoPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "main.go", ProjectFiles: files, HostWorkDir: hostDir, ProjectRoot: "/workspace", BuildTarget: target, Timeouts: testTimeouts(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Steps) != 2 || plan.Steps[1].Stage != "compile:go" {
		t.Fatalf("cross Go plan = %#v", plan.Steps)
	}
	step := plan.Steps[1]
	if step.Env["GOOS"] != "windows" || step.Env["GOARCH"] != "amd64" || step.Env["CGO_ENABLED"] != "0" {
		t.Fatalf("cross Go environment = %#v", step.Env)
	}
	if got := strings.Join(step.Cmd, " "); !strings.Contains(got, "go build") || !strings.Contains(got, "/workspace/artifacts/app_windows_x86_64.exe") {
		t.Fatalf("cross Go command = %s", got)
	}
}

// ---------- Rust 插件 ----------

func TestRustPlugin_CargoMode(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"Cargo.toml":  "[package]\nname = \"myapp\"\nversion = \"0.1.0\"\n",
		"src/main.rs": "fn main(){}",
		"src/lib.rs":  "pub fn x(){}",
	})
	plan, err := RustPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "src/main.rs",
		ProjectFiles: files,
		HostWorkDir:  hostDir,
		Timeouts:     testTimeouts(),
	})
	if err != nil {
		t.Fatalf("Plan failed: %v", err)
	}
	build := strings.Join(plan.Steps[0].Cmd, " ")
	if build != "cargo build" {
		t.Errorf("unexpected cargo build cmd: %s", build)
	}
	run := strings.Join(plan.Steps[1].Cmd, " ")
	if run != "./target/debug/myapp" {
		t.Errorf("unexpected cargo run path: %s", run)
	}
}

func TestDockerRustRuntimeBootstrapUsesCargoTargetWithoutMutatingLocalPlan(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"Cargo.toml":  "[package]\nname = \"myapp\"\nversion = \"0.1.0\"\n",
		"src/main.rs": "fn main(){}",
	})
	plan, err := RustPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "src/main.rs",
		ProjectFiles: files,
		HostWorkDir:  hostDir,
		RunArgs:      []string{"$(must-not-be-evaluated)"},
		Timeouts:     testTimeouts(),
	})
	if err != nil {
		t.Fatal(err)
	}
	written := withDockerRustRuntimeBootstrap(plan)
	want := []string{"sh", "-c", rustRuntimeBootstrap, "rust-runtime", "./target/debug/myapp", "$(must-not-be-evaluated)"}
	if got := written.Steps[1].Cmd; !reflect.DeepEqual(got, want) {
		t.Fatalf("Docker Rust command = %#v, want %#v", got, want)
	}
	if got := plan.Steps[1].Cmd; !reflect.DeepEqual(got, []string{"./target/debug/myapp", "$(must-not-be-evaluated)"}) {
		t.Fatalf("local Rust plan was mutated: %#v", got)
	}
}

func TestDockerRustRuntimeBootstrapExecutesCachedArtifact(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("POSIX shell is unavailable")
	}
	targetRoot := t.TempDir()
	artifact := filepath.Join(targetRoot, "debug", "myapp")
	if err := os.MkdirAll(filepath.Dir(artifact), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0755); err != nil {
		t.Fatal(err)
	}
	argument := "$(must-not-be-evaluated)"
	command := exec.Command(shell, "-c", rustRuntimeBootstrap, "rust-runtime", "./target/debug/myapp", argument)
	command.Env = []string{"CARGO_TARGET_DIR=" + targetRoot}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("execute Rust bootstrap: %v: %s", err, output)
	}
	if got := strings.TrimSpace(string(output)); got != argument {
		t.Fatalf("Rust argv = %q, want literal %q", got, argument)
	}
}

func TestDockerRustArtifactCopyBootstrapUsesCargoTarget(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("POSIX shell is unavailable")
	}
	targetRoot := t.TempDir()
	artifact := filepath.Join(targetRoot, "x86_64-pc-windows-gnu", "debug", "myapp.exe")
	if err := os.MkdirAll(filepath.Dir(artifact), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("cross-artifact"), 0644); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "myapp.exe")
	command := exec.Command(shell, "-c", rustArtifactCopyBootstrap, "rust-artifact", "target/x86_64-pc-windows-gnu/debug/myapp.exe", destination)
	command.Env = []string{"CARGO_TARGET_DIR=" + targetRoot}
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("copy Rust artifact: %v: %s", err, output)
	}
	content, err := os.ReadFile(destination)
	if err != nil || string(content) != "cross-artifact" {
		t.Fatalf("copied artifact = %q, err=%v", content, err)
	}
}

func TestRustPlugin_CargoReleaseProfile(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"Cargo.toml":  "[package]\nname = \"myapp\"\n",
		"src/main.rs": "fn main(){}",
	})
	plan, err := RustPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "src/main.rs",
		ProjectFiles: files,
		HostWorkDir:  hostDir,
		CompileArgs:  []string{"--release"},
		Timeouts:     testTimeouts(),
	})
	if err != nil {
		t.Fatalf("Plan failed: %v", err)
	}
	if !strings.Contains(strings.Join(plan.Steps[0].Cmd, " "), "--release") {
		t.Errorf("build cmd should carry --release")
	}
	if !strings.Contains(plan.Steps[1].Cmd[0], "target/release/") {
		t.Errorf("run path should use release profile: %s", plan.Steps[1].Cmd[0])
	}
}

func TestRustPlugin_SingleFile(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"main.rs": "mod util;\nfn main(){}",
		"util.rs": "pub fn u(){}",
	})
	plan, err := RustPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "main.rs",
		ProjectFiles: files,
		HostWorkDir:  hostDir,
		Timeouts:     testTimeouts(),
	})
	if err != nil {
		t.Fatalf("Plan failed: %v", err)
	}
	compile := strings.Join(plan.Steps[1].Cmd, " ")
	if !strings.HasPrefix(compile, "rustc main.rs") {
		t.Errorf("single-file mode should rustc the entry: %s", compile)
	}
}

func TestRustPlugin_CrossTargetBuildsArtifactWithoutRunning(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{"main.rs": "fn main(){}"})
	target, ok := model.ResolveBuildTarget("rust", "windows-x86_64")
	if !ok {
		t.Fatal("missing Windows target")
	}
	plan, err := RustPlugin{}.Plan(&PlanRequest{EntryRelPath: "main.rs", ProjectFiles: files, HostWorkDir: hostDir, BuildTarget: target, Timeouts: testTimeouts()})
	if err != nil {
		t.Fatal(err)
	}
	cmds := strings.Join(stepCmds(plan), "\n")
	if !strings.Contains(cmds, "--target x86_64-pc-windows-gnu") || !strings.Contains(cmds, "artifacts/app_windows_x86_64.exe") {
		t.Fatalf("cross Rust plan = %s", cmds)
	}
	if len(plan.Steps) != 2 || plan.Steps[len(plan.Steps)-1].Stage == "run:rust" {
		t.Fatalf("cross target must not run: %#v", plan.Steps)
	}
	if written := withDockerRustRuntimeBootstrap(plan); !reflect.DeepEqual(written.Steps, plan.Steps) {
		t.Fatalf("single-file cross plan should not use Cargo target rewriting: %#v", written.Steps)
	}
}

func TestDockerRustCargoCrossArtifactUsesCargoTarget(t *testing.T) {
	hostDir, files := writeTempProject(t, map[string]string{
		"Cargo.toml":  "[package]\nname = \"myapp\"\nversion = \"0.1.0\"\n",
		"src/main.rs": "fn main(){}",
	})
	target, ok := model.ResolveBuildTarget("rust", "windows-x86_64")
	if !ok {
		t.Fatal("missing Windows target")
	}
	plan, err := RustPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "src/main.rs", ProjectFiles: files, HostWorkDir: hostDir,
		BuildTarget: target, Timeouts: testTimeouts(),
	})
	if err != nil {
		t.Fatal(err)
	}
	originalCopy := plan.Steps[len(plan.Steps)-1]
	if originalCopy.Stage != "artifact:rust" || len(originalCopy.Cmd) != 3 || originalCopy.Cmd[0] != "cp" {
		t.Fatalf("Cargo cross plan has no artifact copy: %#v", plan.Steps)
	}
	written := withDockerRustRuntimeBootstrap(plan)
	copyStep := written.Steps[len(written.Steps)-1]
	wantCopy := []string{
		"sh", "-c", rustArtifactCopyBootstrap, "rust-artifact",
		originalCopy.Cmd[1], originalCopy.Cmd[2],
	}
	if !reflect.DeepEqual(copyStep.Cmd, wantCopy) {
		t.Fatalf("Docker cross artifact copy = %#v, want %#v", copyStep.Cmd, wantCopy)
	}
	if plan.Steps[len(plan.Steps)-1].Cmd[0] != "cp" || !strings.HasPrefix(plan.Steps[len(plan.Steps)-1].Cmd[1], "target/") {
		t.Fatalf("local cross plan was mutated: %#v", plan.Steps[len(plan.Steps)-1].Cmd)
	}
}

// ---------- Python / Node 插件 ----------

func TestPythonPlugin_PythonpathAndArgs(t *testing.T) {
	plan, err := PythonPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "src/main.py",
		RunArgs:      []string{"--verbose"},
		Timeouts:     testTimeouts(),
	})
	if err != nil {
		t.Fatalf("Plan failed: %v", err)
	}
	step := plan.Steps[0]
	if got, want := step.Cmd, []string{"python3", "src/main.py", "--verbose"}; !reflect.DeepEqual(got, want) {
		t.Errorf("unexpected python cmd: %v", step.Cmd)
	}
	if step.Env["PYTHONPATH"] != "{{projectRoot}}" {
		t.Errorf("unexpected local PYTHONPATH: %v", step.Env)
	}
	if step.Env["PYTHONUNBUFFERED"] != "1" {
		t.Errorf("unexpected Python environment: %v", step.Env)
	}
}

func TestDockerPythonRuntimeBootstrapUsesScopedTargetWithoutMutatingLocalPlan(t *testing.T) {
	plan, err := PythonPlugin{}.Plan(&PlanRequest{
		EntryRelPath: "src/main.py",
		RunArgs:      []string{"--verbose"},
		Timeouts:     testTimeouts(),
	})
	if err != nil {
		t.Fatal(err)
	}
	wrapped := withDockerPythonRuntimeBootstrap(plan)
	if wrapped == plan {
		t.Fatal("Docker bootstrap must copy the plan")
	}
	if got, want := wrapped.Steps[0].Cmd, []string{"sh", "-c", pythonRuntimeBootstrap, "python-runtime", "src/main.py", "--verbose"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Docker Python command = %v, want %v", got, want)
	}
	if _, exists := wrapped.Steps[0].Env["PYTHONPATH"]; exists {
		t.Fatalf("Docker step must not replace the container dependency PYTHONPATH: %v", wrapped.Steps[0].Env)
	}
	if plan.Steps[0].Env["PYTHONPATH"] != "{{projectRoot}}" || plan.Steps[0].Cmd[0] != "python3" {
		t.Fatalf("local Python plan was mutated: %+v", plan.Steps[0])
	}
}

func TestDockerPythonRuntimeBootstrapPreservesReadOnlyProjectDependencies(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("POSIX shell is unavailable")
	}
	projectRoot := t.TempDir()
	binRoot := t.TempDir()
	pythonPath := filepath.Join(binRoot, "python3")
	if err := os.WriteFile(pythonPath, []byte("#!/bin/sh\nprintf '%s\\n' \"$PYTHONPATH\"\nprintf '%s\\n' \"$@\"\n"), 0755); err != nil {
		t.Fatal(err)
	}
	argument := "$(must-not-be-evaluated)"
	command := exec.Command(shell, "-c", pythonRuntimeBootstrap, "python-runtime", "src/main.py", argument)
	command.Dir = projectRoot
	command.Env = []string{
		"PATH=" + binRoot,
		"PYTHONPATH=/project-deps/python",
	}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("execute Python bootstrap: %v: %s", err, output)
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	wantPythonPath := "/project-deps/python:" + projectRoot
	if len(lines) != 3 || lines[0] != wantPythonPath || lines[1] != "src/main.py" || lines[2] != argument {
		t.Fatalf("bootstrap output = %#v, want PYTHONPATH %q and literal argv", lines, wantPythonPath)
	}
}

func TestAutoPersistPipDefersToContainerPIPTarget(t *testing.T) {
	for _, command := range []string{
		"python3 -m pip install numpy",
		"pip3 install --target /custom/site-packages numpy",
	} {
		if got := AutoPersistPip(command); got != command {
			t.Errorf("AutoPersistPip() = %q, want unchanged command %q", got, command)
		}
	}
}

func TestNodePlugin(t *testing.T) {
	plan, err := NodePlugin{}.Plan(&PlanRequest{
		EntryRelPath: "app/index.js",
		RunArgs:      []string{"--port", "8080"},
		Timeouts:     testTimeouts(),
	})
	if err != nil {
		t.Fatalf("Plan failed: %v", err)
	}
	if strings.Join(plan.Steps[0].Cmd, " ") != "node app/index.js --port 8080" {
		t.Errorf("unexpected node cmd: %v", plan.Steps[0].Cmd)
	}
}

// ---------- 注册表 ----------

func TestPluginRegistry(t *testing.T) {
	reg := NewPluginRegistry()
	RegisterAllPlugins(reg)
	cases := map[string]string{
		".c": "c", ".cpp": "cpp", ".cc": "cpp", ".java": "java",
		".go": "go", ".rs": "rust", ".py": "python",
		".js": "node", ".mjs": "node", ".cjs": "node",
	}
	for ext, lang := range cases {
		p := reg.ForExtension(ext)
		if p == nil {
			t.Errorf("no plugin for %s", ext)
			continue
		}
		if p.Language() != lang {
			t.Errorf("ext %s: got language %s, want %s", ext, p.Language(), lang)
		}
	}
	if reg.ForExtension(".txt") != nil {
		t.Errorf("unexpected plugin for .txt")
	}
}

// ---------- 收集辅助 ----------

func TestFindUpward(t *testing.T) {
	files := []string{"go.mod", "src/app/main.go", "src/util/x.go"}
	dir, ok := FindUpward(files, "src/app", "go.mod")
	if !ok || dir != "" {
		t.Errorf("expected go.mod at root, got dir=%q ok=%v", dir, ok)
	}
	_, ok = FindUpward(files, "src/app", "Cargo.toml")
	if ok {
		t.Errorf("Cargo.toml should not be found")
	}
}

func TestSubstituteEnv(t *testing.T) {
	env := substituteEnv(map[string]string{"PYTHONPATH": "{{projectRoot}}"}, "/workspace")
	if env["PYTHONPATH"] != "/workspace" {
		t.Errorf("unexpected env: %v", env)
	}
}
