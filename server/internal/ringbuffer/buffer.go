package ringbuffer

import (
	"sync"
	"unicode/utf8"
)

// Buffer retains the newest bytes written to it. Writers still report the full
// input length, so callers can stream every byte while bounding only retained
// result/history memory.
type Buffer struct {
	mu        sync.Mutex
	limit     int
	data      []byte
	truncated bool
}

func New(limit int) *Buffer {
	if limit <= 0 {
		limit = 256 << 10
	}
	return &Buffer{limit: limit, data: make([]byte, 0, limit)}
}

func (b *Buffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	written := len(value)
	if written >= b.limit {
		b.data = append(b.data[:0], value[written-b.limit:]...)
		b.truncated = true
		return written, nil
	}
	overflow := len(b.data) + written - b.limit
	if overflow > 0 {
		copy(b.data, b.data[overflow:])
		b.data = b.data[:len(b.data)-overflow]
		b.truncated = true
	}
	b.data = append(b.data, value...)
	return written, nil
}

func (b *Buffer) WriteLine(value string) {
	b.mu.Lock()
	needsNewline := len(b.data) > 0
	b.mu.Unlock()
	if needsNewline {
		_, _ = b.Write([]byte{'\n'})
	}
	_, _ = b.Write([]byte(value))
}

func (b *Buffer) String() string {
	b.mu.Lock()
	value := append([]byte(nil), b.data...)
	b.mu.Unlock()
	for len(value) > 0 && !utf8.Valid(value) {
		value = value[1:]
	}
	return string(value)
}

func (b *Buffer) Truncated() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.truncated
}
