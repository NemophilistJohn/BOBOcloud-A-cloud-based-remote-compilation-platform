package personalcache

import "strings"

// ReadOnlyDependencyDockerEnvironment is for consumers that mount one project
// dependency namespace read-only at /project-deps. It deliberately excludes
// installer destinations and build-output directories.
func ReadOnlyDependencyDockerEnvironment(language string) map[string]string {
	switch strings.ToLower(strings.TrimSpace(language)) {
	case "python":
		return map[string]string{"PYTHONPATH": "/project-deps/python"}
	case "node":
		return map[string]string{"NODE_PATH": "/workspace/node_modules", "BOBOCLOUD_NODE_MODULES": "/project-deps/node_modules"}
	case "go":
		return map[string]string{"GOPATH": "/tmp/bobocloud-go", "GOMODCACHE": "/project-deps/go/pkg/mod"}
	default:
		return map[string]string{}
	}
}

// TerminalDependencyDockerEnvironment layers session-local installer targets
// ahead of the immutable project generation. Interactive installs remain usable
// until the terminal closes without publishing bytes under an unchanged lock
// digest.
func TerminalDependencyDockerEnvironment(language string, hasPublishedBase bool) map[string]string {
	const terminalRoot = "/tmp/bobocloud-terminal-deps"
	switch strings.ToLower(strings.TrimSpace(language)) {
	case "python":
		pythonPath := terminalRoot + "/python"
		if hasPublishedBase {
			pythonPath += ":/project-deps/python"
		}
		return map[string]string{
			"PIP_TARGET":    terminalRoot + "/python",
			"PIP_CACHE_DIR": terminalRoot + "/pip-cache",
			"PYTHONPATH":    pythonPath,
		}
	case "node":
		nodePath := "/workspace/node_modules"
		if hasPublishedBase {
			nodePath += ":/project-deps/node_modules"
		}
		return map[string]string{
			"NODE_PATH":        nodePath,
			"NPM_CONFIG_CACHE": terminalRoot + "/npm-cache",
		}
	case "go":
		return map[string]string{
			"GOPATH":     terminalRoot + "/go",
			"GOMODCACHE": terminalRoot + "/go/pkg/mod",
			"GOCACHE":    terminalRoot + "/go-build-cache",
		}
	case "rust":
		return map[string]string{
			"CARGO_HOME":       terminalRoot + "/cargo",
			"CARGO_TARGET_DIR": "/workspace/target",
		}
	case "java":
		return map[string]string{
			"MAVEN_OPTS":       "-Dmaven.repo.local=" + terminalRoot + "/maven",
			"GRADLE_USER_HOME": terminalRoot + "/gradle",
		}
	default:
		return map[string]string{}
	}
}
