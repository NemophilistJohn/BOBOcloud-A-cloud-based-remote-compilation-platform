//go:build linux && privileged_integration

package handler

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTerminalAndNotebookSnapshotReachesHardenedWorkspace(t *testing.T) {
	image := os.Getenv("BOBO_LSP_TEST_IMAGE")
	if image == "" {
		t.Fatal("BOBO_LSP_TEST_IMAGE is required for the privileged Docker baseline")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", "run", "-d", "--network=none",
		"--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=10001:10001",
		"--tmpfs=/workspace:rw,uid=10001,gid=10001,mode=0700", image, "sleep", "120").CombinedOutput()
	if err != nil {
		t.Fatalf("start hardened container: %v: %s", err, output)
	}
	container := strings.TrimSpace(string(output))
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		if output, err := exec.CommandContext(cleanup, "docker", "rm", "-f", container).CombinedOutput(); err != nil {
			t.Errorf("remove test container: %v: %s", err, output)
		}
	})
	source := t.TempDir()
	if err := os.Mkdir(filepath.Join(source, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	const contents = `{"nbformat":4,"cells":[]}`
	if err := os.WriteFile(filepath.Join(source, "nested", "baseline.ipynb"), []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := copyTerminalWorkspace(ctx, source, container, terminalLimits{
		CopyTimeout: 20 * time.Second, CopyMaxBytes: 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(snapshot)
	got, err := exec.CommandContext(ctx, "docker", "exec", "-w", "/workspace/nested", container, "cat", "baseline.ipynb").CombinedOutput()
	if err != nil || string(got) != contents {
		t.Fatalf("workload could not read the snapshot: %v: %s", err, got)
	}
}
