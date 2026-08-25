package lsp

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCleanupDockerOrphansContextRejectsCancelledStartup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := CleanupDockerOrphansContext(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("CleanupDockerOrphansContext() error = %v, want context cancellation", err)
	}
}

type dockerLifecycleTestProcess struct {
	waits       atomic.Int32
	kills       atomic.Int32
	waitForKill chan struct{}
	killOnce    sync.Once
}

func (p *dockerLifecycleTestProcess) Stdin() io.WriteCloser { return nil }
func (p *dockerLifecycleTestProcess) Stdout() io.ReadCloser { return nil }
func (p *dockerLifecycleTestProcess) Wait() error {
	p.waits.Add(1)
	if p.waitForKill != nil {
		<-p.waitForKill
	}
	return nil
}
func (p *dockerLifecycleTestProcess) Kill() error {
	p.kills.Add(1)
	if p.waitForKill != nil {
		p.killOnce.Do(func() { close(p.waitForKill) })
	}
	return nil
}

func TestNumericContainerUser(t *testing.T) {
	if got := numericContainerUser("1001", "1002"); got != "1001:1002" {
		t.Fatalf("unexpected container user: %q", got)
	}
	for _, invalid := range [][2]string{{"", "1"}, {"-1", "1"}, {"root", "1"}, {"1", "staff"}} {
		if got := numericContainerUser(invalid[0], invalid[1]); got != "" {
			t.Fatalf("accepted invalid uid/gid %q/%q: %q", invalid[0], invalid[1], got)
		}
	}
}

func TestDockerEnvironmentUsesAnalysisCacheHome(t *testing.T) {
	spec := LaunchSpec{Mode: ModeStandard, CacheDir: t.TempDir(), Server: ServerSpec{}}
	dockerEnv := commandEnvironment(spec, true)
	if dockerEnv["HOME"] != "/analysis-cache/home" {
		t.Fatalf("Docker HOME is not writable analysis cache: %+v", dockerEnv)
	}
	if _, exists := commandEnvironment(spec, false)["HOME"]; exists {
		t.Fatal("host language server HOME was unexpectedly replaced")
	}
}

func TestDockerWorkspaceRootSeparatesNodeDependenciesFromReadOnlyProject(t *testing.T) {
	for _, languageID := range []string{"node", "javascript", "typescript", "js", "ts"} {
		if got := dockerWorkspaceRoot(languageID); got != nodeDockerWorkspaceRoot {
			t.Fatalf("%s Docker workspace root = %q", languageID, got)
		}
	}
	if got := dockerWorkspaceRoot("python"); got != DockerWorkspaceRoot {
		t.Fatalf("Python Docker workspace root = %q", got)
	}
	if strings.HasPrefix(nodeModulesContainer, nodeDockerWorkspaceRoot+"/") || nodeModulesContainer == nodeDockerWorkspaceRoot {
		t.Fatalf("Node dependencies %q are nested below read-only project %q", nodeModulesContainer, nodeDockerWorkspaceRoot)
	}
	if !strings.HasPrefix(nodeModulesContainer, DockerWorkspaceRoot+"/") || !strings.HasPrefix(nodeDockerWorkspaceRoot, DockerWorkspaceRoot+"/") {
		t.Fatalf("Node project and dependency mounts must remain siblings below %q", DockerWorkspaceRoot)
	}

	command := expandCommand([]string{"server", "--workspace", "{{workspace}}", "--cache", "{{cacheDir}}"}, LaunchSpec{
		LanguageID: "typescript",
		Workspace:  t.TempDir(),
		CacheDir:   t.TempDir(),
	}, true)
	if strings.Join(command, " ") != "server --workspace /workspace/project --cache /analysis-cache" {
		t.Fatalf("expanded Node Docker command = %q", command)
	}
}

func TestValidateDockerMountSourceRejectsReplacementLink(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	outside := filepath.Join(root, "outside")
	if err := os.Mkdir(source, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(outside, 0755); err != nil {
		t.Fatal(err)
	}
	if resolved, err := validateDockerMountSource(source); err != nil || resolved != source {
		t.Fatalf("real source resolved=%q err=%v", resolved, err)
	}
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, source); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := validateDockerMountSource(source); err == nil {
		t.Fatal("replacement symlink was accepted as a Docker mount")
	}
}

func TestDockerProcessTransientRemovalFailureDoesNotBlockAttachedWaiter(t *testing.T) {
	underlying := &dockerLifecycleTestProcess{waitForKill: make(chan struct{})}
	var removals atomic.Int32
	var releases atomic.Int32
	process := &dockerProcess{Process: underlying, name: "lsp-test", release: func() { releases.Add(1) }}
	process.removal.retryDelay = time.Millisecond
	process.removal.remove = func(string) error {
		if removals.Add(1) == 1 {
			return errors.New("injected docker rm failure")
		}
		return nil
	}

	if err := process.Kill(); err == nil {
		t.Fatal("docker rm failure was swallowed")
	}
	if underlying.kills.Load() != 1 {
		t.Fatal("attached Docker client was not stopped after a transient removal failure")
	}
	done := make(chan error, 1)
	go func() { done <- process.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Wait remained blocked behind the container removal retry")
	}
	if removals.Load() < 2 || underlying.waits.Load() != 1 || releases.Load() != 1 {
		t.Fatalf("removals=%d waits=%d releases=%d", removals.Load(), underlying.waits.Load(), releases.Load())
	}
}

func TestDockerProcessWaitRetainsMountUntilRemovalConfirmed(t *testing.T) {
	underlying := &dockerLifecycleTestProcess{}
	failed := make(chan struct{})
	allowRemoval := make(chan struct{})
	var removals atomic.Int32
	var releases atomic.Int32
	process := &dockerProcess{Process: underlying, name: "lsp-test", release: func() { releases.Add(1) }}
	process.removal.retryDelay = time.Millisecond
	process.removal.remove = func(string) error {
		if removals.Add(1) == 1 {
			close(failed)
			return errors.New("injected docker rm failure")
		}
		<-allowRemoval
		return nil
	}

	done := make(chan error, 1)
	go func() { done <- process.Wait() }()
	<-failed
	time.Sleep(5 * time.Millisecond)
	if releases.Load() != 0 {
		t.Fatal("dependency mount was released after the Docker client exited but before container removal was confirmed")
	}
	close(allowRemoval)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Wait did not finish after container removal was confirmed")
	}
	if releases.Load() != 1 || removals.Load() < 2 {
		t.Fatalf("releases=%d removals=%d", releases.Load(), removals.Load())
	}
}

func TestDockerInspectRequiresConfirmedAbsence(t *testing.T) {
	inspectErr := errors.New("inspect failed")
	if err := dockerInspectConfirmsAbsent("lsp-test", nil, nil); err == nil {
		t.Fatal("a successful inspect was treated as container absence")
	}
	if err := dockerInspectConfirmsAbsent("lsp-test", []byte("Error: No such object: lsp-test"), inspectErr); err != nil {
		t.Fatalf("Docker no-such-object did not confirm absence: %v", err)
	}
	if err := dockerInspectConfirmsAbsent("lsp-test", []byte("Cannot connect to the Docker daemon"), inspectErr); !errors.Is(err, inspectErr) {
		t.Fatalf("Docker inspect failure was hidden: %v", err)
	}
}

func TestCleanupDockerOrphanIDsReturnsRemovalErrors(t *testing.T) {
	removeErr := errors.New("injected removal failure")
	var removed []string
	err := cleanupDockerOrphanIDs([]string{"first", "second"}, func(id string) error {
		removed = append(removed, id)
		if id == "first" {
			return removeErr
		}
		return nil
	})
	if !errors.Is(err, removeErr) {
		t.Fatalf("orphan cleanup failure was swallowed: %v", err)
	}
	if len(removed) != 2 {
		t.Fatalf("cleanup stopped before checking every orphan: %v", removed)
	}
}

func TestDockerLSPOrphanFiltersIncludeHistoricalName(t *testing.T) {
	filters := strings.Join(dockerLSPOrphanFilters(), "\n")
	if !strings.Contains(filters, "label=bobocloud.lsp=true") || !strings.Contains(filters, "name=bobocloud-lsp-") {
		t.Fatalf("incomplete LSP orphan filters: %q", filters)
	}
}
