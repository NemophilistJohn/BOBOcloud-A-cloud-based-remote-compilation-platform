package dap

import (
	"bufio"
	"context"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type managerTestProcess struct {
	stdinR  *io.PipeReader
	stdinW  *io.PipeWriter
	stdoutR *io.PipeReader
	stdoutW *io.PipeWriter
	done    chan struct{}
	once    sync.Once
}

func newManagerTestProcess() *managerTestProcess {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	return &managerTestProcess{stdinR: stdinR, stdinW: stdinW, stdoutR: stdoutR, stdoutW: stdoutW, done: make(chan struct{})}
}

func (process *managerTestProcess) Stdin() io.WriteCloser { return process.stdinW }
func (process *managerTestProcess) Stdout() io.ReadCloser { return process.stdoutR }
func (process *managerTestProcess) Wait() error           { <-process.done; return nil }
func (process *managerTestProcess) Kill() error {
	process.once.Do(func() {
		_ = process.stdinR.Close()
		_ = process.stdinW.Close()
		_ = process.stdoutW.Close()
		close(process.done)
	})
	return nil
}

type managerTestStarter struct {
	mu        sync.Mutex
	launches  []LaunchSpec
	processes []*managerTestProcess
}

func (starter *managerTestStarter) Start(_ context.Context, spec LaunchSpec) (Process, error) {
	process := newManagerTestProcess()
	starter.mu.Lock()
	starter.launches = append(starter.launches, spec)
	starter.processes = append(starter.processes, process)
	starter.mu.Unlock()
	return process, nil
}

func (starter *managerTestStarter) process(index int) *managerTestProcess {
	starter.mu.Lock()
	defer starter.mu.Unlock()
	return starter.processes[index]
}

func managerTestCatalog() *Catalog {
	spec := AdapterSpec{
		ID: "python-debugpy", LanguageID: "python", RuntimeID: "python:3.11",
		Image: "bobocloud/dap-python:test", Command: []string{"adapter"}, SupportsLaunch: true,
	}
	return &Catalog{version: CatalogVersion, byKey: map[string]AdapterSpec{catalogKey(spec.LanguageID, spec.RuntimeID): spec}}
}

func managerTestContext(workspace string, release func()) SessionContext {
	return SessionContext{
		UserID: "user-a", WorkspaceKind: "personal", FolderKey: "project-a",
		RuntimeID: "python:3.11", LanguageID: "python", RemoteRoot: workspace, Release: release,
	}
}

func TestManagerRoutesFramesEnforcesLimitsAndReleases(t *testing.T) {
	starter := &managerTestStarter{}
	manager := NewManager(managerTestCatalog(), starter, ManagerOptions{
		MaxSessions: 1, MaxPerUser: 1, MaxMessageBytes: 1024,
		Inspector: catalogTestInspector{available: true},
	})
	t.Cleanup(manager.Close)
	var releases atomic.Int32
	session, err := manager.Start(managerTestContext(t.TempDir(), func() { releases.Add(1) }))
	if err != nil {
		t.Fatal(err)
	}
	process := starter.process(0)

	clientPayload := []byte(`{"seq":1,"type":"request","command":"initialize"}`)
	type frameResult struct {
		payload []byte
		err     error
	}
	framedResult := make(chan frameResult, 1)
	go func() {
		payload, readErr := ReadFrame(bufio.NewReader(process.stdinR), 1024)
		framedResult <- frameResult{payload: payload, err: readErr}
	}()
	if err := session.Send(clientPayload); err != nil {
		t.Fatal(err)
	}
	framed := <-framedResult
	if framed.err != nil || string(framed.payload) != string(clientPayload) {
		t.Fatalf("adapter input = %s, %v", framed.payload, framed.err)
	}
	adapterPayload := []byte(`{"seq":1,"type":"event","event":"initialized"}`)
	if err := WriteFrame(process.stdoutW, adapterPayload); err != nil {
		t.Fatal(err)
	}
	select {
	case received := <-session.Messages():
		if string(received) != string(adapterPayload) {
			t.Fatalf("client output = %s", received)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for adapter output")
	}

	other := managerTestContext(t.TempDir(), nil)
	other.UserID, other.FolderKey = "user-b", "project-b"
	if _, err := manager.Start(other); err == nil || !strings.Contains(err.Error(), "global debug session limit") {
		t.Fatalf("second session error = %v", err)
	}
	if err := manager.StopUser("user-a"); err != nil {
		t.Fatal(err)
	}
	if releases.Load() != 1 {
		t.Fatalf("release count = %d", releases.Load())
	}
	if err := session.Send(clientPayload); err == nil {
		t.Fatal("stopped session accepted another message")
	}
}

func TestSessionRecordsUnexpectedAdapterFrameFailure(t *testing.T) {
	starter := &managerTestStarter{}
	manager := NewManager(managerTestCatalog(), starter, ManagerOptions{Inspector: catalogTestInspector{available: true}})
	t.Cleanup(manager.Close)
	session, err := manager.Start(managerTestContext(t.TempDir(), nil))
	if err != nil {
		t.Fatal(err)
	}
	process := starter.process(0)
	if _, err := io.WriteString(process.stdoutW, "Invalid: frame\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-session.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("session did not stop after malformed adapter framing")
	}
	if session.Err() == nil || !strings.Contains(session.Err().Error(), "DAP stream") {
		t.Fatalf("terminal error = %v", session.Err())
	}
}
