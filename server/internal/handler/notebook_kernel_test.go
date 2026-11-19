package handler

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func notebookPython(t *testing.T) string {
	t.Helper()
	candidates := []string{}
	for _, name := range []string{"python3", "python"} {
		if path, err := exec.LookPath(name); err == nil {
			candidates = append(candidates, path)
		}
	}
	if runtime.GOOS == "windows" {
		for _, directory := range filepath.SplitList(os.Getenv("PATH")) {
			for _, name := range []string{"python3.exe", "python.exe"} {
				path := filepath.Join(directory, name)
				if _, err := os.Stat(path); err == nil {
					candidates = append(candidates, path)
				}
			}
		}
	}
	for _, candidate := range candidates {
		if exec.Command(candidate, "-c", "pass").Run() == nil {
			return candidate
		}
	}
	t.Skip("python3 is unavailable")
	return ""
}

func TestNotebookKernelKeepsStateAndReturnsCellResults(t *testing.T) {
	python := notebookPython(t)
	process, err := startNotebookProcess(context.Background(), python, "-u", "-c", notebookKernelPython)
	if err != nil {
		t.Fatal(err)
	}
	defer process.close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ready, err := process.receive(ctx)
	if err != nil || !ready.Ready {
		t.Fatalf("kernel readiness = %#v, %v", ready, err)
	}
	first, err := process.execute(ctx, "answer = 41")
	if err != nil || !first.OK || first.Count != 1 {
		t.Fatalf("first cell = %#v, %v", first, err)
	}
	second, err := process.execute(ctx, "answer + 1")
	if err != nil || !second.OK || second.Count != 2 || len(second.Outputs) != 1 ||
		!strings.Contains(string(second.Outputs[0]), "42") {
		t.Fatalf("stateful result = %#v, %v", second, err)
	}
	failed, err := process.execute(ctx, "raise ValueError('cell failure')")
	if err != nil || failed.OK || failed.Count != 3 || len(failed.Outputs) != 1 ||
		!strings.Contains(string(failed.Outputs[0]), "ValueError") {
		t.Fatalf("cell exception = %#v, %v", failed, err)
	}
}

func TestNotebookKernelTimeoutStopsInterpreter(t *testing.T) {
	python := notebookPython(t)
	process, err := startNotebookProcess(context.Background(), python, "-u", "-c", notebookKernelPython)
	if err != nil {
		t.Fatal(err)
	}
	defer process.close()
	readyCtx, cancelReady := context.WithTimeout(context.Background(), 5*time.Second)
	ready, err := process.receive(readyCtx)
	cancelReady()
	if err != nil || !ready.Ready {
		t.Fatalf("kernel readiness = %#v, %v", ready, err)
	}
	cellCtx, cancelCell := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancelCell()
	if _, err := process.execute(cellCtx, "while True: pass"); err == nil {
		t.Fatal("expected cell deadline")
	}
	select {
	case <-process.done:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out interpreter was not stopped")
	}
}

func TestNotebookKernelFigureIDDoesNotChangeExecutionCount(t *testing.T) {
	python := notebookPython(t)
	process, err := startNotebookProcess(context.Background(), python, "-u", "-c", notebookKernelPython)
	if err != nil {
		t.Fatal(err)
	}
	defer process.close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if ready, err := process.receive(ctx); err != nil || !ready.Ready {
		t.Fatalf("kernel readiness = %#v, %v", ready, err)
	}
	result, err := process.execute(ctx, `import sys
from types import SimpleNamespace
sys.modules["matplotlib.pyplot"] = SimpleNamespace(
    get_fignums=lambda: [7],
    figure=lambda number: SimpleNamespace(savefig=lambda target, **kwargs: target.write(b"plot")),
    close=lambda number: None,
)`)
	if err != nil || !result.OK || result.Count != 1 || len(result.Outputs) != 1 ||
		!strings.Contains(string(result.Outputs[0]), `"image/png"`) {
		t.Fatalf("figure result = %#v, %v", result, err)
	}
}
