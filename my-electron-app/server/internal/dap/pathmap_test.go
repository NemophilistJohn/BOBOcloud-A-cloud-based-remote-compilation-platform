package dap

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPathMapperRejectsWorkspaceEscapes(t *testing.T) {
	mapper := NewPathMapper()
	for _, value := range []string{"../secret", "a/../secret", "/workspace/../etc/passwd", "bobocloud-dap:///../secret", "C:\\outside\\file.go", "/etc/passwd"} {
		if _, err := mapper.ToContainer(value); err == nil {
			t.Fatalf("ToContainer(%q) accepted an escaping path", value)
		}
	}
	got, err := mapper.ToContainer("bobocloud-dap:///src/main.go")
	if err != nil || got != "/workspace/src/main.go" {
		t.Fatalf("mapped path = %q, %v", got, err)
	}
}

func TestRewriteInboundKeepsBareRuntimeExecutable(t *testing.T) {
	mapper := NewPathMapper()
	payload := []byte(`{"seq":2,"type":"request","command":"launch","arguments":{"program":"bobocloud-dap:///main.js","runtimeExecutable":"node"}}`)
	rewritten, err := mapper.RewriteInbound(payload, AdapterSpec{ID: "node-js-debug"})
	if err != nil {
		t.Fatal(err)
	}
	var message map[string]any
	_ = json.Unmarshal(rewritten, &message)
	arguments := message["arguments"].(map[string]any)
	if arguments["program"] != "/workspace/main.js" || arguments["runtimeExecutable"] != "node" {
		t.Fatalf("rewritten arguments = %#v", arguments)
	}
}

func TestRewriteOutboundOnlyChangesDAPSourcePaths(t *testing.T) {
	mapper := NewPathMapper()
	payload := []byte(`{"seq":3,"type":"event","event":"stopped","body":{"source":{"name":"main.py","path":"/workspace/main.py"},"metadata":{"path":"/workspace/private.json"}}}`)
	rewritten, err := mapper.RewriteOutbound(payload)
	if err != nil {
		t.Fatal(err)
	}
	text := string(rewritten)
	if !strings.Contains(text, `"path":"bobocloud-dap:///main.py"`) {
		t.Fatalf("source path was not rewritten: %s", text)
	}
	if !strings.Contains(text, `"path":"/workspace/private.json"`) {
		t.Fatalf("non-Source path was rewritten: %s", text)
	}
}
