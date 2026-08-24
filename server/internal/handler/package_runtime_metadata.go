package handler

import (
	"context"
	"encoding/json"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/model"
)

const runtimeMetadataFailureTTL = 5 * time.Second

var exactPythonRuntimeVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

type RuntimeMetadata struct {
	ImageID       string
	Version       string
	VersionSource string
	VersionTrust  string
}

type RuntimeMetadataProvider interface {
	Resolve(context.Context, string, string, string) RuntimeMetadata
}

type RuntimeMetadataProviderFunc func(context.Context, string, string, string) RuntimeMetadata

func (function RuntimeMetadataProviderFunc) Resolve(ctx context.Context, runtimeID, image, configuredVersion string) RuntimeMetadata {
	return function(ctx, runtimeID, image, configuredVersion)
}

type runtimeMetadataCacheEntry struct {
	metadata  RuntimeMetadata
	expiresAt time.Time
}

type runtimeMetadataCall struct {
	done     chan struct{}
	metadata RuntimeMetadata
}

type DockerImageRuntimeMetadataProvider struct {
	mu       sync.Mutex
	ttl      time.Duration
	timeout  time.Duration
	cache    map[string]runtimeMetadataCacheEntry
	inFlight map[string]*runtimeMetadataCall
	now      func() time.Time
	inspect  func(context.Context, string) ([]byte, error)
}

func NewDockerImageRuntimeMetadataProvider(ttl, timeout time.Duration) *DockerImageRuntimeMetadataProvider {
	if ttl <= 0 {
		ttl = time.Hour
	}
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	return &DockerImageRuntimeMetadataProvider{
		ttl: ttl, timeout: timeout, cache: make(map[string]runtimeMetadataCacheEntry),
		inFlight: make(map[string]*runtimeMetadataCall), now: time.Now,
		inspect: func(ctx context.Context, image string) ([]byte, error) {
			return exec.CommandContext(ctx, "docker", "image", "inspect", image).Output()
		},
	}
}

func (provider *DockerImageRuntimeMetadataProvider) Resolve(ctx context.Context, runtimeID, image, configuredVersion string) RuntimeMetadata {
	return provider.resolve(ctx, runtimeID, image, configuredVersion, false)
}

// ResolveFresh bypasses the successful metadata cache. Package operations use
// it immediately before execution so a mutable image tag cannot change between
// version selection and installation without invalidating the plan.
func (provider *DockerImageRuntimeMetadataProvider) ResolveFresh(ctx context.Context, runtimeID, image, configuredVersion string) RuntimeMetadata {
	return provider.resolve(ctx, runtimeID, image, configuredVersion, true)
}

func (provider *DockerImageRuntimeMetadataProvider) resolve(ctx context.Context, runtimeID, image, configuredVersion string, fresh bool) RuntimeMetadata {
	fallback := fallbackRuntimeMetadata(configuredVersion)
	if provider == nil || strings.TrimSpace(runtimeID) == "" || strings.TrimSpace(image) == "" {
		return fallback
	}
	key := strings.TrimSpace(runtimeID) + "\x00" + strings.TrimSpace(image)
	now := provider.now()
	provider.mu.Lock()
	if cached, ok := provider.cache[key]; !fresh && ok && now.Before(cached.expiresAt) {
		provider.mu.Unlock()
		return cached.metadata
	}
	if call := provider.inFlight[key]; call != nil {
		provider.mu.Unlock()
		select {
		case <-call.done:
			return call.metadata
		case <-ctx.Done():
			return fallback
		}
	}
	call := &runtimeMetadataCall{done: make(chan struct{})}
	provider.inFlight[key] = call
	provider.mu.Unlock()

	probeContext, cancel := context.WithTimeout(ctx, provider.timeout)
	data, err := provider.inspect(probeContext, strings.TrimSpace(image))
	cancel()
	metadata := fallback
	cacheTTL := runtimeMetadataFailureTTL
	if err == nil {
		if inspected, ok := parseDockerImageRuntimeMetadata(data, runtimeID, configuredVersion); ok {
			metadata = inspected
			cacheTTL = provider.ttl
		}
	}

	provider.mu.Lock()
	call.metadata = metadata
	provider.cache[key] = runtimeMetadataCacheEntry{metadata: metadata, expiresAt: provider.now().Add(cacheTTL)}
	delete(provider.inFlight, key)
	close(call.done)
	provider.mu.Unlock()
	return metadata
}

func fallbackRuntimeMetadata(configuredVersion string) RuntimeMetadata {
	return RuntimeMetadata{Version: strings.TrimSpace(configuredVersion), VersionSource: "runtime-config", VersionTrust: "series"}
}

func parseDockerImageRuntimeMetadata(data []byte, runtimeID, configuredVersion string) (RuntimeMetadata, bool) {
	var images []struct {
		ID     string `json:"Id"`
		Config struct {
			Env []string `json:"Env"`
		} `json:"Config"`
	}
	if err := json.Unmarshal(data, &images); err != nil || len(images) != 1 || strings.TrimSpace(images[0].ID) == "" {
		return RuntimeMetadata{}, false
	}
	metadata := fallbackRuntimeMetadata(configuredVersion)
	metadata.ImageID = strings.TrimSpace(images[0].ID)
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(runtimeID)), "python:") {
		for _, entry := range images[0].Config.Env {
			if !strings.HasPrefix(entry, "PYTHON_VERSION=") {
				continue
			}
			version := strings.TrimSpace(strings.TrimPrefix(entry, "PYTHON_VERSION="))
			series := strings.TrimSpace(configuredVersion)
			if exactPythonRuntimeVersionPattern.MatchString(version) && (series == "" || version == series || strings.HasPrefix(version, series+".")) {
				metadata.Version = version
				metadata.VersionSource = "docker-image-env"
				metadata.VersionTrust = "exact"
			}
			break
		}
	}
	return metadata, true
}

func resolvedRuntimeFingerprint(ctx context.Context, provider RuntimeMetadataProvider, runtimeID, image, configuredVersion string) string {
	metadata := fallbackRuntimeMetadata(configuredVersion)
	if provider != nil {
		metadata = provider.Resolve(ctx, runtimeID, image, configuredVersion)
	}
	return personalCacheRuntimeFingerprint(runtimeID, image, metadata.ImageID)
}

type freshRuntimeMetadataProvider interface {
	ResolveFresh(context.Context, string, string, string) RuntimeMetadata
}

func resolvedRuntimeFingerprintFresh(ctx context.Context, provider RuntimeMetadataProvider, runtimeID, image, configuredVersion string) string {
	metadata := fallbackRuntimeMetadata(configuredVersion)
	if freshProvider, ok := provider.(freshRuntimeMetadataProvider); ok {
		metadata = freshProvider.ResolveFresh(ctx, runtimeID, image, configuredVersion)
	} else if provider != nil {
		metadata = provider.Resolve(ctx, runtimeID, image, configuredVersion)
	}
	return personalCacheRuntimeFingerprint(runtimeID, image, metadata.ImageID)
}

func resolveProjectRuntimeMetadata(ctx context.Context, provider RuntimeMetadataProvider, runtimeID, image, configuredVersion string) RuntimeMetadata {
	if provider == nil {
		return fallbackRuntimeMetadata(configuredVersion)
	}
	return provider.Resolve(ctx, runtimeID, image, configuredVersion)
}

func configuredRuntimeVersion(runtimeID string) string {
	if runtime := model.GetRuntimeDef(strings.TrimSpace(runtimeID)); runtime != nil {
		return runtime.Version
	}
	return ""
}
