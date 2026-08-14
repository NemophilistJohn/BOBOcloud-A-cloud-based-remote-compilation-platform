package dap

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

func TestFrameRoundTripAndLimit(t *testing.T) {
	payload := []byte(`{"seq":1,"type":"request","command":"threads"}`)
	var framed bytes.Buffer
	if err := WriteFrame(&framed, payload); err != nil {
		t.Fatal(err)
	}
	got, err := ReadFrame(bufio.NewReader(&framed), 1024)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload = %s", got)
	}
	oversized := "Content-Length: 8\r\n\r\n12345678"
	if _, err := ReadFrame(bufio.NewReader(strings.NewReader(oversized)), 4); err == nil {
		t.Fatal("expected oversized DAP frame to fail")
	}
}

func TestFrameRequiresContentLength(t *testing.T) {
	if _, err := ReadFrame(bufio.NewReader(strings.NewReader("Other: 1\r\n\r\n")), 1024); err == nil {
		t.Fatal("expected missing Content-Length to fail")
	}
}

func TestFrameRejectsDuplicateAndOversizedHeaders(t *testing.T) {
	duplicate := "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}"
	if _, err := ReadFrame(bufio.NewReader(strings.NewReader(duplicate)), 1024); err == nil {
		t.Fatal("duplicate Content-Length header was accepted")
	}
	oversized := "X-Test: " + strings.Repeat("x", 9<<10) + "\r\nContent-Length: 2\r\n\r\n{}"
	if _, err := ReadFrame(bufio.NewReader(strings.NewReader(oversized)), 1024); err == nil {
		t.Fatal("oversized DAP headers were accepted")
	}
}
