package lsp

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestBumpAnalysisDependencyGenerationChangesAtomically(t *testing.T) {
	root := t.TempDir()
	first, err := BumpAnalysisDependencyGeneration(root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := BumpAnalysisDependencyGeneration(root)
	if err != nil {
		t.Fatal(err)
	}
	if first == second || analysisDependencyGeneration(root) != second {
		t.Fatalf("generation first=%q second=%q stored=%q", first, second, analysisDependencyGeneration(root))
	}
	if info, err := os.Stat(filepath.Join(root, analysisDependencyGenerationFile)); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		t.Fatalf("generation marker permissions: info=%v err=%v", info, err)
	}
}

func TestBumpAnalysisDependencyGenerationRejectsSymlinkRoot(t *testing.T) {
	parent := t.TempDir()
	target := t.TempDir()
	link := filepath.Join(parent, "linked")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := BumpAnalysisDependencyGeneration(link); err == nil {
		t.Fatal("symlink dependency root was accepted")
	}
}

func TestDependencyRegistryRevisionUsesTrustedSnapshotGeneration(t *testing.T) {
	snapshotRoot := t.TempDir()
	packages := filepath.Join(snapshotRoot, "packages")
	if err := os.MkdirAll(packages, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packages, "package.json"), []byte(`{"name":"example"}`), 0644); err != nil {
		t.Fatal(err)
	}
	registry, err := NewDependencyRegistry(testDependencyAdapter{
		name:      "generation-test",
		languages: []string{"future"},
		result: DependencyAdapterResult{Mounts: []DependencyMountSpec{{
			Role: "future.packages", HostPath: packages, ContainerPath: AnalysisDependenciesRoot + "/future/packages",
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := AnalysisDependencyRequest{
		OwnerKind: "user", UserID: "user-a", RuntimeID: "local", LanguageID: "future", Generation: "runtime-generation",
		Paths: AnalysisDependencyPaths{SnapshotRoot: snapshotRoot, AllowedRoots: []string{snapshotRoot}},
	}
	firstGeneration, err := BumpAnalysisDependencyGeneration(snapshotRoot)
	if err != nil {
		t.Fatal(err)
	}
	first, err := registry.Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	secondGeneration, err := BumpAnalysisDependencyGeneration(snapshotRoot)
	if err != nil {
		t.Fatal(err)
	}
	second, err := registry.Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	if firstGeneration == secondGeneration {
		t.Fatal("generation marker did not change")
	}
	if first.Metadata.Generation != request.Generation || second.Metadata.Generation != request.Generation {
		t.Fatalf("request generation was replaced: first=%+v second=%+v", first.Metadata, second.Metadata)
	}
	if first.Metadata.SnapshotGeneration != firstGeneration || second.Metadata.SnapshotGeneration != secondGeneration {
		t.Fatalf("snapshot marker missing from metadata: first=%+v second=%+v", first.Metadata, second.Metadata)
	}
	if len(first.Metadata.Sources) != 1 || len(second.Metadata.Sources) != 1 || first.Metadata.Sources[0].Signature != second.Metadata.Sources[0].Signature {
		t.Fatalf("mounted directory sampling changed unexpectedly: first=%+v second=%+v", first.Metadata.Sources, second.Metadata.Sources)
	}
	if first.Revision == second.Revision {
		t.Fatal("snapshot generation marker did not change dependency revision")
	}
}

func TestDependencyRegistryRevisionUsesTrustedSharedGeneration(t *testing.T) {
	sharedRoot := t.TempDir()
	packages := filepath.Join(sharedRoot, "go", "pkg", "mod")
	if err := os.MkdirAll(packages, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packages, "module.info"), []byte("stable"), 0644); err != nil {
		t.Fatal(err)
	}
	registry, err := NewDependencyRegistry(testDependencyAdapter{
		name:      "shared-generation-test",
		languages: []string{"future"},
		result: DependencyAdapterResult{Mounts: []DependencyMountSpec{{
			Role: "future.shared", HostPath: packages, ContainerPath: AnalysisDependenciesRoot + "/future/packages",
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := AnalysisDependencyRequest{
		OwnerKind: "team", OwnerID: "team-a", UserID: "user-a", RuntimeID: "local", LanguageID: "future",
		Paths: AnalysisDependencyPaths{SharedCacheRoot: sharedRoot, AllowedRoots: []string{sharedRoot}},
	}
	firstGeneration, err := BumpAnalysisDependencyGeneration(sharedRoot)
	if err != nil {
		t.Fatal(err)
	}
	first, err := registry.Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	secondGeneration, err := BumpAnalysisDependencyGeneration(sharedRoot)
	if err != nil {
		t.Fatal(err)
	}
	second, err := registry.Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Metadata.SharedGeneration != firstGeneration || second.Metadata.SharedGeneration != secondGeneration {
		t.Fatalf("shared marker missing from metadata: first=%+v second=%+v", first.Metadata, second.Metadata)
	}
	if len(first.Metadata.Sources) != 1 || len(second.Metadata.Sources) != 1 || first.Metadata.Sources[0].Signature != second.Metadata.Sources[0].Signature {
		t.Fatalf("mounted child sampling changed unexpectedly: first=%+v second=%+v", first.Metadata.Sources, second.Metadata.Sources)
	}
	if first.Revision == second.Revision {
		t.Fatal("shared generation marker did not change dependency revision")
	}
}

func TestDependencyRegistryIgnoresUnusedSharedGeneration(t *testing.T) {
	sharedRoot := t.TempDir()
	snapshotRoot := t.TempDir()
	packages := filepath.Join(snapshotRoot, "packages")
	if err := os.MkdirAll(packages, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := BumpAnalysisDependencyGeneration(sharedRoot); err != nil {
		t.Fatal(err)
	}
	registry, err := NewDependencyRegistry(testDependencyAdapter{
		name:      "private-generation-test",
		languages: []string{"future"},
		result: DependencyAdapterResult{Mounts: []DependencyMountSpec{{
			Role: "future.private", HostPath: packages, ContainerPath: AnalysisDependenciesRoot + "/future/packages",
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	view, err := registry.Resolve(AnalysisDependencyRequest{
		OwnerKind: "team", OwnerID: "team-a", UserID: "user-a", RuntimeID: "local", LanguageID: "future",
		Paths: AnalysisDependencyPaths{
			SharedCacheRoot: sharedRoot,
			SnapshotRoot:    snapshotRoot,
			AllowedRoots:    []string{sharedRoot, snapshotRoot},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if view.Metadata.SharedGeneration != "" {
		t.Fatalf("unused shared cache marker affected dependency view: %+v", view.Metadata)
	}
}

func TestDependencyRegistryIgnoresUntrustedSnapshotGeneration(t *testing.T) {
	allowed := t.TempDir()
	snapshotRoot := t.TempDir()
	if _, err := BumpAnalysisDependencyGeneration(snapshotRoot); err != nil {
		t.Fatal(err)
	}
	registry, err := NewDependencyRegistry(testDependencyAdapter{name: "generation-test", languages: []string{"future"}})
	if err != nil {
		t.Fatal(err)
	}
	view, err := registry.Resolve(AnalysisDependencyRequest{
		OwnerKind: "user", UserID: "user-a", RuntimeID: "local", LanguageID: "future",
		Paths: AnalysisDependencyPaths{SnapshotRoot: snapshotRoot, AllowedRoots: []string{allowed}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if view.Metadata.SnapshotGeneration != "" {
		t.Fatalf("marker outside the server allowlist was trusted: %+v", view.Metadata)
	}
}

func TestAnalysisDependencyGenerationRejectsSymlinkMarker(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(t.TempDir(), "generation")
	if err := os.WriteFile(target, []byte("untrusted"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, analysisDependencyGenerationFile)); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if generation := analysisDependencyGeneration(root); generation != "" {
		t.Fatalf("symlink marker was trusted: %q", generation)
	}
}
