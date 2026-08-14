package dap

import (
	"context"
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
	ID             string         `json:"id"`
	Label          string         `json:"label"`
	LanguageID     string         `json:"languageId"`
	RuntimeID      string         `json:"runtimeId"`
	Image          string         `json:"image"`
	Command        []string       `json:"command"`
	AdapterVersion string         `json:"adapterVersion"`
	SupportsLaunch bool           `json:"supportsLaunch"`
	SupportsAttach bool           `json:"supportsAttach"`
	RequiresPtrace bool           `json:"requiresPtrace,omitempty"`
	LaunchDefaults map[string]any `json:"launchDefaults,omitempty"`
	DependencyMode string         `json:"dependencyMode,omitempty"`
	Constraints    []string       `json:"constraints,omitempty"`
}

type Manifest struct {
	Version  string        `json:"version"`
	Adapters []AdapterSpec `json:"adapters"`
}

type Capability struct {
	ID             string         `json:"id"`
	Label          string         `json:"label"`
	LanguageID     string         `json:"languageId"`
	RuntimeID      string         `json:"runtimeId"`
	AdapterVersion string         `json:"adapterVersion"`
	Image          string         `json:"image"`
	Available      bool           `json:"available"`
	Unavailable    string         `json:"unavailableReason,omitempty"`
	SupportsLaunch bool           `json:"supportsLaunch"`
	SupportsAttach bool           `json:"supportsAttach"`
	RequiresPtrace bool           `json:"requiresPtrace,omitempty"`
	LaunchDefaults map[string]any `json:"launchDefaults,omitempty"`
	DependencyMode string         `json:"dependencyMode,omitempty"`
	Constraints    []string       `json:"constraints,omitempty"`
}

type Catalog struct {
	version string
	byKey   map[string]AdapterSpec
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
	for index, spec := range manifest.Adapters {
		spec.ID = strings.TrimSpace(spec.ID)
		spec.Label = strings.TrimSpace(spec.Label)
		spec.LanguageID = normalizeLanguage(spec.LanguageID)
		spec.RuntimeID = strings.TrimSpace(spec.RuntimeID)
		spec.Image = strings.TrimSpace(spec.Image)
		if spec.ID == "" || spec.LanguageID == "" || spec.RuntimeID == "" || spec.Image == "" || len(spec.Command) == 0 {
			return nil, fmt.Errorf("DAP adapter %d is missing id, languageId, runtimeId, image, or command", index)
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
	}
	return catalog, nil
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
