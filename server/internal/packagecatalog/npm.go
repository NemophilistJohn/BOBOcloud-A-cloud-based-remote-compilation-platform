package packagecatalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"bobocloud-server/internal/model"
)

const (
	npmSearchPageSize     = 20
	npmMaxSearchOffset    = 10000
	npmMaxSearchQuery     = 200
	npmMaxCatalogTags     = 64
	npmMaxCatalogVersions = 256
)

var (
	npmPackagePartRE   = regexp.MustCompile(`^[a-z0-9~][a-z0-9._~-]*$`)
	npmTagRE           = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$`)
	npmSemverRE        = regexp.MustCompile(`^[vV=]?(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?(?:\.(0|[1-9][0-9]*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)
	npmOperatorSpaceRE = regexp.MustCompile(`([<>!=~^]+)\s+`)
	npmHyphenRangeRE   = regexp.MustCompile(`^\s*([^\s]+)\s+-\s+([^\s]+)\s*$`)
)

type npmSearchResponse struct {
	Objects []struct {
		Package npmSearchPackage `json:"package"`
	} `json:"objects"`
	Total int `json:"total"`
}

type npmSearchPackage struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Date        string `json:"date"`
	Links       struct {
		Homepage   string `json:"homepage"`
		Repository string `json:"repository"`
		NPM        string `json:"npm"`
	} `json:"links"`
}

type npmPackument struct {
	Name        string                    `json:"name"`
	Description string                    `json:"description"`
	Homepage    string                    `json:"homepage"`
	License     json.RawMessage           `json:"license"`
	DistTags    map[string]string         `json:"dist-tags"`
	Versions    map[string]npmVersionInfo `json:"versions"`
	Time        map[string]string         `json:"time"`
}

type npmVersionInfo struct {
	Name        string          `json:"name"`
	Version     string          `json:"version"`
	Description string          `json:"description"`
	Homepage    string          `json:"homepage"`
	License     json.RawMessage `json:"license"`
	Deprecated  json.RawMessage `json:"deprecated"`
	Engines     struct {
		Node string `json:"node"`
	} `json:"engines"`
}

type npmCatalogFetch[T any] struct {
	Value    T
	Response *http.Response
	Source   Source
}

type npmSemver struct {
	major      uint64
	minor      uint64
	patch      uint64
	parts      int
	prerelease []string
}

func (s *Service) searchNPM(ctx context.Context, request SearchRequest) (model.PackageCatalogSearchResult, error) {
	query := strings.TrimSpace(request.Query)
	result := model.PackageCatalogSearchResult{
		Schema: searchSchema, Query: query, SourceID: strings.TrimSpace(request.SourceID),
		SearchMode: SearchModeCatalog, Items: []model.PackageCatalogItem{},
	}
	if err := validateNPMSearchQuery(query); err != nil {
		return result, err
	}
	offset, err := parseNPMSearchCursor(request.Cursor)
	if err != nil {
		return result, err
	}
	source, err := s.ResolveSource("node", request.SourceID)
	if err != nil {
		return result, err
	}
	if result.SourceID == "" {
		result.SourceID = source.Public.ID
	}
	queryContext, cancelQuery := packageCatalogQueryContext(ctx, s.timeout)
	defer cancelQuery()
	fetched, err := fetchEquivalentCatalog(queryContext, s.catalogCandidates(source, ""), func(fetchContext context.Context, candidate Source) (npmSearchResponse, *http.Response, error) {
		endpoint, endpointErr := url.Parse(strings.TrimRight(candidate.CatalogURL, "/") + "/-/v1/search")
		if endpointErr != nil {
			return npmSearchResponse{}, nil, endpointErr
		}
		parameters := endpoint.Query()
		parameters.Set("text", query)
		parameters.Set("size", strconv.Itoa(npmSearchPageSize))
		parameters.Set("from", strconv.Itoa(offset))
		endpoint.RawQuery = parameters.Encode()
		var payload npmSearchResponse
		response, fetchErr := s.fetchJSON(fetchContext, endpoint.String(), "application/json", &payload)
		return payload, response, fetchErr
	})
	if err != nil {
		return result, err
	}
	authority := npmCatalogAuthority(fetched.Source, fetched.Response)
	objects := fetched.Value.Objects
	if len(objects) > npmSearchPageSize {
		objects = objects[:npmSearchPageSize]
	}
	for _, object := range objects {
		candidate := object.Package
		if !validNPMPackageName(candidate.Name) {
			continue
		}
		version := strings.TrimSpace(candidate.Version)
		if _, ok := parseNPMExactSemver(version); !ok {
			version = ""
		}
		homepage := strings.TrimSpace(candidate.Links.Homepage)
		if homepage == "" {
			homepage = strings.TrimSpace(candidate.Links.Repository)
		}
		item := model.PackageCatalogItem{
			Name: strings.TrimSpace(candidate.Name), LatestVersion: version, RecommendedVersion: version,
			Description: strings.TrimSpace(candidate.Description), Homepage: homepage,
			Compatibility: "unknown", CompatibilityReason: "Node.js engine metadata is available in package details",
			CatalogAuthority: authority,
		}
		result.Items = append(result.Items, item)
	}
	nextOffset := offset + len(fetched.Value.Objects)
	if nextOffset > offset && nextOffset < fetched.Value.Total && nextOffset <= npmMaxSearchOffset {
		result.NextCursor = strconv.Itoa(nextOffset)
	}
	return result, nil
}

func (s *Service) itemNPM(ctx context.Context, request ItemRequest) (model.PackageCatalogItem, error) {
	name := strings.TrimSpace(request.Name)
	if !validNPMPackageName(name) {
		return model.PackageCatalogItem{}, fmt.Errorf("invalid npm package name")
	}
	source, err := s.ResolveSource("node", request.SourceID)
	if err != nil {
		return model.PackageCatalogItem{}, err
	}
	queryContext, cancelQuery := packageCatalogQueryContext(ctx, s.timeout)
	defer cancelQuery()
	if version := strings.TrimSpace(request.Version); version != "" {
		if _, ok := parseNPMExactSemver(version); !ok {
			return model.PackageCatalogItem{}, fmt.Errorf("invalid npm package version")
		}
		fetched, fetchErr := fetchEquivalentCatalog(queryContext, s.catalogCandidates(source, request.PreferredCatalogAuthority), func(fetchContext context.Context, candidate Source) (npmVersionInfo, *http.Response, error) {
			var payload npmVersionInfo
			response, itemErr := s.fetchJSON(fetchContext, npmPackageEndpoint(candidate, name)+"/"+url.PathEscape(version), "application/json", &payload)
			return payload, response, itemErr
		})
		if fetchErr != nil {
			return model.PackageCatalogItem{}, fetchErr
		}
		if strings.TrimSpace(fetched.Value.Version) != version || (strings.TrimSpace(fetched.Value.Name) != "" && strings.TrimSpace(fetched.Value.Name) != name) {
			return model.PackageCatalogItem{}, fmt.Errorf("npm registry returned mismatched package metadata")
		}
		return npmItemFromExactVersion(name, fetched.Value, fetched.Source, fetched.Response, request.RuntimeVersion, request.RuntimeVersionTrust), nil
	}
	fetched, err := fetchEquivalentCatalog(queryContext, s.catalogCandidates(source, request.PreferredCatalogAuthority), func(fetchContext context.Context, candidate Source) (npmPackument, *http.Response, error) {
		var payload npmPackument
		response, itemErr := s.fetchJSON(fetchContext, npmPackageEndpoint(candidate, name), "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*", &payload)
		return payload, response, itemErr
	})
	if err != nil {
		return model.PackageCatalogItem{}, err
	}
	if strings.TrimSpace(fetched.Value.Name) != "" && strings.TrimSpace(fetched.Value.Name) != name {
		return model.PackageCatalogItem{}, fmt.Errorf("npm registry returned mismatched package metadata")
	}
	if len(fetched.Value.Versions) == 0 {
		return model.PackageCatalogItem{}, ErrNotFound
	}
	return npmItemFromPackument(name, fetched.Value, fetched.Source, fetched.Response, request.RuntimeVersion, request.RuntimeVersionTrust), nil
}

func packageCatalogQueryContext(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	if timeout > 0 {
		return context.WithTimeout(parent, timeout)
	}
	return context.WithCancel(parent)
}

func fetchEquivalentCatalog[T any](ctx context.Context, candidates []Source, fetch func(context.Context, Source) (T, *http.Response, error)) (npmCatalogFetch[T], error) {
	var zero npmCatalogFetch[T]
	if len(candidates) == 0 {
		return zero, fmt.Errorf("package catalog has no configured authority")
	}
	type outcome struct {
		index    int
		value    T
		response *http.Response
		err      error
	}
	results := make(chan outcome, len(candidates))
	failures := make([]string, len(candidates))
	notFound, timedOut := false, false
	launched, completed := 0, 0
	launch := func(index int) {
		candidate := candidates[index]
		launched++
		go func() {
			value, response, err := fetch(ctx, candidate)
			results <- outcome{index: index, value: value, response: response, err: err}
		}()
	}
	launch(0)
	var hedgeTimer *time.Timer
	var hedge <-chan time.Time
	stopHedge := func() {
		if hedgeTimer != nil {
			if !hedgeTimer.Stop() {
				select {
				case <-hedgeTimer.C:
				default:
				}
			}
			hedgeTimer = nil
		}
		hedge = nil
	}
	armHedge := func() {
		for launched < len(candidates) {
			delay := catalogHedgeDelay(ctx)
			if delay > 0 {
				hedgeTimer = time.NewTimer(delay)
				hedge = hedgeTimer.C
				return
			}
			launch(launched)
		}
		hedge = nil
	}
	defer stopHedge()
	armHedge()
	for completed < len(candidates) {
		select {
		case result := <-results:
			completed++
			candidate := candidates[result.index]
			if result.err == nil {
				return npmCatalogFetch[T]{Value: result.value, Response: result.response, Source: candidate}, nil
			}
			if errors.Is(result.err, ErrNotFound) {
				notFound = true
				if candidate.Public.Official {
					return zero, ErrNotFound
				}
			} else {
				failures[result.index] = candidate.Public.CatalogAuthority + ": " + result.err.Error()
				timedOut = timedOut || errors.Is(result.err, context.DeadlineExceeded) || errors.Is(result.err, context.Canceled)
			}
			if launched < len(candidates) {
				stopHedge()
				launch(launched)
				armHedge()
			}
		case <-hedge:
			stopHedge()
			launch(launched)
			armHedge()
		case <-ctx.Done():
			return zero, fmt.Errorf("query equivalent package catalogs: %w", ctx.Err())
		}
	}
	compactFailures := failures[:0]
	for _, failure := range failures {
		if failure != "" {
			compactFailures = append(compactFailures, failure)
		}
	}
	if len(compactFailures) == 0 {
		if notFound {
			return zero, ErrNotFound
		}
		return zero, fmt.Errorf("package catalog has no configured authority")
	}
	if timedOut {
		return zero, fmt.Errorf("query equivalent package catalogs: %w: %s", context.DeadlineExceeded, strings.Join(compactFailures, "; "))
	}
	return zero, fmt.Errorf("query equivalent package catalogs: %s", strings.Join(compactFailures, "; "))
}

func npmPackageEndpoint(source Source, name string) string {
	return strings.TrimRight(source.CatalogURL, "/") + "/" + url.PathEscape(name)
}

func npmCatalogAuthority(source Source, response *http.Response) string {
	if response != nil && response.Request != nil && response.Request.URL != nil {
		if authority := response.Request.URL.Hostname(); authority != "" {
			return authority
		}
	}
	return source.Public.CatalogAuthority
}

func validateNPMSearchQuery(query string) error {
	if query == "" {
		return fmt.Errorf("npm package search query is required")
	}
	if len(query) > npmMaxSearchQuery || !utf8.ValidString(query) {
		return fmt.Errorf("npm package search query is invalid")
	}
	for _, character := range query {
		if unicode.IsControl(character) {
			return fmt.Errorf("npm package search query is invalid")
		}
	}
	return nil
}

func parseNPMSearchCursor(cursor string) (int, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return 0, nil
	}
	offset, err := strconv.Atoi(cursor)
	if err != nil || offset < 0 || offset > npmMaxSearchOffset {
		return 0, fmt.Errorf("invalid npm package search cursor")
	}
	return offset, nil
}

func validNPMPackageName(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 214 || name != strings.ToLower(name) || !utf8.ValidString(name) {
		return false
	}
	if strings.HasPrefix(name, "@") {
		parts := strings.Split(name, "/")
		return len(parts) == 2 && len(parts[0]) > 1 && npmPackagePartRE.MatchString(parts[0][1:]) && npmPackagePartRE.MatchString(parts[1])
	}
	return !strings.Contains(name, "/") && npmPackagePartRE.MatchString(name)
}

func npmItemFromPackument(name string, payload npmPackument, source Source, response *http.Response, runtimeVersion, runtimeTrust string) model.PackageCatalogItem {
	item := model.PackageCatalogItem{
		Name: name, Description: strings.TrimSpace(payload.Description), Homepage: strings.TrimSpace(payload.Homepage),
		License: npmLicense(payload.License), CatalogAuthority: npmCatalogAuthority(source, response),
		DistTags: validatedNPMDistTags(payload.DistTags, payload.Versions), Versions: []model.PackageCatalogVersion{},
	}
	ordered := sortedNPMVersions(payload.Versions)
	ordered = boundedNPMVersions(ordered, item.DistTags)
	for _, version := range ordered {
		metadata := payload.Versions[version]
		constraint := strings.TrimSpace(metadata.Engines.Node)
		compatibility, reason := nodeCompatibilityWithTrust(runtimeVersion, constraint, runtimeTrust)
		deprecated, deprecationMessage := npmDeprecation(metadata.Deprecated)
		item.Versions = append(item.Versions, model.PackageCatalogVersion{
			Version: version, RequiresLanguage: constraint, PublishedAt: strings.TrimSpace(payload.Time[version]),
			Compatibility: compatibility, Reason: reason, Deprecated: deprecated, DeprecationMessage: deprecationMessage,
		})
	}
	latest := strings.TrimSpace(item.DistTags["latest"])
	if !npmItemHasVersion(item, latest) {
		latest = firstStableNPMVersion(item.Versions)
	}
	item.LatestVersion = latest
	projectCatalogVersionSummary(&item, latest)
	if npmVersionSelectable(item, latest) {
		setRecommendedCatalogVersion(&item, latest)
	} else {
		for _, version := range item.Versions {
			if npmSemverPrerelease(version.Version) || version.Deprecated || !selectableNodeCompatibility(version.Compatibility) {
				continue
			}
			setRecommendedCatalogVersion(&item, version.Version)
			break
		}
	}
	if item.Description == "" {
		if metadata, ok := payload.Versions[item.RecommendedVersion]; ok {
			item.Description = strings.TrimSpace(metadata.Description)
		}
	}
	if item.Homepage == "" {
		if metadata, ok := payload.Versions[item.RecommendedVersion]; ok {
			item.Homepage = strings.TrimSpace(metadata.Homepage)
		}
	}
	if item.License == "" {
		if metadata, ok := payload.Versions[item.RecommendedVersion]; ok {
			item.License = npmLicense(metadata.License)
		}
	}
	return item
}

func npmItemFromExactVersion(name string, payload npmVersionInfo, source Source, response *http.Response, runtimeVersion, runtimeTrust string) model.PackageCatalogItem {
	version := strings.TrimSpace(payload.Version)
	constraint := strings.TrimSpace(payload.Engines.Node)
	compatibility, reason := nodeCompatibilityWithTrust(runtimeVersion, constraint, runtimeTrust)
	deprecated, deprecationMessage := npmDeprecation(payload.Deprecated)
	item := model.PackageCatalogItem{
		Name: name, LatestVersion: version, Description: strings.TrimSpace(payload.Description),
		License: npmLicense(payload.License), Homepage: strings.TrimSpace(payload.Homepage),
		CatalogAuthority: npmCatalogAuthority(source, response), Versions: []model.PackageCatalogVersion{{
			Version: version, RequiresLanguage: constraint, Compatibility: compatibility, Reason: reason,
			Deprecated: deprecated, DeprecationMessage: deprecationMessage,
		}},
	}
	projectCatalogVersionSummary(&item, version)
	if !deprecated && selectableNodeCompatibility(compatibility) && !npmSemverPrerelease(version) {
		setRecommendedCatalogVersion(&item, version)
	}
	return item
}

func validatedNPMDistTags(tags map[string]string, versions map[string]npmVersionInfo) map[string]string {
	result := make(map[string]string)
	keys := make([]string, 0, len(tags))
	for key := range tags {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		key, version := strings.TrimSpace(key), strings.TrimSpace(tags[key])
		if len(result) >= npmMaxCatalogTags || !npmTagRE.MatchString(key) {
			continue
		}
		if _, exists := versions[version]; !exists {
			continue
		}
		if _, ok := parseNPMExactSemver(version); !ok {
			continue
		}
		result[key] = version
	}
	return result
}

func sortedNPMVersions(versions map[string]npmVersionInfo) []string {
	type parsedVersion struct {
		raw    string
		parsed npmSemver
	}
	parsed := make([]parsedVersion, 0, len(versions))
	for raw := range versions {
		version, ok := parseNPMExactSemver(raw)
		if !ok {
			continue
		}
		parsed = append(parsed, parsedVersion{raw: raw, parsed: version})
	}
	sort.SliceStable(parsed, func(left, right int) bool {
		return compareNPMSemver(parsed[left].parsed, parsed[right].parsed) > 0
	})
	result := make([]string, 0, len(parsed))
	for _, version := range parsed {
		result = append(result, version.raw)
	}
	return result
}

func boundedNPMVersions(ordered []string, tags map[string]string) []string {
	if len(ordered) <= npmMaxCatalogVersions {
		return ordered
	}
	required := make(map[string]bool, len(tags))
	for _, version := range tags {
		required[version] = true
	}
	result := make([]string, 0, npmMaxCatalogVersions+len(required))
	seen := make(map[string]bool, npmMaxCatalogVersions+len(required))
	for _, version := range ordered {
		if len(result) >= npmMaxCatalogVersions && !required[version] {
			continue
		}
		if !seen[version] {
			seen[version] = true
			result = append(result, version)
		}
	}
	sort.SliceStable(result, func(left, right int) bool {
		leftVersion, _ := parseNPMExactSemver(result[left])
		rightVersion, _ := parseNPMExactSemver(result[right])
		return compareNPMSemver(leftVersion, rightVersion) > 0
	})
	return result
}

func npmItemHasVersion(item model.PackageCatalogItem, version string) bool {
	for _, candidate := range item.Versions {
		if candidate.Version == version {
			return true
		}
	}
	return false
}

func firstStableNPMVersion(versions []model.PackageCatalogVersion) string {
	for _, version := range versions {
		if !npmSemverPrerelease(version.Version) {
			return version.Version
		}
	}
	if len(versions) > 0 {
		return versions[0].Version
	}
	return ""
}

func npmVersionSelectable(item model.PackageCatalogItem, version string) bool {
	for _, candidate := range item.Versions {
		if candidate.Version == version {
			return !candidate.Deprecated && !npmSemverPrerelease(candidate.Version) && selectableNodeCompatibility(candidate.Compatibility)
		}
	}
	return false
}

func npmDeprecation(raw json.RawMessage) (bool, string) {
	if len(raw) == 0 || string(raw) == "null" {
		return false, ""
	}
	var message string
	if json.Unmarshal(raw, &message) == nil {
		message = strings.TrimSpace(message)
		return message != "", message
	}
	var deprecated bool
	if json.Unmarshal(raw, &deprecated) == nil && deprecated {
		return true, "This package version is deprecated"
	}
	return false, ""
}

func npmLicense(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text)
	}
	var object struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &object) == nil {
		if value := strings.TrimSpace(object.Type); value != "" {
			return value
		}
		return strings.TrimSpace(object.Name)
	}
	return ""
}

func nodeCompatibilityWithTrust(runtimeVersion, constraint, runtimeTrust string) (string, string) {
	runtimeVersion, constraint = strings.TrimSpace(runtimeVersion), strings.TrimSpace(constraint)
	if runtimeVersion == "" {
		return "unknown", "Node.js runtime version is unavailable"
	}
	if constraint == "" {
		return "assumed-compatible", "The release does not declare an engines.node restriction"
	}
	runtime, ok := parseNPMSemver(runtimeVersion)
	if !ok {
		return "unknown", "engines.node could not be evaluated safely"
	}
	trust := strings.ToLower(strings.TrimSpace(runtimeTrust))
	if trust == "" || trust == "exact" {
		if runtime.parts != 3 {
			return "unknown", "An exact Node.js patch version is required to evaluate engines.node safely"
		}
		matches, understood := npmRangeMatches(constraint, runtime)
		if !understood {
			return "unknown", "engines.node could not be evaluated safely"
		}
		if matches {
			return "metadata-compatible", "engines.node " + constraint
		}
		return "incompatible", "engines.node " + constraint
	}
	if runtime.parts != 2 {
		return "unknown", "An exact Node.js patch version is required to evaluate engines.node safely"
	}
	floor := runtime
	floor.parts, floor.patch = 3, 0
	ceiling := runtime
	ceiling.parts, ceiling.patch = 3, ^uint64(0)
	floorMatches, floorUnderstood := npmRangeMatches(constraint, floor)
	ceilingMatches, ceilingUnderstood := npmRangeMatches(constraint, ceiling)
	if floorUnderstood && ceilingUnderstood && floorMatches && ceilingMatches {
		return "metadata-compatible", "engines.node " + constraint + " is compatible with the full Node.js " + runtimeVersion + " series"
	}
	return "unknown", "An exact Node.js patch version is required to evaluate engines.node safely"
}

func selectableNodeCompatibility(value string) bool {
	return value == "metadata-compatible" || value == "assumed-compatible"
}

func parseNPMExactSemver(raw string) (npmSemver, bool) {
	version, ok := parseNPMSemver(raw)
	return version, ok && version.parts == 3
}

func parseNPMSemver(raw string) (npmSemver, bool) {
	match := npmSemverRE.FindStringSubmatch(strings.TrimSpace(raw))
	if match == nil {
		return npmSemver{}, false
	}
	parts := 1
	if match[2] != "" {
		parts = 2
	}
	if match[3] != "" {
		parts = 3
	}
	major, majorErr := strconv.ParseUint(match[1], 10, 64)
	minor, minorErr := strconv.ParseUint(zeroIfEmpty(match[2]), 10, 64)
	patch, patchErr := strconv.ParseUint(zeroIfEmpty(match[3]), 10, 64)
	if majorErr != nil || minorErr != nil || patchErr != nil {
		return npmSemver{}, false
	}
	version := npmSemver{major: major, minor: minor, patch: patch, parts: parts}
	if match[4] != "" {
		version.prerelease = strings.Split(match[4], ".")
	}
	return version, true
}

func zeroIfEmpty(value string) string {
	if value == "" {
		return "0"
	}
	return value
}

func compareNPMSemver(left, right npmSemver) int {
	for _, pair := range [][2]uint64{{left.major, right.major}, {left.minor, right.minor}, {left.patch, right.patch}} {
		if pair[0] < pair[1] {
			return -1
		}
		if pair[0] > pair[1] {
			return 1
		}
	}
	if len(left.prerelease) == 0 && len(right.prerelease) == 0 {
		return 0
	}
	if len(left.prerelease) == 0 {
		return 1
	}
	if len(right.prerelease) == 0 {
		return -1
	}
	for index := 0; index < len(left.prerelease) && index < len(right.prerelease); index++ {
		leftPart, rightPart := left.prerelease[index], right.prerelease[index]
		if leftPart == rightPart {
			continue
		}
		leftNumber, leftErr := strconv.ParseUint(leftPart, 10, 64)
		rightNumber, rightErr := strconv.ParseUint(rightPart, 10, 64)
		if leftErr == nil && rightErr == nil {
			if leftNumber < rightNumber {
				return -1
			}
			return 1
		}
		if leftErr == nil {
			return -1
		}
		if rightErr == nil {
			return 1
		}
		if leftPart < rightPart {
			return -1
		}
		return 1
	}
	if len(left.prerelease) < len(right.prerelease) {
		return -1
	}
	if len(left.prerelease) > len(right.prerelease) {
		return 1
	}
	return 0
}

func npmSemverPrerelease(raw string) bool {
	version, ok := parseNPMExactSemver(raw)
	return ok && len(version.prerelease) > 0
}

func npmRangeMatches(raw string, runtime npmSemver) (bool, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "*" {
		return true, true
	}
	understoodAll := true
	for _, alternative := range strings.Split(raw, "||") {
		alternative = strings.TrimSpace(alternative)
		if alternative == "" {
			understoodAll = false
			continue
		}
		matches, understood := npmComparatorSetMatches(alternative, runtime)
		if understood && matches {
			return true, true
		}
		if !understood {
			understoodAll = false
		}
	}
	return false, understoodAll
}

// NPMVersionSatisfies verifies one installed exact version against the subset
// of npm SemVer ranges understood by the catalog. The second result is false
// for aliases, URLs, Git references, workspace ranges, or malformed input so
// callers do not mistake an unsupported declaration for a mismatch.
func NPMVersionSatisfies(version, constraint string) (bool, bool) {
	installed, ok := parseNPMExactSemver(version)
	if !ok {
		return false, false
	}
	return npmRangeMatches(constraint, installed)
}

func npmComparatorSetMatches(raw string, runtime npmSemver) (bool, bool) {
	if match := npmHyphenRangeRE.FindStringSubmatch(raw); match != nil {
		floor, floorOK := parseNPMSemver(match[1])
		ceiling, ceilingOK := parseNPMSemver(match[2])
		if !floorOK || !ceilingOK {
			return false, false
		}
		floor = npmLowerBound(floor)
		ceiling = npmUpperBound(ceiling)
		return compareNPMSemver(runtime, floor) >= 0 && compareNPMSemver(runtime, ceiling) <= 0, true
	}
	normalized := npmOperatorSpaceRE.ReplaceAllString(strings.ReplaceAll(raw, ",", " "), "$1")
	tokens := strings.Fields(normalized)
	if len(tokens) == 0 {
		return false, false
	}
	for _, token := range tokens {
		matches, understood := npmComparatorMatches(token, runtime)
		if !understood {
			return false, false
		}
		if !matches {
			return false, true
		}
	}
	return true, true
}

func npmComparatorMatches(token string, runtime npmSemver) (bool, bool) {
	token = strings.TrimSpace(token)
	if token == "" || token == "*" || strings.EqualFold(token, "x") {
		return true, true
	}
	operator, rawVersion := "", token
	for _, candidate := range []string{"!=", ">=", "<=", ">", "<", "=", "^", "~"} {
		if strings.HasPrefix(token, candidate) {
			operator, rawVersion = candidate, strings.TrimSpace(strings.TrimPrefix(token, candidate))
			break
		}
	}
	if lower, upper, wildcard := npmWildcardBounds(rawVersion); wildcard {
		if operator != "" && operator != "=" {
			return false, false
		}
		return compareNPMSemver(runtime, lower) >= 0 && compareNPMSemver(runtime, upper) < 0, true
	}
	version, ok := parseNPMSemver(rawVersion)
	if !ok {
		return false, false
	}
	lower := npmLowerBound(version)
	switch operator {
	case "^":
		return compareNPMSemver(runtime, lower) >= 0 && compareNPMSemver(runtime, npmCaretUpperBound(version)) < 0, true
	case "~":
		return compareNPMSemver(runtime, lower) >= 0 && compareNPMSemver(runtime, npmTildeUpperBound(version)) < 0, true
	case ">=":
		return compareNPMSemver(runtime, lower) >= 0, true
	case ">":
		return compareNPMSemver(runtime, npmUpperBound(version)) > 0, true
	case "<=":
		return compareNPMSemver(runtime, npmUpperBound(version)) <= 0, true
	case "<":
		return compareNPMSemver(runtime, lower) < 0, true
	case "!=":
		if version.parts != 3 {
			return false, false
		}
		return compareNPMSemver(runtime, version) != 0, true
	case "", "=":
		if version.parts == 3 {
			return compareNPMSemver(runtime, version) == 0, true
		}
		return compareNPMSemver(runtime, lower) >= 0 && compareNPMSemver(runtime, npmPartialUpperBound(version)) < 0, true
	default:
		return false, false
	}
}

func npmWildcardBounds(raw string) (npmSemver, npmSemver, bool) {
	trimmed := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(raw), "v"), "V")
	parts := strings.Split(trimmed, ".")
	if len(parts) == 0 || len(parts) > 3 {
		return npmSemver{}, npmSemver{}, false
	}
	wildcardIndex := -1
	values := [3]uint64{}
	for index, part := range parts {
		if part == "*" || strings.EqualFold(part, "x") {
			wildcardIndex = index
			break
		}
		value, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			return npmSemver{}, npmSemver{}, false
		}
		values[index] = value
	}
	if wildcardIndex < 0 {
		return npmSemver{}, npmSemver{}, false
	}
	for index := wildcardIndex + 1; index < len(parts); index++ {
		if parts[index] != "*" && !strings.EqualFold(parts[index], "x") {
			return npmSemver{}, npmSemver{}, false
		}
	}
	lower := npmSemver{major: values[0], minor: values[1], patch: values[2], parts: 3}
	upper := lower
	switch wildcardIndex {
	case 0:
		return npmSemver{}, npmSemver{major: ^uint64(0), parts: 3}, true
	case 1:
		upper.major++
		upper.minor, upper.patch = 0, 0
	case 2:
		upper.minor++
		upper.patch = 0
	}
	return lower, upper, true
}

func npmLowerBound(version npmSemver) npmSemver {
	version.parts = 3
	return version
}

func npmUpperBound(version npmSemver) npmSemver {
	parts := version.parts
	version.parts = 3
	if parts <= 1 {
		version.minor = ^uint64(0)
		version.patch = ^uint64(0)
	} else if parts == 2 {
		version.patch = ^uint64(0)
	}
	return version
}

func npmPartialUpperBound(version npmSemver) npmSemver {
	if version.parts <= 1 {
		return npmSemver{major: version.major + 1, parts: 3}
	}
	return npmSemver{major: version.major, minor: version.minor + 1, parts: 3}
}

func npmCaretUpperBound(version npmSemver) npmSemver {
	if version.parts == 1 {
		return npmSemver{major: version.major + 1, parts: 3}
	}
	if version.major > 0 {
		return npmSemver{major: version.major + 1, parts: 3}
	}
	if version.parts == 2 {
		return npmSemver{minor: version.minor + 1, parts: 3}
	}
	if version.minor > 0 {
		return npmSemver{minor: version.minor + 1, parts: 3}
	}
	return npmSemver{patch: version.patch + 1, parts: 3}
}

func npmTildeUpperBound(version npmSemver) npmSemver {
	if version.parts <= 1 {
		return npmSemver{major: version.major + 1, parts: 3}
	}
	return npmSemver{major: version.major, minor: version.minor + 1, parts: 3}
}
