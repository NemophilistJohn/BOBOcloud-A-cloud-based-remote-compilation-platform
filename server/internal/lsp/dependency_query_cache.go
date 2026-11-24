package lsp

import (
	"bobocloud-server/internal/safefile"
	"encoding/json"
	"sort"
	"strings"
)

func openDependencySource(view AnalysisDependencyView, source dependencyModuleSource) (*dependencyAPIIndexDirectory, error) {
	if source.mount < 0 || source.mount >= len(view.Mounts) || !view.Mounts[source.mount].ReadOnly {
		return nil, ErrDependencyAPIIndexUnavailable
	}
	directory, err := openDependencyAPIIndexDirectory(view.Mounts[source.mount].HostPath)
	if err != nil {
		return nil, err
	}
	for _, part := range source.parts {
		child, err := directory.OpenChild(part)
		_ = directory.Close()
		if err != nil {
			return nil, err
		}
		directory = child
	}
	return directory, nil
}

func readDependencySource(directory *dependencyAPIIndexDirectory, file string, maxBytes int64) ([]byte, error) {
	parts := strings.Split(file, "/")
	current := directory
	for _, part := range parts[:len(parts)-1] {
		child, err := current.OpenChild(part)
		if current != directory {
			_ = current.Close()
		}
		if err != nil {
			return nil, err
		}
		current = child
	}
	if current != directory {
		defer current.Close()
	}
	return current.ReadSmallRegular(parts[len(parts)-1], maxBytes)
}

func (s *Session) dependencyModuleSummary(state *dependencyQueryState, module string) (DependencyAPIIndexPage, error) {
	s.loadDependencySummaryCache(state)
	if cached, ok := state.summaries[module]; ok {
		state.touchDependencySummary(module)
		queueDependencySummaryChildren(state, cached)
		return cloneDependencyQueryPage(cached), nil
	}
	page := s.newDependencyQueryPage("module", module, false)
	sources := state.modules[module]
	if len(sources) == 0 {
		// Resolve requested descendants through known library roots, then let
		// each adapter open every segment beneath its validated mount.
		sources = s.resolveDependencyModule(state, module)
	}
	if len(sources) == 0 {
		page.Coverage = "unavailable"
		return page, nil
	}
	{
		symbols := make(map[string]string)
		children := make(map[string]bool)
		for _, source := range sources {
			if s.dependencyQueryStopped() {
				page.Truncated = true
				break
			}
			if source.kind == "runtime" {
				runtimePage, err := s.queryRuntimeDependencies(DependencyAPIQuery{Kind: "module", Module: module})
				if err != nil {
					return DependencyAPIIndexPage{}, ErrDependencyDiscoveryBusy
				}
				for _, entry := range runtimePage.Entries {
					if entry.Module == module {
						for _, symbol := range entry.Symbols {
							symbols[symbol.Name] = symbol.Kind
						}
					} else {
						children[entry.Module] = true
						state.addModule(entry.Module, dependencyModuleSource{mount: -1, kind: "runtime"}, false)
					}
				}
				page.Truncated = page.Truncated || runtimePage.Truncated
				page.Coverage = runtimePage.Coverage
				continue
			}
			directory, err := openDependencySource(s.Context.DependencyView, source)
			if err != nil {
				page.Truncated = true
				continue
			}
			switch state.language {
			case "python":
				s.summarizePython(state, directory, source, module, symbols, children, &page)
			case "node":
				s.summarizeNode(state, directory, source, module, symbols, children, &page)
			case "go":
				s.summarizeGo(state, directory, source, module, symbols, children, &page)
			case "rust":
				data, err := readDependencySource(directory, source.file, 256<<10)
				if err == nil {
					addDeclarationMatches(symbols, data, rustPublicPattern)
				} else {
					page.Coverage = "unavailable"
				}
			case "java":
				s.summarizeJava(directory, source, symbols, &page)
			case "c", "cpp":
				if data, err := readDependencySource(directory, source.file, 256<<10); err == nil {
					addDeclarationMatches(symbols, data, nativePublicPattern)
				} else {
					page.Coverage = "unavailable"
				}
			}
			_ = directory.Close()
		}
		entry := DependencyAPIIndexEntry{Module: module, Kind: "module"}
		for name, kind := range symbols {
			if validDependencyQuerySymbol(state.language, name) && (state.language == "node" || !strings.HasPrefix(name, "_")) {
				entry.Symbols = append(entry.Symbols, DependencyAPIIndexSymbol{Name: name, Kind: kind})
			}
		}
		sort.Slice(entry.Symbols, func(i, j int) bool { return entry.Symbols[i].Name < entry.Symbols[j].Name })
		if len(entry.Symbols) > dependencyQueryMaxSymbols {
			entry.Symbols = entry.Symbols[:dependencyQueryMaxSymbols]
			page.Truncated = true
		}
		page.Roots = []string{module}
		page.Entries = []DependencyAPIIndexEntry{entry}
		var names []string
		for name := range children {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			page.Entries = append(page.Entries, DependencyAPIIndexEntry{Module: name, Kind: "module"})
		}
		if page.Truncated {
			page.Coverage = "partial"
		}
	}
	// Cached child identities are sufficient to re-create the progressive
	// warm queue after reconnecting. Their sources are resolved on demand.
	queueDependencySummaryChildren(state, page)
	if !page.Truncated && page.Coverage != "unavailable" && page.Coverage != "partial" {
		state.cacheDependencySummary(module, page)
		s.writeDependencySummaryCache(state)
	}
	return page, nil
}

func (state *dependencyQueryState) touchDependencySummary(module string) {
	for index, name := range state.summaryOrder {
		if name == module {
			state.summaryOrder = append(state.summaryOrder[:index], state.summaryOrder[index+1:]...)
			break
		}
	}
	state.summaryOrder = append(state.summaryOrder, module)
}

func (state *dependencyQueryState) cacheDependencySummary(module string, page DependencyAPIIndexPage) {
	if _, exists := state.summaries[module]; !exists && len(state.summaries) >= dependencyQueryMaxSummaries {
		oldest := state.summaryOrder[0]
		state.summaryOrder = state.summaryOrder[1:]
		delete(state.summaries, oldest)
	}
	state.summaries[module] = cloneDependencyQueryPage(page)
	state.touchDependencySummary(module)
}

func queueDependencySummaryChildren(state *dependencyQueryState, page DependencyAPIIndexPage) {
	for _, entry := range page.Entries {
		if !state.queued[entry.Module] && len(state.project) < dependencyQueryMaxModules {
			state.queued[entry.Module] = true
			state.project = append(state.project, entry.Module)
		}
	}
}

func cloneDependencyQueryPage(page DependencyAPIIndexPage) DependencyAPIIndexPage {
	page.Roots = append([]string(nil), page.Roots...)
	page.Entries = append([]DependencyAPIIndexEntry(nil), page.Entries...)
	for index := range page.Entries {
		page.Entries[index].Symbols = append([]DependencyAPIIndexSymbol(nil), page.Entries[index].Symbols...)
	}
	return page
}

type dependencySummaryCache struct {
	Version  string                            `json:"version"`
	Revision string                            `json:"revision"`
	Runtime  string                            `json:"runtime"`
	Language string                            `json:"language"`
	Modules  map[string]DependencyAPIIndexPage `json:"modules"`
}

func (s *Session) loadDependencySummaryCache(state *dependencyQueryState) {
	if state.durableLoaded {
		return
	}
	state.durableLoaded = true
	if s.Cache.Path == "" {
		return
	}
	data, err := safefile.ReadSmallRegular(s.Cache.Path, ".dependency-modules-v1.json", dependencyQueryMaxCacheBytes)
	var cached dependencySummaryCache
	if err != nil || json.Unmarshal(data, &cached) != nil || cached.Version != dependencyQueryVersion || cached.Revision != s.dependencyQueryRevision() || cached.Runtime != s.Context.RuntimeID || cached.Language != state.language || len(cached.Modules) > dependencyQueryMaxSummaries {
		return
	}
	for module, page := range cached.Modules {
		if !validDependencyQueryName(module) || page.Schema != DependencyAPIIndexSchema || page.Module != module || page.Revision != cached.Revision || page.RuntimeID != cached.Runtime || page.LanguageID != cached.Language || page.Truncated || page.Coverage == "unavailable" {
			continue
		}
		state.cacheDependencySummary(module, page)
	}
}

func (s *Session) writeDependencySummaryCache(state *dependencyQueryState) {
	if s.Cache.Path == "" || s.dependencyQueryStopped() {
		return
	}
	modules := make(map[string]DependencyAPIIndexPage)
	for module, page := range state.summaries {
		if !page.Truncated && page.Coverage != "unavailable" {
			modules[module] = page
		}
	}
	cached := dependencySummaryCache{Version: dependencyQueryVersion, Revision: s.dependencyQueryRevision(), Runtime: s.Context.RuntimeID, Language: state.language, Modules: modules}
	data, err := json.Marshal(cached)
	if err == nil && len(data) <= dependencyQueryMaxCacheBytes {
		_ = safefile.WriteAtomic(s.Cache.Path, ".dependency-modules-v1.json", data, 0600)
	}
}

func (s *Session) resolveDependencyModule(state *dependencyQueryState, module string) []dependencyModuleSource {
	separator := "."
	if state.language == "node" || state.language == "go" {
		separator = "/"
	}
	for _, root := range state.roots {
		if !strings.HasPrefix(module, root+separator) {
			continue
		}
		tail := strings.TrimPrefix(module, root+separator)
		var sources []dependencyModuleSource
		for _, rootSource := range state.modules[root] {
			if rootSource.kind == "runtime" {
				return []dependencyModuleSource{rootSource}
			}
			if state.language == "python" {
				if source, ok := s.resolvePythonModuleSource(rootSource, tail); ok {
					sources = append(sources, source)
				}
				continue
			}
			source := rootSource
			source.parts = append(append([]string(nil), source.parts...), strings.Split(tail, separator)...)
			source.file, source.kind = "", "package"
			if state.language == "node" {
				source = rootSource
				source.prefix = tail
			}
			sources = append(sources, source)
		}
		return sources
	}
	return nil
}

// A reconnected summary cache retains child identities, not open descriptors.
// Resolve the final Python segment as either a package or a source file.
func (s *Session) resolvePythonModuleSource(root dependencyModuleSource, tail string) (dependencyModuleSource, bool) {
	if root.file != "" {
		return dependencyModuleSource{}, false
	}
	parts := strings.Split(tail, ".")
	source := root
	source.parts = append(append([]string(nil), root.parts...), parts[:len(parts)-1]...)
	parent, err := openDependencySource(s.Context.DependencyView, source)
	if err != nil {
		return dependencyModuleSource{}, false
	}
	defer parent.Close()
	name := parts[len(parts)-1]
	if child, err := parent.OpenChild(name); err == nil {
		_ = child.Close()
		source.parts = appendPath(source.parts, name)
		source.file, source.kind = "", "package"
		return source, true
	}
	for _, extension := range []string{".pyi", ".py"} {
		if _, err := parent.ReadSmallRegular(name+extension, 256<<10); err == nil {
			source.file, source.kind = name+extension, "module"
			return source, true
		}
	}
	return dependencyModuleSource{}, false
}
