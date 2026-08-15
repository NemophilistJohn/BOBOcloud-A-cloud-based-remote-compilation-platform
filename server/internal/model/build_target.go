package model

import "strings"

// BuildTarget is a server-controlled cross-compilation preset. Clients send
// only ID; compiler names, linker configuration, output paths, and images are
// selected on the server so target selection never becomes arbitrary shell.
type BuildTarget struct {
	ID           string `json:"id"`
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
	Environment  string `json:"environment"`
	OutputPath   string `json:"outputPath"`
	Runnable     bool   `json:"runnable"`

	CCompiler          string   `json:"-"`
	CppCompiler        string   `json:"-"`
	RustTarget         string   `json:"-"`
	RustLinker         string   `json:"-"`
	RustLinkerEnv      string   `json:"-"`
	GoOS               string   `json:"-"`
	GoARCH             string   `json:"-"`
	DefaultCompileArgs []string `json:"-"`
}

var buildTargets = []BuildTarget{
	{
		ID: "linux-x86_64", OS: "linux", Architecture: "x86_64", Environment: "hosted",
		OutputPath: ".bobocloud/output", Runnable: true, CCompiler: "gcc", CppCompiler: "g++", GoOS: "linux", GoARCH: "amd64",
	},
	{
		ID: "linux-arm64", OS: "linux", Architecture: "arm64", Environment: "hosted",
		OutputPath: "artifacts/app_linux_arm64", CCompiler: "aarch64-linux-gnu-gcc", CppCompiler: "aarch64-linux-gnu-g++",
		RustTarget: "aarch64-unknown-linux-gnu", RustLinker: "aarch64-linux-gnu-gcc", RustLinkerEnv: "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER", GoOS: "linux", GoARCH: "arm64",
	},
	{
		ID: "windows-x86_64", OS: "windows", Architecture: "x86_64", Environment: "hosted",
		OutputPath: "artifacts/app_windows_x86_64.exe", CCompiler: "x86_64-w64-mingw32-gcc", CppCompiler: "x86_64-w64-mingw32-g++",
		RustTarget: "x86_64-pc-windows-gnu", RustLinker: "x86_64-w64-mingw32-gcc", RustLinkerEnv: "CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER", GoOS: "windows", GoARCH: "amd64",
	},
	{
		ID: "cortex-m4", OS: "none", Architecture: "armv7e-m", Environment: "bare-metal-rtos",
		OutputPath: "artifacts/app_cortex_m4.elf", CCompiler: "arm-none-eabi-gcc", CppCompiler: "arm-none-eabi-g++",
		RustTarget: "thumbv7em-none-eabihf", RustLinker: "rust-lld", RustLinkerEnv: "CARGO_TARGET_THUMBV7EM_NONE_EABIHF_LINKER",
		DefaultCompileArgs: []string{"-mcpu=cortex-m4", "-mthumb", "-specs=nosys.specs"},
	},
}

// BuildTargetsForLanguage exposes only targets a language plugin can execute.
// A copy avoids callers mutating the shared catalog.
func BuildTargetsForLanguage(language string) []BuildTarget {
	if language != "c" && language != "cpp" && language != "rust" && language != "go" {
		return nil
	}
	out := make([]BuildTarget, 0, len(buildTargets))
	for _, target := range buildTargets {
		// Cortex-M Rust and Go need project-provided no_std/TinyGo and linker
		// setup. Do not advertise that as an effortless single-file preset.
		if (language == "rust" || language == "go") && target.ID == "cortex-m4" {
			continue
		}
		out = append(out, target)
	}
	return out
}

// ResolveBuildTarget validates a client selection. Empty means the native
// Linux x86_64 target, keeping existing clients and saved configurations valid.
func ResolveBuildTarget(language, id string) (BuildTarget, bool) {
	if id == "" {
		id = "linux-x86_64"
	}
	for _, target := range BuildTargetsForLanguage(strings.ToLower(language)) {
		if target.ID == id {
			return target, true
		}
	}
	return BuildTarget{}, false
}

func IsCrossBuildTarget(target BuildTarget) bool {
	return target.ID != "" && !target.Runnable
}

// CrossBuildImage chooses a fixed image tag for a supported cross build.
// The corresponding images are built by deploy/cross-toolkit/build.sh.
func CrossBuildImage(runtime RuntimeDef, target BuildTarget) string {
	if !IsCrossBuildTarget(target) {
		return runtime.DockerImage
	}
	switch runtime.Language {
	case "c", "cpp":
		return "bobocloud-cross-gcc:" + runtime.Version
	case "rust":
		return "bobocloud-cross-rust:" + runtime.Version
	case "go":
		// Standard Go cross-compiles pure Go programs using GOOS/GOARCH, so
		// it uses the selected versioned Go runtime rather than another image.
		return runtime.DockerImage
	default:
		return ""
	}
}
