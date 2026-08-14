package dap

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
)

func ReadFrame(reader *bufio.Reader, maxBytes int) ([]byte, error) {
	contentLength := -1
	headerBytes := 0
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		headerBytes += len(line)
		if headerBytes > 8<<10 {
			return nil, fmt.Errorf("DAP frame headers exceed 8192 bytes")
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		name, value, found := strings.Cut(line, ":")
		if !found {
			return nil, fmt.Errorf("invalid DAP frame header")
		}
		if strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			if contentLength >= 0 {
				return nil, fmt.Errorf("DAP frame has duplicate Content-Length headers")
			}
			length, parseErr := strconv.Atoi(strings.TrimSpace(value))
			if parseErr != nil || length < 0 {
				return nil, fmt.Errorf("invalid DAP content length")
			}
			contentLength = length
		}
	}
	if contentLength < 0 {
		return nil, fmt.Errorf("DAP frame is missing Content-Length")
	}
	if maxBytes > 0 && contentLength > maxBytes {
		return nil, fmt.Errorf("DAP frame exceeds %d bytes", maxBytes)
	}
	payload := make([]byte, contentLength)
	_, err := io.ReadFull(reader, payload)
	return payload, err
}

func WriteFrame(writer io.Writer, payload []byte) error {
	if _, err := fmt.Fprintf(writer, "Content-Length: %d\r\n\r\n", len(payload)); err != nil {
		return err
	}
	written, err := writer.Write(payload)
	if err == nil && written != len(payload) {
		return io.ErrShortWrite
	}
	return err
}

type LockedFrameWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func NewLockedFrameWriter(writer io.Writer) *LockedFrameWriter {
	return &LockedFrameWriter{w: writer}
}

func (w *LockedFrameWriter) Write(payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return WriteFrame(w.w, payload)
}
