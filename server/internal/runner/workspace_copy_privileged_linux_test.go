//go:build linux && privileged_integration

package runner

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Exercise the real daemon and live mount namespace. Mocking docker cp's argv
// cannot detect a successful archive operation that writes behind a tmpfs.
func TestWorkspaceArchiveRoundTripThroughHardenedTmpfs(t *testing.T) {
	image := os.Getenv("BOBO_LSP_TEST_IMAGE")
	if image == "" {
		t.Fatal("BOBO_LSP_TEST_IMAGE is required for the privileged Docker baseline")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", "run", "-d", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=10001:10001", "--tmpfs=/workspace:rw,uid=10001,gid=10001,mode=0700", image, "sleep", "120").CombinedOutput()
	if err != nil {
		t.Fatalf("start hardened container: %v: %s", err, output)
	}
	id := strings.TrimSpace(string(output))
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if output, err := exec.CommandContext(cleanup, "docker", "rm", "-f", id).CombinedOutput(); err != nil {
			t.Errorf("remove test container: %v: %s", err, output)
		}
	})
	source, destination := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "source.txt"), []byte("source baseline"), 0600); err != nil {
		t.Fatal(err)
	}
	copier := dockerCLIWorkspaceCopier{}
	if err := copier.CopyTo(ctx, id, source, "/workspace"); err != nil {
		t.Fatal(err)
	}
	command := `test "$(cat /workspace/source.txt)" = 'source baseline' && test "$(stat -c %u /workspace/source.txt)" = 10001 && printf 'artifact baseline' > /workspace/result.txt && mkdir /workspace/.bobocloud && printf 'private cache' > /workspace/.bobocloud/cache`
	if output, err := exec.CommandContext(ctx, "docker", "exec", id, "sh", "-c", command).CombinedOutput(); err != nil {
		t.Fatalf("workload could not read source/write artifact as non-root: %v: %s", err, output)
	}
	if err := copier.CopyFrom(ctx, id, destination, "/workspace"); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"source.txt": "source baseline", "result.txt": "artifact baseline"} {
		got, err := os.ReadFile(filepath.Join(destination, name))
		if err != nil || string(got) != want {
			t.Fatalf("round trip %s: %q, %v", name, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(destination, ".bobocloud")); !os.IsNotExist(err) {
		t.Fatalf("private cache entered artifact staging: %v", err)
	}
}
