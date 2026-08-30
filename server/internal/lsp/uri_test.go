package lsp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestURIMapperRoundTripAndInitialize(t *testing.T) {
	root := t.TempDir()
	mapper, err := NewURIMapper(root)
	if err != nil {
		t.Fatal(err)
	}
	in := []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":"bobocloud-lsp:///wrong","workspaceFolders":[]}}`)
	rewritten, err := mapper.RewriteInitialize(in)
	if err != nil {
		t.Fatal(err)
	}
	var message map[string]any
	if err := json.Unmarshal(rewritten, &message); err != nil {
		t.Fatal(err)
	}
	params := message["params"].(map[string]any)
	if params["rootUri"] != mapper.RootURI() {
		t.Fatalf("initialize root was not forced: %v", params["rootUri"])
	}

	document := []byte(`{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"bobocloud-lsp:///src/main.rs","text":""}}}`)
	remote, err := mapper.RewriteInbound(document)
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.ToSlash(filepath.Join(root, "src", "main.rs"))
	if !strings.Contains(filepath.ToSlash(string(remote)), strings.ReplaceAll(expected, " ", "%20")) {
		t.Fatalf("remote URI does not contain workspace path: %s", remote)
	}
	virtual, err := mapper.RewriteOutbound(remote)
	if err != nil || !strings.Contains(string(virtual), "bobocloud-lsp:///src/main.rs") {
		t.Fatalf("roundtrip failed: %s err=%v", virtual, err)
	}
}

func TestURIMapperRejectsTraversalAndAbsoluteClientURI(t *testing.T) {
	mapper, _ := NewURIMapper(t.TempDir())
	for _, raw := range [][]byte{
		[]byte(`{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"bobocloud-lsp:///../secret"}}}`),
		[]byte(`{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"bobocloud-lsp:///%2e%2e/secret"}}}`),
		[]byte(`{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///etc/passwd"}}}`),
		[]byte(`{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"FILE:///etc/passwd"}}}`),
		[]byte(`{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:/etc/passwd"}}}`),
	} {
		if _, err := mapper.RewriteInbound(raw); err == nil {
			t.Fatalf("expected URI rejection for %s", raw)
		}
	}
}

func TestContainerURIMapperUsesAnalyzerMountPathOnEveryHost(t *testing.T) {
	mapper, err := NewContainerURIMapper(DockerWorkspaceRoot)
	if err != nil {
		t.Fatal(err)
	}
	if mapper.RootURI() != "file:///workspace" {
		t.Fatalf("unexpected container root URI: %s", mapper.RootURI())
	}
	in, err := mapper.RewriteInbound([]byte(`{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"bobocloud-lsp:///src/main.go"}}}`))
	if err != nil || !strings.Contains(string(in), `file:///workspace/src/main.go`) {
		t.Fatalf("container inbound URI mismatch: %s err=%v", in, err)
	}
	out, err := mapper.RewriteOutbound([]byte(`{"jsonrpc":"2.0","id":1,"result":{"uri":"FILE:///workspace/src/main.go"}}`))
	if err != nil || !strings.Contains(string(out), `bobocloud-lsp:///src/main.go`) {
		t.Fatalf("container outbound URI mismatch: %s err=%v", out, err)
	}
}

func TestURIMapperOnlyRewritesProtocolURIFields(t *testing.T) {
	mapper, _ := NewURIMapper(t.TempDir())
	in := []byte(`{"jsonrpc":"2.0","method":"textDocument/didChange","params":{"textDocument":{"uri":"bobocloud-lsp:///main.go"},"contentChanges":[{"text":"const example = \"file:///literal/source\""}]}}`)
	out, err := mapper.RewriteInbound(in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `file:///literal/source`) {
		t.Fatalf("source text was unexpectedly rewritten: %s", out)
	}
	if strings.Contains(string(out), `bobocloud-lsp:///main.go`) {
		t.Fatalf("document URI was not rewritten: %s", out)
	}

	hover := []byte(`{"jsonrpc":"2.0","id":1,"result":{"contents":{"kind":"markdown","value":"See file:///private/docs for details"}}}`)
	hoverOut, err := mapper.RewriteOutbound(hover)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(hoverOut), `file:///private/docs`) {
		t.Fatalf("documentation text was unexpectedly rewritten: %s", hoverOut)
	}
}

func TestURIMapperRewritesWorkspaceEditChangeKeys(t *testing.T) {
	root := t.TempDir()
	mapper, _ := NewURIMapper(root)
	inside := fileURI(filepath.Join(root, "main.go"))
	external := "file:///private/dependency.go"
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      7,
		"result": map[string]any{
			"changes": map[string]any{
				inside:   []any{},
				external: []any{},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	out, err := mapper.RewriteOutbound(payload)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	if !strings.Contains(text, `bobocloud-lsp:///main.go`) {
		t.Fatalf("workspace edit key was not mapped: %s", out)
	}
	if strings.Contains(text, `/private/`) || !strings.Contains(text, `bobocloud-lsp-external:`) {
		t.Fatalf("external workspace edit key was not redacted: %s", out)
	}
}

func TestURIMapperRewritesDiagnosticAndDocumentLinkURIs(t *testing.T) {
	root := t.TempDir()
	mapper, _ := NewURIMapper(root)
	file := fileURI(filepath.Join(root, "src", "main.go"))
	payload, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      9,
		"result": map[string]any{
			"relatedDocuments": map[string]any{file: map[string]any{"kind": "full", "items": []any{}}},
			"codeDescription":  map[string]any{"href": file},
			"target":           file,
		},
	})
	out, err := mapper.RewriteOutbound(payload)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(out), "bobocloud-lsp:///src/main.go") != 3 || strings.Contains(string(out), "file:") {
		t.Fatalf("protocol URI fields were not fully rewritten: %s", out)
	}
}

func TestURIMapperRejectsWorkspaceEditKeyCollision(t *testing.T) {
	root := t.TempDir()
	mapper, _ := NewURIMapper(root)
	inside := fileURI(filepath.Join(root, "main.go"))
	alternate := strings.Replace(inside, "file:///", "file:/", 1)
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      8,
		"result": map[string]any{"changes": map[string]any{
			inside:    []any{map[string]any{"newText": "one"}},
			alternate: []any{map[string]any{"newText": "two"}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mapper.RewriteOutbound(payload); err == nil || !strings.Contains(err.Error(), "collision") {
		t.Fatalf("expected URI rewrite collision, got %v", err)
	}
}

func TestURIMapperRejectsHostSymlinkEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows symlink creation requires host policy support")
	}
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	mapper, err := NewURIMapper(root)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"bobocloud-lsp:///linked/secret.go"}}}`)
	if _, err := mapper.RewriteInbound(payload); err == nil {
		t.Fatal("host mapper allowed a symlink to escape the workspace")
	}
}

func TestURIMapperPreservesHostSymlinkAliasInsideWorkspace(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows symlink creation requires host policy support")
	}
	root := t.TempDir()
	realDirectory := filepath.Join(root, "real")
	aliasDirectory := filepath.Join(root, "alias")
	if err := os.Mkdir(realDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(realDirectory, "main.go"), []byte("package main\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realDirectory, aliasDirectory); err != nil {
		t.Fatal(err)
	}
	mapper, err := NewURIMapper(root)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{"uri": fileURI(filepath.Join(aliasDirectory, "main.go"))})
	if err != nil {
		t.Fatal(err)
	}
	out, err := mapper.RewriteOutbound(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "bobocloud-lsp:///alias/main.go") || strings.Contains(string(out), "bobocloud-lsp:///real/main.go") {
		t.Fatalf("workspace symlink alias identity was not preserved: %s", out)
	}
}

func TestURIMapperRedactsExternalServerPaths(t *testing.T) {
	mapper, _ := NewURIMapper(t.TempDir())
	out, err := mapper.RewriteOutbound([]byte(`{"jsonrpc":"2.0","id":1,"result":{"uri":"file:///private/dependency.rs"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "/private/") || !strings.Contains(string(out), "bobocloud-lsp-external:") {
		t.Fatalf("external path was not redacted: %s", out)
	}
}
