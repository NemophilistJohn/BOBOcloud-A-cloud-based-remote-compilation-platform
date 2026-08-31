package files

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// TestArtifactIgnored 构建目录与依赖目录不应回传为产物
func TestArtifactIgnored(t *testing.T) {
	ignored := []string{
		".bobocloud/output",
		".bobocloud/classes/Main.class",
		"target/debug/myapp",
		"crate/target/release/myapp",
		".git/index",
		"node_modules/x/index.js",
		"__pycache__/main.cpython-311.pyc",
		".venv/lib/python/site.py",
		"venv/Scripts/python.exe",
	}
	for _, p := range ignored {
		if !ArtifactIgnored(p) {
			t.Errorf("should be ignored: %s", p)
		}
	}

	kept := []string{
		"result.txt",
		"plot.png",
		"out/data.csv", // 注意：out 在源码扫描中忽略，但产物不忽略（用户程序可能输出到这里）
		"target.txt",   // 文件名含 target 但不是目录
	}
	for _, p := range kept {
		if ArtifactIgnored(p) {
			t.Errorf("should NOT be ignored: %s", p)
		}
	}
}

func TestSnapshotAndProjectCopyIgnoreLinks(t *testing.T) {
	source := t.TempDir()
	destination := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "main.go"), []byte("package main\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(source, "leak.txt")); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	snapshot, err := SnapshotProjectFiles(context.Background(), source, ProjectCopyLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := snapshot.Files["leak.txt"]; ok {
		t.Fatal("link was included in the file snapshot")
	}
	if err := CopyProjectToTemp(context.Background(), source, destination, ProjectCopyLimits{}); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(destination, "main.go")); err != nil || string(data) != "package main\n" {
		t.Fatalf("regular source was not copied: data=%q err=%v", data, err)
	}
	if _, err := os.Lstat(filepath.Join(destination, "leak.txt")); !os.IsNotExist(err) {
		t.Fatalf("link was copied into the isolated workspace: %v", err)
	}
}

func TestProjectCopyEnforcesIndependentBudgets(t *testing.T) {
	if DefaultProjectCopyMaxFiles <= 4096 {
		t.Fatalf("default project file budget is too low: %d", DefaultProjectCopyMaxFiles)
	}
	source := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt"} {
		if err := os.WriteFile(filepath.Join(source, name), []byte("12"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := CopyProjectToTemp(context.Background(), source, t.TempDir(), ProjectCopyLimits{MaxFiles: 1, MaxTotalBytes: 100, MaxPathBytes: 128}); !errors.Is(err, ErrProjectCopyLimit) {
		t.Fatalf("file-limited copy error=%v", err)
	}
	if err := CopyProjectToTemp(context.Background(), source, t.TempDir(), ProjectCopyLimits{MaxFiles: 4, MaxTotalBytes: 3, MaxPathBytes: 128}); !errors.Is(err, ErrProjectCopyLimit) {
		t.Fatalf("byte-limited copy error=%v", err)
	}
	if err := CopyProjectToTemp(context.Background(), source, t.TempDir(), ProjectCopyLimits{MaxFiles: 4, MaxTotalBytes: 100, MaxPathBytes: 4}); !errors.Is(err, ErrProjectCopyLimit) {
		t.Fatalf("path-limited copy error=%v", err)
	}
}

func TestProjectCopySkipsDependencyAndBuildDirectoriesAtSource(t *testing.T) {
	source := t.TempDir()
	for _, directory := range []string{".git", "node_modules", "target", ".venv"} {
		path := filepath.Join(source, directory)
		if err := os.Mkdir(path, 0755); err != nil {
			t.Fatal(err)
		}
		for index := 0; index < 8; index++ {
			if err := os.WriteFile(filepath.Join(path, fmt.Sprintf("ignored-%d", index)), []byte("ignored"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := os.WriteFile(filepath.Join(source, "main.go"), []byte("package main\n"), 0600); err != nil {
		t.Fatal(err)
	}
	destination := t.TempDir()
	if err := CopyProjectToTemp(context.Background(), source, destination, ProjectCopyLimits{MaxFiles: 1, MaxTotalBytes: 64, MaxPathBytes: 128}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(destination, "main.go")); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{".git", "node_modules", "target", ".venv"} {
		if _, err := os.Lstat(filepath.Join(destination, directory)); !os.IsNotExist(err) {
			t.Fatalf("ignored directory %s was copied: %v", directory, err)
		}
	}
}

func TestProjectCopyHonorsCancelledContext(t *testing.T) {
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "main.go"), []byte("package main\n"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	destination := t.TempDir()
	if err := CopyProjectToTemp(ctx, source, destination, ProjectCopyLimits{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled copy error=%v", err)
	}
	if _, err := os.Lstat(filepath.Join(destination, "main.go")); !os.IsNotExist(err) {
		t.Fatalf("cancelled copy wrote a file: %v", err)
	}
}

func TestProjectCopyRejectsDestinationInsideSource(t *testing.T) {
	source := t.TempDir()
	destination := filepath.Join(source, "nested", "copy")
	if err := CopyProjectToTemp(context.Background(), source, destination, ProjectCopyLimits{}); err == nil {
		t.Fatal("project copy accepted a destination inside its source")
	}
	if _, err := os.Lstat(destination); !os.IsNotExist(err) {
		t.Fatalf("rejected destination was created: %v", err)
	}
}

func TestPlanningSnapshotDoesNotUseArtifactOutputLimit(t *testing.T) {
	source := t.TempDir()
	for index := 0; index < 130; index++ {
		name := filepath.Join(source, fmt.Sprintf("source-%03d.go", index))
		if err := os.WriteFile(name, []byte("package demo\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	limits := ProjectCopyLimits{MaxFiles: 200, MaxTotalBytes: 1 << 20, MaxPathBytes: 256}
	destination := t.TempDir()
	if err := CopyProjectToTemp(context.Background(), source, destination, limits); err != nil {
		t.Fatal(err)
	}
	snapshot, err := SnapshotProjectFiles(context.Background(), destination, limits)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Files) != 130 || snapshot.Truncated || snapshot.LimitReached {
		t.Fatalf("planning snapshot=%+v", snapshot)
	}
}

func TestSyncGeneratedArtifactsUsesRegularHandlesAndAtomicDestination(t *testing.T) {
	temporary := t.TempDir()
	project := t.TempDir()
	outside := filepath.Join(t.TempDir(), "sentinel")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(temporary, "out"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(temporary, "out", "result.txt"), []byte("result"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(temporary, "leak.txt")); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(project, "out"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(project, "out", "result.txt")); err != nil {
		t.Fatal(err)
	}

	result, err := SyncGeneratedArtifactsWithLimits(context.Background(), temporary, project, nil, "", ArtifactLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result.Paths, []string{"out/result.txt"}) {
		t.Fatalf("changed artifacts=%v", result.Paths)
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "keep" {
		t.Fatalf("destination link target changed: data=%q err=%v", data, err)
	}
	if data, err := os.ReadFile(filepath.Join(project, "out", "result.txt")); err != nil || string(data) != "result" {
		t.Fatalf("artifact was not published: data=%q err=%v", data, err)
	}
	if _, err := os.Lstat(filepath.Join(project, "leak.txt")); !os.IsNotExist(err) {
		t.Fatalf("source link was published: %v", err)
	}
}

func TestSyncGeneratedArtifactsEnforcesAggregateLimits(t *testing.T) {
	temporary := t.TempDir()
	project := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(temporary, name), []byte("12"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	byCount, err := SyncGeneratedArtifactsWithLimits(context.Background(), temporary, project, nil, "", ArtifactLimits{MaxFiles: 1, MaxTotalBytes: 100})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(byCount.Paths, []string{"a.txt"}) || byCount.OmittedFiles != 2 || byCount.TotalBytes != 2 {
		t.Fatalf("count-limited result=%+v", byCount)
	}
	project = t.TempDir()
	byBytes, err := SyncGeneratedArtifactsWithLimits(context.Background(), temporary, project, nil, "", ArtifactLimits{MaxFiles: 10, MaxTotalBytes: 3})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(byBytes.Paths, []string{"a.txt"}) || byBytes.OmittedFiles != 2 || byBytes.TotalBytes != 2 {
		t.Fatalf("byte-limited result=%+v", byBytes)
	}
}

func TestSnapshotFilesAppliesBudgetsDuringTraversal(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt", "d.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("12"), 0600); err != nil {
			t.Fatal(err)
		}
	}

	byFiles, err := SnapshotFilesWithLimits(context.Background(), root, ArtifactLimits{
		MaxFiles: 2, MaxTotalBytes: 100, MaxScanEntries: 16,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(byFiles.Files) != 2 || !byFiles.LimitReached || byFiles.OmittedFiles != 2 {
		t.Fatalf("file-limited snapshot=%+v", byFiles)
	}

	byBytes, err := SnapshotFilesWithLimits(context.Background(), root, ArtifactLimits{
		MaxFiles: 10, MaxTotalBytes: 3, MaxScanEntries: 16,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(byBytes.Files) != 1 || byBytes.TotalBytes != 2 || !byBytes.LimitReached {
		t.Fatalf("byte-limited snapshot=%+v", byBytes)
	}

	byEntries, err := SnapshotFilesWithLimits(context.Background(), root, ArtifactLimits{
		MaxFiles: 10, MaxTotalBytes: 100, MaxScanEntries: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(byEntries.Files) > 2 || byEntries.ScannedEntries != 2 || !byEntries.Truncated {
		t.Fatalf("entry-limited snapshot=%+v", byEntries)
	}
}

func TestSnapshotFilesAppliesPathAndSingleFileLimits(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "large.txt"), []byte("1234"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "long-name.txt"), []byte("1"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := SnapshotFilesWithLimits(context.Background(), root, ArtifactLimits{
		MaxFiles: 10, MaxTotalBytes: 100, MaxFileBytes: 3, MaxPathBytes: 8, MaxScanEntries: 16,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Files) != 0 || result.OmittedFiles != 2 {
		t.Fatalf("path/file-limited snapshot=%+v", result)
	}
}

func TestSnapshotSkipsIgnoredDirectoryBeforeReadingItsChildren(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "node_modules"), 0755); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 32; index++ {
		name := filepath.Join(root, "node_modules", fmt.Sprintf("package-%02d.js", index))
		if err := os.WriteFile(name, []byte("dependency"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "main.js"), []byte("main"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := SnapshotFilesWithLimits(context.Background(), root, ArtifactLimits{
		MaxFiles: 4, MaxTotalBytes: 100, MaxScanEntries: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Truncated || result.ScannedEntries != 2 || len(result.Files) != 1 {
		t.Fatalf("ignored-directory snapshot=%+v", result)
	}
	if _, ok := result.Files["main.js"]; !ok {
		t.Fatalf("main.js missing from snapshot: %+v", result.Files)
	}
}

func TestArtifactSyncAndSendHonorCancelledContext(t *testing.T) {
	temporary := t.TempDir()
	project := t.TempDir()
	if err := os.WriteFile(filepath.Join(temporary, "result.txt"), []byte("result"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := SyncGeneratedArtifactsWithLimits(ctx, temporary, project, nil, "", ArtifactLimits{MaxFiles: 4, MaxTotalBytes: 64})
	if !errors.Is(err, context.Canceled) || len(result.Paths) != 0 {
		t.Fatalf("cancelled sync result=%+v err=%v", result, err)
	}
	if _, statErr := os.Lstat(filepath.Join(project, "result.txt")); !os.IsNotExist(statErr) {
		t.Fatalf("cancelled sync published an artifact: %v", statErr)
	}
	if err := SendArtifacts(ctx, nil, temporary, []string{"result.txt"}, 8); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled send error=%v", err)
	}
}
