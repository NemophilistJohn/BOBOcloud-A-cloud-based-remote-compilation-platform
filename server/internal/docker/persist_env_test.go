package docker

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestBuildPersistEnvDoesNotExposeImplicitUserCaches(t *testing.T) {
	environment := (&Pool{}).buildPersistEnv("openjdk:21-slim")
	if len(environment) != 0 {
		t.Fatalf("implicit user cache environment = %#v", environment)
	}
}

func TestUserVolumesRequireExplicitCacheV2Leases(t *testing.T) {
	dataDir := t.TempDir()
	pool := &Pool{userDataDir: dataDir}
	if volumes := pool.buildUserVolumes("alice", "python:3.11-slim"); len(volumes) != 0 {
		t.Fatalf("implicit volumes = %#v", volumes)
	}
}

func TestEnsureDockerBindDirectoryRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	realDirectory := filepath.Join(root, "real")
	if err := os.Mkdir(realDirectory, 0755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(realDirectory, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := ensureDockerBindDirectory(link); err == nil {
		t.Fatal("symlink bind source should be rejected")
	}
}

func TestCancelledExecTaintsContainer(t *testing.T) {
	pool := &Pool{taintedContainers: make(map[string]bool)}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, _, _ = pool.Exec(ctx, "container-a", []string{"true"}, "/")
	pool.mu.Lock()
	tainted := pool.taintedContainers["container-a"]
	pool.mu.Unlock()
	if !tainted {
		t.Fatal("a cancelled docker exec must prevent container reuse")
	}
}

func TestContainerRestartArgumentsForceImmediateProcessReset(t *testing.T) {
	want := []string{"restart", "-t", "0", "container-a"}
	got := containerRestartArguments("container-a")
	if len(got) != len(want) {
		t.Fatalf("restart args = %#v", got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("restart args = %#v", got)
		}
	}
}
