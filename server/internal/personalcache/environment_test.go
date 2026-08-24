package personalcache

import "testing"

func TestTerminalDependencyDockerEnvironmentUsesEphemeralTargets(t *testing.T) {
	tests := []struct {
		language string
		key      string
		want     string
	}{
		{language: "python", key: "PIP_TARGET", want: "/tmp/bobocloud-terminal-deps/python"},
		{language: "node", key: "NODE_PATH", want: "/workspace/node_modules:/project-deps/node_modules"},
		{language: "go", key: "GOMODCACHE", want: "/tmp/bobocloud-terminal-deps/go/pkg/mod"},
		{language: "rust", key: "CARGO_HOME", want: "/tmp/bobocloud-terminal-deps/cargo"},
		{language: "java", key: "GRADLE_USER_HOME", want: "/tmp/bobocloud-terminal-deps/gradle"},
	}
	for _, test := range tests {
		t.Run(test.language, func(t *testing.T) {
			env := TerminalDependencyDockerEnvironment(test.language, true)
			if got := env[test.key]; got != test.want {
				t.Fatalf("%s=%q, want %q", test.key, got, test.want)
			}
		})
	}
	pythonWithoutBase := TerminalDependencyDockerEnvironment("python", false)
	if got := pythonWithoutBase["PYTHONPATH"]; got != "/tmp/bobocloud-terminal-deps/python" {
		t.Fatalf("PYTHONPATH=%q should not expose a missing published generation", got)
	}
}

func TestTerminalDependencyDockerEnvironmentNeverTargetsPublishedCache(t *testing.T) {
	for _, language := range []string{"python", "node", "go", "rust", "java"} {
		env := TerminalDependencyDockerEnvironment(language, true)
		for _, destination := range []string{"PIP_TARGET", "GOPATH", "GOMODCACHE", "CARGO_HOME", "CARGO_TARGET_DIR", "GRADLE_USER_HOME"} {
			if env[destination] == "/project-deps" || env[destination] == "/project-deps/python" || env[destination] == "/project-deps/go" {
				t.Fatalf("%s %s points at immutable project dependencies", language, destination)
			}
		}
	}
}
