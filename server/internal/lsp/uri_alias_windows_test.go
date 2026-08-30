//go:build windows

package lsp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestURIMapperTreatsWindowsShortAndLongPathsAsOneWorkspace(t *testing.T) {
	longRoot := filepath.Join(t.TempDir(), "BOBOCloud URI Alias Workspace")
	if err := os.MkdirAll(filepath.Join(longRoot, "src"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(longRoot, "src", "main.go"), []byte("package main\n"), 0644); err != nil {
		t.Fatal(err)
	}
	shortRoot := lspWindowsShortPath(t, longRoot)
	if strings.EqualFold(filepath.Clean(shortRoot), filepath.Clean(longRoot)) {
		t.Skip("8.3 path aliases are disabled on this volume")
	}
	mapper, err := NewURIMapper(shortRoot)
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		candidate string
		wantURI   string
	}{
		{candidate: filepath.Join(longRoot, "src", "main.go"), wantURI: "bobocloud-lsp:///src/main.go"},
		{candidate: filepath.Join(longRoot, "not-created-yet.go"), wantURI: "bobocloud-lsp:///not-created-yet.go"},
	} {
		raw, err := json.Marshal(map[string]any{"uri": fileURI(test.candidate)})
		if err != nil {
			t.Fatal(err)
		}
		rewritten, err := mapper.RewriteOutbound(raw)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err := json.Unmarshal(rewritten, &value); err != nil {
			t.Fatal(err)
		}
		if uri, _ := value["uri"].(string); uri != test.wantURI {
			t.Fatalf("workspace path %q rewrote to %q, want %q", test.candidate, uri, test.wantURI)
		}
	}

	external := filepath.Join(t.TempDir(), "outside.go")
	raw, err := json.Marshal(map[string]any{"uri": fileURI(external)})
	if err != nil {
		t.Fatal(err)
	}
	rewritten, err := mapper.RewriteOutbound(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rewritten), "bobocloud-lsp-external") {
		t.Fatalf("external path was not redacted: %s", rewritten)
	}
}

func lspWindowsShortPath(t *testing.T, value string) string {
	t.Helper()
	buffer := make([]uint16, windows.MAX_PATH)
	length, err := windows.GetShortPathName(windows.StringToUTF16Ptr(value), &buffer[0], uint32(len(buffer)))
	if err != nil {
		t.Skipf("Windows short paths are unavailable: %v", err)
	}
	if length == 0 || length >= uint32(len(buffer)) {
		t.Skipf("Windows did not return a bounded short path: length=%d", length)
	}
	return windows.UTF16ToString(buffer[:length])
}
