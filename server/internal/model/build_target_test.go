package model

import "testing"

func TestBuildTargetsOnlyExposeCompiledLanguages(t *testing.T) {
	if got := BuildTargetsForLanguage("python"); len(got) != 0 {
		t.Fatalf("python targets = %#v, want none", got)
	}
	for _, language := range []string{"c", "cpp", "rust", "go"} {
		targets := BuildTargetsForLanguage(language)
		wantCount := 4
		if language == "rust" || language == "go" {
			wantCount = 3
		}
		if len(targets) != wantCount {
			t.Fatalf("%s target count = %d, want %d", language, len(targets), wantCount)
		}
		if targets[0].ID != "linux-x86_64" || !targets[0].Runnable {
			t.Fatalf("%s native target = %#v", language, targets[0])
		}
	}
}

func TestResolveBuildTargetAndImage(t *testing.T) {
	native, ok := ResolveBuildTarget("c", "")
	if !ok || native.ID != "linux-x86_64" || IsCrossBuildTarget(native) {
		t.Fatalf("native target = %#v, ok=%v", native, ok)
	}
	arm, ok := ResolveBuildTarget("cpp", "linux-arm64")
	if !ok || !IsCrossBuildTarget(arm) || arm.CppCompiler != "aarch64-linux-gnu-g++" {
		t.Fatalf("arm target = %#v, ok=%v", arm, ok)
	}
	if _, ok := ResolveBuildTarget("python", "linux-arm64"); ok {
		t.Fatal("interpreted language must not accept a build target")
	}
	runtime := *GetRuntimeDef("cpp:13")
	if got := CrossBuildImage(runtime, arm); got != "bobocloud-cross-gcc:13" {
		t.Fatalf("cross image = %q", got)
	}
	if got := CrossBuildImage(runtime, native); got != "gcc:13" {
		t.Fatalf("native image = %q", got)
	}
	goRuntime := *GetRuntimeDef("go:1.23")
	goTarget, ok := ResolveBuildTarget("go", "windows-x86_64")
	if !ok || goTarget.GoOS != "windows" || goTarget.GoARCH != "amd64" {
		t.Fatalf("Go Windows target = %#v, ok=%v", goTarget, ok)
	}
	if got := CrossBuildImage(goRuntime, goTarget); got != goRuntime.DockerImage {
		t.Fatalf("Go must use its selected runtime image, got %q want %q", got, goRuntime.DockerImage)
	}
}
