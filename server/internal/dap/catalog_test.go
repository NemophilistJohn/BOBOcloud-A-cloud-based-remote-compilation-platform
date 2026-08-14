package dap

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

type catalogTestInspector struct {
	available bool
	reason    string
}

func (inspector catalogTestInspector) Available(context.Context, string) (bool, string) {
	return inspector.available, inspector.reason
}

func writeCatalogTestManifest(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "dap_adapters.json")
	if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCatalogLoadsAliasesAndStableAvailability(t *testing.T) {
	path := writeCatalogTestManifest(t, `{
		"version":"1.0",
		"adapters":[{
			"id":"node-js-debug","label":"Node.js js-debug","languageId":"node",
			"runtimeId":"node:20","image":"bobocloud/dap-node:20-test",
			"command":["adapter"],"supportsLaunch":true,
			"dependencyMode":"persist-global-or-dependency-free",
			"constraints":["workspace-node-modules-excluded"]
		}]
	}`)
	catalog, err := LoadCatalog(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := catalog.Lookup("typescript", "node:20"); !ok {
		t.Fatal("TypeScript alias did not resolve to the Node adapter")
	}
	capabilities := catalog.Capabilities(context.Background(), catalogTestInspector{reason: UnavailableImageNotInstalled})
	if len(capabilities) != 1 || capabilities[0].Available || capabilities[0].Unavailable != UnavailableImageNotInstalled {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	if capabilities[0].DependencyMode != "persist-global-or-dependency-free" || len(capabilities[0].Constraints) != 1 {
		t.Fatalf("dependency metadata was lost: %#v", capabilities[0])
	}
}

func TestCatalogRejectsDuplicateRuntimeAdapter(t *testing.T) {
	path := writeCatalogTestManifest(t, `{
		"version":"1.0",
		"adapters":[
			{"id":"one","languageId":"javascript","runtimeId":"node:20","image":"one","command":["one"]},
			{"id":"two","languageId":"node","runtimeId":"node:20","image":"two","command":["two"]}
		]
	}`)
	if _, err := LoadCatalog(path); err == nil {
		t.Fatal("duplicate language/runtime adapter was accepted")
	}
}
