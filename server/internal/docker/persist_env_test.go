package docker

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestBuildPersistEnvSeedsPersistentDependencyStores(t *testing.T) {
	environment := (&Pool{}).buildPersistEnv("openjdk:21-slim")
	if environment["PIP_TARGET"] != "/persist/pip-packages" {
		t.Fatalf("PIP_TARGET = %q", environment["PIP_TARGET"])
	}
	if environment["GRADLE_USER_HOME"] != "/persist/gradle" {
		t.Fatalf("GRADLE_USER_HOME = %q", environment["GRADLE_USER_HOME"])
	}
	if environment["MAVEN_OPTS"] != "-Dmaven.repo.local=/persist/maven" {
		t.Fatalf("MAVEN_OPTS = %q", environment["MAVEN_OPTS"])
	}
}

func TestBuildPersistEnvUsesRuntimeScopedPythonTarget(t *testing.T) {
	environment := (&Pool{}).buildPersistEnv("python:3.10-slim")
	want := "/persist/pip-packages/runtimes/python-3.10"
	if environment["PIP_TARGET"] != want {
		t.Fatalf("PIP_TARGET = %q, want %q", environment["PIP_TARGET"], want)
	}
	if environment["PYTHONPATH"] != want {
		t.Fatalf("PYTHONPATH = %q, want %q", environment["PYTHONPATH"], want)
	}
}

func TestPythonRuntimePackageTargetNeverUsesRawImageText(t *testing.T) {
	for image, want := range map[string]string{
		"python:3.10.14-slim":                   "/persist/pip-packages/runtimes/python-3.10",
		"registry.example/python:3.10-slim;bad": "/persist/pip-packages/runtimes/python-3.10",
		"python:3.10/unsafe":                    "",
		"python:latest":                         "",
	} {
		if got := pythonRuntimePackageTarget(image); got != want {
			t.Errorf("pythonRuntimePackageTarget(%q) = %q, want %q", image, got, want)
		}
	}
}

func TestBuildPersistEnvUsesLegacyPythonPathOnlyAsFallback(t *testing.T) {
	dataDir := t.TempDir()
	pool := &Pool{userDataDir: dataDir}
	legacy := filepath.Join(dataDir, "alice", "persist", "pip-packages")
	if err := os.MkdirAll(legacy, 0755); err != nil {
		t.Fatal(err)
	}

	environment := pool.buildPersistEnvForUser("alice", "python:3.10-slim")
	if environment["PIP_TARGET"] != "/persist/pip-packages/runtimes/python-3.10" {
		t.Fatalf("PIP_TARGET = %q", environment["PIP_TARGET"])
	}
	if environment["PYTHONPATH"] != "/persist/pip-packages" {
		t.Fatalf("PYTHONPATH = %q, want legacy fallback", environment["PYTHONPATH"])
	}

	runtimeRoot := filepath.Join(legacy, "runtimes", "python-3.10")
	if err := os.MkdirAll(runtimeRoot, 0755); err != nil {
		t.Fatal(err)
	}
	environment = pool.buildPersistEnvForUser("alice", "python:3.10-slim")
	if environment["PYTHONPATH"] != "/persist/pip-packages/runtimes/python-3.10" {
		t.Fatalf("PYTHONPATH = %q, want runtime-scoped path", environment["PYTHONPATH"])
	}
}

func TestProjectLockVolumesHideManagedDependencyTree(t *testing.T) {
	dataDir := t.TempDir()
	pool := &Pool{userDataDir: dataDir, personalDependencyScope: "project-lock"}
	volumes := pool.buildUserVolumes("alice", "python:3.11-slim")
	persistRoot := filepath.Join(dataDir, "alice", "persist")
	if _, exposed := volumes[persistRoot]; exposed {
		t.Fatal("project-lock container must not receive the complete persist tree")
	}
	if len(volumes) != len(projectLockSharedCacheDirectories) {
		t.Fatalf("volume count = %d, want %d", len(volumes), len(projectLockSharedCacheDirectories))
	}
	for _, directory := range projectLockSharedCacheDirectories {
		host := filepath.Join(persistRoot, directory)
		if got := volumes[host]; got != "/persist/"+directory {
			t.Errorf("volume %q = %q", host, got)
		}
	}
	for host := range volumes {
		if filepath.Base(host) == "project-dependencies" {
			t.Fatalf("managed dependency tree exposed as %q", host)
		}
	}
}

func TestLegacyVolumesKeepCompletePersistTree(t *testing.T) {
	dataDir := t.TempDir()
	pool := &Pool{userDataDir: dataDir, personalDependencyScope: "legacy-user"}
	persistRoot := filepath.Join(dataDir, "alice", "persist")
	volumes := pool.buildUserVolumes("alice", "python:3.11-slim")
	if len(volumes) != 1 || volumes[persistRoot] != "/persist" {
		t.Fatalf("legacy volumes = %#v", volumes)
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
