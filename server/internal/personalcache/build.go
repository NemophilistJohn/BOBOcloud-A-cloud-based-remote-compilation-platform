package personalcache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/cachev2"
)

const (
	buildMetadataFile = ".build-meta.json"
	buildResultFile   = ".build-result.json"
)

type BuildRequest struct {
	UserID             string
	WorkspaceID        string
	WorkspaceName      string
	RuntimeID          string
	RuntimeFingerprint string
	Language           string
	DependencyDigest   string
	Target             string
}

type buildMetadata struct {
	Schema             int       `json:"schema"`
	UserID             string    `json:"user_id"`
	WorkspaceID        string    `json:"workspace_id"`
	WorkspaceName      string    `json:"workspace_name"`
	RuntimeID          string    `json:"runtime_id"`
	RuntimeFingerprint string    `json:"runtime_fingerprint"`
	Language           string    `json:"language"`
	DependencyDigest   string    `json:"dependency_digest"`
	Target             string    `json:"target"`
	CreatedAt          time.Time `json:"created_at"`
	LastUsed           time.Time `json:"last_used"`
}

type buildResult struct {
	Schema      int       `json:"schema"`
	Fingerprint string    `json:"fingerprint"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type BuildLease struct {
	Key              string
	CacheID          cachev2.CacheID
	ResultCacheID    cachev2.CacheID
	ContainerKey     string
	Generation       string
	ResultGeneration string
	HostRoot         string
	ResultRoot       string
	RelativePath     string
	DockerMounts     map[string]string
	DockerEnv        map[string]string
	cacheRoot        string
	manager          *Manager
	request          BuildRequest
	meta             buildMetadata
	lock             *cacheLock
	released         sync.Once
}

func shortDigest(values ...string) string {
	digest := sha256.Sum256([]byte(strings.Join(values, "\x00")))
	return hex.EncodeToString(digest[:16])
}

func buildCacheEnvironment(language string) map[string]string {
	switch strings.ToLower(strings.TrimSpace(language)) {
	case "go":
		return map[string]string{"GOCACHE": "/project-build/go-cache"}
	case "rust":
		return map[string]string{"CARGO_TARGET_DIR": "/project-build/cargo-target", "SCCACHE_DIR": "/project-build/sccache"}
	default:
		return map[string]string{}
	}
}

func buildCacheMounts(incrementalRoot, resultRoot, language string) map[string]string {
	mounts := map[string]string{resultRoot: "/workspace/.bobocloud"}
	switch strings.ToLower(strings.TrimSpace(language)) {
	case "go", "rust":
		mounts[incrementalRoot] = "/project-build"
	}
	return mounts
}

func (m *Manager) PrepareBuild(ctx context.Context, request BuildRequest) (*BuildLease, error) {
	if m == nil {
		return nil, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if strings.TrimSpace(request.UserID) == "" || strings.TrimSpace(request.WorkspaceID) == "" ||
		strings.TrimSpace(request.RuntimeID) == "" || strings.TrimSpace(request.RuntimeFingerprint) == "" || strings.TrimSpace(request.Language) == "" {
		return nil, fmt.Errorf("personal build cache requires user, workspace, trusted runtime, and language")
	}
	layout, err := m.ensureUserLayout(request.UserID)
	if err != nil {
		return nil, err
	}
	identity := shortDigest(request.DependencyDigest, request.Target)
	runtimePart := safePart(request.RuntimeFingerprint)
	workspacePart := safePart(request.WorkspaceID)
	languagePart := safePart(request.Language)
	key := strings.Join([]string{"build", safePart(request.UserID), workspacePart, runtimePart, languagePart, identity}, "/")

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

	cacheRoot := layout.Root
	hostRoot := filepath.Join(layout.Incremental, workspacePart, runtimePart, languagePart, identity)
	resultRoot := filepath.Join(layout.Results, workspacePart, runtimePart, languagePart, identity)
	directories := []string{
		filepath.Join(layout.Incremental, workspacePart),
		filepath.Join(layout.Incremental, workspacePart, runtimePart),
		filepath.Join(layout.Incremental, workspacePart, runtimePart, languagePart),
		hostRoot,
		filepath.Join(layout.Results, workspacePart),
		filepath.Join(layout.Results, workspacePart, runtimePart),
		filepath.Join(layout.Results, workspacePart, runtimePart, languagePart),
		resultRoot,
	}
	for _, directory := range directories {
		if err := ensureRealDirectory(directory); err != nil {
			return nil, err
		}
	}
	generation, err := ensureGeneration(hostRoot)
	if err != nil {
		return nil, err
	}
	resultGeneration, err := ensureGeneration(resultRoot)
	if err != nil {
		return nil, err
	}
	cacheID, err := cachev2.EnsurePersistentCacheID(hostRoot)
	if err != nil {
		return nil, err
	}
	resultCacheID, err := cachev2.EnsurePersistentCacheID(resultRoot)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	meta := buildMetadata{
		Schema: cacheSchema, UserID: request.UserID, WorkspaceID: request.WorkspaceID, WorkspaceName: request.WorkspaceName,
		RuntimeID: request.RuntimeID, RuntimeFingerprint: request.RuntimeFingerprint, Language: request.Language,
		DependencyDigest: request.DependencyDigest, Target: request.Target, CreatedAt: now, LastUsed: now,
	}
	if stored, readErr := readBuildMetadata(hostRoot); readErr == nil {
		meta.CreatedAt = stored.CreatedAt
	}
	if err := writeBuildMetadata(hostRoot, meta); err != nil {
		return nil, err
	}
	if resultMeta, readErr := readBuildMetadata(resultRoot); readErr == nil {
		resultMeta.LastUsed = now
		meta.CreatedAt = resultMeta.CreatedAt
	}
	if err := writeBuildMetadata(resultRoot, meta); err != nil {
		return nil, err
	}
	relative, _ := filepath.Rel(cacheRoot, hostRoot)
	m.mu.Lock()
	m.buildActive[key]++
	m.activePaths[filepath.Clean(hostRoot)]++
	m.activePaths[filepath.Clean(resultRoot)]++
	m.activeUsers[request.UserID]++
	m.mu.Unlock()
	gate.Unlock()
	gateHeld = false
	lockHeld = false
	return &BuildLease{
		Key: key, CacheID: cacheID, ResultCacheID: resultCacheID,
		ContainerKey: key + "@" + generation + ":" + resultGeneration, Generation: generation, ResultGeneration: resultGeneration,
		HostRoot: hostRoot, ResultRoot: resultRoot, RelativePath: filepath.ToSlash(relative), DockerMounts: buildCacheMounts(hostRoot, resultRoot, request.Language),
		DockerEnv: buildCacheEnvironment(request.Language), cacheRoot: cacheRoot, manager: m, request: request, meta: meta, lock: lock,
	}, nil
}

func readBuildMetadata(root string) (buildMetadata, error) {
	data, err := readSmallRegularFile(filepath.Join(root, buildMetadataFile), maxMetadataBytes)
	if err != nil {
		return buildMetadata{}, err
	}
	var meta buildMetadata
	if json.Unmarshal(data, &meta) != nil || meta.Schema != cacheSchema {
		return buildMetadata{}, fmt.Errorf("invalid build cache metadata")
	}
	return meta, nil
}

func writeBuildMetadata(root string, meta buildMetadata) error {
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(root, buildMetadataFile, data, 0600)
}

func (lease *BuildLease) ResultHit(fingerprint string) bool {
	if lease == nil || strings.TrimSpace(fingerprint) == "" {
		return false
	}
	data, err := readSmallRegularFile(filepath.Join(lease.ResultRoot, buildResultFile), maxMetadataBytes)
	if err != nil {
		return false
	}
	var result buildResult
	return json.Unmarshal(data, &result) == nil && result.Schema == cacheSchema && result.Fingerprint == fingerprint
}

// ConfigureCargoTarget exposes the persistent Cargo target directory at the
// project-relative location used by the generated run plan. Cargo and the run
// step must resolve the same binary path for both cold builds and cache hits.
func (lease *BuildLease) ConfigureCargoTarget(workDir string) error {
	if lease == nil || !strings.EqualFold(strings.TrimSpace(lease.request.Language), "rust") {
		return nil
	}
	rawWorkDir := strings.TrimSpace(workDir)
	nativeWorkDir := filepath.Clean(filepath.FromSlash(rawWorkDir))
	workDir = filepath.ToSlash(nativeWorkDir)
	if workDir == "." {
		workDir = ""
	}
	hasDrivePrefix := len(workDir) >= 2 && ((workDir[0] >= 'a' && workDir[0] <= 'z') || (workDir[0] >= 'A' && workDir[0] <= 'Z')) && workDir[1] == ':'
	if filepath.IsAbs(nativeWorkDir) || hasDrivePrefix || workDir == ".." || strings.HasPrefix(workDir, "../") || path.IsAbs(workDir) {
		return fmt.Errorf("Cargo work directory must stay inside the project")
	}
	targetRoot := filepath.Join(lease.HostRoot, "cargo-target")
	if err := ensureRealDirectory(targetRoot); err != nil {
		return err
	}
	containerTarget := path.Join("/workspace", workDir, "target")
	if lease.DockerMounts == nil {
		lease.DockerMounts = make(map[string]string)
	}
	if lease.DockerEnv == nil {
		lease.DockerEnv = make(map[string]string)
	}
	lease.DockerMounts[targetRoot] = containerTarget
	lease.DockerEnv["CARGO_TARGET_DIR"] = containerTarget
	return nil
}

func (lease *BuildLease) CommitResult(fingerprint string) error {
	if lease == nil || strings.TrimSpace(fingerprint) == "" {
		return nil
	}
	// Publish the cache IDs before exposing a reusable result marker. If the
	// binding cannot be committed, a later run must compile again rather than
	// trusting an unregistered result directory.
	if err := lease.Commit(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(buildResult{Schema: cacheSchema, Fingerprint: fingerprint, UpdatedAt: time.Now().UTC()}, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(lease.ResultRoot, buildResultFile, data, 0600)
}

// Commit publishes this incremental/result pair as the authoritative current
// build generation. Call it only after compilation succeeds. CommitResult does
// this automatically when result reuse is enabled.
func (lease *BuildLease) Commit() error {
	if lease == nil || lease.manager == nil {
		return nil
	}
	gate := lease.manager.userGate(lease.request.UserID)
	gate.Lock()
	defer gate.Unlock()
	return lease.manager.writeBuildCurrentBindingLocked(
		lease.request,
		shortDigest(lease.request.DependencyDigest, lease.request.Target),
		lease.cacheRoot,
	)
}

func (lease *BuildLease) InvalidateResult() error {
	if lease == nil {
		return nil
	}
	err := os.Remove(filepath.Join(lease.ResultRoot, buildResultFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (lease *BuildLease) Release() {
	if lease == nil || lease.manager == nil || lease.lock == nil {
		return
	}
	lease.released.Do(func() {
		gate := lease.manager.userGate(lease.request.UserID)
		gate.Lock()
		lease.meta.LastUsed = time.Now().UTC()
		_ = writeBuildMetadata(lease.HostRoot, lease.meta)
		_ = writeBuildMetadata(lease.ResultRoot, lease.meta)
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
		resultRoot := filepath.Clean(lease.ResultRoot)
		if lease.manager.activePaths[resultRoot] > 1 {
			lease.manager.activePaths[resultRoot]--
		} else {
			delete(lease.manager.activePaths, resultRoot)
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
