package lsp

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeDependencyAPIIndexTestFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
}

func testDependencyAPIIndexView(root, revision string) AnalysisDependencyView {
	return AnalysisDependencyView{
		LanguageID: "python", RuntimeID: "python:3.10", Revision: revision,
		Mounts: []AnalysisDependencyMount{{Role: DependencyRolePythonPackages, HostPath: root, ReadOnly: true}},
	}
}

func indexEntryByModule(index *DependencyAPIIndex, module string) (DependencyAPIIndexEntry, bool) {
	for _, entry := range index.Entries {
		if entry.Module == module {
			return entry, true
		}
	}
	return DependencyAPIIndexEntry{}, false
}

func indexSymbolNames(entry DependencyAPIIndexEntry) []string {
	names := make([]string, 0, len(entry.Symbols))
	for _, symbol := range entry.Symbols {
		names = append(names, symbol.Name)
	}
	return names
}

func TestBuildPythonDependencyAPIIndexStaticTreeAndExports(t *testing.T) {
	packages := filepath.Join(t.TempDir(), "site-packages")
	writeDependencyAPIIndexTestFile(t, filepath.Join(packages, "numpy", "__init__.py"), `
from .core import array, Matrix
from .sub import *
__all__ = ("array", "Matrix", "visible")
_private = "no"
`)
	writeDependencyAPIIndexTestFile(t, filepath.Join(packages, "numpy", "core.py"), `
def array(values):
    return values

class Matrix:
    pass

_hidden = 1
`)
	writeDependencyAPIIndexTestFile(t, filepath.Join(packages, "numpy", "sub", "__init__.pyi"), `
def visible() -> None: ...
class Vector: ...
__all__ = ["visible", "Vector"]
`)
	writeDependencyAPIIndexTestFile(t, filepath.Join(packages, "requests.py"), "VERSION = '1'\n")
	writeDependencyAPIIndexTestFile(t, filepath.Join(packages, "bad-name.py"), "x = 1\n")

	index, err := buildPythonDependencyAPIIndex("python:3.10", testDependencyAPIIndexView(packages, "revision-one"))
	if err != nil {
		t.Fatal(err)
	}
	if index.Schema != DependencyAPIIndexSchema || index.LanguageID != "python" || index.RuntimeID != "python:3.10" || index.Revision != "revision-one" {
		t.Fatalf("unexpected index identity: %+v", index)
	}
	root, found := indexEntryByModule(index, "numpy")
	if !found || root.Kind != "package" {
		t.Fatalf("missing numpy package entry: %+v", index.Entries)
	}
	if strings.Join(indexSymbolNames(root), ",") != "Matrix,array,visible" {
		t.Fatalf("numpy exports = %+v", root.Symbols)
	}
	core, found := indexEntryByModule(index, "numpy.core")
	if !found || strings.Join(indexSymbolNames(core), ",") != "Matrix,array" {
		t.Fatalf("numpy.core exports = %+v", core)
	}
	sub, found := indexEntryByModule(index, "numpy.sub")
	if !found || strings.Join(indexSymbolNames(sub), ",") != "Vector,visible" {
		t.Fatalf("numpy.sub exports = %+v", sub)
	}
	if _, found := indexEntryByModule(index, "bad-name"); found {
		t.Fatalf("invalid Python module reached index: %+v", index.Entries)
	}
	if !validDependencyAPIIndex(index, "python", "python:3.10", "revision-one") {
		t.Fatalf("built index failed validation: %+v", index)
	}
}

func TestBuildPythonDependencyAPIIndexCollectsNumpyStyleGuardedReexports(t *testing.T) {
	packages := filepath.Join(t.TempDir(), "site-packages")
	writeDependencyAPIIndexTestFile(t, filepath.Join(packages, "numpy", "__init__.py"), `
if __NUMPY_SETUP__:
    from ._setup import setup_only
else:
    from ._core import array, ndarray
    from ._core import *
    if True:
        from ._nested import nested_only
    def local_helper():
        from ._nested import function_only
    class LocalHolder:
        from ._nested import class_only

try:
    from ._core import ndarray as ndarray_type
except ImportError:
    from ._core import array as fallback_array
`)
	writeDependencyAPIIndexTestFile(t, filepath.Join(packages, "numpy", "_core", "__init__.py"), `
def array(values=None):
    return values

class ndarray:
    pass
`)
	writeDependencyAPIIndexTestFile(t, filepath.Join(packages, "numpy", "_nested.py"), `
def nested_only():
    pass
def function_only():
    pass
def class_only():
    pass
`)

	index, err := buildPythonDependencyAPIIndex("python:3.10", testDependencyAPIIndexView(packages, "revision-numpy-guard"))
	if err != nil {
		t.Fatal(err)
	}
	root, found := indexEntryByModule(index, "numpy")
	if !found {
		t.Fatalf("missing numpy package entry: %+v", index.Entries)
	}
	symbols := strings.Join(indexSymbolNames(root), ",")
	for _, expected := range []string{"array", "ndarray", "ndarray_type", "fallback_array"} {
		if !strings.Contains(","+symbols+",", ","+expected+",") {
			t.Fatalf("guarded numpy re-export %q was not indexed: %+v", expected, root.Symbols)
		}
	}
	for _, forbidden := range []string{"nested_only", "function_only", "class_only"} {
		if strings.Contains(","+symbols+",", ","+forbidden+",") {
			t.Fatalf("nested Python suite leaked into package exports: %+v", root.Symbols)
		}
	}
}

func TestBuildPythonDependencyAPIIndexBoundsTopLevelCandidatesAndStaticExports(t *testing.T) {
	packages := filepath.Join(t.TempDir(), "site-packages")
	writeDependencyAPIIndexTestFile(t, filepath.Join(packages, "numpy", "__init__.py"), "def array(): pass\n")
	for index := 0; index < dependencyAPIIndexMaxDirectoryItems+48; index++ {
		name := fmt.Sprintf("aaa%04d.dist-info", index)
		if err := os.MkdirAll(filepath.Join(packages, name), 0755); err != nil {
			t.Fatal(err)
		}
	}
	index, err := buildPythonDependencyAPIIndex("python:3.10", testDependencyAPIIndexView(packages, "revision-large"))
	if err != nil {
		t.Fatal(err)
	}
	if _, found := indexEntryByModule(index, "numpy"); !found {
		t.Fatalf("candidate module was lost behind package metadata directories: %+v", index.Entries)
	}

	values := make([]string, 0, dependencyAPIIndexMaxAllExportsPerModule+32)
	for symbol := 0; symbol < dependencyAPIIndexMaxAllExportsPerModule+32; symbol++ {
		values = append(values, fmt.Sprintf("item%d", symbol))
	}
	writeDependencyAPIIndexTestFile(t, filepath.Join(packages, "large", "__init__.py"), "__all__ = [\""+strings.Join(values, "\",\"")+"\"]\n")
	bounded, err := buildPythonDependencyAPIIndex("python:3.10", testDependencyAPIIndexView(packages, "revision-bounded"))
	if err != nil {
		t.Fatal(err)
	}
	entry, found := indexEntryByModule(bounded, "large")
	if !found || len(entry.Symbols) != dependencyAPIIndexMaxSymbolsPerModule || !bounded.Truncated {
		t.Fatalf("static exports were not bounded: entry=%+v truncated=%t", entry, bounded.Truncated)
	}
}

func TestDependencyAPIIndexPageIsBoundedAndCursorIsRevisionBound(t *testing.T) {
	entries := make([]DependencyAPIIndexEntry, 0, 128)
	for index := 0; index < 128; index++ {
		symbols := make([]DependencyAPIIndexSymbol, 0, 128)
		for symbol := 0; symbol < 128; symbol++ {
			symbols = append(symbols, DependencyAPIIndexSymbol{Name: fmt.Sprintf("value%03d_%03d_%s", index, symbol, strings.Repeat("x", 96)), Kind: "function"})
		}
		entries = append(entries, DependencyAPIIndexEntry{Module: fmt.Sprintf("package%03d", index), Kind: "module", Symbols: symbols})
	}
	index := &DependencyAPIIndex{Schema: DependencyAPIIndexSchema, LanguageID: "python", RuntimeID: "python:3.10", Revision: "revision-one", Entries: entries}
	page, err := dependencyAPIIndexPage(index, "", DependencyAPIIndexPageMinBytes)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(page)
	if err != nil || len(data) > DependencyAPIIndexPageMinBytes {
		t.Fatalf("page exceeded requested bound: bytes=%d err=%v page=%+v", len(data), err, page)
	}
	control, err := dependencyAPIIndexControlPayload(page)
	if err != nil || len(control) > DependencyAPIIndexPageMinBytes {
		t.Fatalf("control page exceeded requested bound: bytes=%d err=%v page=%+v", len(control), err, page)
	}
	if page.NextCursor == "" || page.Complete {
		t.Fatalf("expected a paginated fragment: %+v", page)
	}
	if _, err := dependencyAPIIndexPage(index, page.NextCursor, DependencyAPIIndexPageMinBytes); err != nil {
		t.Fatalf("valid cursor rejected: %v", err)
	}
	index.Revision = "revision-two"
	if _, err := dependencyAPIIndexPage(index, page.NextCursor, DependencyAPIIndexPageMinBytes); err != ErrDependencyAPIIndexCursor {
		t.Fatalf("cursor survived dependency revision change: %v", err)
	}
}

func TestLoadOrBuildDependencyAPIIndexUsesSchemaRuntimeAndRevision(t *testing.T) {
	packages := filepath.Join(t.TempDir(), "site-packages")
	cache := filepath.Join(t.TempDir(), "cache")
	if err := os.MkdirAll(cache, 0755); err != nil {
		t.Fatal(err)
	}
	writeDependencyAPIIndexTestFile(t, filepath.Join(packages, "numpy", "__init__.py"), "def array(): pass\n")
	view := testDependencyAPIIndexView(packages, "revision-one")
	first, err := loadOrBuildDependencyAPIIndex(cache, "python", "python:3.10", view)
	if err != nil || len(first.Entries) == 0 {
		t.Fatalf("first index = %+v err=%v", first, err)
	}
	writeDependencyAPIIndexTestFile(t, filepath.Join(packages, "numpy", "__init__.py"), "def changed(): pass\n")
	second, err := loadOrBuildDependencyAPIIndex(cache, "python", "python:3.10", view)
	if err != nil || !strings.Contains(strings.Join(indexSymbolNames(second.Entries[0]), ","), "array") {
		t.Fatalf("same revision should retain durable cache: %+v err=%v", second, err)
	}
	view.Revision = "revision-two"
	third, err := loadOrBuildDependencyAPIIndex(cache, "python", "python:3.10", view)
	if err != nil || !strings.Contains(strings.Join(indexSymbolNames(third.Entries[0]), ","), "changed") {
		t.Fatalf("revision did not rebuild durable cache: %+v err=%v", third, err)
	}
	if _, err := loadOrBuildDependencyAPIIndex(cache, "python", "python:3.11", view); err != nil {
		t.Fatalf("runtime-specific rebuild failed: %v", err)
	}
}

func TestDependencyAPIIndexControlValidation(t *testing.T) {
	if err := ValidateDependencyAPIIndexPageBytes(0); err != nil {
		t.Fatal(err)
	}
	for _, value := range []int{DependencyAPIIndexPageMinBytes - 1, DependencyAPIIndexPageMaxBytes + 1} {
		if err := ValidateDependencyAPIIndexPageBytes(value); err != ErrDependencyAPIIndexPageSize {
			t.Fatalf("page size %d = %v", value, err)
		}
	}
	capability := DependencyAPIIndexCapability("python", true)
	if capability["enabled"] != true || capability["schema"] != DependencyAPIIndexSchema {
		t.Fatalf("capability = %+v", capability)
	}
	if capability["maxPageBytes"] != DependencyAPIIndexPageMaxBytes ||
		capability["recommendedPageBytes"] != DependencyAPIIndexPageDefaultBytes ||
		capability["maxIndexBytes"] != dependencyAPIIndexMaxBytes ||
		capability["maxPages"] != DependencyAPIIndexMaxPages {
		t.Fatalf("dependency index transfer envelope = %+v", capability)
	}
	if DependencyAPIIndexCapability("go", true)["enabled"] != false {
		t.Fatal("non-Python language advertised dependency API indexing")
	}
	session := &Session{Context: SessionContext{LanguageID: "python", RuntimeID: "python:3.10", DependencyResolved: true}}
	if session.DependencyAPIIndexCapability()["enabled"] != false {
		t.Fatal("empty Python dependency view advertised an index")
	}
	session.Context.DependencyView = testDependencyAPIIndexView(t.TempDir(), "revision-one")
	if session.DependencyAPIIndexCapability()["enabled"] != true {
		t.Fatal("mounted Python dependency view did not advertise an index")
	}
	session.Context.DependencyView.Mounts[0].ReadOnly = false
	if session.DependencyAPIIndexCapability()["enabled"] != false {
		t.Fatal("writable Python dependency view advertised an index")
	}
}

func TestDependencyAPIIndexTransferEnvelopeFitsPublishedPageLimit(t *testing.T) {
	// The full index must fit even when a client deliberately selects the
	// documented minimum. The reserve covers repeated control/page metadata.
	const perPageMetadataReserve = 2 << 10
	if dependencyAPIIndexMaxBytes > DependencyAPIIndexMaxPages*(DependencyAPIIndexPageMinBytes-perPageMetadataReserve) {
		t.Fatalf("durable index %d cannot fit published %d-page transfer envelope", dependencyAPIIndexMaxBytes, DependencyAPIIndexMaxPages)
	}
}

func TestDependencyAPIIndexRejectsCachedPayloadBeyondTotalSymbolBound(t *testing.T) {
	entryCount := dependencyAPIIndexMaxTotalSymbols/dependencyAPIIndexMaxSymbolsPerModule + 1
	entries := make([]DependencyAPIIndexEntry, 0, entryCount)
	for entry := 0; entry < entryCount; entry++ {
		symbols := make([]DependencyAPIIndexSymbol, 0, dependencyAPIIndexMaxSymbolsPerModule)
		for symbol := 0; symbol < dependencyAPIIndexMaxSymbolsPerModule; symbol++ {
			symbols = append(symbols, DependencyAPIIndexSymbol{Name: fmt.Sprintf("item%04d", symbol), Kind: "value"})
		}
		entries = append(entries, DependencyAPIIndexEntry{Module: fmt.Sprintf("package%04d", entry), Kind: "module", Symbols: symbols})
	}
	index := &DependencyAPIIndex{
		Schema: DependencyAPIIndexSchema, LanguageID: "python", RuntimeID: "python:3.10", Revision: "revision-overflow",
		Roots: dependencyAPIIndexRoots(entries), Entries: entries,
	}
	if validDependencyAPIIndex(index, "python", "python:3.10", "revision-overflow") {
		t.Fatal("cache validation accepted too many symbols")
	}
}

func TestDependencyAPIIndexStopsAdmittingWorkBeforeCacheRelease(t *testing.T) {
	session := &Session{stopping: make(chan struct{})}
	if !session.beginDependencyAPIIndex() {
		t.Fatal("first index task was rejected")
	}
	done := make(chan struct{})
	go func() {
		session.closeDependencyAPIIndex()
		close(done)
	}()
	session.finishDependencyAPIIndex()
	<-done
	if session.beginDependencyAPIIndex() {
		t.Fatal("index task was admitted after cache release closed the gate")
	}
}

func TestTrimDependencyAPIIndexRetainsValidPartialTree(t *testing.T) {
	entries := make([]DependencyAPIIndexEntry, 0, 32)
	for index := 0; index < 32; index++ {
		entries = append(entries, DependencyAPIIndexEntry{
			Module: "package" + string(rune('A'+index)), Kind: "module",
			Symbols: []DependencyAPIIndexSymbol{{Name: "veryLongPublicSymbol" + strings.Repeat("x", 96), Kind: "function"}},
		})
	}
	index := &DependencyAPIIndex{Schema: DependencyAPIIndexSchema, LanguageID: "python", RuntimeID: "python:3.10", Revision: "revision-one", Entries: entries, Roots: dependencyAPIIndexRoots(entries)}
	data, err := json.Marshal(index)
	if err != nil {
		t.Fatal(err)
	}
	if !trimDependencyAPIIndex(index, len(data)/2) || !index.Truncated || len(index.Entries) == 0 || len(index.Entries) >= len(entries) {
		t.Fatalf("index was not compacted to a valid partial tree: %+v", index)
	}
	if !validDependencyAPIIndex(index, "python", "python:3.10", "revision-one") {
		t.Fatalf("trimmed index failed validation: %+v", index)
	}
}
