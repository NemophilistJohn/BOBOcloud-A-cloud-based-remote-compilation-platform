package lsp

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Mode controls how much semantic work is delegated to a remote language
// server. Local deliberately has no remote process and is handled entirely by
// the Electron client.
type Mode string

const (
	ModeLocal    Mode = "local"
	ModeStandard Mode = "standard"
	ModeFull     Mode = "full"
)

var lifecycleMethods = map[string]struct{}{
	"initialize": {}, "initialized": {}, "shutdown": {}, "exit": {},
	"$/cancelRequest": {}, "textDocument/didClose": {}, "textDocument/didSave": {},
}

var standardMethods = map[string]struct{}{
	"textDocument/didOpen": {}, "textDocument/didChange": {},
	"textDocument/completion": {}, "completionItem/resolve": {},
	"textDocument/hover": {}, "textDocument/definition": {},
	"textDocument/diagnostic": {}, "textDocument/formatting": {},
	"textDocument/rangeFormatting": {},
}

var fullMethods = map[string]struct{}{
	"textDocument/references": {}, "textDocument/rename": {},
	"textDocument/prepareRename": {}, "workspace/symbol": {},
	"workspaceSymbol/resolve": {}, "textDocument/documentSymbol": {},
	"textDocument/implementation": {}, "textDocument/typeDefinition": {},
	"textDocument/signatureHelp": {}, "textDocument/codeAction": {},
	"codeAction/resolve": {}, "textDocument/inlayHint": {},
	"inlayHint/resolve": {}, "textDocument/foldingRange": {},
	"textDocument/selectionRange":      {},
	"textDocument/semanticTokens/full": {}, "textDocument/semanticTokens/full/delta": {},
	"textDocument/semanticTokens/range": {}, "workspace/diagnostic": {},
}

// Server-initiated methods needed by common language servers. Responses do
// not carry a method and are always relayed to the process that requested them.
var serverMethods = map[string]struct{}{
	"textDocument/publishDiagnostics": {}, "window/logMessage": {},
	"window/showMessage": {}, "window/showMessageRequest": {},
	"window/showDocument": {}, "window/workDoneProgress/create": {},
	"$/progress": {}, "client/registerCapability": {},
	"client/unregisterCapability": {}, "workspace/configuration": {},
	"workspace/workspaceFolders": {}, "workspace/applyEdit": {},
	"telemetry/event":                  {},
	"workspace/semanticTokens/refresh": {}, "workspace/diagnostic/refresh": {},
	"workspace/inlayHint/refresh": {}, "workspace/codeLens/refresh": {},
}

func ParseMode(value string) (Mode, error) {
	switch Mode(strings.ToLower(strings.TrimSpace(value))) {
	case ModeLocal:
		return ModeLocal, nil
	case ModeStandard:
		return ModeStandard, nil
	case ModeFull:
		return ModeFull, nil
	default:
		return "", fmt.Errorf("unsupported LSP mode %q", value)
	}
}

func (m Mode) RemoteEnabled() bool { return m == ModeStandard || m == ModeFull }

func AllowsClientMethod(mode Mode, method string) bool {
	if !mode.RemoteEnabled() {
		return false
	}
	if _, ok := lifecycleMethods[method]; ok {
		return true
	}
	if _, ok := standardMethods[method]; ok {
		return true
	}
	if mode == ModeFull {
		_, ok := fullMethods[method]
		return ok
	}
	return false
}

func AllowsServerMethod(method string) bool {
	_, ok := serverMethods[method]
	return ok
}

func AllowedMethods(mode Mode) []string {
	if !mode.RemoteEnabled() {
		return []string{}
	}
	set := make(map[string]struct{}, len(lifecycleMethods)+len(standardMethods)+len(fullMethods))
	for method := range lifecycleMethods {
		set[method] = struct{}{}
	}
	for method := range standardMethods {
		set[method] = struct{}{}
	}
	if mode == ModeFull {
		for method := range fullMethods {
			set[method] = struct{}{}
		}
	}
	out := make([]string, 0, len(set))
	for method := range set {
		out = append(out, method)
	}
	sort.Strings(out)
	return out
}

type rpcEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
}

// ValidateClientRPC rejects malformed JSON-RPC and methods outside the
// selected tier. A response to a server-initiated request has no method and is
// allowed as long as it has an id.
func ValidateClientRPC(mode Mode, raw []byte) (rpcEnvelope, error) {
	var env rpcEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return env, fmt.Errorf("invalid JSON-RPC: %w", err)
	}
	if env.JSONRPC != "2.0" {
		return env, fmt.Errorf("jsonrpc must be 2.0")
	}
	if env.Method == "" {
		if len(env.ID) == 0 || string(env.ID) == "null" {
			return env, fmt.Errorf("JSON-RPC response is missing id")
		}
		return env, nil
	}
	if !AllowsClientMethod(mode, env.Method) {
		return env, fmt.Errorf("method %q is not available in %s mode", env.Method, mode)
	}
	return env, nil
}

func ValidateServerRPC(raw []byte) (rpcEnvelope, error) {
	var env rpcEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return env, fmt.Errorf("invalid JSON-RPC from language server: %w", err)
	}
	if env.JSONRPC != "2.0" {
		return env, fmt.Errorf("language server response is not JSON-RPC 2.0")
	}
	if env.Method != "" && !AllowsServerMethod(env.Method) {
		return env, fmt.Errorf("language server method %q is not allowed", env.Method)
	}
	return env, nil
}
