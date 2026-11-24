package lsp

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
)

func (scan *dependencyQueryScan) readDirectory(directory *dependencyAPIIndexDirectory) []os.DirEntry {
	if scan.dirs >= dependencyQueryMaxDirs || scan.items >= dependencyQueryMaxItems || scan.session.dependencyQueryStopped() {
		scan.state.truncated = true
		return nil
	}
	scan.dirs++
	var result []os.DirEntry
	for len(result) < 4096 {
		batch, err := directory.ReadDir(128)
		scan.items += len(batch)
		result = append(result, batch...)
		if err != nil || scan.items >= dependencyQueryMaxItems || scan.session.dependencyQueryStopped() {
			if err != io.EOF || scan.items >= dependencyQueryMaxItems {
				scan.state.truncated = true
			}
			break
		}
	}
	if len(result) >= 4096 {
		scan.state.truncated = true
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name() < result[j].Name() })
	return result
}

func (state *dependencyQueryState) addModule(name string, source dependencyModuleSource, root bool) {
	if !validDependencyQueryName(name) {
		return
	}
	if _, exists := state.modules[name]; !exists {
		if len(state.modules) >= dependencyQueryMaxModules {
			state.truncated = true
			return
		}
		if root {
			state.roots = append(state.roots, name)
		}
	}
	source.parts = append([]string(nil), source.parts...)
	state.modules[name] = append(state.modules[name], source)
	if !state.queued[name] {
		state.queued[name] = true
		state.project = append(state.project, name)
	}
}

func (state *dependencyQueryState) catalogComplete() bool {
	return state.catalogStarted && len(state.catalogPending) == 0 && !state.runtimePending
}

func (state *dependencyQueryState) queueCatalog(task dependencyCatalogTask) {
	if len(state.catalogPending) >= dependencyQueryMaxDirs {
		state.truncated = true
		return
	}
	task.parts = append([]string(nil), task.parts...)
	state.catalogPending = append(state.catalogPending, task)
}

// Each request advances a bounded slice of discovery. Directory names are
// appended in discovery order, keeping offset cursors stable across slices.
// Source parsing stays in module requests and never delays the import catalog.
func (s *Session) discoverDependencyCatalog(state *dependencyQueryState) error {
	if !state.catalogStarted {
		state.catalogStarted = true
		state.runtimePending = s.Context.RuntimeDependencyQuery != nil
		for mountIndex, mount := range s.Context.DependencyView.Mounts {
			if mount.ReadOnly && mount.HostPath != "" && dependencyQueryMountRole(state.language, mount.Role) {
				state.queueCatalog(dependencyCatalogTask{mount: mountIndex, kind: "directory"})
			}
		}
	}
	scan := &dependencyQueryScan{session: s, state: state, dirs: state.catalogDirs, items: state.catalogItems}
	deadline := time.Now().Add(75 * time.Millisecond)
	for steps := 0; len(state.catalogPending) > 0 && steps < 64 && time.Now().Before(deadline); steps++ {
		if s.dependencyQueryStopped() {
			return ErrDependencyAPIIndexUnavailable
		}
		if scan.dirs >= dependencyQueryMaxDirs || scan.items >= dependencyQueryMaxItems {
			state.truncated = true
			state.catalogPending = nil
			break
		}
		task := state.catalogPending[0]
		state.catalogPending = state.catalogPending[1:]
		directory, err := openDependencySource(s.Context.DependencyView, dependencyModuleSource{mount: task.mount, parts: task.parts})
		if err != nil {
			state.truncated = true
			continue
		}
		switch task.kind {
		case "node-package":
			if _, err := directory.ReadSmallRegular("package.json", 256<<10); err == nil {
				state.addModule(strings.Join(task.parts, "/"), dependencyModuleSource{mount: task.mount, parts: task.parts, kind: "package"}, true)
			}
		case "node-scope":
			for _, entry := range scan.readDirectory(directory) {
				if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
					state.queueCatalog(dependencyCatalogTask{mount: task.mount, parts: appendPath(task.parts, entry.Name()), kind: "node-package"})
				}
			}
		case "java-archive":
			scan.discoverJavaArchive(directory, task.mount, task.parts, task.file)
		default:
			switch state.language {
			case "python":
				scan.discoverPython(directory, task.mount, task.parts, "", true)
			case "node":
				scan.discoverNode(directory, task.mount)
			case "rust":
				scan.discoverRust(directory, task.mount, task.parts, task.depth)
			default:
				scan.discoverTree(directory, task.mount, task.parts, task.depth)
			}
		}
		_ = directory.Close()
	}
	state.catalogDirs, state.catalogItems = scan.dirs, scan.items
	// Project mounts take precedence; merge runtime roots only after mount
	// discovery finishes. A denied no-wait lease remains retryable.
	if len(state.catalogPending) == 0 && state.runtimePending && !s.dependencyQueryStopped() {
		page, err := s.queryRuntimeDependencies(DependencyAPIQuery{Kind: "catalog"})
		if err != nil {
			return ErrDependencyDiscoveryBusy
		}
		for _, name := range page.Roots {
			if _, exists := state.modules[name]; !exists {
				state.addModule(name, dependencyModuleSource{mount: -1, kind: "runtime"}, true)
			}
		}
		state.truncated = state.truncated || page.Truncated
		state.runtimePending = false
	}
	if s.dependencyQueryStopped() {
		return ErrDependencyAPIIndexUnavailable
	}
	return nil
}

func pythonImportFile(name string) string {
	for _, extension := range []string{".pyi", ".py", ".so", ".pyd"} {
		if strings.HasSuffix(name, extension) {
			base := strings.TrimSuffix(name, extension)
			if extension == ".so" || extension == ".pyd" {
				base, _, _ = strings.Cut(base, ".")
			}
			if validPythonIdentifier(base) && base != "__init__" {
				return base
			}
		}
	}
	return ""
}

func (scan *dependencyQueryScan) discoverPython(directory *dependencyAPIIndexDirectory, mount int, parts []string, module string, roots bool) {
	for _, entry := range scan.readDirectory(directory) {
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		name := pythonImportFile(entry.Name())
		if entry.IsDir() {
			if !validPythonIdentifier(entry.Name()) || ignoredPythonTopLevelDirectory(entry.Name()) {
				continue
			}
			name = entry.Name()
			scan.state.addModule(joinModule(module, name, "."), dependencyModuleSource{mount: mount, parts: appendPath(parts, name), kind: "package"}, roots)
		} else if name != "" {
			scan.state.addModule(joinModule(module, name, "."), dependencyModuleSource{mount: mount, parts: parts, file: entry.Name(), kind: "module"}, roots)
		}
	}
}

func joinModule(parent, name, separator string) string {
	if parent == "" {
		return name
	}
	return parent + separator + name
}

func appendPath(parts []string, name string) []string {
	return append(append([]string(nil), parts...), name)
}

func (scan *dependencyQueryScan) discoverNode(directory *dependencyAPIIndexDirectory, mount int) {
	for _, entry := range scan.readDirectory(directory) {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		kind := "node-package"
		if strings.HasPrefix(entry.Name(), "@") {
			kind = "node-scope"
		}
		scan.state.queueCatalog(dependencyCatalogTask{mount: mount, parts: []string{entry.Name()}, kind: kind})
	}
}

var cargoNamePattern = regexp.MustCompile(`(?m)^\s*name\s*=\s*"([A-Za-z_][A-Za-z0-9_-]*)"`)

func (scan *dependencyQueryScan) discoverRust(directory *dependencyAPIIndexDirectory, mount int, parts []string, depth int) {
	if data, err := directory.ReadSmallRegular("Cargo.toml", 256<<10); err == nil {
		if match := cargoNamePattern.FindSubmatch(data); len(match) > 1 {
			name := strings.ReplaceAll(string(match[1]), "-", "_")
			scan.state.addModule(name, dependencyModuleSource{mount: mount, parts: parts, file: "src/lib.rs", kind: "module"}, true)
			return
		}
	}
	if depth >= 3 {
		return
	}
	for _, entry := range scan.readDirectory(directory) {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		scan.state.queueCatalog(dependencyCatalogTask{mount: mount, parts: appendPath(parts, entry.Name()), depth: depth + 1, kind: "directory"})
	}
}

func (scan *dependencyQueryScan) discoverTree(directory *dependencyAPIIndexDirectory, mount int, parts []string, depth int) {
	if depth > 16 {
		scan.state.truncated = true
		return
	}
	entries := scan.readDirectory(directory)
	if scan.state.language == "go" {
		if data, err := directory.ReadSmallRegular("go.mod", 256<<10); err == nil {
			name := goModuleName(data)
			if name != "" {
				scan.state.addModule(name, dependencyModuleSource{mount: mount, parts: parts, kind: "module"}, true)
				return
			}
		}
	}
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" || entry.Name() == "target" {
				continue
			}
			scan.state.queueCatalog(dependencyCatalogTask{mount: mount, parts: appendPath(parts, entry.Name()), depth: depth + 1, kind: "directory"})
			continue
		}
		switch scan.state.language {
		case "go":
			if strings.HasSuffix(entry.Name(), ".mod") {
				if data, err := directory.ReadSmallRegular(entry.Name(), 256<<10); err == nil {
					if name := goModuleName(data); name != "" {
						scan.state.addModule(name, dependencyModuleSource{mount: mount, parts: parts, archive: strings.TrimSuffix(entry.Name(), ".mod") + ".zip", prefix: name, kind: "module"}, true)
					}
				}
			}
		case "java":
			if strings.HasSuffix(entry.Name(), ".jar") && !strings.HasSuffix(entry.Name(), "-sources.jar") && !strings.HasSuffix(entry.Name(), "-javadoc.jar") {
				scan.state.queueCatalog(dependencyCatalogTask{mount: mount, parts: parts, file: entry.Name(), kind: "java-archive"})
			}
		case "c", "cpp":
			if isNativeHeader(entry.Name()) {
				name := strings.Join(appendPath(parts, entry.Name()), "/")
				if scan.session.Context.DependencyView.Mounts[mount].Role == DependencyRoleNativeSysroot {
					if index := strings.Index(name, "include/"); index >= 0 {
						name = name[index+len("include/"):]
					} else {
						continue
					}
				}
				scan.state.addModule(name, dependencyModuleSource{mount: mount, parts: parts, file: entry.Name(), kind: "module"}, true)
			}
		}
	}
}

func goModuleName(data []byte) string {
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "module" {
			name := strings.Trim(fields[1], "\"")
			if validDependencyQueryName(name) {
				return name
			}
		}
	}
	return ""
}

func isNativeHeader(name string) bool {
	return strings.HasSuffix(name, ".h") || strings.HasSuffix(name, ".hpp") || strings.HasSuffix(name, ".hxx") || !strings.Contains(name, ".")
}

func (scan *dependencyQueryScan) discoverJavaArchive(directory *dependencyAPIIndexDirectory, mount int, parts []string, archive string) {
	data, err := directory.ReadSmallRegular(archive, dependencyQueryMaxArchive)
	if err != nil {
		scan.state.truncated = true
		return
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		scan.state.truncated = true
		return
	}
	packages := make(map[string]bool)
	for _, file := range reader.File {
		if scan.session.dependencyQueryStopped() || scan.items >= dependencyQueryMaxItems {
			scan.state.truncated = true
			break
		}
		scan.items++
		name := file.Name
		if !strings.HasSuffix(name, ".class") || strings.Contains(name, "$") || strings.HasPrefix(name, "META-INF/") {
			continue
		}
		packageName := strings.ReplaceAll(path.Dir(name), "/", ".")
		if packageName == "." || !validPythonModulePath(packageName) || packages[packageName] {
			continue
		}
		packages[packageName] = true
		scan.state.addModule(packageName, dependencyModuleSource{mount: mount, parts: parts, archive: archive, prefix: strings.ReplaceAll(packageName, ".", "/") + "/", kind: "package"}, true)
	}
}
