package dap

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func hasDAPArgPair(args []string, flag, value string) bool {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == flag && args[index+1] == value {
			return true
		}
	}
	return false
}

func TestDAPEnvironmentKeepsPersistForDownloadsAndBuildsOnly(t *testing.T) {
	env := dapEnvironment(LaunchSpec{Adapter: AdapterSpec{LanguageID: "python", RuntimeID: "python:3.11"}})
	for _, key := range []string{"PYTHONPATH", "NODE_PATH", "NPM_CONFIG_PREFIX", "GOPATH", "GOMODCACHE"} {
		if value := env[key]; value != "" {
			t.Fatalf("legacy installed dependency environment %s=%q was retained", key, value)
		}
	}
	if env["PIP_CACHE_DIR"] != "/persist/pip-cache" || env["GOCACHE"] != "/persist/go-cache" || env["NPM_CONFIG_CACHE"] != "/persist/npm-cache" {
		t.Fatalf("download/build cache environment = %#v", env)
	}
	for _, value := range env {
		if strings.Contains(value, "/persist/pip-packages") || strings.Contains(value, "/persist/npm-global/lib/node_modules") || strings.Contains(value, "/persist/go/pkg/mod") {
			t.Fatalf("legacy dependency path survived in %#v", env)
		}
	}
}

func TestDockerRunArgsMountProjectDependenciesReadOnly(t *testing.T) {
	workspace := t.TempDir()
	persist := t.TempDir()
	dependencies := t.TempDir()
	spec := LaunchSpec{
		SessionID: "session", UserID: "user", Workspace: workspace, PersistDir: persist,
		DependencyRoot: dependencies, DependencyEnv: map[string]string{"PYTHONPATH": "/project-deps/python"},
		Adapter: AdapterSpec{LanguageID: "python", RuntimeID: "python:3.11"}, NetworkEnable: true,
	}
	args, err := dockerRunArgs(spec, "dap-test", false)
	if err != nil {
		t.Fatal(err)
	}
	absoluteDependencies, _ := filepath.Abs(dependencies)
	absolutePersist, _ := filepath.Abs(persist)
	if hasDAPArgPair(args, "-v", absolutePersist+":/persist:rw") {
		t.Fatalf("the complete persist tree was mounted writable: %v", args)
	}
	for _, cacheDirectory := range []string{"pip-cache", "go-cache", "npm-cache"} {
		hostCache := filepath.Join(absolutePersist, cacheDirectory)
		if !hasDAPArgPair(args, "-v", hostCache+":/persist/"+cacheDirectory+":rw") {
			t.Fatalf("writable %s mount missing from %v", cacheDirectory, args)
		}
	}
	if !hasDAPArgPair(args, "-v", absoluteDependencies+":/project-deps:ro") {
		t.Fatalf("dependency mount missing from %v", args)
	}
	if !hasDAPArgPair(args, "-e", "PYTHONPATH=/project-deps/python") {
		t.Fatalf("dependency environment missing from %v", args)
	}
}

func TestDockerRunArgsMountNodeModulesAtWorkspaceReadOnly(t *testing.T) {
	dependencies := t.TempDir()
	nodeModules := filepath.Join(dependencies, "node_modules")
	if err := os.Mkdir(nodeModules, 0700); err != nil {
		t.Fatal(err)
	}
	args, err := dockerRunArgs(LaunchSpec{
		SessionID: "session", UserID: "user", Workspace: t.TempDir(), DependencyRoot: dependencies,
		DependencyEnv: map[string]string{"NODE_PATH": "/workspace/node_modules"},
		Adapter:       AdapterSpec{LanguageID: "node", RuntimeID: "node:22"}, NetworkEnable: true,
	}, "dap-node-test", false)
	if err != nil {
		t.Fatal(err)
	}
	absoluteNodeModules, _ := filepath.Abs(nodeModules)
	if !hasDAPArgPair(args, "-v", absoluteNodeModules+":"+ContainerRoot+"/node_modules:ro") {
		t.Fatalf("read-only node_modules mount missing from %v", args)
	}
}
