package dap

import (
	"context"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
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

func TestCatalogAcceptsPrivateUnixChildTransport(t *testing.T) {
	path := writeCatalogTestManifest(t, `{
		"version":"1.0",
		"adapters":[{
			"id":"node-js-debug","languageId":"node","runtimeId":"node:20",
			"image":"node","command":["adapter"],"transport":"unix",
			"containerPort":4711,"supportsChildSessions":true
		}]
	}`)
	catalog, err := LoadCatalog(path)
	if err != nil {
		t.Fatal(err)
	}
	spec, ok := catalog.Lookup("javascript", "node:20")
	if !ok || spec.Transport != "unix" || !spec.SupportsChildSessions {
		t.Fatalf("private child transport was not retained: %#v", spec)
	}
}

func TestCatalogFingerprintIsStableAcrossManifestOrdering(t *testing.T) {
	first, err := LoadCatalog(writeCatalogTestManifest(t, `{
		"version":"1.0",
		"adapters":[
			{"id":"node","label":"Node","languageId":"node","runtimeId":"node:20","image":"first-node-image","command":["first-node-command"],"adapterVersion":"1","supportsLaunch":true,"launchDefaults":{"cwd":"workspace","console":"internalConsole"},"constraints":["two","one"]},
			{"id":"python","label":"Python","languageId":"python","runtimeId":"python:3.11","image":"first-python-image","command":["first-python-command"],"adapterVersion":"2","supportsLaunch":true}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadCatalog(writeCatalogTestManifest(t, `{
		"version":"1.0",
		"adapters":[
			{"id":"python","label":"Python","languageId":"py","runtimeId":"python:3.11","image":"second-python-image","command":["second-python-command"],"adapterVersion":"2","supportsLaunch":true},
			{"id":"node","label":"Node","languageId":"typescript","runtimeId":"node:20","image":"second-node-image","command":["second-node-command"],"adapterVersion":"1","supportsLaunch":true,"launchDefaults":{"console":"internalConsole","cwd":"workspace"},"constraints":["one","two"]}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}

	if first.Fingerprint() == "" || first.Fingerprint() != second.Fingerprint() {
		t.Fatalf("order-independent fingerprints differ: %q != %q", first.Fingerprint(), second.Fingerprint())
	}
	if len(first.Fingerprint()) != 64 {
		t.Fatalf("fingerprint length = %d, want 64", len(first.Fingerprint()))
	}
	if _, err := hex.DecodeString(first.Fingerprint()); err != nil {
		t.Fatalf("fingerprint is not opaque hexadecimal: %v", err)
	}
}

func TestCatalogFingerprintChangesWithPublicProjection(t *testing.T) {
	base, err := LoadCatalog(writeCatalogTestManifest(t, `{
		"version":"1.0","adapters":[{"id":"go","label":"Go","languageId":"go","runtimeId":"go:1.24","image":"image","command":["adapter"],"adapterVersion":"1","supportsLaunch":true}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	changed, err := LoadCatalog(writeCatalogTestManifest(t, `{
		"version":"1.0","adapters":[{"id":"go","label":"Go Delve","languageId":"go","runtimeId":"go:1.24","image":"image","command":["adapter"],"adapterVersion":"1","supportsLaunch":true}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if base.Fingerprint() == changed.Fingerprint() {
		t.Fatal("public adapter label change did not revise the catalog fingerprint")
	}
}

func TestCatalogFingerprintExcludesPrivateAndDynamicDetails(t *testing.T) {
	first, err := LoadCatalog(writeCatalogTestManifest(t, `{
		"version":"1.0","adapters":[{"id":"go","label":"Go","languageId":"go","runtimeId":"go:1.24","image":"private.registry/secret:first","command":["/private/bin/dlv","--token=first"],"adapterVersion":"1","supportsLaunch":true}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadCatalog(writeCatalogTestManifest(t, `{
		"version":"1.0","adapters":[{"id":"go","label":"Go","languageId":"go","runtimeId":"go:1.24","image":"other.registry/second","command":["/different/bin/dlv","--token=second"],"adapterVersion":"1","supportsLaunch":true}]
	}`))
	if err != nil {
		t.Fatal(err)
	}

	if first.Fingerprint() != second.Fingerprint() {
		t.Fatal("private command or image details affected the public catalog fingerprint")
	}
	for _, secret := range []string{"private", "secret", "dlv"} {
		if strings.Contains(first.Fingerprint(), secret) {
			t.Fatalf("fingerprint leaked %q: %s", secret, first.Fingerprint())
		}
	}
	var nilCatalog *Catalog
	if got := nilCatalog.Fingerprint(); got != "" {
		t.Fatalf("nil catalog fingerprint = %q, want empty", got)
	}
}
