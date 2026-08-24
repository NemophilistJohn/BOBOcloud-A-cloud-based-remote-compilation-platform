package packagecatalog

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/config"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func testSources() []config.PackageSourceConfig {
	return []config.PackageSourceConfig{
		{ID: "pypi-official", Ecosystem: "python", Name: "PyPI", Kind: "official", CatalogURL: "https://pypi.example", InstallURL: "https://pypi.example/simple/", EquivalenceGroup: "pypi", Official: true},
		{ID: "pypi-tuna", Ecosystem: "python", Name: "TUNA", Kind: "mirror", CatalogURL: "https://tuna.example", InstallURL: "https://tuna.example/simple/", EquivalenceGroup: "pypi"},
	}
}

func catalogResponse(request *http.Request, body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header), Request: request}
}

func simpleProject(serial string) string {
	return `{"meta":{"_last-serial":"` + serial + `"},"name":"numpy","versions":["1.0.0","2.1.0"],"files":[` +
		`{"filename":"numpy-1.0.0.tar.gz","requires-python":">=3.8","yanked":false,"upload-time":"2025-01-01T00:00:00Z"},` +
		`{"filename":"numpy-2.1.0-cp310-cp310-manylinux.whl","requires-python":">=3.10","yanked":false,"upload-time":"2026-01-01T00:00:00Z"}]}`
}

func versionProject(serial string) string {
	return `{"last_serial":` + serial + `,"info":{"name":"numpy","version":"2.1.0","summary":"arrays","requires_python":">=3.10"},"urls":[{"yanked":false,"upload_time_iso_8601":"2026-01-01T00:00:00Z","requires_python":">=3.10"}]}`
}

func versionProjectFor(serial, version, requires string) string {
	return `{"last_serial":` + serial + `,"info":{"name":"numpy","version":"` + version + `","summary":"arrays","requires_python":"` + requires + `"},"urls":[{"yanked":false,"upload_time_iso_8601":"2026-01-01T00:00:00Z","requires_python":"` + requires + `"}]}`
}

func TestCatalogUsesSelectedMetadataAuthorityAndClassifiesRuntime(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch request.URL.String() {
		case "https://tuna.example/simple/numpy/":
			return catalogResponse(request, simpleProject("17")), nil
		case "https://pypi.example/pypi/numpy/2.1.0/json":
			return catalogResponse(request, versionProject("17")), nil
		default:
			t.Fatalf("catalog request URL = %s", request.URL)
			return nil, nil
		}
	})}
	catalog := NewWithClient(testSources(), client, 1<<20)
	item, err := catalog.Item(context.Background(), ItemRequest{Name: "numpy", SourceID: "pypi-tuna", RuntimeVersion: "3.10"})
	if err != nil {
		t.Fatal(err)
	}
	if item.Name != "numpy" || item.CatalogAuthority != "tuna.example" || len(item.Versions) != 2 || item.Versions[0].Version != "2.1.0" || item.Versions[0].Compatibility != "metadata-compatible" {
		t.Fatalf("catalog item = %+v", item)
	}
	if item.RecommendedVersion != "2.1.0" || item.Versions[1].Version != "1.0.0" || item.Versions[1].Compatibility != "metadata-compatible" || item.Versions[1].RequiresLanguage != ">=3.8" {
		t.Fatalf("historical release metadata was not preserved: %+v", item)
	}
	source, err := catalog.ResolveSource("python", "pypi-tuna")
	if err != nil || source.InstallURL != "https://tuna.example/simple/" || source.CatalogURL != "https://tuna.example" {
		t.Fatalf("mirror source = %+v err=%v", source, err)
	}
}

func TestCatalogFallsBackOnlyToConfiguredEquivalentAuthority(t *testing.T) {
	var requests []string
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.URL.Host)
		if request.URL.String() == "https://pypi.example/simple/numpy/" {
			return nil, errors.New("upstream timeout")
		}
		if request.URL.String() == "https://tuna.example/simple/numpy/" {
			return catalogResponse(request, simpleProject("17")), nil
		}
		return catalogResponse(request, versionProject("17")), nil
	})}
	catalog := NewWithClient(testSources(), client, 1<<20)
	result, err := catalog.Search(context.Background(), SearchRequest{Query: "numpy", SourceID: "pypi-official", RuntimeVersion: "3.10"})
	if err != nil {
		t.Fatal(err)
	}
	if result.SourceID != "pypi-official" || len(result.Items) != 1 || result.Items[0].CatalogAuthority != "tuna.example" || strings.Join(requests, ",") != "pypi.example,tuna.example,pypi.example" {
		t.Fatalf("fallback result=%+v requests=%v", result, requests)
	}
}

func TestCatalogPrefersPreviouslySuccessfulEquivalentAuthority(t *testing.T) {
	var requests []string
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.URL.Host)
		if request.URL.Host == "tuna.example" {
			return catalogResponse(request, simpleProject("17")), nil
		}
		return catalogResponse(request, versionProject("17")), nil
	})}
	catalog := NewWithClient(testSources(), client, 1<<20)
	item, err := catalog.Item(context.Background(), ItemRequest{Name: "numpy", SourceID: "pypi-official", RuntimeVersion: "3.10", PreferredCatalogAuthority: "tuna.example"})
	if err != nil {
		t.Fatal(err)
	}
	if item.CatalogAuthority != "tuna.example" || strings.Join(requests, ",") != "tuna.example,pypi.example" {
		t.Fatalf("preferred result=%+v requests=%v", item, requests)
	}
}

func TestCatalogReservesTotalDeadlineForEquivalentFallback(t *testing.T) {
	client := &http.Client{Timeout: 120 * time.Millisecond, Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() == "https://pypi.example/simple/numpy/" {
			<-request.Context().Done()
			return nil, request.Context().Err()
		}
		if request.URL.Host == "tuna.example" {
			return catalogResponse(request, simpleProject("17")), nil
		}
		return catalogResponse(request, versionProject("17")), nil
	})}
	catalog := NewWithClient(testSources(), client, 1<<20)
	started := time.Now()
	item, err := catalog.Item(context.Background(), ItemRequest{Name: "numpy", SourceID: "pypi-official", RuntimeVersion: "3.10"})
	if err != nil {
		t.Fatal(err)
	}
	if item.CatalogAuthority != "tuna.example" || time.Since(started) >= client.Timeout {
		t.Fatalf("fallback did not complete inside total deadline: item=%+v elapsed=%s", item, time.Since(started))
	}
}

func TestCatalogAcceptsLaggingMirrorAfterOfficialExactVersionValidation(t *testing.T) {
	var requests []string
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.URL.String())
		if request.URL.String() == "https://tuna.example/simple/numpy/" {
			return catalogResponse(request, simpleProject("16")), nil
		}
		return catalogResponse(request, versionProject("17")), nil
	})}
	catalog := NewWithClient(testSources(), client, 1<<20)
	item, err := catalog.Item(context.Background(), ItemRequest{Name: "numpy", SourceID: "pypi-tuna", RuntimeVersion: "3.10"})
	if err != nil {
		t.Fatal(err)
	}
	if item.CatalogAuthority != "tuna.example" || strings.Join(requests, ",") != "https://tuna.example/simple/numpy/,https://pypi.example/pypi/numpy/2.1.0/json" {
		t.Fatalf("lagging mirror item=%+v requests=%v", item, requests)
	}
}

func TestCatalogDiscoveryDoesNotBlockOnSlowOptionalOfficialEnrichment(t *testing.T) {
	client := &http.Client{Timeout: 300 * time.Millisecond, Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() == "https://tuna.example/simple/numpy/" {
			return catalogResponse(request, simpleProject("16")), nil
		}
		<-request.Context().Done()
		return nil, request.Context().Err()
	})}
	catalog := NewWithClient(testSources(), client, 1<<20)
	started := time.Now()
	item, err := catalog.Item(context.Background(), ItemRequest{Name: "numpy", SourceID: "pypi-tuna", RuntimeVersion: "3.10"})
	if err != nil {
		t.Fatal(err)
	}
	if item.CatalogAuthority != "tuna.example" || item.RecommendedVersion != "2.1.0" || time.Since(started) >= client.Timeout {
		t.Fatalf("optional enrichment blocked discovery: item=%+v elapsed=%s", item, time.Since(started))
	}
}

func TestCatalogValidatesAnExactPlanVersionAgainstOfficialMetadata(t *testing.T) {
	var requestURL string
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requestURL = request.URL.String()
		return catalogResponse(request, versionProject("17")), nil
	})}
	catalog := NewWithClient(testSources(), client, 1<<20)
	item, err := catalog.Item(context.Background(), ItemRequest{Name: "numpy", SourceID: "pypi-tuna", RuntimeVersion: "3.10", Version: "2.1.0"})
	if err != nil {
		t.Fatal(err)
	}
	if requestURL != "https://pypi.example/pypi/numpy/2.1.0/json" || len(item.Versions) != 1 || item.Versions[0].Compatibility != "metadata-compatible" || item.CatalogAuthority != "pypi.example" {
		t.Fatalf("exact validation item=%+v url=%s", item, requestURL)
	}
}

func TestCatalogTotalDeadlineRemainsClassifiable(t *testing.T) {
	client := &http.Client{Timeout: 60 * time.Millisecond, Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	})}
	catalog := NewWithClient(testSources(), client, 1<<20)
	_, err := catalog.Item(context.Background(), ItemRequest{Name: "numpy", SourceID: "pypi-official", RuntimeVersion: "3.10"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("catalog deadline error = %v", err)
	}
}

func TestCatalogRedirectsStayWithinOriginalAuthority(t *testing.T) {
	catalog := New(testSources(), "pypi-official", time.Second, 1<<20)
	origin, _ := http.NewRequest(http.MethodGet, "https://pypi.example/pypi/numpy/json", nil)
	same, _ := http.NewRequest(http.MethodGet, "https://pypi.example:443/project/numpy/json", nil)
	cross, _ := http.NewRequest(http.MethodGet, "https://tuna.example/pypi/numpy/json", nil)
	if err := catalog.client.CheckRedirect(same, []*http.Request{origin}); err != nil {
		t.Fatalf("same-authority redirect rejected: %v", err)
	}
	if err := catalog.client.CheckRedirect(cross, []*http.Request{origin}); err == nil {
		t.Fatal("cross-authority redirect was accepted")
	}
}

func TestCatalogSearchIsExactAndBounded(t *testing.T) {
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if strings.Contains(request.URL.Path, "missing") {
			return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader("not found")), Header: make(http.Header)}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", 65))), Header: make(http.Header)}, nil
	})}
	catalog := NewWithClient(testSources(), client, 64)
	result, err := catalog.Search(context.Background(), SearchRequest{Query: "missing", SourceID: "pypi-official", RuntimeVersion: "3.10"})
	if err != nil || len(result.Items) != 0 || result.SearchMode != SearchModeExact {
		t.Fatalf("missing search = %+v err=%v", result, err)
	}
	if _, err := catalog.Item(context.Background(), ItemRequest{Name: "large", SourceID: "pypi-official", RuntimeVersion: "3.10"}); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversized response was accepted: %v", err)
	}
	if requests != 3 {
		t.Fatalf("catalog request count = %d", requests)
	}
}

func TestCatalogRejectsArbitrarySourceAndInvalidNameBeforeNetwork(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		t.Fatal("invalid request reached the network")
		return nil, nil
	})}
	catalog := NewWithClient(testSources(), client, 1<<20)
	if _, err := catalog.Item(context.Background(), ItemRequest{Name: "numpy;rm", SourceID: "pypi-official"}); err == nil {
		t.Fatal("invalid distribution name was accepted")
	}
	if _, err := catalog.Item(context.Background(), ItemRequest{Name: "numpy", SourceID: "https://attacker.example/simple"}); err == nil {
		t.Fatal("arbitrary source URL was accepted")
	}
}

func TestCatalogRecommendsLatestStableReleaseCompatibleWithExactPythonRuntime(t *testing.T) {
	simple := `{"meta":{"_last-serial":"90"},"name":"numpy","versions":["2.2.6","1.26.4","2.5.2","2.0.0rc1","2.3.0"],"files":[` +
		`{"filename":"numpy-2.5.2-cp312.whl","requires-python":">=3.12","yanked":false},` +
		`{"filename":"numpy-2.3.0-cp311.whl","requires-python":">=3.11","yanked":false},` +
		`{"filename":"numpy-2.2.6-cp310.whl","requires-python":">=3.10","yanked":false},` +
		`{"filename":"numpy-1.26.4-cp39.whl","requires-python":">=3.9","yanked":false},` +
		`{"filename":"numpy-2.0.0rc1-cp310.whl","requires-python":">=3.10","yanked":false}]}`
	var requests []string
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.URL.String())
		switch request.URL.String() {
		case "https://tuna.example/simple/numpy/":
			return catalogResponse(request, simple), nil
		case "https://pypi.example/pypi/numpy/2.5.2/json":
			return catalogResponse(request, versionProjectFor("90", "2.5.2", ">=3.12")), nil
		default:
			t.Fatalf("unexpected request %s", request.URL)
			return nil, nil
		}
	})}
	catalog := NewWithClient(testSources(), client, 1<<20)
	item, err := catalog.Item(t.Context(), ItemRequest{
		Name: "numpy", SourceID: "pypi-tuna", RuntimeVersion: "3.10.21", RuntimeVersionTrust: "exact",
	})
	if err != nil {
		t.Fatal(err)
	}
	if item.LatestVersion != "2.5.2" || item.RecommendedVersion != "2.2.6" || len(requests) != 2 {
		t.Fatalf("runtime recommendation item=%+v requests=%v", item, requests)
	}
	if item.Compatibility != "metadata-compatible" || item.CompatibilityReason != "Requires-Python >=3.10" || item.RequiresLanguage != ">=3.10" {
		t.Fatalf("recommended release summary does not match %s: %+v", item.RecommendedVersion, item)
	}
	if item.Versions[0].Version != "2.5.2" || item.Versions[0].Compatibility != "incompatible" || item.Versions[1].Version != "2.3.0" || item.Versions[2].Version != "2.2.6" || item.Versions[2].Compatibility != "metadata-compatible" {
		t.Fatalf("PEP 440 ordering/compatibility = %+v", item.Versions)
	}
}

func TestCatalogTreatsStringYankedAsWithdrawnAndSelectsNonYankedFile(t *testing.T) {
	var simple pypiSimpleProject
	payload := `{"versions":["2.1.0","2.0.0","1.9.0"],"files":[` +
		`{"filename":"demo-2.1.0.tar.gz","requires-python":">=3.8","yanked":""},` +
		`{"filename":"demo-2.0.0.tar.gz","requires-python":">=3.8","yanked":"bad release"},` +
		`{"filename":"demo-1.9.0.tar.gz","requires-python":">=3.8","yanked":false}]}`
	if err := json.Unmarshal([]byte(payload), &simple); err != nil {
		t.Fatal(err)
	}
	releases := simpleProjectReleases(simple)
	project := pypiProject{Info: pypiInfo{Name: "demo", Version: "2.0.0"}, Releases: releases}
	item := packageItemFromPyPI(project, Source{}, "3.10.21", "exact")
	if len(item.Versions) != 3 || !item.Versions[0].Yanked || !item.Versions[1].Yanked || item.Versions[2].Yanked {
		t.Fatalf("yanked aggregation = %+v", item.Versions)
	}
}

func TestPEP440OrderingAndSpecifierCompatibility(t *testing.T) {
	ordered := sortedStablePythonReleases([]string{"1.0.post1", "1.1rc1", "1.0", "1.1.dev1", "1.0.1"})
	if strings.Join(ordered, ",") != "1.0.1,1.0.post1,1.0" {
		t.Fatalf("stable PEP 440 order = %v", ordered)
	}
	for name, test := range map[string]struct {
		runtime, constraint, trust, want string
	}{
		"wildcard":   {"3.10.21", "==3.10.*", "exact", "metadata-compatible"},
		"excluded":   {"3.10.21", "!=3.10.21", "exact", "incompatible"},
		"compound":   {"3.10.21", "~=3.10.0,!=3.10.4", "exact", "metadata-compatible"},
		"series gap": {"3.10", "!=3.10.4", "series", "unknown"},
		"unbounded":  {"3.10", ">=3.8,<3.11", "series", "metadata-compatible"},
	} {
		t.Run(name, func(t *testing.T) {
			got, _ := pythonCompatibilityWithTrust(test.runtime, test.constraint, test.trust)
			if got != test.want {
				t.Fatalf("compatibility = %s, want %s", got, test.want)
			}
		})
	}
}

func TestExactVersionMetadataCacheIsClonedAndSeparateFromDiscoveryEnrichment(t *testing.T) {
	requests := 0
	serial := "17"
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if strings.Contains(request.URL.Path, "/simple/") {
			return catalogResponse(request, simpleProject(serial)), nil
		}
		return catalogResponse(request, versionProject(serial)), nil
	})}
	catalog := NewWithClient(testSources(), client, 1<<20)
	request := ItemRequest{Name: "numpy", SourceID: "pypi-official", RuntimeVersion: "3.10.21", RuntimeVersionTrust: "exact", Version: "2.1.0"}
	first, err := catalog.Item(t.Context(), request)
	if err != nil {
		t.Fatal(err)
	}
	first.Versions[0].Compatibility = "mutated"
	second, err := catalog.Item(t.Context(), request)
	if err != nil || requests != 1 || second.Versions[0].Compatibility != "metadata-compatible" {
		t.Fatalf("exact cache result=%+v requests=%d err=%v", second, requests, err)
	}
	serial = "18"
	item, err := catalog.Item(t.Context(), ItemRequest{Name: "numpy", SourceID: "pypi-official", RuntimeVersion: "3.10.21", RuntimeVersionTrust: "exact"})
	if err != nil || item.RecommendedVersion != "2.1.0" || requests != 3 {
		t.Fatalf("serial refresh item=%+v requests=%d err=%v", item, requests, err)
	}
}
