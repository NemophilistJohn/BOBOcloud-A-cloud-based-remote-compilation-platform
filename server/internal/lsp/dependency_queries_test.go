package lsp

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDependencyQueriesCatalogDiscoveryIsProgressiveAndCursorsRemainStable(t *testing.T) {
	session, root := queryTestSession(t, "cpp", DependencyRoleNativeIncludes)
	for index := 0; index < 180; index++ {
		writeDependencyAPIIndexTestFile(t, filepath.Join(root, fmt.Sprintf("library%03d", index), "api.hpp"), "int public_api();\n")
	}
	page, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "catalog"})
	if err != nil || page.Complete || page.NextCursor == "" || len(page.Roots) >= 180 {
		t.Fatalf("catalog eagerly scanned all directories = %+v, %v", page, err)
	}
	seen := map[string]bool{}
	for count := 0; count < 20; count++ {
		for _, name := range page.Roots {
			if seen[name] {
				t.Fatalf("catalog repeated %s across cursors", name)
			}
			seen[name] = true
		}
		if page.Complete {
			break
		}
		previous := page.NextCursor
		page, err = session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "catalog", Cursor: previous})
		if err != nil || !page.Complete && page.NextCursor == previous {
			t.Fatalf("catalog failed to advance = %+v, %v", page, err)
		}
	}
	if !page.Complete || len(seen) != 180 {
		t.Fatalf("progressive catalog missed libraries: %d complete=%v", len(seen), page.Complete)
	}
}

func TestDependencyQueriesCachedPythonChildrenResolveFilesAfterReconnect(t *testing.T) {
	session, root := queryTestSession(t, "python", DependencyRolePythonPackages)
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "numpy", "__init__.pyi"), "from .core import *\n")
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "numpy", "core.pyi"), "def array(values): ...\n")
	if _, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "numpy"}); err != nil {
		t.Fatal(err)
	}
	reconnected := &Session{ID: "reconnected", stopping: make(chan struct{}), Context: session.Context, Cache: session.Cache}
	page, err := reconnected.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "numpy.core"})
	if err != nil || querySymbolNames(page, "numpy.core") != "array" {
		t.Fatalf("cached child file = %+v, %v", page, err)
	}
}

func TestDependencyQuerySummaryLRUPreservesWarmEntries(t *testing.T) {
	state := &dependencyQueryState{summaries: make(map[string]DependencyAPIIndexPage)}
	for index := 0; index < dependencyQueryMaxSummaries; index++ {
		name := fmt.Sprintf("module%d", index)
		state.cacheDependencySummary(name, DependencyAPIIndexPage{Module: name})
	}
	state.touchDependencySummary("module0")
	state.cacheDependencySummary("newModule", DependencyAPIIndexPage{Module: "newModule"})
	if len(state.summaries) != dependencyQueryMaxSummaries || state.summaries["module0"].Module == "" || state.summaries["newModule"].Module == "" {
		t.Fatal("overflow cleared hot summaries")
	}
	if _, exists := state.summaries["module1"]; exists {
		t.Fatal("overflow retained least recently used summary")
	}
}

func queryTestSession(t *testing.T, language, role string) (*Session, string) {
	t.Helper()
	root := t.TempDir()
	return &Session{
		ID: "query-session", stopping: make(chan struct{}), Cache: CacheNamespace{Path: t.TempDir()},
		Context: SessionContext{LanguageID: language, RuntimeID: language + ":test", DependencyResolved: true,
			DependencyView: AnalysisDependencyView{LanguageID: language, Revision: "generation-one", Mounts: []AnalysisDependencyMount{{Role: role, HostPath: root, ReadOnly: true}}}},
	}, root
}

func querySymbolNames(page DependencyAPIIndexPage, module string) string {
	for _, entry := range page.Entries {
		if entry.Module == module {
			return strings.Join(indexSymbolNames(entry), ",")
		}
	}
	return ""
}

func TestDependencyQueriesCatalogDoesNotParsePythonAndModuleResolvesExports(t *testing.T) {
	session, root := queryTestSession(t, "python", DependencyRolePythonPackages)
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "numpy", "__init__.pyi"), "from .core import *\n")
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "numpy", "core.pyi"), "def array(values): ...\nclass Matrix: ...\n")
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "namespace", "child.py"), "value=1\n")
	catalog, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "catalog"})
	if err != nil || strings.Join(catalog.Roots, ",") != "namespace,numpy" || len(catalog.Entries[0].Symbols) != 0 {
		t.Fatalf("catalog = %+v, %v", catalog, err)
	}
	if len(session.dependencyQueries.summaries) != 0 {
		t.Fatal("catalog request parsed module source")
	}
	summary, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "numpy"})
	if err != nil || querySymbolNames(summary, "numpy") != "Matrix,array" {
		t.Fatalf("numpy module = %+v, %v", summary, err)
	}
	if strings.Contains(string(mustQueryJSON(t, summary)), filepath.ToSlash(root)) {
		t.Fatal("module summary exposed a host path")
	}
}

func mustQueryJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestDependencyQueriesProjectAdvancesAndBindsCursorToSession(t *testing.T) {
	session, root := queryTestSession(t, "python", DependencyRolePythonPackages)
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "alpha", "__init__.py"), "def first(): pass\n")
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "alpha", "child.py"), "def second(): pass\n")
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "beta.py"), "def third(): pass\n")
	page, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "project"})
	if err != nil || page.Module != "alpha" || page.Complete || page.NextCursor == "" {
		t.Fatalf("first project page = %+v, %v", page, err)
	}
	cursor := page.NextCursor
	seen := map[string]bool{page.Module: true}
	for count := 0; !page.Complete && count < 10; count++ {
		page, err = session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "project", Cursor: page.NextCursor})
		if err != nil {
			t.Fatal(err)
		}
		seen[page.Module] = true
	}
	if !page.Complete || !seen["beta"] || !seen["alpha.child"] {
		t.Fatalf("project skipped a module: %+v", seen)
	}
	session.ID = "replacement-session"
	if _, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "project", Cursor: cursor}); err != ErrDependencyAPIIndexCursor {
		t.Fatalf("foreign cursor error = %v", err)
	}
	close(session.stopping)
	if _, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "catalog"}); err != ErrDependencyAPIIndexUnavailable {
		t.Fatalf("stopped query error = %v", err)
	}
}

func TestDependencyQueriesNodeScopedExportsAndDeclarations(t *testing.T) {
	session, root := queryTestSession(t, "typescript", DependencyRoleNodeModules)
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "@scope", "math", "package.json"), `{"name":"@scope/math","types":"index.d.ts","exports":{".":{"types":"./index.d.ts"},"./matrix":{"types":"./matrix.d.ts"}}}`)
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "@scope", "math", "index.d.ts"), "export declare function array(): unknown;\nexport interface Matrix {}\nexport const $array: unknown;\nconst privateLocal = 1;\n")
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "@scope", "math", "matrix.d.ts"), "export class Vector {}\n")
	catalog, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "catalog"})
	if err != nil || strings.Join(catalog.Roots, ",") != "@scope/math" || catalog.LanguageID != "node" {
		t.Fatalf("node catalog = %+v, %v", catalog, err)
	}
	module, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "@scope/math"})
	if err != nil || querySymbolNames(module, "@scope/math") != "$array,Matrix,array" {
		t.Fatalf("node module = %+v, %v", module, err)
	}
	child, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "@scope/math/matrix"})
	if err != nil || querySymbolNames(child, "@scope/math/matrix") != "Vector" {
		t.Fatalf("node subpath = %+v, %v", child, err)
	}
}

func TestDependencyQueriesGoRustJavaAndNativeUseRealSources(t *testing.T) {
	t.Run("go", func(t *testing.T) {
		session, root := queryTestSession(t, "go", DependencyRoleGoModules)
		writeDependencyAPIIndexTestFile(t, filepath.Join(root, "example.com", "math@v1.0.0", "go.mod"), "module example.com/math\n")
		writeDependencyAPIIndexTestFile(t, filepath.Join(root, "example.com", "math@v1.0.0", "math.go"), "package math\nfunc Array() {}\nfunc private() {}\ntype Matrix struct {}\n")
		page, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "example.com/math"})
		if err != nil || querySymbolNames(page, "example.com/math") != "Array,Matrix" {
			t.Fatalf("Go module = %+v, %v", page, err)
		}
	})
	t.Run("rust", func(t *testing.T) {
		session, root := queryTestSession(t, "rust", DependencyRoleRustRegistrySrc)
		writeDependencyAPIIndexTestFile(t, filepath.Join(root, "registry", "my-math-1.0.0", "Cargo.toml"), "[package]\nname = \"my-math\"\n")
		writeDependencyAPIIndexTestFile(t, filepath.Join(root, "registry", "my-math-1.0.0", "src", "lib.rs"), "pub fn array() {}\npub struct Matrix {}\nfn private() {}\n")
		page, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "my_math"})
		if err != nil || querySymbolNames(page, "my_math") != "Matrix,array" {
			t.Fatalf("Rust module = %+v, %v", page, err)
		}
	})
	t.Run("java", func(t *testing.T) {
		session, root := queryTestSession(t, "java", DependencyRoleJavaMaven)
		var output bytes.Buffer
		archive := zip.NewWriter(&output)
		for _, name := range []string{"com/example/Matrix.class", "com/example/Vector.class", "META-INF/module-info.class"} {
			file, err := archive.Create(name)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = file.Write([]byte("fixture"))
		}
		if err := archive.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "math.jar"), output.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		page, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "com.example"})
		if err != nil || querySymbolNames(page, "com.example") != "Matrix,Vector" {
			t.Fatalf("Java module = %+v, %v", page, err)
		}
	})
	t.Run("cpp", func(t *testing.T) {
		session, root := queryTestSession(t, "cpp", DependencyRoleNativeIncludes)
		writeDependencyAPIIndexTestFile(t, filepath.Join(root, "math", "array.hpp"), "int array(int value);\n")
		page, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "math/array.hpp"})
		if err != nil || querySymbolNames(page, "math/array.hpp") != "array" {
			t.Fatalf("native header = %+v, %v", page, err)
		}
	})
}

func TestDependencyQueriesRejectInvalidNamesAndManifestTraversal(t *testing.T) {
	for _, query := range []DependencyAPIQuery{
		{Kind: "module", Module: "../private"}, {Kind: "module", Module: "/root/private"},
		{Kind: "module", Module: ""}, {Kind: "execute", Module: "numpy"},
	} {
		if err := ValidateDependencyAPIQuery(query); err == nil {
			t.Fatalf("unsafe query accepted: %+v", query)
		}
	}
	session, root := queryTestSession(t, "node", DependencyRoleNodeModules)
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "unsafe", "package.json"), `{"types":"../../secret.d.ts"}`)
	writeDependencyAPIIndexTestFile(t, filepath.Join(root, "secret.d.ts"), "export function privateFile(): void;\n")
	page, err := session.DependencyAPIQueryPage(DependencyAPIQuery{Kind: "module", Module: "unsafe"})
	if err != nil || querySymbolNames(page, "unsafe") != "" || page.Coverage != "unavailable" {
		t.Fatalf("traversal summary = %+v, %v", page, err)
	}
}
