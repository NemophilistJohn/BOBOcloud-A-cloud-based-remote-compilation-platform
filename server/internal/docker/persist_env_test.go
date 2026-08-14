package docker

import (
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
		"python:3.10.14-slim":                 "/persist/pip-packages/runtimes/python-3.10",
		"registry.example/python:3.10-slim;bad": "/persist/pip-packages/runtimes/python-3.10",
		"python:3.10/unsafe":                  "",
		"python:latest":                       "",
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
