package streamoutput

import (
	"bytes"
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/session"
)

type fragmentCapture struct {
	mu        sync.Mutex
	fragments []session.OutputFragment
}

func (*fragmentCapture) WriteStatus(string, string)           {}
func (*fragmentCapture) WriteStdout(string, string)           {}
func (*fragmentCapture) WriteStderr(string, string)           {}
func (*fragmentCapture) WriteArtifactBegin()                  {}
func (*fragmentCapture) WriteArtifact(string, []byte, string) {}
func (*fragmentCapture) WriteArtifactEnd()                    {}
func (*fragmentCapture) WriteResult(bool, int)                {}
func (*fragmentCapture) WriteError(string)                    {}

func (capture *fragmentCapture) WriteStdoutFragment(fragment session.OutputFragment, _ string) {
	capture.mu.Lock()
	capture.fragments = append(capture.fragments, fragment)
	capture.mu.Unlock()
}

func (capture *fragmentCapture) WriteStderrFragment(fragment session.OutputFragment, _ string) {
	capture.WriteStdoutFragment(fragment, "")
}

func (capture *fragmentCapture) snapshot() []session.OutputFragment {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return append([]session.OutputFragment(nil), capture.fragments...)
}

type chunkReader struct {
	chunks [][]byte
}

func (reader *chunkReader) Read(target []byte) (int, error) {
	if len(reader.chunks) == 0 {
		return 0, io.EOF
	}
	chunk := reader.chunks[0]
	reader.chunks = reader.chunks[1:]
	return copy(target, chunk), nil
}

func TestForwardKeepsLongLineAcrossReadBoundaries(t *testing.T) {
	first := strings.Repeat("a", readBufferSize)
	second := strings.Repeat("b", readBufferSize)
	source := first + second + "\n"
	capture := &fragmentCapture{}
	var retained bytes.Buffer
	reader := &chunkReader{chunks: [][]byte{[]byte(first), []byte(second), []byte("\n")}}

	if err := Forward(context.Background(), reader, &retained, capture, "run", false); err != nil {
		t.Fatal(err)
	}
	fragments := capture.snapshot()
	if len(fragments) != 3 {
		t.Fatalf("fragments = %#v", fragments)
	}
	if fragments[0].Append || fragments[0].Replace || fragments[0].Newline || fragments[0].Text != first {
		t.Fatalf("first fragment = %#v", fragments[0])
	}
	if !fragments[1].Append || fragments[1].Replace || fragments[1].Newline || fragments[1].Text != second {
		t.Fatalf("continued fragment = %#v", fragments[1])
	}
	if !fragments[2].Append || fragments[2].Replace || !fragments[2].Newline || fragments[2].Text != "" {
		t.Fatalf("newline fragment = %#v", fragments[2])
	}
	if retained.String() != source {
		t.Fatalf("retained output changed: got %d bytes, want %d", retained.Len(), len(source))
	}
}

func TestForwardEmitsPromptBeforeReaderCompletes(t *testing.T) {
	reader, writer := io.Pipe()
	capture := &fragmentCapture{}
	done := make(chan error, 1)
	go func() { done <- Forward(context.Background(), reader, io.Discard, capture, "run", false) }()

	if _, err := writer.Write([]byte("enter value: ")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for len(capture.snapshot()) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	fragments := capture.snapshot()
	if len(fragments) != 1 || fragments[0].Text != "enter value: " || fragments[0].Newline {
		t.Fatalf("prompt was not streamed immediately: %#v", fragments)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestForwardDistinguishesCRLFAndCarriageReturnReplacementAcrossChunks(t *testing.T) {
	capture := &fragmentCapture{}
	reader := &chunkReader{chunks: [][]byte{
		[]byte("download 1%\r"),
		[]byte("download 50%\r"),
		[]byte("download 100%\r"),
		[]byte("\nnext\r"),
		[]byte("\n"),
	}}

	if err := Forward(context.Background(), reader, io.Discard, capture, "setup", true); err != nil {
		t.Fatal(err)
	}
	fragments := capture.snapshot()
	want := []session.OutputFragment{
		{Text: "download 1%"},
		{Text: "download 50%", Replace: true},
		{Text: "download 100%", Replace: true},
		{Text: "", Append: true, Newline: true},
		{Text: "next"},
		{Text: "", Append: true, Newline: true},
	}
	if len(fragments) != len(want) {
		t.Fatalf("fragments = %#v", fragments)
	}
	for index := range want {
		if fragments[index] != want[index] {
			t.Fatalf("fragment[%d] = %#v, want %#v", index, fragments[index], want[index])
		}
	}
}

func TestForwardPreservesBlankLinesAndSplitUTF8(t *testing.T) {
	encoded := []byte("你\n\n好")
	capture := &fragmentCapture{}
	reader := &chunkReader{chunks: [][]byte{
		encoded[:2],
		encoded[2:5],
		encoded[5:],
	}}
	var retained bytes.Buffer

	if err := Forward(context.Background(), reader, &retained, capture, "run", false); err != nil {
		t.Fatal(err)
	}
	fragments := capture.snapshot()
	want := []session.OutputFragment{
		{Text: "你", Newline: true},
		{Text: "", Newline: true},
		{Text: "好"},
	}
	if len(fragments) != len(want) {
		t.Fatalf("fragments = %#v", fragments)
	}
	for index := range want {
		if fragments[index] != want[index] {
			t.Fatalf("fragment[%d] = %#v, want %#v", index, fragments[index], want[index])
		}
	}
	if !bytes.Equal(retained.Bytes(), encoded) {
		t.Fatalf("retained bytes = %q, want %q", retained.Bytes(), encoded)
	}
}
