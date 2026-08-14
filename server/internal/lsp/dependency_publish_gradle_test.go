package lsp

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func gradleModulesFixture(t *testing.T, root, name, value string) string {
	t.Helper()
	modules := filepath.Join(root, name, "caches", "modules-2", "files-2.1", "example", "demo", "1.0")
	if err := os.MkdirAll(modules, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(modules, "demo.jar"), []byte(value), 0644); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(root, name, "caches", "modules-2")
}

func TestPublishGradleDependencySnapshotIsImmutableAndActivatesRollback(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "store")
	first, err := PublishGradleDependencySnapshot(base, "java:17", gradleModulesFixture(t, root, "a", "one"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := PublishGradleDependencySnapshot(base, "java:17", gradleModulesFixture(t, root, "b", "two"))
	if err != nil {
		t.Fatal(err)
	}
	if !first.Changed || !second.Changed || first.Revision == second.Revision {
		t.Fatalf("Gradle generations first=%+v second=%+v", first, second)
	}
	rolledBack, err := PublishGradleDependencySnapshot(base, "java:17", gradleModulesFixture(t, root, "a-again", "one"))
	if err != nil {
		t.Fatal(err)
	}
	if rolledBack.Revision != first.Revision || !rolledBack.Changed {
		t.Fatalf("Gradle rollback did not change active view: first=%+v rollback=%+v", first, rolledBack)
	}
	if current := currentGradleDependencySnapshot(base, "java:17"); current != filepath.Dir(rolledBack.Path) {
		t.Fatalf("current Gradle generation = %q, want %q", current, filepath.Dir(rolledBack.Path))
	}
	if data, err := os.ReadFile(filepath.Join(second.Path, "files-2.1", "example", "demo", "1.0", "demo.jar")); err != nil || string(data) != "two" {
		t.Fatalf("previous immutable generation changed: data=%q err=%v", data, err)
	}
}

func TestGradleDependencySnapshotLeaseBlocksQuotaEviction(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "store")
	policy := DependencySnapshotPolicy{MaxStoreBytes: 7 * NodeDependencyEntryChargeBytes, MaxAdditionalBytes: -1}
	first, err := PublishGradleDependencySnapshotWithPolicy(base, "java:17", gradleModulesFixture(t, root, "pinned", "one"), policy)
	if err != nil {
		t.Fatal(err)
	}
	release, err := acquireDependencySnapshotMounts(AnalysisDependencyView{Mounts: []AnalysisDependencyMount{{HostPath: first.Path, Managed: true}}})
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, err := PublishGradleDependencySnapshotWithPolicy(base, "java:21", gradleModulesFixture(t, root, "next", "two"), policy); !errors.Is(err, ErrDependencySnapshotStoreFull) {
		t.Fatalf("publish with pinned Gradle generation error = %v", err)
	}
	if _, err := os.Stat(first.Path); err != nil {
		t.Fatalf("pinned Gradle generation was removed: %v", err)
	}
}

func TestManagedSnapshotLocationAcceptsNodeAndGradleGenerations(t *testing.T) {
	root := t.TempDir()
	revision := "0123456789abcdef0123456789abcdef"
	for _, leaf := range []string{"node_modules", "modules-2"} {
		path := filepath.Join(root, "generations", revision, leaf)
		gotRoot, generation, ok := managedSnapshotLocation(path)
		if !ok || gotRoot != root || generation != filepath.Dir(path) {
			t.Fatalf("managed %s location root=%q generation=%q ok=%t", leaf, gotRoot, generation, ok)
		}
	}
}
