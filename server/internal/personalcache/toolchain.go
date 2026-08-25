package personalcache

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/cachev2"
)

const toolchainMetadataFile = ".toolchain-meta.json"

type ToolchainRequest struct {
	UserID             string
	RuntimeID          string
	RuntimeFingerprint string
	Language           string
	Tool               string
	SourcePolicyDigest string
	QuotaBytes         int64
}

type toolchainMetadata struct {
	Schema             int       `json:"schema"`
	UserID             string    `json:"user_id"`
	RuntimeID          string    `json:"runtime_id"`
	RuntimeFingerprint string    `json:"runtime_fingerprint"`
	Language           string    `json:"language"`
	Tool               string    `json:"tool"`
	SourcePolicyDigest string    `json:"source_policy_digest"`
	CreatedAt          time.Time `json:"created_at"`
	LastUsed           time.Time `json:"last_used"`
}

type ToolchainLease struct {
	ID           cachev2.CacheID
	Key          string
	ContainerKey string
	Generation   string
	HostRoot     string
	RelativePath string
	DockerMounts map[string]string
	DockerEnv    map[string]string
	manager      *Manager
	request      ToolchainRequest
	meta         toolchainMetadata
	lock         *cacheLock
	guard        *Guard
	released     sync.Once
}

type toolchainLeasesContextKey struct{}

// ContextWithToolchainLeases attaches toolchain cache leases to one trusted
// server-side operation context. Existing leases are retained in insertion
// order so setup executors may select the matching tool and source policy.
func ContextWithToolchainLeases(ctx context.Context, leases ...*ToolchainLease) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	combined := ToolchainLeasesFromContext(ctx)
	for _, lease := range leases {
		if lease != nil {
			combined = append(combined, lease)
		}
	}
	return context.WithValue(ctx, toolchainLeasesContextKey{}, combined)
}

// ToolchainLeasesFromContext returns a defensive slice copy. Lease objects are
// intentionally shared because their Release method is idempotent.
func ToolchainLeasesFromContext(ctx context.Context) []*ToolchainLease {
	if ctx == nil {
		return nil
	}
	leases, _ := ctx.Value(toolchainLeasesContextKey{}).([]*ToolchainLease)
	return append([]*ToolchainLease(nil), leases...)
}

// PrepareToolchainCache grants one exclusive lease over a source-policy and
// immutable-runtime scoped package-manager/compiler download cache.
func (m *Manager) PrepareToolchainCache(ctx context.Context, request ToolchainRequest) (*ToolchainLease, error) {
	if m == nil {
		return nil, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if strings.TrimSpace(request.UserID) == "" || strings.TrimSpace(request.RuntimeID) == "" ||
		strings.TrimSpace(request.RuntimeFingerprint) == "" || strings.TrimSpace(request.Language) == "" ||
		strings.TrimSpace(request.Tool) == "" || strings.TrimSpace(request.SourcePolicyDigest) == "" {
		return nil, fmt.Errorf("toolchain cache requires user, trusted runtime, language, tool, and source policy")
	}
	request.Language = strings.ToLower(strings.TrimSpace(request.Language))
	request.Tool = strings.ToLower(strings.TrimSpace(request.Tool))
	layout, err := m.ensureUserLayout(request.UserID)
	if err != nil {
		return nil, err
	}
	parts := []string{
		safePart(request.RuntimeFingerprint), safePart(request.Language),
		safePart(request.Tool), safePart(request.SourcePolicyDigest),
	}
	key := strings.Join(append([]string{"toolchain", safePart(request.UserID)}, parts...), "/")

	m.mu.Lock()
	lock := m.buildLocks[key]
	if lock == nil {
		lock = &cacheLock{token: make(chan struct{}, 1)}
		lock.token <- struct{}{}
		m.buildLocks[key] = lock
	}
	m.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-lock.token:
	}
	lockHeld := true
	defer func() {
		if lockHeld {
			lock.token <- struct{}{}
		}
	}()

	gate := m.userGate(request.UserID)
	gate.Lock()
	gateHeld := true
	defer func() {
		if gateHeld {
			gate.Unlock()
		}
	}()
	hostRoot := filepath.Join(layout.Toolchains, parts[0], parts[1], parts[2], parts[3])
	for _, directory := range []string{
		filepath.Join(layout.Toolchains, parts[0]),
		filepath.Join(layout.Toolchains, parts[0], parts[1]),
		filepath.Join(layout.Toolchains, parts[0], parts[1], parts[2]),
		hostRoot,
	} {
		if err := ensureRealDirectory(directory); err != nil {
			return nil, err
		}
	}
	id, err := cachev2.EnsurePersistentCacheID(hostRoot)
	if err != nil {
		return nil, err
	}
	generation, err := ensureGeneration(hostRoot)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	meta := toolchainMetadata{
		Schema: cacheSchema, UserID: request.UserID, RuntimeID: request.RuntimeID,
		RuntimeFingerprint: request.RuntimeFingerprint, Language: request.Language,
		Tool: request.Tool, SourcePolicyDigest: request.SourcePolicyDigest,
		CreatedAt: now, LastUsed: now,
	}
	if stored, readErr := readToolchainMetadata(hostRoot); readErr == nil {
		meta.CreatedAt = stored.CreatedAt
	}
	if err := writeToolchainMetadata(hostRoot, meta); err != nil {
		return nil, err
	}
	mounts, environment, err := toolchainDockerContext(hostRoot, request.Tool)
	if err != nil {
		return nil, err
	}
	relative, _ := filepath.Rel(layout.Root, hostRoot)
	m.mu.Lock()
	m.buildActive[key]++
	m.activePaths[filepath.Clean(hostRoot)]++
	m.activeUsers[request.UserID]++
	m.mu.Unlock()
	gate.Unlock()
	gateHeld = false
	lockHeld = false
	return &ToolchainLease{
		ID: id, Key: key, ContainerKey: key + "@" + generation, Generation: generation,
		HostRoot: hostRoot, RelativePath: filepath.ToSlash(relative), manager: m,
		DockerMounts: mounts, DockerEnv: environment,
		request: request, meta: meta, lock: lock,
	}, nil
}

func toolchainDockerContext(hostRoot, tool string) (map[string]string, map[string]string, error) {
	containerRoot := "/tool-cache/" + safePart(tool)
	mounts := map[string]string{hostRoot: containerRoot}
	environment := map[string]string{"BOBOCLOUD_TOOL_CACHE": containerRoot}
	switch tool {
	case "pip":
		environment["PIP_CACHE_DIR"] = containerRoot
	case "npm":
		environment["NPM_CONFIG_CACHE"] = containerRoot
	case "pnpm":
		for _, child := range []string{"corepack", "store"} {
			if err := ensureRealDirectory(filepath.Join(hostRoot, child)); err != nil {
				return nil, nil, err
			}
		}
		environment["COREPACK_HOME"] = containerRoot + "/corepack"
		environment["PNPM_STORE_DIR"] = containerRoot + "/store"
	case "go":
		for _, child := range []string{"build", "mod"} {
			if err := ensureRealDirectory(filepath.Join(hostRoot, child)); err != nil {
				return nil, nil, err
			}
		}
		environment["GOCACHE"] = containerRoot + "/build"
		environment["GOMODCACHE"] = containerRoot + "/mod"
	case "cargo":
		environment["CARGO_HOME"] = containerRoot
	case "maven":
		environment["MAVEN_OPTS"] = "-Dmaven.repo.local=" + containerRoot
	case "gradle":
		environment["GRADLE_USER_HOME"] = containerRoot
	case "sccache":
		environment["SCCACHE_DIR"] = containerRoot
	case "ccache":
		environment["CCACHE_DIR"] = containerRoot
	default:
		return nil, nil, fmt.Errorf("unsupported toolchain cache tool %q", tool)
	}
	return mounts, environment, nil
}

// StartGuard monitors writes made through this lease. Callers that already
// own an Operation should pass Operation.Context so either quota violation or
// request cancellation stops the setup process.
func (lease *ToolchainLease) StartGuard(parent context.Context) *Guard {
	if lease == nil || lease.manager == nil {
		return nil
	}
	if lease.guard != nil {
		return lease.guard
	}
	if parent == nil {
		parent = context.Background()
	}
	lease.guard = lease.manager.newGuard(parent, lease.request.UserID, lease.request.QuotaBytes, directoryUsage{})
	return lease.guard
}

func readToolchainMetadata(root string) (toolchainMetadata, error) {
	data, err := readSmallRegularFile(filepath.Join(root, toolchainMetadataFile), maxMetadataBytes)
	if err != nil {
		return toolchainMetadata{}, err
	}
	var meta toolchainMetadata
	if json.Unmarshal(data, &meta) != nil || meta.Schema != cacheSchema {
		return toolchainMetadata{}, fmt.Errorf("invalid toolchain cache metadata")
	}
	return meta, nil
}

func writeToolchainMetadata(root string, meta toolchainMetadata) error {
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(root, toolchainMetadataFile, append(data, '\n'), 0600)
}

func (lease *ToolchainLease) Release() {
	if lease == nil || lease.manager == nil || lease.lock == nil {
		return
	}
	lease.released.Do(func() {
		if lease.guard != nil {
			lease.guard.Stop()
		}
		gate := lease.manager.userGate(lease.request.UserID)
		gate.Lock()
		lease.meta.LastUsed = time.Now().UTC()
		_ = writeToolchainMetadata(lease.HostRoot, lease.meta)
		lease.manager.mu.Lock()
		if lease.manager.buildActive[lease.Key] > 1 {
			lease.manager.buildActive[lease.Key]--
		} else {
			delete(lease.manager.buildActive, lease.Key)
		}
		root := filepath.Clean(lease.HostRoot)
		if lease.manager.activePaths[root] > 1 {
			lease.manager.activePaths[root]--
		} else {
			delete(lease.manager.activePaths, root)
		}
		if lease.manager.activeUsers[lease.request.UserID] > 1 {
			lease.manager.activeUsers[lease.request.UserID]--
		} else {
			delete(lease.manager.activeUsers, lease.request.UserID)
		}
		lease.manager.mu.Unlock()
		gate.Unlock()
		lease.lock.token <- struct{}{}
	})
}

func toolchainMetadataMatchesPath(meta toolchainMetadata, userID string, parts []string) bool {
	return len(parts) == 4 && meta.Schema == cacheSchema && meta.UserID == userID &&
		safePart(meta.RuntimeFingerprint) == parts[0] && safePart(meta.Language) == parts[1] &&
		safePart(meta.Tool) == parts[2] && safePart(meta.SourcePolicyDigest) == parts[3]
}

func toolchainKey(meta toolchainMetadata) string {
	return strings.Join([]string{
		"toolchain", safePart(meta.UserID), safePart(meta.RuntimeFingerprint),
		safePart(meta.Language), safePart(meta.Tool), safePart(meta.SourcePolicyDigest),
	}, "/")
}
