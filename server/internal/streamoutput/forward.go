package streamoutput

import (
	"context"
	"fmt"
	"io"
	"unicode/utf8"

	"bobocloud-server/internal/session"
)

const readBufferSize = 4096

// Forward copies one process stream to bounded retained storage and emits
// display fragments without treating arbitrary Read boundaries as line breaks.
func Forward(ctx context.Context, reader io.Reader, retained io.Writer, output session.OutputWriter, stage string, stderr bool) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if reader == nil {
		return nil
	}

	decoder := fragmentDecoder{emit: func(fragment session.OutputFragment) {
		if stderr {
			session.WriteStderrFragment(output, fragment, stage)
			return
		}
		session.WriteStdoutFragment(output, fragment, stage)
	}}
	buffer := make([]byte, readBufferSize)
	for {
		n, readErr := reader.Read(buffer)
		if n > 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
			chunk := buffer[:n]
			if retained != nil {
				written, writeErr := retained.Write(chunk)
				if writeErr != nil {
					return fmt.Errorf("retain process output: %w", writeErr)
				}
				if written != len(chunk) {
					return io.ErrShortWrite
				}
			}
			decoder.write(chunk)
		}
		if readErr != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			decoder.finish()
			if readErr == io.EOF {
				return nil
			}
			return readErr
		}
	}
}

type fragmentDecoder struct {
	emit        func(session.OutputFragment)
	utf8Carry   []byte
	pendingCR   bool
	lineOpen    bool
	replaceNext bool
}

func (decoder *fragmentDecoder) write(chunk []byte) {
	data := make([]byte, 0, len(decoder.utf8Carry)+len(chunk))
	data = append(data, decoder.utf8Carry...)
	data = append(data, chunk...)
	complete := completeUTF8Prefix(data)
	decoder.utf8Carry = append(decoder.utf8Carry[:0], data[complete:]...)
	decoder.writeComplete(data[:complete])
}

func (decoder *fragmentDecoder) finish() {
	if len(decoder.utf8Carry) > 0 {
		decoder.writeComplete(decoder.utf8Carry)
		decoder.utf8Carry = nil
	}
	// A terminal carriage return with no following text only moves the cursor;
	// the visible content is already correct and needs no synthetic fragment.
	decoder.pendingCR = false
}

func (decoder *fragmentDecoder) writeComplete(data []byte) {
	if decoder.pendingCR {
		decoder.pendingCR = false
		if len(data) > 0 && data[0] == '\n' {
			decoder.emitText(nil, true)
			data = data[1:]
		} else {
			decoder.replaceNext = decoder.lineOpen
		}
	}

	start := 0
	for index := 0; index < len(data); index++ {
		switch data[index] {
		case '\n':
			decoder.emitText(data[start:index], true)
			start = index + 1
		case '\r':
			if index+1 < len(data) && data[index+1] == '\n' {
				decoder.emitText(data[start:index], true)
				index++
				start = index + 1
				continue
			}
			decoder.emitText(data[start:index], false)
			if index+1 == len(data) {
				decoder.pendingCR = true
			} else {
				decoder.replaceNext = decoder.lineOpen
			}
			start = index + 1
		}
	}
	if start < len(data) {
		decoder.emitText(data[start:], false)
	}
}

func (decoder *fragmentDecoder) emitText(text []byte, newline bool) {
	if len(text) == 0 && !newline {
		return
	}
	fragment := session.OutputFragment{Text: string(text), Newline: newline}
	if decoder.lineOpen {
		if decoder.replaceNext && len(text) > 0 {
			fragment.Replace = true
		} else {
			fragment.Append = true
		}
	}
	if decoder.emit != nil {
		decoder.emit(fragment)
	}

	if newline {
		decoder.lineOpen = false
		decoder.replaceNext = false
		return
	}
	decoder.lineOpen = true
	if len(text) > 0 {
		decoder.replaceNext = false
	}
}

func completeUTF8Prefix(data []byte) int {
	for index := 0; index < len(data); {
		if data[index] < utf8.RuneSelf {
			index++
			continue
		}
		if !utf8.FullRune(data[index:]) {
			return index
		}
		_, size := utf8.DecodeRune(data[index:])
		index += size
	}
	return len(data)
}
