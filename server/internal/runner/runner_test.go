package runner

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"bobocloud-server/internal/session"
)

type captureOutput struct {
	mu              sync.Mutex
	stdout          []string
	stdoutFragments []session.OutputFragment
}

func (o *captureOutput) WriteStatus(string, string)           {}
func (o *captureOutput) WriteStderr(string, string)           {}
func (o *captureOutput) WriteArtifactBegin()                  {}
func (o *captureOutput) WriteArtifact(string, []byte, string) {}
func (o *captureOutput) WriteArtifactEnd()                    {}
func (o *captureOutput) WriteResult(bool, int)                {}
func (o *captureOutput) WriteError(string)                    {}
func (o *captureOutput) WriteStdout(line, _ string) {
	o.mu.Lock()
	o.stdout = append(o.stdout, line)
	o.mu.Unlock()
}

func (o *captureOutput) WriteStdoutFragment(fragment session.OutputFragment, _ string) {
	o.mu.Lock()
	o.stdoutFragments = append(o.stdoutFragments, fragment)
	switch {
	case fragment.Replace && len(o.stdout) > 0:
		o.stdout[len(o.stdout)-1] = fragment.Text
	case fragment.Append && len(o.stdout) > 0:
		o.stdout[len(o.stdout)-1] += fragment.Text
	default:
		o.stdout = append(o.stdout, fragment.Text)
	}
	o.mu.Unlock()
}

func (o *captureOutput) WriteStderrFragment(session.OutputFragment, string) {}

func TestStreamProcessRetainsTailWithoutTruncatingLiveOutput(t *testing.T) {
	SetOutputRetentionLimit(32)
	t.Cleanup(func() { SetOutputRetentionLimit(256 << 10) })
	output := &captureOutput{}
	result := StreamProcess(context.Background(), []string{os.Args[0], "-test.run=TestStreamProcessOutputHelper", "--"}, t.TempDir(), output, "run", map[string]string{"BOBO_STREAM_HELPER": "1"}, nil)
	if !result.Success {
		t.Fatalf("process failed: %+v", result)
	}
	output.mu.Lock()
	live := append([]string(nil), output.stdout...)
	output.mu.Unlock()
	if len(live) != 20 || live[0] != "line-00" || live[19] != "line-19" {
		t.Fatalf("live output was truncated: %#v", live)
	}
	if !result.StdoutTruncated || strings.Contains(result.Stdout, "line-00") || !strings.Contains(result.Stdout, "line-19") {
		t.Fatalf("retained output should contain only the newest tail: %+v", result)
	}
}

func TestStreamProcessOutputHelper(t *testing.T) {
	if os.Getenv("BOBO_STREAM_HELPER") != "1" {
		return
	}
	for i := 0; i < 20; i++ {
		fmt.Printf("line-%02d\n", i)
	}
	os.Exit(0)
}

func TestStreamProcessKeepsLongUnterminatedOutputAsOneLogicalLine(t *testing.T) {
	output := &captureOutput{}
	result := StreamProcess(context.Background(), []string{os.Args[0], "-test.run=TestStreamProcessLongOutputHelper", "--"}, t.TempDir(), output, "run", map[string]string{"BOBO_LONG_STREAM_HELPER": "1"}, nil)
	if !result.Success {
		t.Fatalf("process failed: %+v", result)
	}
	output.mu.Lock()
	live := append([]string(nil), output.stdout...)
	fragments := append([]session.OutputFragment(nil), output.stdoutFragments...)
	output.mu.Unlock()
	if len(live) != 1 || len(live[0]) != 9000 || live[0] != strings.Repeat("x", 9000) {
		t.Fatalf("long live output became %d logical lines with lengths %v", len(live), stringLengths(live))
	}
	if len(fragments) < 2 || fragments[0].Append || !fragments[1].Append {
		t.Fatalf("long output fragment continuity = %#v", fragments)
	}
	if result.Stdout != strings.Repeat("x", 9000) {
		t.Fatalf("retained long output changed: %d bytes", len(result.Stdout))
	}
}

func TestStreamProcessLongOutputHelper(t *testing.T) {
	if os.Getenv("BOBO_LONG_STREAM_HELPER") != "1" {
		return
	}
	fmt.Print(strings.Repeat("x", 9000))
	os.Exit(0)
}

func stringLengths(values []string) []int {
	lengths := make([]int, len(values))
	for index, value := range values {
		lengths[index] = len(value)
	}
	return lengths
}
