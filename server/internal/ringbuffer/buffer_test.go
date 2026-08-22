package ringbuffer

import "testing"

func TestBufferKeepsTailAndFullWriteCount(t *testing.T) {
	buffer := New(5)
	written, err := buffer.Write([]byte("abcdefgh"))
	if err != nil || written != 8 || buffer.String() != "defgh" || !buffer.Truncated() {
		t.Fatalf("buffer = %q truncated=%v write=(%d,%v)", buffer.String(), buffer.Truncated(), written, err)
	}
}

func TestBufferKeepsValidUTF8Tail(t *testing.T) {
	buffer := New(4)
	_, _ = buffer.Write([]byte("A你好"))
	if got := buffer.String(); got != "好" {
		t.Fatalf("UTF-8 tail = %q", got)
	}
}
