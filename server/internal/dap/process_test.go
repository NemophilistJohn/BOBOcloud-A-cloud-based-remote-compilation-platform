package dap

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func hasDAPArgPair(args []string, flag, value string) bool {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == flag && args[index+1] == value {
			return true
		}
	}
	return false
}

func TestDAPEnvironmentUsesDedicatedDownloadAndBuildCache(t *testing.T) {
	env := dapEnvironment(LaunchSpec{Adapter: AdapterSpec{LanguageID: "python", RuntimeID: "python:3.11"}})
	for _, key := range []string{"PYTHONPATH", "NODE_PATH", "NPM_CONFIG_PREFIX", "GOPATH", "GOMODCACHE"} {
		if value := env[key]; value != "" {
			t.Fatalf("legacy installed dependency environment %s=%q was retained", key, value)
		}
	}
	if env["PIP_CACHE_DIR"] != "/dap-cache/pip" || env["GOCACHE"] != "/dap-cache/go-build" || env["NPM_CONFIG_CACHE"] != "/dap-cache/npm" {
		t.Fatalf("download/build cache environment = %#v", env)
	}
	for _, value := range env {
		if strings.Contains(value, "/persist/pip-packages") || strings.Contains(value, "/persist/npm-global/lib/node_modules") || strings.Contains(value, "/persist/go/pkg/mod") {
			t.Fatalf("legacy dependency path survived in %#v", env)
		}
	}
}

func TestDockerRunArgsMountProjectDependenciesReadOnly(t *testing.T) {
	workspace := t.TempDir()
	cacheParent := t.TempDir()
	persist := filepath.Join(cacheParent, "dap-cache", "users", "user")
	lspSentinel := filepath.Join(cacheParent, "lsp-cache", "sentinel")
	if err := os.MkdirAll(filepath.Dir(lspSentinel), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lspSentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	dependencies := t.TempDir()
	spec := LaunchSpec{
		SessionID: "session", UserID: "user", Workspace: workspace, PersistDir: persist,
		DependencyRoot: dependencies, DependencyEnv: map[string]string{"PYTHONPATH": "/project-deps/python"},
		Adapter: AdapterSpec{LanguageID: "python", RuntimeID: "python:3.11"}, NetworkEnable: true,
	}
	args, err := dockerRunArgs(spec, "dap-test", false)
	if err != nil {
		t.Fatal(err)
	}
	absoluteDependencies, _ := filepath.Abs(dependencies)
	absolutePersist, _ := filepath.Abs(persist)
	if hasDAPArgPair(args, "-v", absolutePersist+":/persist:rw") {
		t.Fatalf("the complete persist tree was mounted writable: %v", args)
	}
	for _, cacheDirectory := range []string{"pip", "go-build", "npm"} {
		hostCache := filepath.Join(absolutePersist, cacheDirectory)
		if !hasDAPArgPair(args, "-v", hostCache+":/dap-cache/"+cacheDirectory+":rw") {
			t.Fatalf("writable %s mount missing from %v", cacheDirectory, args)
		}
	}
	absoluteLSP, _ := filepath.Abs(filepath.Dir(lspSentinel))
	for _, arg := range args {
		if strings.Contains(arg, absoluteLSP) {
			t.Fatalf("DAP launch crossed into LSP cache root: %v", args)
		}
	}
	if !hasDAPArgPair(args, "-v", absoluteDependencies+":/project-deps:ro") {
		t.Fatalf("dependency mount missing from %v", args)
	}
	if !hasDAPArgPair(args, "-e", "PYTHONPATH=/project-deps/python") {
		t.Fatalf("dependency environment missing from %v", args)
	}
	if data, err := os.ReadFile(lspSentinel); err != nil || string(data) != "keep" {
		t.Fatalf("DAP argument planning changed LSP cache sentinel: data=%q err=%v", data, err)
	}
}

func TestDockerRunArgsMountNodeModulesAtWorkspaceReadOnly(t *testing.T) {
	dependencies := t.TempDir()
	nodeModules := filepath.Join(dependencies, "node_modules")
	if err := os.Mkdir(nodeModules, 0700); err != nil {
		t.Fatal(err)
	}
	args, err := dockerRunArgs(LaunchSpec{
		SessionID: "session", UserID: "user", Workspace: t.TempDir(), DependencyRoot: dependencies,
		DependencyEnv: map[string]string{"NODE_PATH": "/workspace/node_modules"},
		Adapter:       AdapterSpec{LanguageID: "node", RuntimeID: "node:22"}, NetworkEnable: true,
	}, "dap-node-test", false)
	if err != nil {
		t.Fatal(err)
	}
	absoluteNodeModules, _ := filepath.Abs(nodeModules)
	if !hasDAPArgPair(args, "-v", absoluteNodeModules+":"+ContainerRoot+"/node_modules:ro") {
		t.Fatalf("read-only node_modules mount missing from %v", args)
	}
}

type mountedProcessTestStub struct {
	stdinR   *io.PipeReader
	stdinW   *io.PipeWriter
	stdoutR  *io.PipeReader
	stdoutW  *io.PipeWriter
	once     sync.Once
	killErr  error
	waitDone chan struct{}
}

func newMountedProcessTestStub() *mountedProcessTestStub {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	return &mountedProcessTestStub{stdinR: stdinR, stdinW: stdinW, stdoutR: stdoutR, stdoutW: stdoutW}
}

func newBlockingMountedProcessTestStub() *mountedProcessTestStub {
	process := newMountedProcessTestStub()
	process.waitDone = make(chan struct{})
	return process
}

func (process *mountedProcessTestStub) Stdin() io.WriteCloser { return process.stdinW }
func (process *mountedProcessTestStub) Stdout() io.ReadCloser { return process.stdoutR }
func (process *mountedProcessTestStub) Wait() error {
	if process.waitDone != nil {
		<-process.waitDone
	}
	return nil
}
func (process *mountedProcessTestStub) Kill() error {
	if process.killErr != nil {
		return process.killErr
	}
	process.once.Do(func() {
		if process.waitDone != nil {
			close(process.waitDone)
		}
		_ = process.stdinR.Close()
		_ = process.stdinW.Close()
		_ = process.stdoutR.Close()
		_ = process.stdoutW.Close()
	})
	return nil
}

func TestDAPDependencyProjectionSurvivesFailedKillUntilWait(t *testing.T) {
	var releases atomic.Int32
	underlying := newMountedProcessTestStub()
	underlying.killErr = errors.New("kill failed")
	process := wrapDAPDependencyProcess(underlying, func() { releases.Add(1) })
	if err := process.Kill(); err == nil {
		t.Fatal("failed underlying kill was hidden")
	}
	if releases.Load() != 0 {
		t.Fatal("projection was released while the DAP process could still be alive")
	}
	if err := process.Wait(); err != nil {
		t.Fatal(err)
	}
	if releases.Load() != 1 {
		t.Fatalf("projection release count after Wait = %d", releases.Load())
	}
}

func TestDAPDockerProcessTransientRemovalFailureDoesNotBlockWait(t *testing.T) {
	var releases atomic.Int32
	var removals atomic.Int32
	underlying := newBlockingMountedProcessTestStub()
	docker := &dockerProcess{Process: underlying, name: "dap-test"}
	docker.removal.retryDelay = time.Millisecond
	docker.removal.remove = func(string) error {
		if removals.Add(1) == 1 {
			return errors.New("injected docker rm failure")
		}
		return nil
	}
	process := wrapDAPDependencyProcess(docker, func() { releases.Add(1) })

	if err := process.Kill(); err == nil {
		t.Fatal("docker rm failure was swallowed")
	}
	if releases.Load() != 0 {
		t.Fatal("dependency projection was released after failed container removal")
	}
	done := make(chan error, 1)
	go func() { done <- process.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("DAP Wait remained blocked behind the container removal retry")
	}
	if releases.Load() != 1 || removals.Load() < 2 {
		t.Fatalf("releases=%d removals=%d", releases.Load(), removals.Load())
	}
}

func TestDAPDockerProcessWaitRetainsProjectionUntilRemovalConfirmed(t *testing.T) {
	failed := make(chan struct{})
	allowRemoval := make(chan struct{})
	var removals atomic.Int32
	var releases atomic.Int32
	docker := &dockerProcess{Process: newMountedProcessTestStub(), name: "dap-test"}
	docker.removal.retryDelay = time.Millisecond
	docker.removal.remove = func(string) error {
		if removals.Add(1) == 1 {
			close(failed)
			return errors.New("injected docker rm failure")
		}
		<-allowRemoval
		return nil
	}
	process := wrapDAPDependencyProcess(docker, func() { releases.Add(1) })
	done := make(chan error, 1)
	go func() { done <- process.Wait() }()
	<-failed
	time.Sleep(5 * time.Millisecond)
	if releases.Load() != 0 {
		t.Fatal("dependency projection was released while Docker removal was unconfirmed")
	}
	close(allowRemoval)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Wait did not finish after Docker removal was confirmed")
	}
	if releases.Load() != 1 || removals.Load() < 2 {
		t.Fatalf("releases=%d removals=%d", releases.Load(), removals.Load())
	}
}

func TestDAPSocketProcessWaitSucceedsOnlyAfterConfirmedRemoval(t *testing.T) {
	for _, test := range []struct {
		name  string
		build func(string, func(string) error) Process
	}{
		{name: "tcp", build: func(name string, remove func(string) error) Process {
			process := &tcpDockerProcess{name: name}
			process.removal.remove = remove
			return process
		}},
		{name: "unix", build: func(name string, remove func(string) error) Process {
			process := &unixDockerProcess{name: name, socketDir: t.TempDir()}
			process.removal.remove = remove
			return process
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			removalStarted := make(chan struct{})
			allowRemoval := make(chan struct{})
			var releases atomic.Int32
			process := wrapDAPDependencyProcess(test.build("dap-"+test.name, func(string) error {
				close(removalStarted)
				<-allowRemoval
				return nil
			}), func() { releases.Add(1) })
			done := make(chan error, 1)
			go func() { done <- process.Wait() }()
			<-removalStarted
			if releases.Load() != 0 {
				t.Fatal("dependency projection was released before container absence was confirmed")
			}
			close(allowRemoval)
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("Wait returned a false error after confirmed removal: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("Wait did not finish after confirmed removal")
			}
			if releases.Load() != 1 {
				t.Fatalf("dependency projection release count = %d", releases.Load())
			}
		})
	}
}

func TestDAPDockerInspectRequiresConfirmedAbsence(t *testing.T) {
	inspectErr := errors.New("inspect failed")
	if err := dockerInspectConfirmsAbsent("dap-test", nil, nil); err == nil {
		t.Fatal("a successful inspect was treated as container absence")
	}
	if err := dockerInspectConfirmsAbsent("dap-test", []byte("Error: No such container: dap-test"), inspectErr); err != nil {
		t.Fatalf("Docker no-such-container did not confirm absence: %v", err)
	}
	if err := dockerInspectConfirmsAbsent("dap-test", []byte("Cannot connect to the Docker daemon"), inspectErr); !errors.Is(err, inspectErr) {
		t.Fatalf("Docker inspect failure was hidden: %v", err)
	}
}

func TestDAPCleanupDockerOrphanIDsReturnsRemovalErrors(t *testing.T) {
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

func TestDockerDAPOrphanFiltersIncludeLegacyToolkitLabel(t *testing.T) {
	filters := strings.Join(dockerDAPOrphanFilters(), "\n")
	if !strings.Contains(filters, "label=bobocloud.dap=true") || !strings.Contains(filters, "label=bobocloud.dap.adapter") || !strings.Contains(filters, "name=bobocloud-dap-") {
		t.Fatalf("incomplete DAP orphan filters: %q", filters)
	}
}

func TestDAPFailedStartRetainsProjectionUntilContainerCleanup(t *testing.T) {
	removed := make(chan struct{})
	released := make(chan struct{})
	err := &dockerAdapterStartCleanupError{cause: errors.New("adapter start failed"), removed: removed}
	releaseDependencyMountAfterStartError(func() { close(released) }, err)
	select {
	case <-released:
		t.Fatal("dependency projection was released while failed-start container cleanup was pending")
	default:
	}
	close(removed)
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("dependency projection was not released after failed-start container cleanup")
	}
}

func TestDAPFailedStartCleanupSignalSurvivesTransientRemovalFailureAndWrapping(t *testing.T) {
	firstFailure := make(chan struct{})
	allowRemoval := make(chan struct{})
	var removals atomic.Int32
	removal := &dockerContainerRemoval{retryDelay: time.Millisecond}
	removal.remove = func(string) error {
		if removals.Add(1) == 1 {
			close(firstFailure)
			return errors.New("injected docker rm failure")
		}
		<-allowRemoval
		return nil
	}
	err := failDockerAdapterStartWithRemoval(errors.New("adapter connection failed"), "dap-start-test", "", removal)
	cleanupDone := StartCleanupDone(fmt.Errorf("start managed debug adapter: %w", err))
	if cleanupDone == nil {
		t.Fatal("wrapped failed-start error lost its cleanup completion signal")
	}
	<-firstFailure
	select {
	case <-cleanupDone:
		t.Fatal("cleanup completed after the transient docker rm failure")
	default:
	}
	close(allowRemoval)
	select {
	case <-cleanupDone:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not complete after Docker container absence was confirmed")
	}
	if removals.Load() < 2 {
		t.Fatalf("docker removal attempts = %d, want at least 2", removals.Load())
	}
}

func (process *mountedProcessTestStub) OpenChild(context.Context) (io.ReadWriteCloser, error) {
	return nil, context.Canceled
}

func TestDAPDependencyProjectionLivesUntilProcessEnds(t *testing.T) {
	var releases atomic.Int32
	underlying := newMountedProcessTestStub()
	process := wrapDAPDependencyProcess(underlying, func() { releases.Add(1) })
	if _, ok := process.(ChildConnectionProvider); !ok {
		t.Fatal("dependency process wrapper dropped DAP child-session support")
	}
	if err := process.Wait(); err != nil {
		t.Fatal(err)
	}
	if releases.Load() != 1 {
		t.Fatalf("projection release count after Wait = %d", releases.Load())
	}
	if err := process.Kill(); err != nil {
		t.Fatal(err)
	}
	if releases.Load() != 1 {
		t.Fatalf("projection release count after Wait and Kill = %d", releases.Load())
	}
}

func TestDAPDependencyProjectionValidatesSourceOutsideLinux(t *testing.T) {
	if filepath.Separator == '/' {
		t.Skip("Linux bind-anchor behavior is covered by dependency_mount_linux_test.go")
	}
	source := t.TempDir()
	pinned, release, err := pinDAPDependencyMount(filepath.Join(t.TempDir(), "dap-cache", "mounts"), "session", source)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	expected, _ := filepath.Abs(source)
	if filepath.Clean(pinned) != filepath.Clean(expected) {
		t.Fatalf("validated development projection = %q, want %q", pinned, expected)
	}
}
