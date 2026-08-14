package lsp

import (
	"encoding/json"
	"testing"
)

func TestDependencyPublicStatusMarksLegacyViewsAsMixed(t *testing.T) {
	view := AnalysisDependencyView{
		LanguageID: "python", RuntimeID: "python:3.10", Revision: "revision",
		Mounts: []AnalysisDependencyMount{{Role: DependencyRolePythonPackages, Legacy: true}},
	}
	status := view.PublicStatus(true, "user")
	if status.Status != "mixed" || status.Source != "mixed" {
		t.Fatalf("legacy dependency status = %+v", status)
	}
}

func TestMergeDependencyInitializationOptionsPreservesUserAndOverridesServerFields(t *testing.T) {
	payload := []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":"file:///workspace","initializationOptions":{"tsserver":{"path":"/client/tsserver.js","logVerbosity":"verbose"},"other":{"enabled":true}}}}`)
	merged, err := MergeDependencyInitializationOptions(payload, map[string]any{
		"tsserver": map[string]any{"path": "/opt/node-lsp/typescript/lib/tsserver.js"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var request map[string]any
	if err := json.Unmarshal(merged, &request); err != nil {
		t.Fatal(err)
	}
	params := request["params"].(map[string]any)
	options := params["initializationOptions"].(map[string]any)
	tsserver := options["tsserver"].(map[string]any)
	if tsserver["path"] != "/opt/node-lsp/typescript/lib/tsserver.js" || tsserver["logVerbosity"] != "verbose" {
		t.Fatalf("merged tsserver options = %+v", tsserver)
	}
	if other := options["other"].(map[string]any); other["enabled"] != true {
		t.Fatalf("user initialization options were lost: %+v", options)
	}
}

func TestMergeDependencyInitializationOptionsRejectsNonInitializePayload(t *testing.T) {
	if _, err := MergeDependencyInitializationOptions([]byte(`{"jsonrpc":"2.0","method":"initialized","params":{}}`), map[string]any{"owned": true}); err == nil {
		t.Fatal("non-initialize payload accepted dependency initialization options")
	}
}
