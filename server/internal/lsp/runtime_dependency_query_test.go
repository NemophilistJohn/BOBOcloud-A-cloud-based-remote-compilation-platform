package lsp

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRuntimeDependencyProbeFindsNodePrefixGlobalPackagesAndDollarExports(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is unavailable")
	}
	prefix := t.TempDir()
	writeDependencyAPIIndexTestFile(t, filepath.Join(prefix, "lib", "node_modules", "prefix-math", "package.json"), `{"types":"index.d.ts"}`)
	writeDependencyAPIIndexTestFile(t, filepath.Join(prefix, "lib", "node_modules", "prefix-math", "index.d.ts"), "export function $array(): void;\n")
	executable, _ := json.Marshal(filepath.Join(prefix, "bin", "node"))
	script := strings.Replace(runtimeNodeDependencyProbe, "process.execPath", string(executable), 1)
	image := "sha256:" + strings.Repeat("a", 64)
	for _, kind := range []string{"catalog", "module"} {
		module := ""
		if kind == "module" {
			module = "prefix-math"
		}
		page, err := runtimeDependencyAPIQuery(context.Background(), image, "node", "node:test", "rev", DependencyAPIQuery{Kind: kind, Module: module}, func(ctx context.Context, _, _, module string) ([]byte, error) {
			return exec.CommandContext(ctx, node, "--no-addons", "-e", script, module).Output()
		})
		if err != nil {
			t.Fatal(err)
		}
		if kind == "catalog" && !strings.Contains(strings.Join(page.Roots, ","), "prefix-math") {
			t.Fatalf("npm prefix package absent: %+v", page)
		}
		if kind == "module" && querySymbolNames(page, "prefix-math") != "$array" {
			t.Fatalf("Node dollar export absent: %+v", page)
		}
	}
}

func TestRuntimeDependencyPythonProbeResolvesConditionalBinaryReexports(t *testing.T) {
	python, err := exec.LookPath("python")
	if err != nil {
		t.Skip("python is unavailable")
	}
	root := t.TempDir()
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "numpy", "__init__.py"), "if __NUMPY_SETUP__:\n    pass\nelse:\n    from .core import *\n__all__ = ['warning']\n__all__ += core.__all__\n")
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "numpy", "core", "__init__.py"), "try:\n    from .multiarray import *\nexcept ImportError:\n    pass\n")
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "numpy", "core", "multiarray.py"), "from ._multiarray_umath import array, ndarray\n__all__ = ['array', 'ndarray']\n")
	encodedRoot, _ := json.Marshal(root)
	script := strings.Replace(runtimePythonDependencyProbe, "paths=[]", "paths=["+string(encodedRoot)+"]", 1)
	// This fixture tests extraction and response parsing. Give the CI host's
	// Python startup its own budget instead of measuring the production probe timeout.
	fixtureContext, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	output, err := exec.CommandContext(fixtureContext, python, "-I", "-S", "-c", script, "numpy").Output()
	if err != nil {
		t.Fatalf("run static Python fixture: %v", err)
	}
	image := "sha256:" + strings.Repeat("a", 64)
	page, err := runtimeDependencyAPIQuery(t.Context(), image, "python", "python:test", "rev", DependencyAPIQuery{Kind: "module", Module: "numpy"}, func(_ context.Context, _, _, _ string) ([]byte, error) {
		return output, nil
	})
	if err != nil || !strings.Contains(querySymbolNames(page, "numpy"), "array") {
		t.Fatalf("NumPy-shaped static binary reexports=%+v, %v", page, err)
	}
}

func TestRuntimeDependencyTransientFailuresRemainRetryable(t *testing.T) {
	session, _ := queryTestSession(t, "python", DependencyRolePythonPackages)
	session.Context.DependencyView.Mounts = nil
	session.Context.RuntimeDependencyRevision = "immutable-image"
	catalogCalls, moduleCalls := 0, 0
	session.Context.RuntimeDependencyQuery = func(_ context.Context, query DependencyAPIQuery) (DependencyAPIIndexPage, error) {
		if query.Kind == "catalog" {
			catalogCalls++
			if catalogCalls == 1 {
				return DependencyAPIIndexPage{}, ErrDependencyDiscoveryBusy
			}
		} else {
			moduleCalls++
			if moduleCalls == 1 {
				return DependencyAPIIndexPage{}, ErrDependencyDiscoveryBusy
			}
		}
		page := session.newDependencyQueryPage(query.Kind, query.Module, false)
		page.Roots = []string{"numpy"}
		if query.Kind == "module" {
			page.Entries = []DependencyAPIIndexEntry{{Module: "numpy", Kind: "module", Symbols: []DependencyAPIIndexSymbol{{Name: "array", Kind: "function"}}}}
		}
		return page, nil
	}
	if _, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "catalog"}); !errors.Is(err, ErrDependencyDiscoveryBusy) {
		t.Fatalf("catalog error=%v", err)
	}
	page, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "catalog"})
	if err != nil || !page.Complete || strings.Join(page.Roots, ",") != "numpy" {
		t.Fatalf("catalog retry=%+v, %v", page, err)
	}
	if _, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "numpy"}); !errors.Is(err, ErrDependencyDiscoveryBusy) {
		t.Fatalf("module error=%v", err)
	}
	if len(session.dependencyQueries.summaries) != 0 {
		t.Fatal("transient module failure was cached")
	}
	page, err = session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "numpy"})
	if err != nil || querySymbolNames(page, "numpy") != "array" || moduleCalls != 2 {
		t.Fatalf("module retry=%+v, %v calls=%d", page, err, moduleCalls)
	}
}

func TestRuntimeDependencyProbePinsImageAndNeverMountsWorkspace(t *testing.T) {
	image := "sha256:" + strings.Repeat("a", 64)
	for _, language := range []string{"python", "node"} {
		arguments, err := runtimeDependencyProbeArguments("bobocloud-lsp-probe-fixture", image, language, "numpy")
		if err != nil {
			t.Fatal(err)
		}
		joined := strings.Join(arguments, "\x00")
		for _, required := range []string{"--pull=never", "--network\x00none", "--read-only", "--cap-drop\x00ALL", "--memory\x00128m", "--cpus\x000.5", image} {
			if !strings.Contains(joined, required) {
				t.Fatalf("runtime probe missing %q", required)
			}
		}
		for _, argument := range arguments {
			if argument == "-v" || argument == "--mount" || argument == "--privileged" || argument == "--network=host" {
				t.Fatalf("runtime probe exposed privileged argument %q", argument)
			}
		}
	}
	if _, err := runtimeDependencyProbeArguments("bobocloud-lsp-probe-fixture", "python:latest", "python", "numpy"); err == nil {
		t.Fatal("runtime query accepted a mutable image tag")
	}
}

func TestRuntimeDependencyQueryValidatesProtocolBeforeExecution(t *testing.T) {
	image := "sha256:" + strings.Repeat("b", 64)
	calls := 0
	probe := func(_ context.Context, actualImage, language, module string) ([]byte, error) {
		calls++
		if actualImage != image || language != "python" || module != "numpy" {
			t.Fatalf("runtime query identity = %q %q %q", actualImage, language, module)
		}
		return []byte(`{"roots":["numpy"],"entries":[{"module":"numpy","kind":"module","symbols":[{"name":"array","kind":"function"}]}]}`), nil
	}
	page, err := runtimeDependencyAPIQuery(context.Background(), image, "python", "python:3.11", "combined-revision", DependencyAPIQuery{Kind: "module", Module: "numpy"}, probe)
	if err != nil || page.Revision != "combined-revision" || querySymbolNames(page, "numpy") != "array" || calls != 1 {
		t.Fatalf("runtime query = %+v, %v calls=%d", page, err, calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runtimeDependencyAPIQuery(ctx, image, "python", "python:3.11", "revision", DependencyAPIQuery{Kind: "catalog"}, probe); !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatalf("cancelled probe = %v calls=%d", err, calls)
	}
	if _, err := runtimeDependencyAPIQuery(context.Background(), image, "python", "python:3.11", "revision", DependencyAPIQuery{Kind: "module", Module: "../../private"}, probe); err == nil || calls != 1 {
		t.Fatalf("invalid probe = %v calls=%d", err, calls)
	}
}

func TestRuntimeDependencyQueryMergesImageCatalogAndInvalidatesByImageIdentity(t *testing.T) {
	session, _ := queryTestSession(t, "python", DependencyRolePythonPackages)
	session.Context.DependencyView.Mounts = nil
	session.Context.RuntimeDependencyRevision = "image-one"
	queries := []string{}
	session.Context.RuntimeDependencyQuery = func(_ context.Context, query DependencyAPIQuery) (DependencyAPIIndexPage, error) {
		queries = append(queries, query.Kind+":"+query.Module)
		page := session.newDependencyQueryPage(query.Kind, query.Module, false)
		page.Roots = []string{"numpy"}
		if query.Kind == "module" {
			page.Entries = []DependencyAPIIndexEntry{{Module: "numpy", Kind: "module", Symbols: []DependencyAPIIndexSymbol{{Name: "array", Kind: "function"}}}}
		}
		return page, nil
	}
	capability := session.DependencyAPIIndexCapability()
	if capability["enabled"] != true || capability["runtimeRevision"] != "image-one" {
		t.Fatalf("runtime-only index capability = %+v", capability)
	}
	page, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "catalog"})
	if err != nil || strings.Join(page.Roots, ",") != "numpy" || page.Revision == session.Context.DependencyView.Revision {
		t.Fatalf("runtime catalog = %+v, %v", page, err)
	}
	firstRevision := page.Revision
	module, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "numpy"})
	if err != nil || querySymbolNames(module, "numpy") != "array" || strings.Join(queries, ",") != "catalog:,module:numpy" {
		t.Fatalf("runtime module = %+v, %v queries=%+v", module, err, queries)
	}
	session.Context.RuntimeDependencyRevision = "image-two"
	page, err = session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "catalog"})
	if err != nil || firstRevision == page.Revision || len(queries) != 3 {
		t.Fatalf("image change reused old catalog = %+v, %v queries=%+v", page, err, queries)
	}
}
