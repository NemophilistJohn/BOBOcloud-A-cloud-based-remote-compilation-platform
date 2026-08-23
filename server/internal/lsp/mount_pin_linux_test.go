//go:build linux

package lsp

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPinnedDependencyMountSurvivesPathReplacement(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "packages")
	if err := os.Mkdir(source, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "sentinel"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	mountRoot := filepath.Join(root, "mounts")
	mounts, release, err := pinDockerDependencyMounts(mountRoot, "test-session", []AnalysisDependencyMount{{
		Role: DependencyRolePythonPackages, HostPath: source,
		ContainerPath: pythonRuntimePackagesContainer, ReadOnly: true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 1 || !mounts[0].Pinned {
		t.Fatalf("unexpected pinned mounts: %#v", mounts)
	}
	anchor := mounts[0].HostPath
	if _, err := validateDockerMountSource(anchor); err != nil {
		t.Fatalf("validate pinned source: %v", err)
	}

	moved := filepath.Join(root, "packages-original")
	if err := os.Rename(source, moved); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "outside")
	if err := os.Mkdir(outside, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "sentinel"), []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, source); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(anchor, "sentinel"))
	if err != nil {
		t.Fatalf("read through pinned source: %v", err)
	}
	if string(data) != "original" {
		t.Fatalf("pinned source followed replacement: %q", data)
	}

	release()
	if _, err := os.Stat(anchor); !os.IsNotExist(err) {
		t.Fatalf("mount anchor remained after release: %v", err)
	}
}

func TestPinnedDependencyMountIsAcceptedByDocker(t *testing.T) {
	image := strings.TrimSpace(os.Getenv("BOBO_LSP_TEST_IMAGE"))
	if image == "" {
		t.Skip("BOBO_LSP_TEST_IMAGE is not configured")
	}
	root := t.TempDir()
	source := filepath.Join(root, "packages")
	if err := os.Mkdir(source, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "sentinel"), []byte("anchored"), 0600); err != nil {
		t.Fatal(err)
	}
	mounts, release, err := pinDockerDependencyMounts(filepath.Join(root, "mounts"), "docker-test", []AnalysisDependencyMount{{
		Role: DependencyRolePythonPackages, HostPath: source,
		ContainerPath: "/probe", ReadOnly: true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	output, err := exec.Command("docker", "run", "--rm", "--network", "none", "-v", mounts[0].HostPath+":/probe:ro", image, "sh", "-c", "cat /probe/sentinel").CombinedOutput()
	if err != nil || strings.TrimSpace(string(output)) != "anchored" {
		t.Fatalf("Docker bind mount output=%q err=%v", output, err)
	}
}

func TestCleanupDependencyMountOrphansFailsClosedOnUnremovedSession(t *testing.T) {
	mountRoot := filepath.Join(t.TempDir(), "mounts")
	sessionRoot := filepath.Join(mountRoot, "session-incomplete")
	if err := os.MkdirAll(sessionRoot, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(sessionRoot, "unexpected-owner")
	if err := os.WriteFile(marker, []byte("still owned"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := CleanupDependencyMountOrphans(mountRoot); err == nil {
		t.Fatal("unremoved LSP projection state did not fail cleanup")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("fail-closed cleanup removed unknown owner state: %v", err)
	}
}
