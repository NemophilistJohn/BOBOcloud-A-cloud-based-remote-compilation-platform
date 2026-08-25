package packagecatalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/model"
	pep440 "github.com/aquasecurity/go-pep440-version"
)

const (
	SearchModeExact       = "exact"
	SearchModeCatalog     = "catalog"
	searchSchema          = "package-catalog-search/v1"
	exactMetadataCacheTTL = 2 * time.Minute
	exactMetadataCacheMax = 256
	catalogHedgeMaxDelay  = 200 * time.Millisecond
	catalogEnrichmentWait = 750 * time.Millisecond
)

var (
	ErrNotFound          = errors.New("package not found")
	pythonDistributionRE = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$`)
)

type Source struct {
	Public     model.PackageCenterSource
	CatalogURL string
	InstallURL string
}

type SearchRequest struct {
	Ecosystem           string
	Query               string
	SourceID            string
	Cursor              string
	RuntimeVersion      string
	RuntimeVersionTrust string
}

type ItemRequest struct {
	Ecosystem                 string
	Name                      string
	SourceID                  string
	RuntimeVersion            string
	RuntimeVersionTrust       string
	Version                   string
	PreferredCatalogAuthority string
}

type Catalog interface {
	Sources(ecosystem string) []model.PackageCenterSource
	DefaultSource(ecosystem string) string
	ResolveSource(ecosystem, id string) (Source, error)
	Search(context.Context, SearchRequest) (model.PackageCatalogSearchResult, error)
	Item(context.Context, ItemRequest) (model.PackageCatalogItem, error)
}

type Service struct {
	client           *http.Client
	timeout          time.Duration
	maxResponseBytes int64
	defaultSourceIDs map[string]string
	sources          map[string]Source
	ordered          []Source
	exactMu          sync.Mutex
	exactCache       map[string]exactMetadataCacheEntry
	exactInFlight    map[string]*exactMetadataCall
}

type exactMetadataCacheEntry struct {
	payload      pypiProject
	authorityURL string
	cachedAt     time.Time
	expiresAt    time.Time
}

type exactMetadataCall struct {
	done         chan struct{}
	payload      pypiProject
	authorityURL string
	err          error
}

func New(sources []config.PackageSourceConfig, defaultSourceID string, timeout time.Duration, maxResponseBytes int64) *Service {
	service := NewWithDefaults(sources, nil, timeout, maxResponseBytes)
	service.setDefaultSource(defaultSourceID)
	return service
}

// NewWithDefaults configures an independent default source for every package
// ecosystem. Registry URLs remain owned by the server-side source registry;
// callers can select only an advertised source ID.
func NewWithDefaults(sources []config.PackageSourceConfig, defaultSourceIDs map[string]string, timeout time.Duration, maxResponseBytes int64) *Service {
	if timeout <= 0 {
		timeout = 8 * time.Second
	}
	if maxResponseBytes <= 0 {
		maxResponseBytes = 4 << 20
	}
	client := &http.Client{Timeout: timeout}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) == 0 || len(via) >= 4 || req.URL.Scheme != "https" || catalogURLAuthority(req.URL) != catalogURLAuthority(via[0].URL) {
			return fmt.Errorf("package catalog redirect changed authority")
		}
		return nil
	}
	service := NewWithClient(sources, client, maxResponseBytes)
	for ecosystem, sourceID := range defaultSourceIDs {
		service.setDefaultSourceForEcosystem(ecosystem, sourceID)
	}
	return service
}

func catalogURLAuthority(value *url.URL) string {
	if value == nil {
		return ""
	}
	port := value.Port()
	if port == "" {
		port = "443"
	}
	return strings.ToLower(net.JoinHostPort(value.Hostname(), port))
}

func NewWithClient(sources []config.PackageSourceConfig, client *http.Client, maxResponseBytes int64) *Service {
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	if maxResponseBytes <= 0 {
		maxResponseBytes = 4 << 20
	}
	service := &Service{
		client: client, timeout: client.Timeout, maxResponseBytes: maxResponseBytes, sources: make(map[string]Source),
		defaultSourceIDs: make(map[string]string),
		exactCache:       make(map[string]exactMetadataCacheEntry), exactInFlight: make(map[string]*exactMetadataCall),
	}
	for _, item := range sources {
		catalogURL := strings.TrimRight(strings.TrimSpace(item.CatalogURL), "/")
		installURL := strings.TrimRight(strings.TrimSpace(item.InstallURL), "/") + "/"
		parsed, _ := url.Parse(catalogURL)
		source := Source{
			Public: model.PackageCenterSource{
				ID: strings.TrimSpace(item.ID), Ecosystem: strings.ToLower(strings.TrimSpace(item.Ecosystem)), Name: strings.TrimSpace(item.Name),
				Kind: strings.ToLower(strings.TrimSpace(item.Kind)), Official: item.Official, EquivalenceGroup: strings.TrimSpace(item.EquivalenceGroup),
				CatalogAuthority: parsed.Hostname(),
			},
			CatalogURL: catalogURL,
			InstallURL: installURL,
		}
		if source.Public.ID == "" || source.Public.Ecosystem == "" {
			continue
		}
		service.sources[source.Public.ID] = source
		service.ordered = append(service.ordered, source)
	}
	return service
}

func (s *Service) setDefaultSource(sourceID string) {
	if s == nil {
		return
	}
	sourceID = strings.TrimSpace(sourceID)
	if source, ok := s.sources[sourceID]; ok {
		s.defaultSourceIDs[source.Public.Ecosystem] = sourceID
	}
}

func (s *Service) setDefaultSourceForEcosystem(ecosystem, sourceID string) {
	if s == nil {
		return
	}
	ecosystem = strings.ToLower(strings.TrimSpace(ecosystem))
	sourceID = strings.TrimSpace(sourceID)
	if source, ok := s.sources[sourceID]; ok && source.Public.Ecosystem == ecosystem {
		s.defaultSourceIDs[ecosystem] = sourceID
	}
}

func (s *Service) Sources(ecosystem string) []model.PackageCenterSource {
	ecosystem = strings.ToLower(strings.TrimSpace(ecosystem))
	result := make([]model.PackageCenterSource, 0, len(s.ordered))
	for _, source := range s.ordered {
		if source.Public.Ecosystem == ecosystem {
			result = append(result, source.Public)
		}
	}
	return result
}

func (s *Service) DefaultSource(ecosystem string) string {
	ecosystem = strings.ToLower(strings.TrimSpace(ecosystem))
	if configured, ok := s.sources[s.defaultSourceIDs[ecosystem]]; ok && configured.Public.Ecosystem == ecosystem {
		return configured.Public.ID
	}
	var fallback string
	for _, source := range s.ordered {
		if source.Public.Ecosystem != ecosystem {
			continue
		}
		if fallback == "" {
			fallback = source.Public.ID
		}
		if source.Public.Official {
			return source.Public.ID
		}
	}
	return fallback
}

func (s *Service) ResolveSource(ecosystem, id string) (Source, error) {
	if s == nil {
		return Source{}, fmt.Errorf("package catalog is unavailable")
	}
	ecosystem = strings.ToLower(strings.TrimSpace(ecosystem))
	id = strings.TrimSpace(id)
	if id == "" {
		id = s.DefaultSource(ecosystem)
	}
	source, ok := s.sources[id]
	if !ok || source.Public.Ecosystem != ecosystem {
		return Source{}, fmt.Errorf("unknown %s package source: %s", ecosystem, id)
	}
	return source, nil
}

func (s *Service) Search(ctx context.Context, request SearchRequest) (model.PackageCatalogSearchResult, error) {
	switch normalizeCatalogEcosystem(request.Ecosystem) {
	case "python":
		return s.searchPython(ctx, request)
	case "node":
		return s.searchNPM(ctx, request)
	default:
		return model.PackageCatalogSearchResult{}, fmt.Errorf("unsupported package ecosystem: %s", strings.TrimSpace(request.Ecosystem))
	}
}

func normalizeCatalogEcosystem(ecosystem string) string {
	ecosystem = strings.ToLower(strings.TrimSpace(ecosystem))
	if ecosystem == "" {
		// Preserve the original API contract for existing Python callers while
		// handlers migrate to an explicit ecosystem.
		return "python"
	}
	return ecosystem
}

func (s *Service) searchPython(ctx context.Context, request SearchRequest) (model.PackageCatalogSearchResult, error) {
	query := strings.TrimSpace(request.Query)
	result := model.PackageCatalogSearchResult{Schema: searchSchema, Query: query, SourceID: strings.TrimSpace(request.SourceID), SearchMode: SearchModeExact, Items: []model.PackageCatalogItem{}}
	if request.Cursor != "" {
		return result, fmt.Errorf("the exact package catalog does not use cursors")
	}
	item, err := s.Item(ctx, ItemRequest{Ecosystem: "python", Name: query, SourceID: request.SourceID, RuntimeVersion: request.RuntimeVersion, RuntimeVersionTrust: request.RuntimeVersionTrust})
	if errors.Is(err, ErrNotFound) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.SourceID = request.SourceID
	if result.SourceID == "" {
		result.SourceID = s.DefaultSource("python")
	}
	item.Versions = nil
	result.Items = append(result.Items, item)
	return result, nil
}

func (s *Service) Item(ctx context.Context, request ItemRequest) (model.PackageCatalogItem, error) {
	switch normalizeCatalogEcosystem(request.Ecosystem) {
	case "python":
		return s.itemPython(ctx, request)
	case "node":
		return s.itemNPM(ctx, request)
	default:
		return model.PackageCatalogItem{}, fmt.Errorf("unsupported package ecosystem: %s", strings.TrimSpace(request.Ecosystem))
	}
}

func (s *Service) itemPython(ctx context.Context, request ItemRequest) (model.PackageCatalogItem, error) {
	name := strings.TrimSpace(request.Name)
	if !pythonDistributionRE.MatchString(name) {
		return model.PackageCatalogItem{}, fmt.Errorf("invalid Python distribution name")
	}
	source, err := s.ResolveSource("python", request.SourceID)
	if err != nil {
		return model.PackageCatalogItem{}, err
	}
	queryContext, cancelQuery := context.WithCancel(ctx)
	if s.timeout > 0 {
		queryContext, cancelQuery = context.WithTimeout(ctx, s.timeout)
	}
	defer cancelQuery()
	if version := strings.TrimSpace(request.Version); version != "" {
		official, ok := s.officialSource(source)
		if !ok {
			return model.PackageCatalogItem{}, fmt.Errorf("package source has no configured official metadata authority")
		}
		return s.fetchVersionItem(queryContext, official, name, version, request.RuntimeVersion, request.RuntimeVersionTrust)
	}
	candidates := s.catalogCandidates(source, request.PreferredCatalogAuthority)
	type catalogResult struct {
		index int
		item  model.PackageCatalogItem
		err   error
	}
	results := make(chan catalogResult, len(candidates))
	failures := make([]string, len(candidates))
	notFound := false
	timedOut := false
	launched := 0
	completed := 0
	launch := func(index int) {
		candidate := candidates[index]
		launched++
		go func() {
			item, fetchErr := s.fetchItem(queryContext, candidate, name, request.RuntimeVersion, request.RuntimeVersionTrust)
			results <- catalogResult{index: index, item: item, err: fetchErr}
		}()
	}
	launch(0)
	var hedgeTimer *time.Timer
	var hedge <-chan time.Time
	armHedge := func() {
		for launched < len(candidates) {
			delay := catalogHedgeDelay(queryContext)
			if delay > 0 {
				hedgeTimer = time.NewTimer(delay)
				hedge = hedgeTimer.C
				return
			}
			launch(launched)
		}
		hedge = nil
	}
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
	defer stopHedge()
	armHedge()
	for completed < len(candidates) {
		select {
		case outcome := <-results:
			completed++
			candidate := candidates[outcome.index]
			if outcome.err == nil {
				return outcome.item, nil
			}
			if errors.Is(outcome.err, ErrNotFound) {
				notFound = true
				if candidate.Public.Official {
					return model.PackageCatalogItem{}, ErrNotFound
				}
			} else {
				failures[outcome.index] = candidate.Public.CatalogAuthority + ": " + outcome.err.Error()
				timedOut = timedOut || errors.Is(outcome.err, context.DeadlineExceeded) || errors.Is(outcome.err, context.Canceled)
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
		case <-queryContext.Done():
			return model.PackageCatalogItem{}, fmt.Errorf("query equivalent package catalogs: %w", queryContext.Err())
		}
	}
	if queryContext.Err() != nil {
		return model.PackageCatalogItem{}, fmt.Errorf("query equivalent package catalogs: %w", queryContext.Err())
	}
	compactFailures := failures[:0]
	for _, failure := range failures {
		if failure != "" {
			compactFailures = append(compactFailures, failure)
		}
	}
	if len(compactFailures) == 0 {
		if notFound {
			return model.PackageCatalogItem{}, ErrNotFound
		}
		return model.PackageCatalogItem{}, fmt.Errorf("package catalog has no configured authority")
	}
	if timedOut {
		return model.PackageCatalogItem{}, fmt.Errorf("query equivalent package catalogs: %w: %s", context.DeadlineExceeded, strings.Join(compactFailures, "; "))
	}
	return model.PackageCatalogItem{}, fmt.Errorf("query equivalent package catalogs: %s", strings.Join(compactFailures, "; "))
}

func (s *Service) officialSource(source Source) (Source, bool) {
	for _, candidate := range s.ordered {
		if candidate.Public.Official && candidate.Public.Ecosystem == source.Public.Ecosystem && candidate.Public.EquivalenceGroup == source.Public.EquivalenceGroup {
			return candidate, true
		}
	}
	return Source{}, false
}

func catalogHedgeDelay(parent context.Context) time.Duration {
	delay := catalogHedgeMaxDelay
	if deadline, bounded := parent.Deadline(); bounded {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return 0
		}
		if fraction := remaining / 8; fraction < delay {
			delay = fraction
		}
	}
	return delay
}

func catalogEnrichmentContext(parent context.Context) (context.Context, context.CancelFunc) {
	wait := catalogEnrichmentWait
	if deadline, bounded := parent.Deadline(); bounded {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return context.WithCancel(parent)
		}
		if fraction := remaining / 3; fraction < wait {
			wait = fraction
		}
	}
	return context.WithTimeout(parent, wait)
}

func (s *Service) catalogCandidates(primary Source, preferredAuthority string) []Source {
	result := []Source{primary}
	seen := map[string]bool{primary.CatalogURL: true}
	for _, candidate := range s.ordered {
		if candidate.Public.Ecosystem != primary.Public.Ecosystem || candidate.Public.EquivalenceGroup != primary.Public.EquivalenceGroup || seen[candidate.CatalogURL] {
			continue
		}
		seen[candidate.CatalogURL] = true
		result = append(result, candidate)
	}
	for index := 1; index < len(result); index++ {
		if strings.EqualFold(result[index].Public.CatalogAuthority, strings.TrimSpace(preferredAuthority)) {
			preferred := result[index]
			copy(result[1:index+1], result[0:index])
			result[0] = preferred
			break
		}
	}
	return result
}

func (s *Service) fetchItem(ctx context.Context, source Source, name, runtimeVersion, runtimeVersionTrust string) (model.PackageCatalogItem, error) {
	endpoint := source.CatalogURL + "/simple/" + url.PathEscape(name) + "/"
	var simple pypiSimpleProject
	response, err := s.fetchJSON(ctx, endpoint, "application/vnd.pypi.simple.v1+json", &simple)
	if err != nil {
		return model.PackageCatalogItem{}, err
	}
	releases := simpleProjectReleases(simple)
	stable := sortedStablePythonReleases(simple.Versions)
	latest := firstInstallableRelease(stable, releases)
	if latest == "" {
		return model.PackageCatalogItem{}, ErrNotFound
	}
	official, ok := s.officialSource(source)
	if !ok {
		return model.PackageCatalogItem{}, fmt.Errorf("package source has no configured official metadata authority")
	}
	metadata := pypiProject{
		Info:       pypiInfo{Name: strings.TrimSpace(simple.Name), Version: latest},
		Releases:   releases,
		LastSerial: simple.Meta.LastSerial,
	}
	enrichmentContext, cancelEnrichment := catalogEnrichmentContext(ctx)
	enrichment, _, enrichmentErr := s.fetchVersionProjectDirect(enrichmentContext, official, name, latest)
	cancelEnrichment()
	if enrichmentErr == nil && !catalogRevisionAhead(simple.Meta.LastSerial, enrichment.LastSerial) {
		for index := range enrichment.URLs {
			enrichment.URLs[index].MetadataKnown = true
			if strings.TrimSpace(enrichment.URLs[index].RequiresPython) == "" {
				enrichment.URLs[index].RequiresPython = strings.TrimSpace(enrichment.Info.RequiresPython)
			}
		}
		releases[latest] = enrichment.URLs
		enrichment.Releases = releases
		if strings.TrimSpace(enrichment.Info.Name) == "" {
			enrichment.Info.Name = strings.TrimSpace(simple.Name)
		}
		enrichment.Info.Version = latest
		metadata = enrichment
	}
	actualSource := source
	if response != nil && response.Request != nil && response.Request.URL != nil && response.Request.URL.Hostname() != "" {
		actualSource.Public.CatalogAuthority = response.Request.URL.Hostname()
	}
	item := packageItemFromPyPI(metadata, actualSource, runtimeVersion, runtimeVersionTrust)
	for index := range item.Versions {
		candidate := item.Versions[index]
		if !stablePythonRelease(candidate.Version) || candidate.Yanked || !selectablePythonCompatibility(candidate.Compatibility) {
			continue
		}
		setRecommendedCatalogVersion(&item, candidate.Version)
		return item, nil
	}
	return item, nil
}

func (s *Service) fetchVersionItem(ctx context.Context, official Source, name, version, runtimeVersion, runtimeVersionTrust string) (model.PackageCatalogItem, error) {
	payload, response, err := s.fetchVersionProject(ctx, official, name, version)
	if err != nil {
		return model.PackageCatalogItem{}, err
	}
	for index := range payload.URLs {
		payload.URLs[index].MetadataKnown = true
		if strings.TrimSpace(payload.URLs[index].RequiresPython) == "" {
			payload.URLs[index].RequiresPython = strings.TrimSpace(payload.Info.RequiresPython)
		}
	}
	payload.Releases = map[string][]pypiRelease{version: payload.URLs}
	payload.Info.Version = version
	actualSource := official
	if response != nil && response.Request != nil && response.Request.URL != nil && response.Request.URL.Hostname() != "" {
		actualSource.Public.CatalogAuthority = response.Request.URL.Hostname()
	}
	item := packageItemFromPyPI(payload, actualSource, runtimeVersion, runtimeVersionTrust)
	if len(item.Versions) == 1 && stablePythonRelease(version) && !item.Versions[0].Yanked && selectablePythonCompatibility(item.Versions[0].Compatibility) {
		setRecommendedCatalogVersion(&item, version)
	}
	return item, nil
}

func (s *Service) fetchVersionProject(ctx context.Context, official Source, name, version string) (pypiProject, *http.Response, error) {
	key := strings.TrimRight(official.CatalogURL, "/") + "\x00" + strings.ToLower(strings.TrimSpace(name)) + "\x00" + strings.TrimSpace(version)
	now := time.Now()
	s.exactMu.Lock()
	if cached, ok := s.exactCache[key]; ok && now.Before(cached.expiresAt) {
		s.exactMu.Unlock()
		return clonePyPIProject(cached.payload), catalogResponseForAuthority(cached.authorityURL), nil
	}
	if call := s.exactInFlight[key]; call != nil {
		s.exactMu.Unlock()
		select {
		case <-call.done:
			return clonePyPIProject(call.payload), catalogResponseForAuthority(call.authorityURL), call.err
		case <-ctx.Done():
			return pypiProject{}, nil, ctx.Err()
		}
	}
	call := &exactMetadataCall{done: make(chan struct{})}
	s.exactInFlight[key] = call
	s.exactMu.Unlock()

	payload, response, err := s.fetchVersionProjectDirect(ctx, official, name, version)
	authorityURL := ""
	if response != nil && response.Request != nil && response.Request.URL != nil {
		authorityURL = response.Request.URL.String()
	}
	s.exactMu.Lock()
	call.payload, call.authorityURL, call.err = clonePyPIProject(payload), authorityURL, err
	if err == nil {
		if len(s.exactCache) >= exactMetadataCacheMax {
			oldestKey := ""
			var oldest time.Time
			for candidateKey, candidate := range s.exactCache {
				if oldestKey == "" || candidate.cachedAt.Before(oldest) {
					oldestKey, oldest = candidateKey, candidate.cachedAt
				}
			}
			delete(s.exactCache, oldestKey)
		}
		s.exactCache[key] = exactMetadataCacheEntry{
			payload: clonePyPIProject(payload), authorityURL: authorityURL,
			cachedAt: now, expiresAt: now.Add(exactMetadataCacheTTL),
		}
	}
	delete(s.exactInFlight, key)
	close(call.done)
	s.exactMu.Unlock()
	return payload, response, err
}

func (s *Service) fetchVersionProjectDirect(ctx context.Context, official Source, name, version string) (pypiProject, *http.Response, error) {
	endpoint := official.CatalogURL + "/pypi/" + url.PathEscape(name) + "/" + url.PathEscape(version) + "/json"
	var payload pypiProject
	response, err := s.fetchJSON(ctx, endpoint, "application/json", &payload)
	return payload, response, err
}

func (s *Service) invalidateVersionProject(official Source, name, version string) {
	key := strings.TrimRight(official.CatalogURL, "/") + "\x00" + strings.ToLower(strings.TrimSpace(name)) + "\x00" + strings.TrimSpace(version)
	s.exactMu.Lock()
	delete(s.exactCache, key)
	s.exactMu.Unlock()
}

func clonePyPIProject(value pypiProject) pypiProject {
	result := value
	result.Info.ProjectURLs = make(map[string]string, len(value.Info.ProjectURLs))
	for key, item := range value.Info.ProjectURLs {
		result.Info.ProjectURLs[key] = item
	}
	result.URLs = append([]pypiRelease(nil), value.URLs...)
	result.Releases = make(map[string][]pypiRelease, len(value.Releases))
	for version, files := range value.Releases {
		result.Releases[version] = append([]pypiRelease(nil), files...)
	}
	return result
}

func catalogResponseForAuthority(authorityURL string) *http.Response {
	parsed, err := url.Parse(strings.TrimSpace(authorityURL))
	if err != nil || parsed.Host == "" {
		return nil
	}
	return &http.Response{Request: &http.Request{URL: parsed}}
}

func (s *Service) fetchJSON(ctx context.Context, endpoint, accept string, target any) (*http.Response, error) {
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Accept", accept)
	httpRequest.Header.Set("User-Agent", "BOBOCLOUD-Package-Center/1")
	response, err := s.client.Do(httpRequest)
	if err != nil {
		return nil, fmt.Errorf("query package catalog: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, ErrNotFound
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("package catalog returned HTTP %d", response.StatusCode)
	}
	limited := io.LimitReader(response.Body, s.maxResponseBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("read package catalog response: %w", err)
	}
	if int64(len(data)) > s.maxResponseBytes {
		return nil, fmt.Errorf("package catalog response exceeds %d bytes", s.maxResponseBytes)
	}
	if err := json.Unmarshal(data, target); err != nil {
		return nil, fmt.Errorf("decode package catalog response: %w", err)
	}
	return response, nil
}

type pypiSerial string

func (value *pypiSerial) UnmarshalJSON(data []byte) error {
	raw := strings.Trim(strings.TrimSpace(string(data)), `"`)
	if raw == "" || raw == "null" {
		*value = ""
		return nil
	}
	if _, err := strconv.ParseUint(raw, 10, 64); err != nil {
		return fmt.Errorf("invalid package catalog serial")
	}
	*value = pypiSerial(raw)
	return nil
}

func catalogRevisionAhead(candidate, official pypiSerial) bool {
	if candidate == "" || official == "" {
		return false
	}
	candidateValue, candidateErr := strconv.ParseUint(string(candidate), 10, 64)
	officialValue, officialErr := strconv.ParseUint(string(official), 10, 64)
	return candidateErr == nil && officialErr == nil && candidateValue > officialValue
}

type pypiSimpleProject struct {
	Name     string           `json:"name"`
	Versions []string         `json:"versions"`
	Files    []pypiSimpleFile `json:"files"`
	Meta     struct {
		LastSerial pypiSerial `json:"_last-serial"`
	} `json:"meta"`
}

type pypiSimpleFile struct {
	Filename       string     `json:"filename"`
	RequiresPython string     `json:"requires-python"`
	Yanked         pypiYanked `json:"yanked"`
	UploadTime     string     `json:"upload-time"`
}

type pypiYanked bool

func (value *pypiYanked) UnmarshalJSON(data []byte) error {
	var boolean bool
	if err := json.Unmarshal(data, &boolean); err == nil {
		*value = pypiYanked(boolean)
		return nil
	}
	var reason string
	if err := json.Unmarshal(data, &reason); err == nil {
		// PEP 691 uses any string value as a yanked marker; the string is the
		// optional reason and may legitimately be empty.
		*value = true
		return nil
	}
	if strings.TrimSpace(string(data)) == "null" {
		*value = false
		return nil
	}
	return fmt.Errorf("invalid package yanked metadata")
}

type pypiInfo struct {
	Name           string            `json:"name"`
	Version        string            `json:"version"`
	Summary        string            `json:"summary"`
	License        string            `json:"license"`
	HomePage       string            `json:"home_page"`
	RequiresPython string            `json:"requires_python"`
	ProjectURLs    map[string]string `json:"project_urls"`
}

type pypiRelease struct {
	Yanked         bool   `json:"yanked"`
	UploadTime     string `json:"upload_time_iso_8601"`
	RequiresPython string `json:"requires_python"`
	MetadataKnown  bool   `json:"-"`
}

type pypiProject struct {
	Info       pypiInfo                 `json:"info"`
	Releases   map[string][]pypiRelease `json:"releases"`
	URLs       []pypiRelease            `json:"urls"`
	LastSerial pypiSerial               `json:"last_serial"`
}

func sortedStablePythonReleases(versions []string) []string {
	type parsedRelease struct {
		raw    string
		parsed pep440.Version
	}
	seen := make(map[string]bool, len(versions))
	parsed := make([]parsedRelease, 0, len(versions))
	for _, raw := range versions {
		raw = strings.TrimSpace(raw)
		if raw == "" || seen[raw] {
			continue
		}
		version, err := pep440.Parse(raw)
		if err != nil || version.IsPreRelease() {
			continue
		}
		seen[raw] = true
		parsed = append(parsed, parsedRelease{raw: raw, parsed: version})
	}
	sort.SliceStable(parsed, func(i, j int) bool {
		return parsed[i].parsed.Compare(parsed[j].parsed) > 0
	})
	result := make([]string, 0, len(parsed))
	for _, item := range parsed {
		result = append(result, item.raw)
	}
	return result
}

func stablePythonRelease(raw string) bool {
	version, err := pep440.Parse(strings.TrimSpace(raw))
	return err == nil && !version.IsPreRelease()
}

func firstInstallableRelease(sorted []string, releases map[string][]pypiRelease) string {
	for _, version := range sorted {
		if len(releases[version]) > 0 {
			return version
		}
	}
	return ""
}

func simpleProjectReleases(project pypiSimpleProject) map[string][]pypiRelease {
	releases := make(map[string][]pypiRelease, len(project.Versions))
	for _, file := range project.Files {
		version := simpleFileVersion(file.Filename, project.Versions)
		if version == "" {
			continue
		}
		releases[version] = append(releases[version], pypiRelease{
			Yanked: bool(file.Yanked), UploadTime: file.UploadTime,
			RequiresPython: strings.TrimSpace(file.RequiresPython), MetadataKnown: true,
		})
	}
	return releases
}

func simpleFileVersion(filename string, versions []string) string {
	filename = strings.ToLower(strings.TrimSpace(filename))
	if filename == "" {
		return ""
	}
	bestVersion, bestMarkerLength := "", 0
	for _, raw := range versions {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		variants := []string{raw, strings.ReplaceAll(raw, "-", "_")}
		if parsed, err := pep440.Parse(raw); err == nil {
			variants = append(variants, parsed.String(), strings.ReplaceAll(parsed.String(), "-", "_"))
		}
		seen := make(map[string]bool, len(variants))
		for _, variant := range variants {
			variant = strings.ToLower(strings.TrimSpace(variant))
			if variant == "" || seen[variant] {
				continue
			}
			seen[variant] = true
			marker := "-" + variant
			position := strings.LastIndex(filename, marker)
			if position < 0 {
				continue
			}
			suffix := filename[position+len(marker):]
			if !strings.HasPrefix(suffix, "-") && !pythonArchiveSuffix(suffix) {
				continue
			}
			if len(marker) > bestMarkerLength {
				bestVersion, bestMarkerLength = raw, len(marker)
			}
		}
	}
	return bestVersion
}

func pythonArchiveSuffix(value string) bool {
	for _, suffix := range []string{".tar.gz", ".tar.bz2", ".tar.xz", ".zip", ".tgz"} {
		if strings.EqualFold(value, suffix) {
			return true
		}
	}
	return false
}

func packageItemFromPyPI(payload pypiProject, source Source, runtimeVersion, runtimeVersionTrust string) model.PackageCatalogItem {
	homepage := strings.TrimSpace(payload.Info.HomePage)
	if homepage == "" {
		for _, key := range []string{"Homepage", "Home", "Source", "Repository"} {
			if value := strings.TrimSpace(payload.Info.ProjectURLs[key]); value != "" {
				homepage = value
				break
			}
		}
	}
	item := model.PackageCatalogItem{
		Name: strings.TrimSpace(payload.Info.Name), LatestVersion: strings.TrimSpace(payload.Info.Version), Description: strings.TrimSpace(payload.Info.Summary),
		License: strings.TrimSpace(payload.Info.License), Homepage: homepage, RequiresLanguage: strings.TrimSpace(payload.Info.RequiresPython),
		CatalogAuthority: source.Public.CatalogAuthority, Versions: []model.PackageCatalogVersion{},
	}
	for version, files := range payload.Releases {
		if strings.TrimSpace(version) == "" || len(files) == 0 {
			continue
		}
		requires, published, yanked := "", "", true
		compatibility, reason, compatibilityRank := "unknown", "Package file compatibility metadata is unavailable", 0
		for _, file := range files {
			if published == "" || (file.UploadTime != "" && file.UploadTime < published) {
				published = file.UploadTime
			}
			if !file.Yanked {
				yanked = false
			}
			if file.Yanked {
				continue
			}
			candidateCompatibility, candidateReason := "unknown", "Package file compatibility metadata is unavailable"
			if file.MetadataKnown {
				candidateCompatibility, candidateReason = pythonCompatibilityWithTrust(runtimeVersion, file.RequiresPython, runtimeVersionTrust)
			}
			rank := pythonCompatibilityRank(candidateCompatibility)
			if rank > compatibilityRank {
				compatibility, reason, compatibilityRank = candidateCompatibility, candidateReason, rank
				requires = strings.TrimSpace(file.RequiresPython)
			}
		}
		if yanked {
			for _, file := range files {
				if file.MetadataKnown {
					compatibility, reason = pythonCompatibilityWithTrust(runtimeVersion, file.RequiresPython, runtimeVersionTrust)
					requires = strings.TrimSpace(file.RequiresPython)
					break
				}
			}
		}
		item.Versions = append(item.Versions, model.PackageCatalogVersion{Version: version, RequiresLanguage: requires, Yanked: yanked, PublishedAt: published, Compatibility: compatibility, Reason: reason})
	}
	sort.SliceStable(item.Versions, func(i, j int) bool {
		left, leftErr := pep440.Parse(item.Versions[i].Version)
		right, rightErr := pep440.Parse(item.Versions[j].Version)
		if leftErr != nil || rightErr != nil {
			return strings.Compare(strings.ToLower(item.Versions[i].Version), strings.ToLower(item.Versions[j].Version)) > 0
		}
		return left.Compare(right) > 0
	})
	projectCatalogVersionSummary(&item, item.LatestVersion)
	return item
}

func setRecommendedCatalogVersion(item *model.PackageCatalogItem, version string) {
	if item == nil {
		return
	}
	item.RecommendedVersion = strings.TrimSpace(version)
	projectCatalogVersionSummary(item, item.RecommendedVersion)
}

func projectCatalogVersionSummary(item *model.PackageCatalogItem, version string) {
	if item == nil {
		return
	}
	version = strings.TrimSpace(version)
	for _, candidate := range item.Versions {
		if candidate.Version != version {
			continue
		}
		item.RequiresLanguage = candidate.RequiresLanguage
		item.Compatibility = candidate.Compatibility
		item.CompatibilityReason = candidate.Reason
		item.Deprecated = candidate.Deprecated
		item.DeprecationMessage = candidate.DeprecationMessage
		return
	}
}

func pythonCompatibility(runtimeVersion, constraint string) (string, string) {
	return pythonCompatibilityWithTrust(runtimeVersion, constraint, "exact")
}

func pythonCompatibilityWithTrust(runtimeVersion, constraint, runtimeVersionTrust string) (string, string) {
	runtimeVersion, constraint = strings.TrimSpace(runtimeVersion), strings.TrimSpace(constraint)
	if runtimeVersion == "" {
		return "unknown", "Python runtime version is unavailable"
	}
	if constraint == "" {
		return "assumed-compatible", "The release does not declare a Requires-Python restriction"
	}
	runtime, runtimeErr := pep440.Parse(runtimeVersion)
	specifiers, constraintErr := pep440.NewSpecifiers(constraint)
	if runtimeErr != nil || constraintErr != nil {
		return "unknown", "Requires-Python could not be evaluated safely"
	}
	trust := strings.ToLower(strings.TrimSpace(runtimeVersionTrust))
	if trust == "" || trust == "exact" {
		if specifiers.Check(runtime) {
			return "metadata-compatible", "Requires-Python " + constraint
		}
		return "incompatible", "Requires-Python " + constraint
	}
	parts := strings.Split(runtimeVersion, ".")
	if len(parts) != 2 || strings.Contains(constraint, "!=") || strings.Contains(constraint, "==") || strings.Contains(constraint, "===") {
		return "unknown", "An exact Python patch version is required to evaluate Requires-Python safely"
	}
	floor, floorErr := pep440.Parse(runtimeVersion + ".0")
	ceiling, ceilingErr := pep440.Parse(runtimeVersion + ".999999999")
	if floorErr == nil && ceilingErr == nil && specifiers.Check(floor) && specifiers.Check(ceiling) {
		return "metadata-compatible", "Requires-Python " + constraint + " is compatible with the full Python " + runtimeVersion + " series"
	}
	return "unknown", "An exact Python patch version is required to evaluate Requires-Python safely"
}

func pythonCompatibilityRank(value string) int {
	switch value {
	case "metadata-compatible":
		return 4
	case "assumed-compatible":
		return 3
	case "unknown":
		return 2
	case "incompatible":
		return 1
	default:
		return 0
	}
}

func selectablePythonCompatibility(value string) bool {
	return value == "metadata-compatible" || value == "assumed-compatible"
}
