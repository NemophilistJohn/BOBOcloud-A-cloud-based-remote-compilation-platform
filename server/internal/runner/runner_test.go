package runner

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
)

type captureOutput struct {
	mu     sync.Mutex
	stdout []string
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
