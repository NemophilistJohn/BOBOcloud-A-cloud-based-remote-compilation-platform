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
