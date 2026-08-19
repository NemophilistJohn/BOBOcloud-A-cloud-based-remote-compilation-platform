package lsp

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ServerSpec is an administrator-owned execution manifest. No command or
// image is accepted over the client protocol.
type ServerSpec struct {
	LanguageID      string            `json:"languageId"`
	Aliases         []string          `json:"aliases,omitempty"`
	Command         []string          `json:"command"`
	StandardCommand []string          `json:"standardCommand,omitempty"`
	FullCommand     []string          `json:"fullCommand,omitempty"`
	Docker          DockerSpec        `json:"docker,omitempty"`
	Environment     map[string]string `json:"environment,omitempty"`
	Fingerprint     string            `json:"fingerprint,omitempty"`
}

type DockerSpec struct {
	Image           string   `json:"image,omitempty"`
	Command         []string `json:"command,omitempty"`
	StandardCommand []string `json:"standardCommand,omitempty"`
	FullCommand     []string `json:"fullCommand,omitempty"`
}

type Manifest struct {
	Version int          `json:"version"`
	Servers []ServerSpec `json:"servers"`
}

type Catalog struct {
	version    int
	byLanguage map[string]ServerSpec
}

func normalizeLanguage(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "javascript", "typescript", "javascriptreact", "typescriptreact", "js", "ts":
		return "node"
	case "c++":
		return "cpp"
	case "py":
		return "python"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func NewCatalog(manifest Manifest) (*Catalog, error) {
	if manifest.Version != 1 {
		return nil, fmt.Errorf("unsupported LSP manifest version %d", manifest.Version)
	}
	catalog := &Catalog{version: manifest.Version, byLanguage: make(map[string]ServerSpec)}
	for _, spec := range manifest.Servers {
		spec.LanguageID = normalizeLanguage(spec.LanguageID)
		if spec.LanguageID == "" || len(spec.Command) == 0 || strings.TrimSpace(spec.Command[0]) == "" {
			return nil, fmt.Errorf("each LSP server requires languageId and command")
		}
		if len(spec.Docker.Command) == 0 {
			spec.Docker.Command = append([]string(nil), spec.Command...)
		}
		if len(spec.StandardCommand) == 0 {
			spec.StandardCommand = append([]string(nil), spec.Command...)
		}
		if len(spec.FullCommand) == 0 {
			spec.FullCommand = append([]string(nil), spec.Command...)
		}
		if len(spec.Docker.StandardCommand) == 0 {
			spec.Docker.StandardCommand = append([]string(nil), spec.Docker.Command...)
		}
		if len(spec.Docker.FullCommand) == 0 {
			spec.Docker.FullCommand = append([]string(nil), spec.Docker.Command...)
		}
		keys := append([]string{spec.LanguageID}, spec.Aliases...)
		for _, key := range keys {
			key = normalizeLanguage(key)
			if existing, exists := catalog.byLanguage[key]; exists {
				if existing.LanguageID == spec.LanguageID {
					continue
				}
				return nil, fmt.Errorf("duplicate LSP language %q", key)
			}
			catalog.byLanguage[key] = spec
		}
	}
	return catalog, nil
}

func LoadCatalog(path string) (*Catalog, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read LSP manifest %s: %w", path, err)
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("parse LSP manifest %s: %w", path, err)
	}
	return NewCatalog(manifest)
}

func DefaultCatalog() *Catalog {
	catalog, _ := NewCatalog(Manifest{Version: 1, Servers: []ServerSpec{
		{LanguageID: "rust", Command: []string{"rust-analyzer"}, Fingerprint: "rust-analyzer-v1"},
		{LanguageID: "go", Command: []string{"gopls"}, Fingerprint: "gopls-v1"},
		{LanguageID: "c", Aliases: []string{"cpp"}, Command: []string{"clangd", "--clang-tidy=false"}, StandardCommand: []string{"clangd", "--clang-tidy=false"}, FullCommand: []string{"clangd", "--background-index", "--clang-tidy=false"}, Fingerprint: "clangd-v2-dependency-flags"},
		{LanguageID: "java", Command: []string{"jdtls", "-data", "{{cacheDir}}/jdtls"}, Environment: map[string]string{"JAVA_TOOL_OPTIONS": "-Xms64m -Xmx384m"}, Fingerprint: "jdtls-v2-dependency-repository"},
		{LanguageID: "python", Command: []string{"pyright-langserver", "--stdio"}, Fingerprint: "pyright-v1"},
		{LanguageID: "node", Aliases: []string{"javascript", "typescript"}, Command: []string{"typescript-language-server", "--stdio"}, Fingerprint: "typescript-language-server-v1"},
		{LanguageID: "html", Command: []string{"vscode-html-language-server", "--stdio"}, Fingerprint: "vscode-html-language-server-v1"},
		{LanguageID: "css", Aliases: []string{"scss", "less"}, Command: []string{"vscode-css-language-server", "--stdio"}, Fingerprint: "vscode-css-language-server-v1"},
		{LanguageID: "json", Aliases: []string{"jsonc"}, Command: []string{"vscode-json-language-server", "--stdio"}, Fingerprint: "vscode-json-language-server-v1"},
		{LanguageID: "yaml", Command: []string{"yaml-language-server", "--stdio"}, Fingerprint: "yaml-language-server-v1"},
		{LanguageID: "shell", Aliases: []string{"shellscript", "bash", "sh"}, Command: []string{"bash-language-server", "start"}, Fingerprint: "bash-language-server-v1"},
	}})
	return catalog
}

func (c *Catalog) Lookup(languageID string) (ServerSpec, bool) {
	if c == nil {
		return ServerSpec{}, false
	}
	spec, ok := c.byLanguage[normalizeLanguage(languageID)]
	return spec, ok
}

func (c *Catalog) Languages() []string {
	seen := make(map[string]bool)
	out := make([]string, 0)
	for _, spec := range c.byLanguage {
		values := append([]string{spec.LanguageID}, spec.Aliases...)
		for _, value := range values {
			value = strings.ToLower(strings.TrimSpace(value))
			if value != "" && !seen[value] {
				seen[value] = true
				out = append(out, value)
			}
		}
	}
	sort.Strings(out)
	return out
}

// Version returns the validated manifest revision used by this catalog.
func (c *Catalog) Version() int {
	if c == nil {
		return 0
	}
	return c.version
}

func ResolveManifestPath(execDir, configured string) string {
	if configured == "" {
		configured = "lsp_servers.json"
	}
	if filepath.IsAbs(configured) {
		return filepath.Clean(configured)
	}
	return filepath.Join(execDir, configured)
}
