package lsp

import (
	"encoding/hex"
	"strings"
	"testing"
)

func newFingerprintTestCatalog(t *testing.T, servers []ServerSpec) *Catalog {
	t.Helper()
	catalog, err := NewCatalog(Manifest{Version: 1, Servers: servers})
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func TestCatalogFingerprintIsStableAcrossManifestOrdering(t *testing.T) {
	first := newFingerprintTestCatalog(t, []ServerSpec{
		{LanguageID: "node", Aliases: []string{"typescript", "javascript"}, Command: []string{"node-lsp"}, Fingerprint: "node-v1"},
		{LanguageID: "python", Aliases: []string{"py"}, Command: []string{"python-lsp"}, Fingerprint: "python-v1"},
	})
	second := newFingerprintTestCatalog(t, []ServerSpec{
		{LanguageID: "python", Aliases: []string{"py"}, Command: []string{"other-python-command"}, Fingerprint: "python-v1"},
		{LanguageID: "node", Aliases: []string{"javascript", "typescript"}, Command: []string{"other-node-command"}, Fingerprint: "node-v1"},
	})

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
	base := newFingerprintTestCatalog(t, []ServerSpec{{LanguageID: "go", Aliases: []string{"golang"}, Command: []string{"gopls"}, Fingerprint: "gopls-v1"}})
	changed := newFingerprintTestCatalog(t, []ServerSpec{{LanguageID: "go", Aliases: []string{"golang"}, Command: []string{"gopls"}, Fingerprint: "gopls-v2"}})

	if base.Fingerprint() == changed.Fingerprint() {
		t.Fatal("public toolchain fingerprint change did not revise the catalog fingerprint")
	}
}

func TestCatalogFingerprintExcludesPrivateLaunchDetails(t *testing.T) {
	first := newFingerprintTestCatalog(t, []ServerSpec{{
		LanguageID: "go", Aliases: []string{"golang"}, Command: []string{"/private/bin/gopls", "-remote=secret"},
		Docker:      DockerSpec{Image: "private.registry/secret/gopls:first", Command: []string{"private-command"}},
		Environment: map[string]string{"PRIVATE_TOKEN": "first-secret"}, Fingerprint: "gopls-v1",
	}})
	second := newFingerprintTestCatalog(t, []ServerSpec{{
		LanguageID: "go", Aliases: []string{"golang"}, Command: []string{"/different/bin/gopls", "-remote=other"},
		Docker:      DockerSpec{Image: "another.registry/gopls:second", Command: []string{"different-command"}},
		Environment: map[string]string{"PRIVATE_TOKEN": "second-secret"}, Fingerprint: "gopls-v1",
	}})

	if first.Fingerprint() != second.Fingerprint() {
		t.Fatal("private command, environment, or image details affected the public catalog fingerprint")
	}
	for _, secret := range []string{"private", "secret", "gopls"} {
		if strings.Contains(first.Fingerprint(), secret) {
			t.Fatalf("fingerprint leaked %q: %s", secret, first.Fingerprint())
		}
	}
}

func TestNilCatalogFingerprintIsEmpty(t *testing.T) {
	var catalog *Catalog
	if got := catalog.Fingerprint(); got != "" {
		t.Fatalf("nil catalog fingerprint = %q, want empty", got)
	}
}
