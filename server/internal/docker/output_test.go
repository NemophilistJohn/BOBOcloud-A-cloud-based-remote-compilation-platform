package docker

import (
	"strings"
	"testing"
)

func TestCappedBuffer(t *testing.T) {
	buffer := newCappedBuffer(5)
	n, err := buffer.Write([]byte("abcdefgh"))
	if err != nil || n != 8 {
		t.Fatalf("Write = (%d, %v), want (8, nil)", n, err)
	}
	value := buffer.String()
	if !strings.HasPrefix(value, "abcde") || !strings.Contains(value, "Output truncated") {
		t.Fatalf("unexpected capped output: %q", value)
	}
}

func TestPoolOutputRetentionLimitClampsOversizedValues(t *testing.T) {
	pool := &Pool{}
	pool.SetOutputRetentionLimit(maxPoolOutputRetentionBytes + 1)
	if pool.outputRetainedBytes != maxPoolOutputRetentionBytes {
		t.Fatalf("pool retained output limit = %d, want %d", pool.outputRetainedBytes, maxPoolOutputRetentionBytes)
	}
}
