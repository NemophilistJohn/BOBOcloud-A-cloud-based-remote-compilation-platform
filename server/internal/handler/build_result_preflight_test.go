package handler

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/files"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/runner"
)

func TestBuildResultPreflightFindsPublishedResultWithoutCreatingCacheState(t *testing.T) {
	dataRoot := t.TempDir()
	serverRoot := t.TempDir()
	workspace := filepath.Join(serverRoot, "project")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "main.go"), []byte("package main\nfunc main() {}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.DataDir = dataRoot
	cfg.ServerRoot = serverRoot
	cfg.PersonalBuildCacheEnabled = true
	cfg.PersonalBuildResultReuse = config.PersonalBuildResultReuseCompileOnly
	manager := newPersonalCacheManagerForTest(dataRoot, personalcache.Options{})
	plugins := runner.NewPluginRegistry()
	runner.RegisterAllPlugins(plugins)
	handler := &WSHandler{Config: cfg, PersonalCache: manager, Plugins: plugins}
	sess := &model.RunSession{UserID: "u1", FolderName: "Project", FolderKey: "project", FilePath: "main.go", Runtime: "go:1.23"}
	runtime := model.GetRuntimeDef(sess.Runtime)
	if runtime == nil {
		t.Fatalf("runtime %q is not registered", sess.Runtime)
	}
	plugin := plugins.ForLanguage("go")
	target, ok := model.ResolveBuildTarget("go", "")
	if !ok {
		t.Fatal("native Go build target is unavailable")
	}
	first, err := handler.preflightBuildResult(context.Background(), sess, *runtime, plugin, target, sess.FilePath, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if first == nil || first.hit {
		t.Fatalf("initial preflight = %+v, want a miss without a published result", first)
	}
	if first.fingerprint != "" {
		t.Fatalf("cold preflight eagerly scanned source, fingerprint=%q", first.fingerprint)
	}
	dependencyFingerprint, err := personalcache.DependencyFingerprintWithRuntimeAndPolicy(workspace, "go", sess.SetupCommands, first.request.RuntimeFingerprint, "")
	if err != nil {
		t.Fatal(err)
	}
	first.request.DependencyDigest = dependencyFingerprint.Digest
	snapshot, err := files.SnapshotProjectFiles(context.Background(), workspace, workspaceCopyLimits(cfg))
	if err != nil {
		t.Fatal(err)
	}
	projectFiles := make([]string, 0, len(snapshot.Files))
	for relative := range snapshot.Files {
		projectFiles = append(projectFiles, relative)
	}
	sort.Strings(projectFiles)
	plan, err := plugin.Plan(&runner.PlanRequest{
		EntryRelPath: sess.FilePath, ProjectFiles: projectFiles, HostWorkDir: workspace,
		ProjectRoot: "/workspace", CompileArgs: sess.CompileArgs, RunArgs: sess.RunArgs,
		BuildTarget: target, Timeouts: runner.TimeoutConfig{CompileSec: cfg.DefaultCompileTimeout, RustCompileSec: cfg.RustCompileTimeout, RunSec: cfg.DefaultRunTimeout},
	})
	if err != nil {
		t.Fatal(err)
	}
	fingerprint, err := executionBuildFingerprint(context.Background(), workspace, first.request.RuntimeFingerprint, first.request.DependencyDigest, plan, projectFiles)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := manager.PrepareBuild(context.Background(), first.request)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.CommitResult(fingerprint); err != nil {
		lease.Release()
		t.Fatal(err)
	}
	lease.Release()
	second, err := handler.preflightBuildResult(context.Background(), sess, *runtime, plugin, target, sess.FilePath, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if second == nil || !second.hit || second.fingerprint != fingerprint {
		t.Fatalf("published preflight = %+v, want hit fingerprint %q", second, fingerprint)
	}
}
