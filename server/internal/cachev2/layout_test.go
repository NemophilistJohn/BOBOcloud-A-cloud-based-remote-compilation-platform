package cachev2

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestNewUserLayoutUsesV2RootAndManagedCategories(t *testing.T) {
	dataDir := t.TempDir()
	layout, err := NewUserLayout(dataDir, "root")
	if err != nil {
		t.Fatal(err)
	}
	expectedRoot := filepath.Join(dataDir, "users", "root", "cache-v2")
	if layout.Root != expectedRoot || layout.UserRoot != filepath.Dir(expectedRoot) {
		t.Fatalf("unexpected layout root: %+v", layout)
	}
	expected := map[Category]string{
		CategoryDependencies: filepath.Join(expectedRoot, "artifacts", "dependencies"),
		CategoryResults:      filepath.Join(expectedRoot, "artifacts", "results"),
		CategoryToolchains:   filepath.Join(expectedRoot, "mutable", "toolchains"),
		CategoryIncremental:  filepath.Join(expectedRoot, "mutable", "incremental"),
	}
	for category, path := range expected {
		actual, rootErr := layout.CategoryRoot(category)
		if rootErr != nil || actual != path {
			t.Fatalf("category %q root = %q, %v; want %q", category, actual, rootErr, path)
		}
	}
	if layout.Registry != filepath.Join(expectedRoot, "registry") ||
		layout.Transactions != filepath.Join(expectedRoot, "transactions") ||
		layout.Retired != filepath.Join(expectedRoot, "retired") {
		t.Fatalf("lifecycle directories are not independent: %+v", layout)
	}
	if _, err := layout.CategoryRoot(Category("unknown")); !errors.Is(err, ErrInvalidCategory) {
		t.Fatalf("invalid category error = %v", err)
	}
}

func TestSafeSegmentIsDeterministicPortableAndCollisionResistant(t *testing.T) {
	logical := "../Project A\\python:3.10/amd64"
	first, err := SafeSegment(logical)
	if err != nil {
		t.Fatal(err)
	}
	second, err := SafeSegment(logical)
	if err != nil || first != second {
		t.Fatalf("safe segment is not deterministic: %q, %q, %v", first, second, err)
	}
	if err := ValidatePathSegment(first); err != nil {
		t.Fatalf("generated segment %q is not portable: %v", first, err)
	}
	if strings.ContainsAny(first, "/\\:.") {
		t.Fatalf("generated segment contains unsafe characters: %q", first)
	}
	other, err := SafeSegment("Project A python 3.10 amd64")
	if err != nil {
		t.Fatal(err)
	}
	if first == other {
		t.Fatal("different logical identities collapsed to one segment")
	}
	if _, err := SafeSegment(" \t\n"); !errors.Is(err, ErrInvalidPathSegment) {
		t.Fatalf("blank logical identity error = %v", err)
	}
}

func TestValidatePathSegmentRejectsTraversalAndPortableDeviceNames(t *testing.T) {
	for _, valid := range []string{"root", "user-01", "name@example.com", "用户"} {
		if err := ValidatePathSegment(valid); err != nil {
			t.Errorf("valid segment %q rejected: %v", valid, err)
		}
	}
	for _, invalid := range []string{"", ".", "..", "../root", "a/b", "a\\b", " name", "name ", "name.", "CON", "com1.txt", "bad:name"} {
		if err := ValidatePathSegment(invalid); !errors.Is(err, ErrInvalidPathSegment) {
			t.Errorf("invalid segment %q error = %v", invalid, err)
		}
	}
}

func TestEnsureUserLayoutCreatesAndReusesSchema(t *testing.T) {
	layout, marker, err := EnsureUserLayout(t.TempDir(), "root")
	if err != nil {
		t.Fatal(err)
	}
	if marker.Schema != SchemaVersion || marker.Format != SchemaFormat || marker.OwnerID != "root" || marker.CreatedAt.IsZero() {
		t.Fatalf("unexpected marker: %+v", marker)
	}
	for _, directory := range append([]string{layout.Root}, layout.RequiredDirectories()...) {
		info, statErr := os.Lstat(directory)
		if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			t.Fatalf("managed directory %q is not real: info=%v err=%v", directory, info, statErr)
		}
	}
	stored, err := ReadSchemaMarker(layout.Root)
	if err != nil || stored != marker {
		t.Fatalf("stored marker = %+v, %v; want %+v", stored, err, marker)
	}

	_, repeated, err := EnsureUserLayout(layout.DataDir, "root")
	if err != nil {
		t.Fatal(err)
	}
	if repeated != marker {
		t.Fatalf("idempotent ensure replaced marker: first=%+v repeated=%+v", marker, repeated)
	}
}

func TestEnsureUserLayoutSerializesConcurrentInitialization(t *testing.T) {
	dataDir := t.TempDir()
	const workers = 24
	type result struct {
		marker SchemaMarker
		err    error
	}
	results := make(chan result, workers)
	start := make(chan struct{})
	var group sync.WaitGroup
	for index := 0; index < workers; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			_, marker, err := EnsureUserLayout(dataDir, "root")
			results <- result{marker: marker, err: err}
		}()
	}
	close(start)
	group.Wait()
	close(results)

	var first SchemaMarker
	for current := range results {
		if current.err != nil {
			t.Fatalf("concurrent initialization failed: %v", current.err)
		}
		if first.CreatedAt.IsZero() {
			first = current.marker
		} else if current.marker != first {
			t.Fatalf("concurrent initialization returned different markers: first=%+v current=%+v", first, current.marker)
		}
	}
}

func TestEnsureUserLayoutRejectsUnmarkedNonEmptyRoot(t *testing.T) {
	layout, err := NewUserLayout(t.TempDir(), "root")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(layout.Root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(layout.Root, "legacy-data"), []byte("v1"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := EnsureUserLayout(layout.DataDir, "root"); !errors.Is(err, ErrSchemaMarkerMissing) {
		t.Fatalf("unmarked root error = %v", err)
	}
}

func TestEnsureUserLayoutRejectsIncompatibleOrMovedMarker(t *testing.T) {
	for name, marker := range map[string]string{
		"old schema":  `{"schema":1,"format":"bobocloud-cache","owner_kind":"user","owner_id":"root","created_at":"2026-01-01T00:00:00Z"}`,
		"moved owner": `{"schema":2,"format":"bobocloud-cache","owner_kind":"user","owner_id":"other","created_at":"2026-01-01T00:00:00Z"}`,
	} {
		t.Run(name, func(t *testing.T) {
			layout, err := NewUserLayout(t.TempDir(), "root")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(layout.Root, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(layout.SchemaMarker, []byte(marker), 0600); err != nil {
				t.Fatal(err)
			}
			if _, _, err := EnsureUserLayout(layout.DataDir, "root"); !errors.Is(err, ErrIncompatibleSchema) {
				t.Fatalf("incompatible marker error = %v", err)
			}
		})
	}
}

func TestEnsureUserLayoutRejectsSymlinkedManagedDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks is not consistently available on Windows test hosts")
	}
	layout, _, err := EnsureUserLayout(t.TempDir(), "root")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(layout.Toolchains); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), layout.Toolchains); err != nil {
		t.Fatal(err)
	}
	if _, _, err := EnsureUserLayout(layout.DataDir, "root"); err == nil {
		t.Fatal("symlinked managed directory was accepted")
	}
}
