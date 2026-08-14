package buildcache

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type preparedResult struct {
	prepared *Prepared
	err      error
}

type sharedDependenciesResult struct {
	shared *SharedDependencies
	err    error
}

func TestPrepareSerializesSameNamespaceAndSeparatesBranches(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	base := BuildContext{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "docker-rust:1.90", Language: "rust"}
	first, err := m.Prepare(context.Background(), base)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := m.Prepare(ctx, base); err == nil {
		t.Fatal("same writable namespace should wait for the active build lease")
	}

	other := base
	other.Branch = "feature/cache"
	second, err := m.Prepare(context.Background(), other)
	if err != nil {
		t.Fatalf("different branch should compile in parallel: %v", err)
	}
	second.Release()

	if first.TargetHost == second.TargetHost {
		t.Fatal("branch targets must be isolated")
	}
	if first.SharedHost != second.SharedHost {
		t.Fatal("dependency cache should be shared by runtime")
	}
	if first.DockerMounts[first.SharedHost] != "/team-cache/shared" {
		t.Fatal("missing stable Docker shared mount")
	}
}

func TestInspectReturnsEmptyNamespaceArray(t *testing.T) {
	info := NewManager(t.TempDir(), 64).Inspect("empty-team", 64)
	if info.Namespaces == nil || len(info.Namespaces) != 0 {
		t.Fatalf("empty cache namespaces must serialize as []: %+v", info.Namespaces)
	}
	if info.Dependencies == nil || len(info.Dependencies) != 0 {
		t.Fatalf("empty dependency namespaces must serialize as []: %+v", info.Dependencies)
	}
}

func TestInspectAndManualClearProtectActiveNamespace(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	prepared, err := m.Prepare(context.Background(), BuildContext{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "local", Language: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prepared.TargetHost, "artifact.bin"), make([]byte, 4096), 0644); err != nil {
		t.Fatal(err)
	}

	info := m.Inspect("team-a", 64)
	if len(info.Namespaces) != 1 || info.TargetBytes < 4096 {
		t.Fatalf("unexpected cache info: %+v", info)
	}
	if err := m.Clear("team-a", "namespace", "", prepared.Key); err == nil {
		t.Fatal("active cache must not be deleted")
	}

	prepared.Release()
	if err := m.Clear("team-a", "namespace", "", prepared.Key); err != nil {
		t.Fatal(err)
	}
	if got := m.Inspect("team-a", 64); len(got.Namespaces) != 0 {
		t.Fatalf("namespace was not cleared: %+v", got.Namespaces)
	}
}

func TestRetentionAndScratchCleanupPreserveActiveBuilds(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	buildContext := BuildContext{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "local", Language: "rust"}
	prepared, err := m.Prepare(context.Background(), buildContext)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prepared.Buildspace, "source.rs"), []byte("fn main() {}"), 0644); err != nil {
		t.Fatal(err)
	}
	m.CleanScratch("team-a")
	if _, err := os.Stat(prepared.Buildspace); err != nil {
		t.Fatalf("active buildspace was removed: %v", err)
	}
	prepared.Release()
	old := namespaceMeta{TeamID: buildContext.TeamID, ProjectID: buildContext.ProjectID, Branch: buildContext.Branch, Runtime: buildContext.Runtime, Language: buildContext.Language, LastUsed: time.Now().UTC().Add(-48 * time.Hour)}
	writeMeta(prepared.TargetHost, old)
	m.CleanScratch("team-a")
	if _, err := os.Stat(prepared.Buildspace); !os.IsNotExist(err) {
		t.Fatalf("inactive scratch was not removed: %v", err)
	}
	info := m.PruneExpired("team-a", 1, 64)
	if len(info.Namespaces) != 0 {
		t.Fatalf("expired namespace was not removed: %+v", info.Namespaces)
	}
}

func TestContainerKeyChangesAfterManualCacheDeletion(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	buildContext := BuildContext{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "docker-c:13", Language: "c"}
	first, err := m.Prepare(context.Background(), buildContext)
	if err != nil {
		t.Fatal(err)
	}
	firstKey := first.ContainerKey
	first.Release()
	if firstKey == "" {
		t.Fatal("container cache key was not generated")
	}
	if err := m.Clear("team-a", "namespace", "", first.Key); err != nil {
		t.Fatal(err)
	}

	second, err := m.Prepare(context.Background(), buildContext)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Release()
	if second.ContainerKey == firstKey {
		t.Fatal("container with a stale bind mount could be reused after cache deletion")
	}
}

func TestSharedDependenciesAreNonExclusiveAndProtectedFromClear(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	ctx := BuildContext{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "docker-rust:1.82", Language: "rust"}
	first, err := m.SharedDependencies(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	second, err := m.SharedDependencies(ctx)
	if err != nil {
		t.Fatalf("second shared lease blocked: %v", err)
	}
	defer second.Release()
	if first.SharedHost != second.SharedHost || first.ContainerKey != second.ContainerKey {
		t.Fatal("same runtime did not reuse shared dependency mount")
	}
	if first.LocalEnv["CARGO_HOME"] == "" || first.DockerMounts[first.SharedHost] != "/team-cache/shared" {
		t.Fatalf("shared dependency environment is incomplete: %+v", first)
	}
	if first.LocalEnv["GRADLE_USER_HOME"] != filepath.ToSlash(filepath.Join(first.SharedHost, "gradle")) || first.DockerEnv["GRADLE_USER_HOME"] != "/team-cache/shared/gradle" {
		t.Fatalf("Gradle dependency producer is not runtime-scoped: local=%q docker=%q", first.LocalEnv["GRADLE_USER_HOME"], first.DockerEnv["GRADLE_USER_HOME"])
	}

	// A shared dependency reference is not the exclusive compiler target lock.
	build, err := m.Prepare(context.Background(), ctx)
	if err != nil {
		t.Fatalf("shared LSP lease blocked a build: %v", err)
	}
	build.Release()
	if err := m.Clear("team-a", "shared", "", ""); err == nil {
		t.Fatal("active shared dependency mount was deleted")
	}
	first.Release()
	second.Release()
	if err := m.Clear("team-a", "shared", "", ""); err != nil {
		t.Fatalf("released shared dependency cache could not be cleared: %v", err)
	}
}

func TestProjectDependencyRootsAreIsolatedAndServerOnly(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	base := BuildContext{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "python:3.10", Language: "python"}
	lease, err := m.SharedDependencies(base)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	expected := filepath.Join(
		m.root, safePart(base.TeamID), "projects", safePart(base.ProjectID), "dependencies",
		safePart(base.Runtime), safePart(base.Language), safePart(base.Branch),
	)
	if lease.DependencyHost != expected {
		t.Fatalf("dependency root = %q, want %q", lease.DependencyHost, expected)
	}
	if _, mounted := lease.DockerMounts[lease.DependencyHost]; mounted {
		t.Fatal("server-side project dependencies were exposed to the LSP container")
	}
	if info, statErr := os.Stat(lease.DependencyHost); statErr != nil {
		t.Fatal(statErr)
	} else if os.PathSeparator == '/' && info.Mode().Perm() != 0700 {
		t.Fatalf("dependency root permissions = %o, want 700", info.Mode().Perm())
	}

	prepared, err := m.Prepare(context.Background(), base)
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.Release()
	if prepared.DependencyHost != lease.DependencyHost {
		t.Fatalf("prepare and analysis dependency roots differ: %q != %q", prepared.DependencyHost, lease.DependencyHost)
	}
	if _, mounted := prepared.DockerMounts[prepared.DependencyHost]; mounted {
		t.Fatal("server-side project dependencies were exposed to the build container")
	}
	for _, value := range prepared.LocalEnv {
		if strings.Contains(value, prepared.DependencyHost) {
			t.Fatal("server-side project dependencies leaked into the local build environment")
		}
	}

	contexts := []BuildContext{
		{TeamID: "team-a", ProjectID: "project-b", Branch: "main", Runtime: "python:3.10", Language: "python"},
		{TeamID: "team-a", ProjectID: "project-a", Branch: "feature", Runtime: "python:3.10", Language: "python"},
		{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "python:3.9", Language: "python"},
		{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "python:3.10", Language: "javascript"},
	}
	seen := map[string]bool{lease.DependencyHost: true}
	for _, buildContext := range contexts {
		other, acquireErr := m.SharedDependencies(buildContext)
		if acquireErr != nil {
			t.Fatal(acquireErr)
		}
		if other.DependencyHost == "" || seen[other.DependencyHost] {
			other.Release()
			t.Fatalf("dependency root was not isolated for %+v: %q", buildContext, other.DependencyHost)
		}
		seen[other.DependencyHost] = true
		other.Release()
	}
	partial, err := m.SharedDependencies(BuildContext{TeamID: "team-a", Runtime: "python:3.10"})
	if err != nil {
		t.Fatal(err)
	}
	defer partial.Release()
	if partial.DependencyHost != "" {
		t.Fatalf("incomplete build context created project dependencies: %q", partial.DependencyHost)
	}
}

func TestSharedDependencyLeaseSupportsPartialReleaseAndScopedClear(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	buildContext := BuildContext{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "python:3.10", Language: "python"}
	lease, err := m.SharedDependencies(buildContext)
	if err != nil {
		t.Fatal(err)
	}
	dependencyHost := lease.DependencyHost
	lease.ReleaseSharedCache()
	lease.ReleaseSharedCache()
	if err := m.Clear(buildContext.TeamID, "shared", "", ""); err != nil {
		t.Fatalf("project dependency lease incorrectly blocked shared clear: %v", err)
	}
	if _, err := os.Stat(dependencyHost); err != nil {
		t.Fatalf("shared clear removed project dependencies: %v", err)
	}
	if err := m.Clear(buildContext.TeamID, "project", buildContext.ProjectID, ""); err == nil {
		t.Fatal("active project dependency lease did not block project clear")
	}
	if err := m.Clear(buildContext.TeamID, "all", "", ""); err == nil {
		t.Fatal("active project dependency lease did not block team clear")
	}
	info := m.Inspect(buildContext.TeamID, 64)
	if len(info.Dependencies) != 1 || !info.Dependencies[0].Active {
		t.Fatalf("dependency lease was not reported active: %+v", info.Dependencies)
	}

	lease.ReleaseProjectDependencies()
	lease.ReleaseProjectDependencies()
	lease.Release()
	info = m.Inspect(buildContext.TeamID, 64)
	if len(info.Dependencies) != 1 || info.Dependencies[0].Active {
		t.Fatalf("dependency lease remained active after idempotent release: %+v", info.Dependencies)
	}
	if err := m.Clear(buildContext.TeamID, "project", buildContext.ProjectID, ""); err != nil {
		t.Fatalf("released project cache could not be cleared: %v", err)
	}
	if _, err := os.Stat(filepath.Join(m.root, safePart(buildContext.TeamID), "projects", safePart(buildContext.ProjectID))); !os.IsNotExist(err) {
		t.Fatalf("project clear did not remove the complete project cache: %v", err)
	}
}

func TestClearSerializesPrepareLifecyclePerTeam(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	buildContext := BuildContext{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "docker-rust:1.90", Language: "rust"}
	seed, err := m.Prepare(context.Background(), buildContext)
	if err != nil {
		t.Fatal(err)
	}
	target := seed.TargetHost
	namespaceKey := seed.Key
	seed.Release()

	deleteEntered := make(chan struct{})
	allowDelete := make(chan struct{})
	var enterOnce sync.Once
	var allowOnce sync.Once
	unblockDelete := func() { allowOnce.Do(func() { close(allowDelete) }) }
	defer unblockDelete()
	m.removeAll = func(path string) error {
		if filepath.Clean(path) == filepath.Clean(target) {
			enterOnce.Do(func() {
				close(deleteEntered)
				<-allowDelete
			})
		}
		return os.RemoveAll(path)
	}

	clearDone := make(chan error, 1)
	go func() { clearDone <- m.Clear(buildContext.TeamID, "namespace", "", namespaceKey) }()
	select {
	case <-deleteEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("namespace clear did not reach the controlled delete")
	}
	teamGate := m.ownerGate(safePart(buildContext.TeamID))
	if teamGate.TryLock() {
		teamGate.Unlock()
		t.Fatal("namespace delete did not hold the team lifecycle gate")
	}

	sameStarted := make(chan struct{})
	sameTeam := make(chan preparedResult, 1)
	go func() {
		close(sameStarted)
		prepared, prepareErr := m.Prepare(context.Background(), buildContext)
		sameTeam <- preparedResult{prepared: prepared, err: prepareErr}
	}()
	<-sameStarted

	otherContext := buildContext
	otherContext.TeamID = "team-b"
	otherTeam := make(chan preparedResult, 1)
	go func() {
		prepared, prepareErr := m.Prepare(context.Background(), otherContext)
		otherTeam <- preparedResult{prepared: prepared, err: prepareErr}
	}()
	select {
	case result := <-otherTeam:
		if result.err != nil {
			t.Fatalf("another team was blocked by team-a cleanup: %v", result.err)
		}
		result.prepared.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("another team was blocked by team-a lifecycle gate")
	}
	select {
	case result := <-sameTeam:
		unblockDelete()
		if result.prepared != nil {
			result.prepared.Release()
		}
		t.Fatal("same-team prepare completed while namespace deletion was in progress")
	default:
	}

	unblockDelete()
	select {
	case clearErr := <-clearDone:
		if clearErr != nil {
			t.Fatalf("namespace clear failed: %v", clearErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("namespace clear did not finish")
	}
	select {
	case result := <-sameTeam:
		if result.err != nil {
			t.Fatalf("same-team prepare did not recover after clear: %v", result.err)
		}
		defer result.prepared.Release()
		if _, statErr := os.Stat(result.prepared.TargetHost); statErr != nil {
			t.Fatalf("prepare did not recreate the cleared namespace: %v", statErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("same-team prepare remained blocked after clear")
	}
}

func TestClearSerializesSharedDependencyLifecycle(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	buildContext := BuildContext{TeamID: "team-a", Runtime: "python:3.10"}
	seed, err := m.SharedDependencies(buildContext)
	if err != nil {
		t.Fatal(err)
	}
	sharedRoot := filepath.Dir(seed.SharedHost)
	seed.Release()

	deleteEntered := make(chan struct{})
	allowDelete := make(chan struct{})
	var enterOnce sync.Once
	var allowOnce sync.Once
	unblockDelete := func() { allowOnce.Do(func() { close(allowDelete) }) }
	defer unblockDelete()
	m.removeAll = func(path string) error {
		if filepath.Clean(path) == filepath.Clean(sharedRoot) {
			enterOnce.Do(func() {
				close(deleteEntered)
				<-allowDelete
			})
		}
		return os.RemoveAll(path)
	}

	clearDone := make(chan error, 1)
	go func() { clearDone <- m.Clear(buildContext.TeamID, "shared", "", "") }()
	select {
	case <-deleteEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("shared clear did not reach the controlled delete")
	}

	acquireStarted := make(chan struct{})
	acquireDone := make(chan sharedDependenciesResult, 1)
	go func() {
		close(acquireStarted)
		shared, acquireErr := m.SharedDependencies(buildContext)
		acquireDone <- sharedDependenciesResult{shared: shared, err: acquireErr}
	}()
	<-acquireStarted
	otherTeam := make(chan sharedDependenciesResult, 1)
	go func() {
		shared, acquireErr := m.SharedDependencies(BuildContext{TeamID: "team-b", Runtime: buildContext.Runtime})
		otherTeam <- sharedDependenciesResult{shared: shared, err: acquireErr}
	}()
	select {
	case result := <-otherTeam:
		if result.err != nil {
			t.Fatalf("another team's shared dependency lease was blocked: %v", result.err)
		}
		result.shared.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("another team's shared dependency lease was blocked by team-a cleanup")
	}
	select {
	case result := <-acquireDone:
		unblockDelete()
		if result.shared != nil {
			result.shared.Release()
		}
		t.Fatal("shared dependency lease completed during shared deletion")
	default:
	}

	unblockDelete()
	select {
	case clearErr := <-clearDone:
		if clearErr != nil {
			t.Fatalf("shared clear failed: %v", clearErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shared clear did not finish")
	}
	select {
	case result := <-acquireDone:
		if result.err != nil {
			t.Fatalf("shared dependency lease did not recover after clear: %v", result.err)
		}
		defer result.shared.Release()
		if _, statErr := os.Stat(result.shared.SharedHost); statErr != nil {
			t.Fatalf("shared dependency lease did not recreate its runtime: %v", statErr)
		}
		if clearErr := m.Clear(buildContext.TeamID, "shared", "", ""); clearErr == nil {
			t.Fatal("new shared dependency reference was not registered after recreation")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shared dependency lease remained blocked after clear")
	}
}

func TestEnforceEvictsOnlyInactiveSharedRuntime(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	activeBuild, err := m.Prepare(context.Background(), BuildContext{
		TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "python:3.10", Language: "python",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer activeBuild.Release()
	if err := os.WriteFile(filepath.Join(activeBuild.SharedHost, "active-runtime.bin"), make([]byte, 1_100_000), 0644); err != nil {
		t.Fatal(err)
	}

	inactiveRuntime, err := m.SharedDependencies(BuildContext{TeamID: "team-a", Runtime: "python:3.9"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inactiveRuntime.SharedHost, "inactive-runtime.bin"), make([]byte, 1_100_000), 0644); err != nil {
		t.Fatal(err)
	}
	inactivePath := inactiveRuntime.SharedHost
	inactiveRuntime.Release()

	m.Enforce("team-a", 1)
	if _, statErr := os.Stat(activeBuild.SharedHost); statErr != nil {
		t.Fatalf("active runtime shared cache was evicted: %v", statErr)
	}
	if _, statErr := os.Stat(inactivePath); !os.IsNotExist(statErr) {
		t.Fatalf("inactive runtime shared cache was not evicted: %v", statErr)
	}
}

func TestPreparedBuildProtectsProjectDependencies(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	buildContext := BuildContext{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "python:3.10", Language: "python"}
	prepared, err := m.Prepare(context.Background(), buildContext)
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.Release()
	if err := os.WriteFile(filepath.Join(prepared.DependencyHost, "active-dependencies.bin"), make([]byte, 1_100_000), 0600); err != nil {
		t.Fatal(err)
	}
	info := m.Inspect(buildContext.TeamID, 1)
	if len(info.Dependencies) != 1 || !info.Dependencies[0].Active {
		t.Fatalf("build lease did not mark project dependencies active: %+v", info.Dependencies)
	}
	m.Enforce(buildContext.TeamID, 1)
	if _, err := os.Stat(prepared.DependencyHost); err != nil {
		t.Fatalf("quota enforcement removed dependencies used by a build: %v", err)
	}
}

func TestEnforceEvictsProjectDependenciesByLRU(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	oldContext := BuildContext{TeamID: "team-a", ProjectID: "project-a", Branch: "old", Runtime: "python:3.10", Language: "python"}
	newContext := oldContext
	newContext.Branch = "new"
	oldPrepared, err := m.Prepare(context.Background(), oldContext)
	if err != nil {
		t.Fatal(err)
	}
	oldPath := oldPrepared.DependencyHost
	oldPrepared.Release()
	newPrepared, err := m.Prepare(context.Background(), newContext)
	if err != nil {
		t.Fatal(err)
	}
	newPath := newPrepared.DependencyHost
	newPrepared.Release()
	if err := os.WriteFile(filepath.Join(oldPath, "old-dependencies.bin"), make([]byte, 800_000), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(newPath, "new-dependencies.bin"), make([]byte, 800_000), 0600); err != nil {
		t.Fatal(err)
	}
	oldMeta := namespaceMeta{
		TeamID: oldContext.TeamID, ProjectID: oldContext.ProjectID, Branch: oldContext.Branch,
		Runtime: oldContext.Runtime, Language: oldContext.Language, LastUsed: time.Now().UTC().Add(-2 * time.Hour),
	}
	newMeta := namespaceMeta{
		TeamID: newContext.TeamID, ProjectID: newContext.ProjectID, Branch: newContext.Branch,
		Runtime: newContext.Runtime, Language: newContext.Language, LastUsed: time.Now().UTC().Add(-time.Hour),
	}
	writePrivateMeta(oldPath, oldMeta)
	writePrivateMeta(newPath, newMeta)

	before := m.Inspect(oldContext.TeamID, 1)
	if len(before.Dependencies) != 2 || before.DependencyBytes < 1_600_000 {
		t.Fatalf("dependency namespaces were not inspected: %+v", before)
	}
	if before.TotalBytes != before.SharedBytes+before.TargetBytes+before.DependencyBytes+before.ScratchBytes {
		t.Fatalf("dependency bytes were not included in total: %+v", before)
	}
	after := m.Enforce(oldContext.TeamID, 1)
	if _, statErr := os.Stat(oldPath); !os.IsNotExist(statErr) {
		t.Fatalf("old dependency namespace was not evicted: %v", statErr)
	}
	if _, statErr := os.Stat(newPath); statErr != nil {
		t.Fatalf("new dependency namespace was evicted before the older namespace: %v", statErr)
	}
	if len(after.Dependencies) != 1 || after.Dependencies[0].Branch != newContext.Branch {
		t.Fatalf("unexpected dependency LRU result: %+v", after.Dependencies)
	}
}

func TestLRUDeletionRejectsCacheReusedAfterSnapshot(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	buildContext := BuildContext{TeamID: "team-a", ProjectID: "project-a", Branch: "main", Runtime: "python:3.10", Language: "python"}
	seed, err := m.Prepare(context.Background(), buildContext)
	if err != nil {
		t.Fatal(err)
	}
	targetPath := seed.TargetHost
	dependencyPath := seed.DependencyHost
	seed.Release()
	old := namespaceMeta{
		TeamID: buildContext.TeamID, ProjectID: buildContext.ProjectID, Branch: buildContext.Branch,
		Runtime: buildContext.Runtime, Language: buildContext.Language, LastUsed: time.Now().UTC().Add(-time.Hour),
	}
	writeMeta(targetPath, old)
	writePrivateMeta(dependencyPath, old)
	cacheSnapshot := m.Inspect(buildContext.TeamID, 64)
	targetSnapshot := cacheSnapshot.Namespaces[0]
	dependencySnapshot := cacheSnapshot.Dependencies[0]
	reused, err := m.Prepare(context.Background(), buildContext)
	if err != nil {
		t.Fatal(err)
	}
	reused.Release()
	teamPart := safePart(buildContext.TeamID)
	teamRoot := filepath.Join(m.root, teamPart)
	if m.removeInactiveLRUNamespace(teamPart, teamRoot, targetSnapshot.Key, targetPath, targetSnapshot.LastUsed, targetSnapshot.generation) {
		t.Fatal("target reused after the LRU snapshot was deleted")
	}
	if _, err := os.Stat(targetPath); err != nil {
		t.Fatalf("reused target cache is missing: %v", err)
	}
	if m.removeInactiveLRUDependencyNamespace(teamPart, teamRoot, dependencySnapshot.Key, dependencyPath, dependencySnapshot.LastUsed, dependencySnapshot.generation) {
		t.Fatal("project dependencies reused after the LRU snapshot were deleted")
	}
	if _, err := os.Stat(dependencyPath); err != nil {
		t.Fatalf("reused project dependency cache is missing: %v", err)
	}

	sharedContext := BuildContext{TeamID: buildContext.TeamID, Runtime: "python:3.9"}
	shared, err := m.SharedDependencies(sharedContext)
	if err != nil {
		t.Fatal(err)
	}
	sharedPath := shared.SharedHost
	shared.Release()
	runtimePart := safePart(sharedContext.Runtime)
	expectedEpoch := m.runtimeEpochValue(teamPart, runtimePart)
	expectedGeneration, err := readMountGeneration(sharedPath)
	if err != nil {
		t.Fatal(err)
	}
	shared, err = m.SharedDependencies(sharedContext)
	if err != nil {
		t.Fatal(err)
	}
	shared.Release()
	if m.removeInactiveSharedRuntime(teamPart, teamRoot, runtimePart, sharedPath, expectedGeneration, expectedEpoch) {
		t.Fatal("shared runtime reused after the LRU snapshot was deleted")
	}
	if _, err := os.Stat(sharedPath); err != nil {
		t.Fatalf("reused shared runtime cache is missing: %v", err)
	}
}

func TestWithQuotaGuardSerializesSameTeamAndIsolatesTeams(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	enteredA := make(chan struct{})
	releaseA := make(chan struct{})
	doneA := make(chan error, 1)
	go func() {
		doneA <- m.WithQuotaGuard("team-a", 64, func(Info) error {
			close(enteredA)
			<-releaseA
			return nil
		})
	}()
	<-enteredA

	enteredSecondA := make(chan struct{})
	doneSecondA := make(chan error, 1)
	go func() {
		doneSecondA <- m.WithQuotaGuard("team-a", 64, func(Info) error {
			close(enteredSecondA)
			return nil
		})
	}()
	select {
	case <-enteredSecondA:
		t.Fatal("same-team quota mutation was not serialized")
	case <-time.After(40 * time.Millisecond):
	}

	enteredB := make(chan struct{})
	doneB := make(chan error, 1)
	go func() {
		doneB <- m.WithQuotaGuard("team-b", 64, func(Info) error {
			close(enteredB)
			return nil
		})
	}()
	select {
	case <-enteredB:
	case <-time.After(time.Second):
		t.Fatal("different-team quota mutation was blocked")
	}
	if err := <-doneB; err != nil {
		t.Fatal(err)
	}
	close(releaseA)
	if err := <-doneA; err != nil {
		t.Fatal(err)
	}
	select {
	case <-enteredSecondA:
	case <-time.After(time.Second):
		t.Fatal("queued same-team quota mutation did not resume")
	}
	if err := <-doneSecondA; err != nil {
		t.Fatal(err)
	}
}

func TestDirSizeChargesEmptyEntries(t *testing.T) {
	root := t.TempDir()
	for index := 0; index < 64; index++ {
		name := filepath.Join(root, fmt.Sprintf("empty-%03d", index))
		if err := os.WriteFile(name, nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	minimum := int64(65) * cacheEntryChargeBytes
	if got := dirSize(root); got < minimum {
		t.Fatalf("empty entries were not charged: got %d, want at least %d", got, minimum)
	}
}

func TestInspectRepairsCorruptNamespaceMetadataAndEnforceDeletesIt(t *testing.T) {
	m := NewManager(t.TempDir(), 1)
	ctx := BuildContext{TeamID: "team-corrupt", ProjectID: "project-a", Branch: "main", Runtime: "docker-go:1.23", Language: "go"}
	prepared, err := m.Prepare(context.Background(), ctx)
	if err != nil {
		t.Fatal(err)
	}
	target := prepared.TargetHost
	expectedKey := prepared.Key
	if err := os.WriteFile(filepath.Join(target, "large.bin"), make([]byte, 1_200_000), 0600); err != nil {
		t.Fatal(err)
	}
	prepared.Release()
	if err := os.WriteFile(filepath.Join(target, ".cache-meta.json"), []byte("not-json"), 0600); err != nil {
		t.Fatal(err)
	}

	info := m.Inspect(ctx.TeamID, 1)
	if len(info.Namespaces) != 1 || info.Namespaces[0].Key != expectedKey {
		t.Fatalf("corrupt namespace disappeared from inspection: %+v", info.Namespaces)
	}
	if info.Namespaces[0].LastUsed.IsZero() || info.TargetBytes < 1_200_000 {
		t.Fatalf("corrupt namespace was not conservatively accounted: %+v", info)
	}
	m.Enforce(ctx.TeamID, 1)
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("inactive repaired namespace was not evicted: %v", err)
	}
}

func TestPrepareReplacesCorruptMountGeneration(t *testing.T) {
	m := NewManager(t.TempDir(), 64)
	ctx := BuildContext{TeamID: "team-generation", ProjectID: "project-a", Branch: "main", Runtime: "docker-python:3.10", Language: "python"}
	prepared, err := m.Prepare(context.Background(), ctx)
	if err != nil {
		t.Fatal(err)
	}
	shared := prepared.SharedHost
	prepared.Release()
	marker := filepath.Join(shared, mountGenerationFile)
	if err := os.WriteFile(marker, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	reprepared, err := m.Prepare(context.Background(), ctx)
	if err != nil {
		t.Fatalf("corrupt generation marker prevented recovery: %v", err)
	}
	defer reprepared.Release()
	value, err := readMountGeneration(shared)
	if err != nil || len(value) != 32 {
		t.Fatalf("generation marker was not safely rebuilt: %q, %v", value, err)
	}
	if info, err := os.Lstat(marker); err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("generation marker remained a symlink: %v, %v", info, err)
	}
}
