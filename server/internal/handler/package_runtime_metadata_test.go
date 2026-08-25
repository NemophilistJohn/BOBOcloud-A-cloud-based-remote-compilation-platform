package handler

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDockerImageRuntimeMetadataUsesExactPythonVersionAndImmutableImageID(t *testing.T) {
	metadata, ok := parseDockerImageRuntimeMetadata([]byte(`[{"Id":"sha256:image-a","Config":{"Env":["PATH=/usr/bin","PYTHON_VERSION=3.10.21"]}}]`), "python:3.10", "3.10")
	if !ok || metadata.ImageID != "sha256:image-a" || metadata.Version != "3.10.21" || metadata.VersionSource != "docker-image-env" || metadata.VersionTrust != "exact" {
		t.Fatalf("runtime metadata = %+v ok=%v", metadata, ok)
	}
	mismatch, ok := parseDockerImageRuntimeMetadata([]byte(`[{"Id":"sha256:image-b","Config":{"Env":["PYTHON_VERSION=3.11.16"]}}]`), "python:3.10", "3.10")
	if !ok || mismatch.ImageID != "sha256:image-b" || mismatch.Version != "3.10" || mismatch.VersionTrust != "series" {
		t.Fatalf("mismatched image version did not fail closed: %+v ok=%v", mismatch, ok)
	}
}

func TestDockerImageRuntimeMetadataUsesExactNodeVersion(t *testing.T) {
	metadata, ok := parseDockerImageRuntimeMetadata([]byte(`[{"Id":"sha256:node-20","Config":{"Env":["PATH=/usr/local/bin","NODE_VERSION=20.20.2"]}}]`), "node:20", "20")
	if !ok || metadata.ImageID != "sha256:node-20" || metadata.Version != "20.20.2" || metadata.VersionSource != "docker-image-env" || metadata.VersionTrust != "exact" {
		t.Fatalf("Node runtime metadata = %+v ok=%v", metadata, ok)
	}
	mismatch, ok := parseDockerImageRuntimeMetadata([]byte(`[{"Id":"sha256:node-22","Config":{"Env":["NODE_VERSION=22.23.2"]}}]`), "node:20", "20")
	if !ok || mismatch.ImageID != "sha256:node-22" || mismatch.Version != "20" || mismatch.VersionTrust != "series" {
		t.Fatalf("mismatched Node image version did not fail closed: %+v ok=%v", mismatch, ok)
	}
}

func TestRuntimeMetadataCacheRefreshChangesDependencyFingerprintForMutableTag(t *testing.T) {
	provider := NewDockerImageRuntimeMetadataProvider(time.Minute, time.Second)
	current := time.Unix(100, 0)
	provider.now = func() time.Time { return current }
	var mu sync.Mutex
	calls := 0
	provider.inspect = func(context.Context, string) ([]byte, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		return []byte(fmt.Sprintf(`[{"Id":"sha256:image-%d","Config":{"Env":["PYTHON_VERSION=3.10.%d"]}}]`, calls, 20+calls)), nil
	}
	first := resolvedRuntimeFingerprint(t.Context(), provider, "python:3.10", "python:3.10-slim", "3.10")
	second := resolvedRuntimeFingerprint(t.Context(), provider, "python:3.10", "python:3.10-slim", "3.10")
	if first != second || calls != 1 {
		t.Fatalf("metadata cache miss: first=%q second=%q calls=%d", first, second, calls)
	}
	current = current.Add(2 * time.Minute)
	third := resolvedRuntimeFingerprint(t.Context(), provider, "python:3.10", "python:3.10-slim", "3.10")
	if third == first || calls != 2 {
		t.Fatalf("mutable tag did not rotate fingerprint: first=%q third=%q calls=%d", first, third, calls)
	}
}

func TestRuntimeMetadataFreshResolveBypassesSuccessfulCache(t *testing.T) {
	provider := NewDockerImageRuntimeMetadataProvider(time.Minute, time.Second)
	calls := 0
	provider.inspect = func(context.Context, string) ([]byte, error) {
		calls++
		return []byte(fmt.Sprintf(`[{"Id":"sha256:image-%d","Config":{"Env":["PYTHON_VERSION=3.10.21"]}}]`, calls)), nil
	}
	first := provider.Resolve(t.Context(), "python:3.10", "python:3.10-slim", "3.10")
	second := provider.ResolveFresh(t.Context(), "python:3.10", "python:3.10-slim", "3.10")
	third := provider.Resolve(t.Context(), "python:3.10", "python:3.10-slim", "3.10")
	if calls != 2 || first.ImageID != "sha256:image-1" || second.ImageID != "sha256:image-2" || third.ImageID != second.ImageID {
		t.Fatalf("fresh metadata results calls=%d first=%+v second=%+v third=%+v", calls, first, second, third)
	}
}

func TestRuntimeMetadataProviderCoalescesConcurrentImageInspection(t *testing.T) {
	provider := NewDockerImageRuntimeMetadataProvider(time.Minute, time.Second)
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	provider.inspect = func(context.Context, string) ([]byte, error) {
		calls.Add(1)
		close(started)
		<-release
		return []byte(`[{"Id":"sha256:shared","Config":{"Env":["PYTHON_VERSION=3.10.21"]}}]`), nil
	}
	results := make(chan RuntimeMetadata, 2)
	go func() { results <- provider.Resolve(t.Context(), "python:3.10", "python:3.10-slim", "3.10") }()
	<-started
	go func() { results <- provider.Resolve(t.Context(), "python:3.10", "python:3.10-slim", "3.10") }()
	close(release)
	first, second := <-results, <-results
	if calls.Load() != 1 || first.ImageID != "sha256:shared" || second.ImageID != first.ImageID {
		t.Fatalf("singleflight results calls=%d first=%+v second=%+v", calls.Load(), first, second)
	}
}
