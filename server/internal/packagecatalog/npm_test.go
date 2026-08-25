package packagecatalog

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"bobocloud-server/internal/config"
)

func npmTestSource(id, endpoint string, official bool) config.PackageSourceConfig {
	kind := "mirror"
	if official {
		kind = "official"
	}
	return config.PackageSourceConfig{
		ID: id, Ecosystem: "node", Name: id, Kind: kind, CatalogURL: endpoint,
		InstallURL: endpoint, EquivalenceGroup: "npm", Official: official,
	}
}

func TestNPMCatalogSearchUsesRegistryProtocolAndCursor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/-/v1/search" {
			t.Fatalf("search request = %s %s", request.Method, request.URL.String())
		}
		if request.URL.Query().Get("text") != "web framework" || request.URL.Query().Get("size") != "20" || request.URL.Query().Get("from") != "40" {
			t.Fatalf("search query = %s", request.URL.RawQuery)
		}
		writer.Header().Set("Content-Type", "application/json")
		fmt.Fprint(writer, `{"objects":[`+
			`{"package":{"name":"fastify","version":"5.2.1","description":"Fast web framework","date":"2026-01-02T00:00:00Z","links":{"homepage":"https://fastify.dev"}}},`+
			`{"package":{"name":"@scope/router","version":"2.0.0","description":"Scoped router","links":{"repository":"https://example.test/router"}}},`+
			`{"package":{"name":"Bad Package","version":"1.0.0"}}`+
			`],"total":80}`)
	}))
	defer server.Close()

	catalog := NewWithClient([]config.PackageSourceConfig{npmTestSource("npm-official", server.URL, true)}, server.Client(), 1<<20)
	result, err := catalog.Search(context.Background(), SearchRequest{
		Ecosystem: "node", Query: "web framework", SourceID: "npm-official", Cursor: "40", RuntimeVersion: "22.14.0", RuntimeVersionTrust: "exact",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.SearchMode != SearchModeCatalog || result.SourceID != "npm-official" || result.NextCursor != "43" || len(result.Items) != 2 {
		t.Fatalf("npm search result = %+v", result)
	}
	if result.Items[0].Name != "fastify" || result.Items[0].RecommendedVersion != "5.2.1" || result.Items[0].Homepage != "https://fastify.dev" || result.Items[0].CatalogAuthority != "127.0.0.1" {
		t.Fatalf("first npm result = %+v", result.Items[0])
	}
	if result.Items[1].Name != "@scope/router" || result.Items[1].Homepage != "https://example.test/router" || len(result.Items[1].Versions) != 0 {
		t.Fatalf("scoped npm result = %+v", result.Items[1])
	}
}

func TestNPMCatalogItemUsesScopedPackumentAndRecommendsCompatibleVersion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || !strings.Contains(strings.ToLower(request.URL.EscapedPath()), "%2f") || request.URL.Path != "/@scope/router" {
			t.Fatalf("packument request = %s path=%q escaped=%q", request.Method, request.URL.Path, request.URL.EscapedPath())
		}
		if !strings.Contains(request.Header.Get("Accept"), "application/vnd.npm.install-v1+json") {
			t.Fatalf("packument Accept = %q", request.Header.Get("Accept"))
		}
		writer.Header().Set("Content-Type", "application/json")
		fmt.Fprint(writer, `{
			"name":"@scope/router",
			"description":"Project router",
			"homepage":"https://router.example",
			"license":{"type":"MIT"},
			"dist-tags":{"latest":"2.0.0","next":"3.0.0-beta.1","broken":"9.9.9"},
			"versions":{
				"3.0.0-beta.1":{"name":"@scope/router","version":"3.0.0-beta.1","engines":{"node":">=18"}},
				"2.0.0":{"name":"@scope/router","version":"2.0.0","engines":{"node":">=20"}},
				"1.5.0":{"name":"@scope/router","version":"1.5.0","engines":{"node":">=18"},"deprecated":"Use 2.x"},
				"1.0.0":{"name":"@scope/router","version":"1.0.0","engines":{"node":">=16 <20"}}
			},
			"time":{"1.0.0":"2024-01-01T00:00:00Z","2.0.0":"2026-01-01T00:00:00Z"}
		}`)
	}))
	defer server.Close()

	catalog := NewWithClient([]config.PackageSourceConfig{npmTestSource("npm-official", server.URL, true)}, server.Client(), 1<<20)
	item, err := catalog.Item(t.Context(), ItemRequest{
		Ecosystem: "node", Name: "@scope/router", SourceID: "npm-official", RuntimeVersion: "18.19.1", RuntimeVersionTrust: "exact",
	})
	if err != nil {
		t.Fatal(err)
	}
	if item.Name != "@scope/router" || item.LatestVersion != "2.0.0" || item.RecommendedVersion != "1.0.0" || item.License != "MIT" || item.Homepage != "https://router.example" {
		t.Fatalf("npm item summary = %+v", item)
	}
	if item.Compatibility != "metadata-compatible" || item.RequiresLanguage != ">=16 <20" || item.Deprecated || len(item.DistTags) != 2 || item.DistTags["next"] != "3.0.0-beta.1" {
		t.Fatalf("npm item recommendation = %+v", item)
	}
	if len(item.Versions) != 4 || item.Versions[0].Version != "3.0.0-beta.1" || item.Versions[1].Version != "2.0.0" || item.Versions[1].Compatibility != "incompatible" {
		t.Fatalf("npm version ordering = %+v", item.Versions)
	}
	if item.Versions[2].Version != "1.5.0" || !item.Versions[2].Deprecated || item.Versions[2].DeprecationMessage != "Use 2.x" {
		t.Fatalf("npm deprecation metadata = %+v", item.Versions[2])
	}
}

func TestNPMCatalogExactVersionPreservesDeprecation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/left-pad/1.3.0" {
			t.Fatalf("exact version URL = %s", request.URL.String())
		}
		fmt.Fprint(writer, `{"name":"left-pad","version":"1.3.0","description":"padding","license":"WTFPL","deprecated":"No longer maintained","engines":{"node":">=6"}}`)
	}))
	defer server.Close()

	catalog := NewWithClient([]config.PackageSourceConfig{npmTestSource("npm-official", server.URL, true)}, server.Client(), 1<<20)
	item, err := catalog.Item(t.Context(), ItemRequest{
		Ecosystem: "node", Name: "left-pad", Version: "1.3.0", RuntimeVersion: "18.19.1", RuntimeVersionTrust: "exact",
	})
	if err != nil {
		t.Fatal(err)
	}
	if item.LatestVersion != "1.3.0" || item.RecommendedVersion != "" || !item.Deprecated || item.DeprecationMessage != "No longer maintained" || len(item.Versions) != 1 {
		t.Fatalf("exact deprecated npm item = %+v", item)
	}
}

func TestNPMCatalogFallsBackOnlyAcrossConfiguredEquivalentSources(t *testing.T) {
	var mirrorRequests, officialRequests atomic.Int32
	mirror := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mirrorRequests.Add(1)
		http.Error(writer, "temporary failure", http.StatusBadGateway)
	}))
	defer mirror.Close()
	official := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		officialRequests.Add(1)
		fmt.Fprint(writer, `{"name":"fastify","dist-tags":{"latest":"5.2.1"},"versions":{"5.2.1":{"name":"fastify","version":"5.2.1","engines":{"node":">=20"}}}}`)
	}))
	defer official.Close()

	sources := []config.PackageSourceConfig{
		npmTestSource("npm-official", official.URL, true),
		npmTestSource("npm-mirror", mirror.URL, false),
	}
	catalog := NewWithClient(sources, &http.Client{Timeout: time.Second}, 1<<20)
	item, err := catalog.Item(t.Context(), ItemRequest{
		Ecosystem: "node", Name: "fastify", SourceID: "npm-mirror", RuntimeVersion: "22.14.0", RuntimeVersionTrust: "exact",
	})
	if err != nil {
		t.Fatal(err)
	}
	if item.CatalogAuthority != "127.0.0.1" || mirrorRequests.Load() != 1 || officialRequests.Load() != 1 {
		t.Fatalf("npm fallback item=%+v mirror=%d official=%d", item, mirrorRequests.Load(), officialRequests.Load())
	}
}

func TestNPMCatalogRejectsUnsafeInputBeforeNetwork(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		t.Fatal("unsafe npm request reached the registry")
	}))
	defer server.Close()
	catalog := NewWithClient([]config.PackageSourceConfig{npmTestSource("npm-official", server.URL, true)}, server.Client(), 1<<20)

	for _, name := range []string{"../escape", "BadName", "@scope", "@scope/name/extra", "name%2fother", ".hidden"} {
		if _, err := catalog.Item(t.Context(), ItemRequest{Ecosystem: "node", Name: name, SourceID: "npm-official"}); err == nil {
			t.Fatalf("unsafe npm name %q was accepted", name)
		}
	}
	if _, err := catalog.Item(t.Context(), ItemRequest{Ecosystem: "node", Name: "safe-name", SourceID: "https://attacker.example"}); err == nil {
		t.Fatal("arbitrary npm registry URL was accepted")
	}
	if _, err := catalog.Search(t.Context(), SearchRequest{Ecosystem: "node", Query: "safe", SourceID: "npm-official", Cursor: "-1"}); err == nil {
		t.Fatal("negative npm search cursor was accepted")
	}
	if _, err := catalog.Search(t.Context(), SearchRequest{Ecosystem: "node", Query: "bad\nquery", SourceID: "npm-official"}); err == nil {
		t.Fatal("control characters in npm search were accepted")
	}
	if requests.Load() != 0 {
		t.Fatalf("unsafe npm request count = %d", requests.Load())
	}
}

func TestNodeSemverCompatibilityIsConservative(t *testing.T) {
	for name, test := range map[string]struct {
		runtime, constraint, trust, want string
	}{
		"bounded":        {"18.19.1", ">=18 <20", "exact", "metadata-compatible"},
		"incompatible":   {"18.19.1", ">=20", "exact", "incompatible"},
		"caret or":       {"18.19.1", "^16.0.0 || ^18.12.0 || >=20", "exact", "metadata-compatible"},
		"wildcard":       {"18.19.1", "18.x", "exact", "metadata-compatible"},
		"hyphen":         {"18.19.1", "16 - 18", "exact", "metadata-compatible"},
		"full series":    {"18.19", ">=18 <19", "series", "metadata-compatible"},
		"partial series": {"18.19", ">=18.19.5 <19", "series", "unknown"},
		"unsupported":    {"18.19.1", "workspace:*", "exact", "unknown"},
	} {
		t.Run(name, func(t *testing.T) {
			got, _ := nodeCompatibilityWithTrust(test.runtime, test.constraint, test.trust)
			if got != test.want {
				t.Fatalf("compatibility = %s, want %s", got, test.want)
			}
		})
	}
}

func TestCatalogSupportsPerEcosystemDefaultSources(t *testing.T) {
	sources := append(testSources(), npmTestSource("npm-official", "https://registry.example", true), npmTestSource("npm-mirror", "https://mirror.example", false))
	catalog := NewWithDefaults(sources, map[string]string{"python": "pypi-tuna", "node": "npm-mirror"}, time.Second, 1<<20)
	if catalog.DefaultSource("python") != "pypi-tuna" || catalog.DefaultSource("node") != "npm-mirror" {
		t.Fatalf("catalog defaults: python=%q node=%q", catalog.DefaultSource("python"), catalog.DefaultSource("node"))
	}
	legacy := New(sources, "pypi-tuna", time.Second, 1<<20)
	if legacy.DefaultSource("python") != "pypi-tuna" || legacy.DefaultSource("node") != "npm-official" {
		t.Fatalf("legacy catalog defaults: python=%q node=%q", legacy.DefaultSource("python"), legacy.DefaultSource("node"))
	}
}
