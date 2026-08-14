package handler

import (
	"os"
	"path/filepath"
	"testing"

	"bobocloud-server/internal/buildcache"
	"bobocloud-server/internal/lsp"
)

func TestNodeDependencySnapshotPolicyUsesOwnerHeadroom(t *testing.T) {
	unlimited := nodeDependencySnapshotPolicy(0, 999)
	if unlimited.MaxStoreBytes != lsp.DefaultNodeDependencyStoreBytes || unlimited.MaxAdditionalBytes != -1 {
		t.Fatalf("unlimited policy = %+v", unlimited)
	}

	bounded := nodeDependencySnapshotPolicy(1_000, 750)
	if bounded.MaxStoreBytes != 250 || bounded.MaxAdditionalBytes != -1 {
		t.Fatalf("bounded policy = %+v", bounded)
	}

	exhausted := nodeDependencySnapshotPolicy(1_000, 1_100)
	if exhausted.MaxStoreBytes != 1 || exhausted.MaxAdditionalBytes != 0 {
		t.Fatalf("exhausted policy = %+v", exhausted)
	}
}

func TestGradleDependencySnapshotPolicyUsesSeparateFamilyBudget(t *testing.T) {
	unlimited := gradleDependencySnapshotPolicy(0, 999)
	if unlimited.MaxStoreBytes != lsp.DefaultGradleDependencyStoreBytes || unlimited.MaxAdditionalBytes != -1 {
		t.Fatalf("unlimited Gradle policy = %+v", unlimited)
	}
	bounded := gradleDependencySnapshotPolicy(2_000, 1_250)
	if bounded.MaxStoreBytes != 750 {
		t.Fatalf("bounded Gradle policy = %+v", bounded)
	}
}

func TestDependencyCommandUsesGradle(t *testing.T) {
	for _, command := range []string{"gradle build", "./gradlew test", "gradlew dependencies"} {
		if !dependencyCommandUsesGradle(command) {
			t.Fatalf("Gradle command %q was not detected", command)
		}
	}
	for _, command := range []string{"mvn package", "echo gradle", "npm install"} {
		if dependencyCommandUsesGradle(command) {
			t.Fatalf("non-Gradle command %q was detected", command)
		}
	}
}

func TestDependencyCommandLikelyChangesEnvironment(t *testing.T) {
	for _, command := range []string{
		"pip install numpy",
		"python3.10 -m pip uninstall numpy",
		"cd app && npm ci",
		"pnpm add typescript",
		"go mod download",
		"cargo fetch",
		"./mvnw dependency:go-offline",
		"./gradlew :app:dependencies",
		"gradle build --refresh-dependencies",
	} {
		if !dependencyCommandLikelyChangesEnvironment(command) {
			t.Errorf("dependency command %q was not detected", command)
		}
	}
	for _, command := range []string{
		"go build ./...",
		"go test ./...",
		"go run main.go",
		"cargo build",
		"cargo check",
		"cargo test",
		"mvn package",
		"./gradlew build",
		"echo npm install",
	} {
		if dependencyCommandLikelyChangesEnvironment(command) {
			t.Errorf("ordinary command %q was treated as a dependency change", command)
		}
	}
}

func TestSuccessfulDependencyCommandRequiresZeroExitCode(t *testing.T) {
	if successfulDependencyCommand(1, "pip install numpy") {
		t.Fatal("failed dependency install requested a refresh")
	}
	if !successfulDependencyCommand(0, "pip install numpy") {
		t.Fatal("successful dependency install did not request a refresh")
	}
	if successfulDependencyCommand(0, "go test ./...") {
		t.Fatal("successful ordinary command requested a dependency refresh")
	}
}

func TestTeamDependencyGenerationBumpsProjectAndSharedRoots(t *testing.T) {
	root := t.TempDir()
	prepared := &buildcache.Prepared{
		DependencyHost: filepath.Join(root, "project-dependencies"),
		SharedHost:     filepath.Join(root, "shared-runtime"),
	}
	for _, directory := range []string{prepared.DependencyHost, prepared.SharedHost} {
		if err := os.MkdirAll(directory, 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := (&WSHandler{}).bumpAnalysisDependencyGeneration("user", prepared); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{prepared.DependencyHost, prepared.SharedHost} {
		data, err := os.ReadFile(filepath.Join(directory, ".analysis-generation"))
		if err != nil || len(data) == 0 {
			t.Fatalf("dependency generation missing in %s: data=%q err=%v", directory, data, err)
		}
	}
}
