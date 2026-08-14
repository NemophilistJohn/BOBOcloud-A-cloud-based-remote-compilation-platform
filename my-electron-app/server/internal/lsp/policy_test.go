package lsp

import (
	"encoding/json"
	"testing"
)

func TestModeMethodPolicy(t *testing.T) {
	if ModeLocal.RemoteEnabled() {
		t.Fatal("local mode must not allocate remote resources")
	}
	standardAllowed := []string{"initialize", "textDocument/didOpen", "textDocument/didChange", "textDocument/completion", "completionItem/resolve", "textDocument/hover", "textDocument/definition", "textDocument/diagnostic", "textDocument/formatting", "textDocument/rangeFormatting", "$/cancelRequest"}
	for _, method := range standardAllowed {
		if !AllowsClientMethod(ModeStandard, method) {
			t.Fatalf("standard should allow %s", method)
		}
	}
	for _, method := range []string{"textDocument/references", "textDocument/rename", "workspace/symbol", "textDocument/semanticTokens/full"} {
		if AllowsClientMethod(ModeStandard, method) {
			t.Fatalf("standard unexpectedly allows %s", method)
		}
	}
	for _, method := range []string{"textDocument/references", "textDocument/rename", "workspace/symbol"} {
		if !AllowsClientMethod(ModeFull, method) {
			t.Fatalf("full should allow %s", method)
		}
	}
}

func TestValidateClientRPC(t *testing.T) {
	request := []byte(`{"jsonrpc":"2.0","id":1,"method":"workspace/symbol","params":{"query":"x"}}`)
	env, err := ValidateClientRPC(ModeStandard, request)
	if err == nil || env.Method != "workspace/symbol" {
		t.Fatalf("expected tier rejection, env=%+v err=%v", env, err)
	}
	if _, err := ValidateClientRPC(ModeFull, request); err != nil {
		t.Fatalf("full request rejected: %v", err)
	}
	response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 9, "result": []any{}})
	if _, err := ValidateClientRPC(ModeStandard, response); err != nil {
		t.Fatalf("response to server request must pass: %v", err)
	}
}

func TestServerRequestPolicy(t *testing.T) {
	for _, method := range []string{"workspace/configuration", "window/showMessageRequest", "window/showDocument"} {
		request := []byte(`{"jsonrpc":"2.0","id":5,"method":"` + method + `","params":{}}`)
		if _, err := ValidateServerRPC(request); err != nil {
			t.Fatalf("expected server request %s to be allowed: %v", method, err)
		}
	}
	if _, err := ValidateServerRPC([]byte(`{"jsonrpc":"2.0","id":6,"method":"workspace/executeCommand","params":{}}`)); err == nil {
		t.Fatal("unexpected server method should be rejected")
	}
}
