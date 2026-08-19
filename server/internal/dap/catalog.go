package dap

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const CatalogVersion = "1.0"

const (
	UnavailableImageNotInstalled = "image_not_installed"
	UnavailableInspectionTimeout = "image_inspection_timeout"
	UnavailableDocker            = "docker_unavailable"
	UnavailableImageInspection   = "image_inspection_failed"
)

type AdapterSpec struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	LanguageID     string   `json:"languageId"`
	RuntimeID      string   `json:"runtimeId"`
	Image          string   `json:"image"`
	Command        []string `json:"command"`
	AdapterVersion string   `json:"adapterVersion"`
	SupportsLaunch bool     `json:"supportsLaunch"`
	SupportsAttach bool     `json:"supportsAttach"`
	RequiresPtrace bool     `json:"requiresPtrace,omitempty"`
	// Transport is "stdio" (the default), "tcp", or "unix". The Unix
	// variant is reserved for adapters such as js-debug which create child DAP
	// sessions without publishing an adapter TCP port on the host.
	Transport             string         `json:"transport,omitempty"`
	ContainerPort         int            `json:"containerPort,omitempty"`
	SupportsChildSessions bool           `json:"supportsChildSessions,omitempty"`
	LaunchDefaults        map[string]any `json:"launchDefaults,omitempty"`
	DependencyMode        string         `json:"dependencyMode,omitempty"`
	Constraints           []string       `json:"constraints,omitempty"`
}

type Manifest struct {
	Version  string        `json:"version"`
	Adapters []AdapterSpec `json:"adapters"`
}

type Capability struct {
	ID                    string         `json:"id"`
	Label                 string         `json:"label"`
	LanguageID            string         `json:"languageId"`
	RuntimeID             string         `json:"runtimeId"`
	AdapterVersion        string         `json:"adapterVersion"`
	Image                 string         `json:"image"`
	Available             bool           `json:"available"`
	Unavailable           string         `json:"unavailableReason,omitempty"`
	SupportsLaunch        bool           `json:"supportsLaunch"`
	SupportsAttach        bool           `json:"supportsAttach"`
	RequiresPtrace        bool           `json:"requiresPtrace,omitempty"`
	Transport             string         `json:"transport,omitempty"`
	SupportsChildSessions bool           `json:"supportsChildSessions,omitempty"`
	LaunchDefaults        map[string]any `json:"launchDefaults,omitempty"`
	DependencyMode        string         `json:"dependencyMode,omitempty"`
	Constraints           []string       `json:"constraints,omitempty"`
}

type Catalog struct {
	version     string
	fingerprint string
	byKey       map[string]AdapterSpec
}

type catalogFingerprintEntry struct {
	ID                    string         `json:"id"`
	Label                 string         `json:"label"`
	LanguageID            string         `json:"languageId"`
	RuntimeID             string         `json:"runtimeId"`
	AdapterVersion        string         `json:"adapterVersion"`
	SupportsLaunch        bool           `json:"supportsLaunch"`
	SupportsAttach        bool           `json:"supportsAttach"`
	RequiresPtrace        bool           `json:"requiresPtrace,omitempty"`
	Transport             string         `json:"transport"`
	SupportsChildSessions bool           `json:"supportsChildSessions,omitempty"`
	LaunchDefaults        map[string]any `json:"launchDefaults,omitempty"`
	DependencyMode        string         `json:"dependencyMode,omitempty"`
	Constraints           []string       `json:"constraints,omitempty"`
}

func normalizeLanguage(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "javascript", "typescript", "javascriptreact", "typescriptreact", "nodejs", "node":
		return "node"
	case "py", "python":
		return "python"
	case "golang", "go":
		return "go"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func catalogKey(languageID, runtimeID string) string {
	return normalizeLanguage(languageID) + "\x00" + strings.TrimSpace(runtimeID)
}

func LoadCatalog(path string) (*Catalog, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("parse DAP manifest: %w", err)
	}
	if manifest.Version != CatalogVersion {
		return nil, fmt.Errorf("unsupported DAP manifest version %q", manifest.Version)
	}
	catalog := &Catalog{version: manifest.Version, byKey: make(map[string]AdapterSpec)}
	fingerprintEntries := make([]catalogFingerprintEntry, 0, len(manifest.Adapters))
	for index, spec := range manifest.Adapters {
		spec.ID = strings.TrimSpace(spec.ID)
		spec.Label = strings.TrimSpace(spec.Label)
		spec.LanguageID = normalizeLanguage(spec.LanguageID)
		spec.RuntimeID = strings.TrimSpace(spec.RuntimeID)
		spec.Image = strings.TrimSpace(spec.Image)
		spec.Transport = strings.ToLower(strings.TrimSpace(spec.Transport))
		if spec.Transport == "" {
			spec.Transport = "stdio"
		}
		if spec.ID == "" || spec.LanguageID == "" || spec.RuntimeID == "" || spec.Image == "" || len(spec.Command) == 0 {
			return nil, fmt.Errorf("DAP adapter %d is missing id, languageId, runtimeId, image, or command", index)
		}
		if spec.Transport != "stdio" && spec.Transport != "tcp" && spec.Transport != "unix" {
			return nil, fmt.Errorf("DAP adapter %q has unsupported transport %q", spec.ID, spec.Transport)
		}
		if (spec.Transport == "tcp" || spec.Transport == "unix") && (spec.ContainerPort < 1 || spec.ContainerPort > 65535) {
			return nil, fmt.Errorf("DAP adapter %q requires a valid containerPort for connection transport", spec.ID)
		}
		if spec.SupportsChildSessions && spec.Transport != "tcp" && spec.Transport != "unix" {
			return nil, fmt.Errorf("DAP adapter %q supports child sessions but does not use a connection transport", spec.ID)
		}
		for _, arg := range spec.Command {
			if strings.TrimSpace(arg) == "" {
				return nil, fmt.Errorf("DAP adapter %q has an empty command argument", spec.ID)
			}
		}
		key := catalogKey(spec.LanguageID, spec.RuntimeID)
		if _, exists := catalog.byKey[key]; exists {
			return nil, fmt.Errorf("duplicate DAP adapter for %s and %s", spec.LanguageID, spec.RuntimeID)
		}
		catalog.byKey[key] = spec
		constraints := append([]string(nil), spec.Constraints...)
		sort.Strings(constraints)
		fingerprintEntries = append(fingerprintEntries, catalogFingerprintEntry{
			ID: spec.ID, Label: spec.Label, LanguageID: spec.LanguageID, RuntimeID: spec.RuntimeID,
			AdapterVersion: spec.AdapterVersion, SupportsLaunch: spec.SupportsLaunch,
			SupportsAttach: spec.SupportsAttach, RequiresPtrace: spec.RequiresPtrace,
			Transport: spec.Transport, SupportsChildSessions: spec.SupportsChildSessions,
			LaunchDefaults: cloneMap(spec.LaunchDefaults), DependencyMode: spec.DependencyMode,
			Constraints: constraints,
		})
	}
	catalog.fingerprint = fingerprintCatalog(fingerprintEntries)
	return catalog, nil
}

func fingerprintCatalog(entries []catalogFingerprintEntry) string {
	encoded := make([]string, 0, len(entries))
	for _, entry := range entries {
		data, err := json.Marshal(entry)
		if err != nil {
			return ""
		}
		encoded = append(encoded, string(data))
	}
	sort.Strings(encoded)
	hash := sha256.New()
	_, _ = hash.Write([]byte("bobocloud:dap-catalog:v1\x00"))
	for _, entry := range encoded {
		_, _ = hash.Write([]byte(entry))
		_, _ = hash.Write([]byte{0})
	}
	return fmt.Sprintf("%x", hash.Sum(nil))
}

func ResolveManifestPath(execDir, configured string) string {
	configured = strings.TrimSpace(configured)
	if configured == "" {
		configured = "dap_adapters.json"
	}
	if filepath.IsAbs(configured) {
		return configured
	}
	return filepath.Join(execDir, configured)
}

func (c *Catalog) Version() string {
	if c == nil || c.version == "" {
		return CatalogVersion
	}
	return c.version
}

// Fingerprint identifies the client-observable static catalog projection. It
// excludes adapter commands, images, ports, and dynamic Docker availability.
func (c *Catalog) Fingerprint() string {
	if c == nil {
		return ""
	}
	return c.fingerprint
}

func (c *Catalog) Lookup(languageID, runtimeID string) (AdapterSpec, bool) {
	if c == nil {
		return AdapterSpec{}, false
	}
	spec, ok := c.byKey[catalogKey(languageID, runtimeID)]
	return spec, ok
}

type ImageInspector interface {
	Available(context.Context, string) (bool, string)
}

type DockerImageInspector struct {
	TTL   time.Duration
	mu    sync.Mutex
	cache map[string]imageInspection
}

type imageInspection struct {
	available bool
	reason    string
	expires   time.Time
}

func (i *DockerImageInspector) Available(ctx context.Context, image string) (bool, string) {
	if i == nil {
		return false, "Docker image inspection is unavailable"
	}
	if i.TTL <= 0 {
		i.TTL = 30 * time.Second
	}
	now := time.Now()
	i.mu.Lock()
	if cached, ok := i.cache[image]; ok && now.Before(cached.expires) {
		i.mu.Unlock()
		return cached.available, cached.reason
	}
	i.mu.Unlock()
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(checkCtx, "docker", "image", "inspect", image).CombinedOutput()
	available, reason := err == nil, ""
	if err != nil {
		switch {
		case checkCtx.Err() != nil:
			reason = UnavailableInspectionTimeout
		case errors.Is(err, exec.ErrNotFound):
			reason = UnavailableDocker
		case strings.Contains(strings.ToLower(string(output)), "no such image"):
			reason = UnavailableImageNotInstalled
		default:
			reason = UnavailableImageInspection
		}
	}
	i.mu.Lock()
	if i.cache == nil {
		i.cache = make(map[string]imageInspection)
	}
	i.cache[image] = imageInspection{available: available, reason: reason, expires: now.Add(i.TTL)}
	i.mu.Unlock()
	return available, reason
}

func (c *Catalog) Capabilities(ctx context.Context, inspector ImageInspector) []Capability {
	if c == nil {
		return []Capability{}
	}
	keys := make([]string, 0, len(c.byKey))
	for key := range c.byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	capabilities := make([]Capability, 0, len(keys))
	for _, key := range keys {
		spec := c.byKey[key]
		available, reason := false, UnavailableImageNotInstalled
		if inspector != nil {
			available, reason = inspector.Available(ctx, spec.Image)
		}
		capabilities = append(capabilities, Capability{
			ID: spec.ID, Label: spec.Label, LanguageID: spec.LanguageID, RuntimeID: spec.RuntimeID,
			AdapterVersion: spec.AdapterVersion, Image: spec.Image, Available: available, Unavailable: reason,
			SupportsLaunch: spec.SupportsLaunch, SupportsAttach: spec.SupportsAttach,
			RequiresPtrace: spec.RequiresPtrace, LaunchDefaults: cloneMap(spec.LaunchDefaults),
			Transport: spec.Transport, SupportsChildSessions: spec.SupportsChildSessions,
			DependencyMode: spec.DependencyMode, Constraints: append([]string(nil), spec.Constraints...),
		})
	}
	return capabilities
}

func cloneMap(source map[string]any) map[string]any {
	if source == nil {
		return nil
	}
	copy := make(map[string]any, len(source))
	for key, value := range source {
		copy[key] = value
	}
	return copy
}
