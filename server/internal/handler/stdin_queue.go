package handler

import (
	"io"
	"sync"
)

const (
	stdinQueueMaxMessages = 32
	stdinQueueMaxBytes    = 256 * 1024
)

// stdinWriteQueue keeps WebSocket reads independent from a potentially
// blocking process stdin pipe while bounding retained input.
type stdinWriteQueue struct {
	writer      io.WriteCloser
	pending     chan []byte
	maxMessages int
	maxBytes    int
	onWriteErr  func(error)
	stop        chan struct{}
	done        chan struct{}

	mu              sync.Mutex
	stopped         bool
	pendingMessages int
	pendingBytes    int
}

func newStdinWriteQueue(writer io.WriteCloser, maxMessages, maxBytes int, onWriteErr func(error)) *stdinWriteQueue {
	if maxMessages < 1 {
		maxMessages = 1
	}
	if maxBytes < 1 {
		maxBytes = 1
	}
	queue := &stdinWriteQueue{
		writer:      writer,
		pending:     make(chan []byte, maxMessages),
		maxMessages: maxMessages,
		maxBytes:    maxBytes,
		onWriteErr:  onWriteErr,
		stop:        make(chan struct{}),
		done:        make(chan struct{}),
	}
	go queue.writeLoop()
	return queue
}

func (q *stdinWriteQueue) Enqueue(data string) bool {
	payload := []byte(data)

	q.mu.Lock()
	defer q.mu.Unlock()
	if q.stopped || q.pendingMessages >= q.maxMessages || len(payload) > q.maxBytes-q.pendingBytes {
		return false
	}
	select {
	case q.pending <- payload:
		q.pendingMessages++
		q.pendingBytes += len(payload)
		return true
	default:
		return false
	}
}

func (q *stdinWriteQueue) Stop() {
	q.mu.Lock()
	if q.stopped {
		q.mu.Unlock()
		return
	}
	q.stopped = true
	close(q.stop)
	q.mu.Unlock()

	// Closing an os.Pipe writer interrupts a Write blocked on a full pipe.
	_ = q.writer.Close()
}

func (q *stdinWriteQueue) Done() <-chan struct{} {
	return q.done
}

func (q *stdinWriteQueue) writeLoop() {
	defer close(q.done)
	for {
		select {
		case <-q.stop:
			return
		case payload := <-q.pending:
			err := writeAll(q.writer, payload)
			q.mu.Lock()
			q.pendingMessages--
			q.pendingBytes -= len(payload)
			q.mu.Unlock()

			if err != nil {
				select {
				case <-q.stop:
					return
				default:
				}
				if q.onWriteErr != nil {
					q.onWriteErr(err)
				}
				q.Stop()
				return
			}
		}
	}
}

func writeAll(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		written, err := writer.Write(data)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}
