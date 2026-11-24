package lsp

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"path"
	"regexp"
	"strings"
)

func (s *Session) summarizePython(state *dependencyQueryState, directory *dependencyAPIIndexDirectory, source dependencyModuleSource, module string, symbols map[string]string, children map[string]bool, page *DependencyAPIIndexPage) {
	builder := newDependencyAPIIndexBuild()
	if source.file != "" {
		if data, err := directory.ReadSmallRegular(source.file, 256<<10); err == nil && (strings.HasSuffix(source.file, ".py") || strings.HasSuffix(source.file, ".pyi")) {
			parsed := builder.parsePythonModuleSource(data, module, false)
			for name, kind := range parsed.symbols {
				symbols[name] = kind
			}
		} else {
			page.Coverage = "unavailable"
		}
		return
	}
	builder.addPythonModule(directory, module, "package", "__init__")
	scan := &dependencyQueryScan{session: s, state: state}
	scan.discoverPython(directory, source.mount, source.parts, module, false)
	for name, locations := range state.modules {
		if !strings.HasPrefix(name, module+".") || strings.Contains(strings.TrimPrefix(name, module+"."), ".") {
			continue
		}
		children[name] = true
		// Static star re-exports need the corresponding direct child source.
		if len(locations) > 0 && locations[0].file != "" {
			builder.addPythonModule(directory, name, "module", strings.TrimSuffix(locations[0].file, path.Ext(locations[0].file)))
		}
	}
	entries, _, truncated := builder.finalizePythonModules()
	page.Truncated = page.Truncated || truncated
	for _, entry := range entries {
		if entry.Module == module {
			for _, symbol := range entry.Symbols {
				symbols[symbol.Name] = symbol.Kind
			}
		}
	}
}

var nodeDeclarationPattern = regexp.MustCompile(`(?m)(?:^|[;\n])\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)`)
var nodeExportAssignmentPattern = regexp.MustCompile(`\b(?:exports|module\.exports)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=`)
var nodeExportListPattern = regexp.MustCompile(`(?s)export\s+(?:type\s+)?\{([^}]+)\}`)
var rustPublicPattern = regexp.MustCompile(`(?m)^\s*pub\s+(?:async\s+)?(fn|struct|enum|trait|type|const|static|mod)\s+([A-Za-z_][A-Za-z0-9_]*)`)
var nativePublicPattern = regexp.MustCompile(`(?m)^\s*(?:(?:extern|static|inline|constexpr|typedef)\s+)*(?:(?:[A-Za-z_][A-Za-z0-9_]*\s+|[*&])+)([A-Za-z_][A-Za-z0-9_]*)\s*\(`)

func addDeclarationMatches(symbols map[string]string, data []byte, pattern *regexp.Regexp) {
	for _, match := range pattern.FindAllSubmatch(data, dependencyQueryMaxSymbols+1) {
		kind, name := "function", ""
		if len(match) == 3 {
			kind, name = string(match[1]), string(match[2])
		} else if len(match) == 2 {
			name = string(match[1])
		}
		switch kind {
		case "function", "fn":
			kind = "function"
		case "class", "interface", "type", "enum", "struct", "trait":
			kind = "class"
		case "mod":
			kind = "module"
		default:
			kind = "value"
		}
		if name != "" {
			symbols[name] = kind
		}
	}
}

func (s *Session) summarizeNode(state *dependencyQueryState, directory *dependencyAPIIndexDirectory, source dependencyModuleSource, module string, symbols map[string]string, children map[string]bool, page *DependencyAPIIndexPage) {
	data, err := directory.ReadSmallRegular("package.json", 256<<10)
	var manifest struct {
		Types   string `json:"types"`
		Typings string `json:"typings"`
		Main    string `json:"main"`
		Exports any    `json:"exports"`
	}
	if err != nil || json.Unmarshal(data, &manifest) != nil {
		page.Coverage = "unavailable"
		return
	}
	entry := chooseNodeExport(manifest.Exports)
	if exports, ok := manifest.Exports.(map[string]any); ok {
		if value, exists := exports["."]; exists {
			entry = chooseNodeExport(value)
		}
		for subpath := range exports {
			if strings.HasPrefix(subpath, "./") && !strings.Contains(subpath, "*") && validDependencyQueryName(strings.TrimPrefix(subpath, "./")) {
				name := module + "/" + strings.TrimPrefix(subpath, "./")
				children[name] = true
			}
		}
		if source.prefix != "" {
			entry = chooseNodeExport(exports["./"+source.prefix])
		}
	}
	if source.prefix == "" {
		for _, candidate := range []string{manifest.Types, manifest.Typings, entry, manifest.Main, "index.d.ts", "index.js"} {
			if body, err := readNodeEntrySource(directory, candidate); err == nil {
				addNodeSymbols(symbols, body)
				return
			}
		}
	} else if body, err := readNodeEntrySource(directory, entry); err == nil {
		addNodeSymbols(symbols, body)
		return
	}
	page.Coverage = "unavailable"
}

func chooseNodeExport(value any) string {
	switch value := value.(type) {
	case string:
		return value
	case map[string]any:
		for _, condition := range []string{"types", "import", "require", "node", "default"} {
			if result := chooseNodeExport(value[condition]); result != "" {
				return result
			}
		}
	}
	return ""
}

func readNodeEntrySource(directory *dependencyAPIIndexDirectory, entry string) ([]byte, error) {
	entry = strings.TrimPrefix(entry, "./")
	if !validDependencyQueryName(entry) {
		return nil, ErrDependencyAPIIndexUnavailable
	}
	for _, candidate := range []string{entry, entry + ".d.ts", strings.TrimSuffix(entry, ".js") + ".d.ts", entry + "/index.d.ts"} {
		if data, err := readDependencySource(directory, candidate, 256<<10); err == nil {
			return data, nil
		}
	}
	return nil, ErrDependencyAPIIndexUnavailable
}

func addNodeSymbols(symbols map[string]string, data []byte) {
	addDeclarationMatches(symbols, data, nodeDeclarationPattern)
	for _, match := range nodeExportAssignmentPattern.FindAllSubmatch(data, dependencyQueryMaxSymbols) {
		symbols[string(match[1])] = "value"
	}
	for _, match := range nodeExportListPattern.FindAllSubmatch(data, dependencyQueryMaxSymbols) {
		for _, declaration := range strings.Split(string(match[1]), ",") {
			fields := strings.Fields(strings.TrimSpace(declaration))
			if len(fields) > 0 {
				name := fields[len(fields)-1]
				if validDependencyQuerySymbol("node", name) {
					symbols[name] = "alias"
				}
			}
		}
	}
}

func (s *Session) summarizeGo(state *dependencyQueryState, directory *dependencyAPIIndexDirectory, source dependencyModuleSource, module string, symbols map[string]string, children map[string]bool, page *DependencyAPIIndexPage) {
	if source.archive != "" {
		data, err := directory.ReadSmallRegular(source.archive, dependencyQueryMaxArchive)
		if err != nil {
			page.Coverage = "unavailable"
			return
		}
		reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			page.Coverage = "unavailable"
			return
		}
		for index, file := range reader.File {
			if index >= dependencyQueryMaxItems || s.dependencyQueryStopped() {
				page.Truncated = true
				break
			}
			// The module zip prefix is import-path@version/. A root query
			// reads only root source; descendants remain analyzer-backed.
			_, relative, ok := strings.Cut(file.Name, "@")
			_, relative, ok = strings.Cut(relative, "/")
			if !ok || strings.Contains(relative, "/") || !strings.HasSuffix(relative, ".go") || strings.HasSuffix(relative, "_test.go") || file.UncompressedSize64 > 256<<10 {
				continue
			}
			opened, err := file.Open()
			if err != nil {
				continue
			}
			body, err := io.ReadAll(io.LimitReader(opened, (256<<10)+1))
			_ = opened.Close()
			if err == nil && len(body) <= 256<<10 {
				addGoSymbols(symbols, body)
			}
		}
		return
	}
	scan := &dependencyQueryScan{session: s, state: state}
	for _, entry := range scan.readDirectory(directory) {
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") && entry.Name() != "testdata" && entry.Name() != "internal" {
			name := module + "/" + entry.Name()
			children[name] = true
			state.addModule(name, dependencyModuleSource{mount: source.mount, parts: appendPath(source.parts, entry.Name()), kind: "module"}, false)
		} else if strings.HasSuffix(entry.Name(), ".go") && !strings.HasSuffix(entry.Name(), "_test.go") {
			if data, err := directory.ReadSmallRegular(entry.Name(), 256<<10); err == nil {
				addGoSymbols(symbols, data)
			}
		}
	}
}

func addGoSymbols(symbols map[string]string, data []byte) {
	file, err := parser.ParseFile(token.NewFileSet(), "module.go", data, parser.SkipObjectResolution)
	if err != nil {
		return
	}
	for _, declaration := range file.Decls {
		switch declaration := declaration.(type) {
		case *ast.FuncDecl:
			if declaration.Recv == nil && ast.IsExported(declaration.Name.Name) {
				symbols[declaration.Name.Name] = "function"
			}
		case *ast.GenDecl:
			for _, spec := range declaration.Specs {
				switch spec := spec.(type) {
				case *ast.TypeSpec:
					if ast.IsExported(spec.Name.Name) {
						symbols[spec.Name.Name] = "class"
					}
				case *ast.ValueSpec:
					for _, name := range spec.Names {
						if ast.IsExported(name.Name) {
							symbols[name.Name] = "value"
						}
					}
				}
			}
		}
	}
}

func (s *Session) summarizeJava(directory *dependencyAPIIndexDirectory, source dependencyModuleSource, symbols map[string]string, page *DependencyAPIIndexPage) {
	data, err := directory.ReadSmallRegular(source.archive, dependencyQueryMaxArchive)
	if err != nil {
		page.Truncated = true
		return
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		page.Truncated = true
		return
	}
	for index, file := range reader.File {
		if index >= dependencyQueryMaxItems || s.dependencyQueryStopped() {
			page.Truncated = true
			break
		}
		if !strings.HasPrefix(file.Name, source.prefix) || !strings.HasSuffix(file.Name, ".class") {
			continue
		}
		name := strings.TrimSuffix(strings.TrimPrefix(file.Name, source.prefix), ".class")
		if validPythonIdentifier(name) && name != "module-info" && name != "package-info" {
			symbols[name] = "class"
		}
	}
}
