package lsp

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"path/filepath"
	"strings"

	"bobocloud-server/internal/safefile"
)

const VirtualRootURI = "bobocloud-lsp:///"

type URIMapper struct {
	root     string
	rootURI  string
	rootFold string
	rootReal string
	posix    bool
}

func NewURIMapper(root string) (*URIMapper, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	abs = filepath.Clean(abs)
	realRoot, err := safefile.CanonicalPath(abs)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace root: %w", err)
	}
	return &URIMapper{root: abs, rootURI: fileURI(abs), rootReal: realRoot}, nil
}

// NewContainerURIMapper creates a mapper for paths as seen inside a Linux
// analyzer container. It deliberately uses POSIX path semantics even when the
// BOBOCloud server itself is tested or run on another operating system.
func NewContainerURIMapper(root string) (*URIMapper, error) {
	if !path.IsAbs(root) {
		return nil, fmt.Errorf("container workspace root must be absolute")
	}
	clean := path.Clean(root)
	return &URIMapper{root: clean, rootURI: fileURIForPath(clean, true), rootFold: clean, posix: true}, nil
}

func (m *URIMapper) RootURI() string { return m.rootURI }

func fileURI(value string) string {
	return fileURIForPath(value, false)
}

func fileURIForPath(value string, posix bool) string {
	if posix {
		value = path.Clean(value)
	} else {
		value = filepath.ToSlash(filepath.Clean(value))
	}
	if !strings.HasPrefix(value, "/") {
		value = "/" + value
	}
	return (&url.URL{Scheme: "file", Path: value}).String()
}

func filePathFromURI(value string, posix bool) (string, error) {
	u, err := url.Parse(value)
	if err != nil || !strings.EqualFold(u.Scheme, "file") {
		return "", fmt.Errorf("not a file URI")
	}
	if u.Host != "" && u.Host != "localhost" {
		return "", fmt.Errorf("remote file URI is not allowed")
	}
	p, err := url.PathUnescape(u.EscapedPath())
	if err != nil {
		return "", err
	}
	if posix {
		return path.Clean(p), nil
	}
	if filepath.Separator == '\\' && len(p) >= 3 && p[0] == '/' && p[2] == ':' {
		p = p[1:]
	}
	return filepath.Clean(filepath.FromSlash(p)), nil
}

func (m *URIMapper) within(candidate string) bool {
	_, ok := m.relative(candidate)
	return ok
}

func (m *URIMapper) relative(candidate string) (string, bool) {
	if m.posix {
		clean := path.Clean(candidate)
		if clean == m.rootFold {
			return ".", true
		}
		if !strings.HasPrefix(clean, m.rootFold+"/") {
			return "", false
		}
		return strings.TrimPrefix(clean, m.rootFold+"/"), true
	}
	resolved, err := safefile.CanonicalPathAllowMissing(candidate)
	if err != nil {
		return "", false
	}
	canonicalRelative, err := filepath.Rel(m.rootReal, resolved)
	if err != nil || !relativePathWithinRoot(canonicalRelative) {
		return "", false
	}
	// Canonical paths prove containment, but protocol identity remains lexical:
	// an editor opened through workspace/alias/file.go must not receive
	// diagnostics for workspace/real/file.go. When Windows short/long aliases
	// make the lexical roots incomparable, fall back to the canonical relative.
	lexicalRelative, lexicalErr := filepath.Rel(m.root, filepath.Clean(candidate))
	if lexicalErr == nil && relativePathWithinRoot(lexicalRelative) {
		return lexicalRelative, true
	}
	return canonicalRelative, true
}

func relativePathWithinRoot(relative string) bool {
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func (m *URIMapper) virtualToFile(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || !strings.EqualFold(u.Scheme, "bobocloud-lsp") {
		return "", fmt.Errorf("invalid virtual workspace URI")
	}
	if u.Host != "" {
		return "", fmt.Errorf("virtual workspace URI must not contain a host")
	}
	rel, err := url.PathUnescape(u.EscapedPath())
	if err != nil {
		return "", err
	}
	rel = strings.TrimPrefix(rel, "/")
	for _, segment := range strings.Split(rel, "/") {
		if segment == ".." {
			return "", fmt.Errorf("virtual workspace URI escapes the workspace")
		}
	}
	clean := path.Clean("/" + rel)
	if clean == "/.." || strings.HasPrefix(clean, "/../") || strings.Contains(rel, "\\") {
		return "", fmt.Errorf("virtual workspace URI escapes the workspace")
	}
	var target string
	if m.posix {
		target = path.Join(m.root, strings.TrimPrefix(clean, "/"))
	} else {
		target = filepath.Join(m.root, filepath.FromSlash(strings.TrimPrefix(clean, "/")))
	}
	if !m.within(target) {
		return "", fmt.Errorf("virtual workspace URI escapes the workspace")
	}
	return fileURIForPath(target, m.posix), nil
}

func (m *URIMapper) fileToVirtual(value string) string {
	p, err := filePathFromURI(value, m.posix)
	rel, within := m.relative(p)
	if err != nil || !within {
		sum := sha256.Sum256([]byte(value))
		name := filepath.Base(p)
		if m.posix {
			name = path.Base(p)
		}
		if name == "." || name == string(filepath.Separator) || name == "/" || name == "" {
			name = "external"
		}
		return (&url.URL{Scheme: "bobocloud-lsp-external", Path: "/" + name, RawQuery: "id=" + hex.EncodeToString(sum[:8])}).String()
	}
	if rel == "." {
		return VirtualRootURI
	}
	if !m.posix {
		rel = filepath.ToSlash(rel)
	}
	return (&url.URL{Scheme: "bobocloud-lsp", Path: "/" + rel}).String()
}

func isURIField(key string) bool {
	lower := strings.ToLower(strings.TrimSpace(key))
	return lower == "uri" || lower == "href" || lower == "target" || strings.HasSuffix(lower, "uri")
}

func isURIKeyedMap(key string) bool {
	return strings.EqualFold(key, "changes") || strings.EqualFold(key, "relatedDocuments")
}

func isURIMapKey(value string) bool {
	u, err := url.Parse(value)
	scheme := ""
	if err == nil {
		scheme = strings.ToLower(u.Scheme)
	} else if colon := strings.IndexByte(value, ':'); colon > 0 {
		scheme = strings.ToLower(value[:colon])
	}
	return scheme == "file" || scheme == "bobocloud-lsp" || scheme == "bobocloud-lsp-external"
}

func transformJSON(value any, parentKey string, transform func(string) (string, error)) (any, error) {
	switch typed := value.(type) {
	case []any:
		for i := range typed {
			v, err := transformJSON(typed[i], parentKey, transform)
			if err != nil {
				return nil, err
			}
			typed[i] = v
		}
		return typed, nil
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			resultKey := key
			if isURIKeyedMap(parentKey) && isURIMapKey(key) {
				var err error
				resultKey, err = transform(key)
				if err != nil {
					return nil, err
				}
			}

			var (
				v   any
				err error
			)
			if text, ok := item.(string); ok && isURIField(key) {
				v, err = transform(text)
			} else {
				v, err = transformJSON(item, key, transform)
			}
			if err != nil {
				return nil, err
			}
			if _, exists := result[resultKey]; exists {
				return nil, fmt.Errorf("URI rewrite collision for %q", resultKey)
			}
			result[resultKey] = v
		}
		return result, nil
	default:
		return value, nil
	}
}

func rewriteRaw(raw []byte, transform func(string) (string, error)) ([]byte, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	rewritten, err := transformJSON(value, "", transform)
	if err != nil {
		return nil, err
	}
	return json.Marshal(rewritten)
}

// RewriteInbound maps opaque client workspace URIs to the authorized remote
// root. Client supplied file:// and external URIs are rejected.
func (m *URIMapper) RewriteInbound(raw []byte) ([]byte, error) {
	return rewriteRaw(raw, func(value string) (string, error) {
		u, err := url.Parse(value)
		if err != nil {
			return "", fmt.Errorf("invalid URI: %w", err)
		}
		switch strings.ToLower(u.Scheme) {
		case "bobocloud-lsp":
			return m.virtualToFile(value)
		case "file", "bobocloud-lsp-external":
			return "", fmt.Errorf("client absolute or external file URI is not allowed")
		default:
			return value, nil
		}
	})
}

// RewriteInitialize forces the root and workspace folder regardless of what
// the client sent, then applies normal virtual URI rewriting to document URIs.
func (m *URIMapper) RewriteInitialize(raw []byte) ([]byte, error) {
	rewritten, err := m.RewriteInbound(raw)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if err := json.Unmarshal(rewritten, &value); err != nil {
		return nil, err
	}
	params, _ := value["params"].(map[string]any)
	if params == nil {
		params = make(map[string]any)
		value["params"] = params
	}
	params["rootUri"] = m.rootURI
	params["rootPath"] = m.root
	params["workspaceFolders"] = []any{map[string]any{"uri": m.rootURI, "name": filepath.Base(m.root)}}
	return json.Marshal(value)
}

func (m *URIMapper) RewriteOutbound(raw []byte) ([]byte, error) {
	return rewriteRaw(raw, func(value string) (string, error) {
		u, err := url.Parse(value)
		if err != nil {
			return "", fmt.Errorf("invalid URI: %w", err)
		}
		if strings.EqualFold(u.Scheme, "file") {
			return m.fileToVirtual(value), nil
		}
		return value, nil
	})
}
