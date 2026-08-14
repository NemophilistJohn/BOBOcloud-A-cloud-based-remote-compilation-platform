package buildcache

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/safefile"
)

// BuildContext identifies a cache namespace. Runtime must distinguish local
// toolchains from Docker images; Branch is isolated because compiler target
// directories are writable and cannot safely be shared by concurrent branches.
type BuildContext struct {
	TeamID    string
	ProjectID string
	Branch    string
	Runtime   string
	Language  string
}

type Prepared struct {
	Key            string
	ContainerKey   string
	Buildspace     string
	SharedHost     string
	TargetHost     string
	DependencyHost string
	LocalEnv       map[string]string
	DockerEnv      map[string]string
	DockerMounts   map[string]string
	manager        *Manager
	lock           *cacheLock
	owner          string
	meta           namespaceMeta
	released       sync.Once
}

// SharedDependencies is a non-exclusive lease over a team's downloaded
// dependency cache. It deliberately excludes writable compiler target
// directories, so a long-running language server never blocks incremental
// builds. The reference protects the shared mount from cache deletion.
type SharedDependencies struct {
	Key                string
	ContainerKey       string
	SharedHost         string
	DependencyHost     string
	LocalEnv           map[string]string
	DockerEnv          map[string]string
	DockerMounts       map[string]string
	manager            *Manager
	owner              string
	dependencyKey      string
	dependencyMeta     namespaceMeta
	sharedReleased     sync.Once
	dependencyReleased sync.Once
}

func (s *SharedDependencies) ReleaseSharedCache() {
	if s == nil || s.manager == nil {
		return
	}
	s.sharedReleased.Do(func() {
		s.manager.releaseShared(s.owner, s.Key, s.SharedHost)
	})
}

func (s *SharedDependencies) ReleaseProjectDependencies() {
	if s == nil || s.manager == nil || s.dependencyKey == "" || s.DependencyHost == "" {
		return
	}
	s.dependencyReleased.Do(func() {
		s.dependencyMeta.LastUsed = time.Now().UTC()
		s.manager.releaseProjectDependencies(s.owner, s.dependencyKey, s.DependencyHost, s.dependencyMeta)
	})
}

func (s *SharedDependencies) Release() {
	if s == nil {
		return
	}
	s.ReleaseSharedCache()
	s.ReleaseProjectDependencies()
}

const mountGenerationFile = ".container-generation"

const cacheMetadataMaxBytes = 64 << 10

const (
	cacheEntryChargeBytes = int64(4096)
	cacheUsageMaxEntries  = 250_000
	cacheUsageMaxDepth    = 64
	cacheUsageMaxDuration = 2 * time.Second
	unknownCacheUsage     = int64(1 << 40)
)

// ensureMountGeneration returns an identity that changes when a cache mount is
// manually deleted and recreated. Docker bind mounts retain the old inode in
// that situation, so the pool must not reuse a container created for the old
// directory even though the logical cache key is unchanged.
func ensureMountGeneration(dir string) (string, error) {
	if value, err := readMountGeneration(dir); err == nil {
		return value, nil
	}

	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	value := hex.EncodeToString(random)
	if err := safefile.WriteAtomic(dir, mountGenerationFile, []byte(value+"\n"), 0600); err != nil {
		return "", err
	}
	return readMountGeneration(dir)
}

func readMountGeneration(dir string) (string, error) {
	data, err := safefile.ReadSmallRegular(dir, mountGenerationFile, 4096)
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(data))
	if len(value) != 32 {
		return "", fmt.Errorf("invalid cache mount generation")
	}
	return value, nil
}

func touchCacheDirectory(dir string) {
	now := time.Now()
	_ = os.Chtimes(dir, now, now)
}

type namespaceMeta struct {
	TeamID    string    `json:"team_id"`
	ProjectID string    `json:"project_id"`
	Branch    string    `json:"branch"`
	Runtime   string    `json:"runtime"`
	Language  string    `json:"language"`
	LastUsed  time.Time `json:"last_used"`
}

func (meta namespaceMeta) key() string {
	return strings.Join([]string{
		safePart(meta.TeamID), safePart(meta.ProjectID), safePart(meta.Runtime),
		safePart(meta.Language), safePart(meta.Branch),
	}, "/")
}

type NamespaceInfo struct {
	ProjectID  string    `json:"project_id"`
	Branch     string    `json:"branch"`
	Runtime    string    `json:"runtime"`
	Language   string    `json:"language"`
	SizeBytes  int64     `json:"size_bytes"`
	LastUsed   time.Time `json:"last_used"`
	Active     bool      `json:"active"`
	Key        string    `json:"key"`
	generation string
}

type Info struct {
	TeamID          string          `json:"team_id"`
	QuotaBytes      int64           `json:"quota_bytes"`
	TotalBytes      int64           `json:"total_bytes"`
	SharedBytes     int64           `json:"shared_bytes"`
	TargetBytes     int64           `json:"target_bytes"`
	DependencyBytes int64           `json:"dependency_bytes"`
	ScratchBytes    int64           `json:"scratch_bytes"`
	Namespaces      []NamespaceInfo `json:"namespaces"`
	Dependencies    []NamespaceInfo `json:"dependencies"`
}

type cacheLock struct {
	token chan struct{}
}

type Manager struct {
	root             string
	defaultQuota     int64
	mu               sync.Mutex
	locks            map[string]*cacheLock
	active           map[string]int
	sharedActive     map[string]int
	dependencyActive map[string]int
	runtimeEpoch     map[string]uint64
	ownerGates       sync.Map
	maintenanceGates sync.Map
	enforcementMu    sync.Mutex
	enforcement      map[string]*enforcementRequest
	removeAll        func(string) error
}

type enforcementRequest struct {
	running bool
	dirty   bool
	quotaMB int
}

func NewManager(root string, defaultQuotaMB int) *Manager {
	if defaultQuotaMB <= 0 {
		defaultQuotaMB = 4096
	}
	return &Manager{
		root:             filepath.Clean(root),
		defaultQuota:     int64(defaultQuotaMB) * 1_000_000,
		locks:            make(map[string]*cacheLock),
		active:           make(map[string]int),
		sharedActive:     make(map[string]int),
		dependencyActive: make(map[string]int),
		runtimeEpoch:     make(map[string]uint64),
		enforcement:      make(map[string]*enforcementRequest),
		removeAll:        os.RemoveAll,
	}
}

func (m *Manager) maintenanceGate(teamPart string) *sync.Mutex {
	created := &sync.Mutex{}
	actual, _ := m.maintenanceGates.LoadOrStore(teamPart, created)
	return actual.(*sync.Mutex)
}

func (m *Manager) ownerGate(owner string) *sync.Mutex {
	gate, _ := m.ownerGates.LoadOrStore(owner, &sync.Mutex{})
	return gate.(*sync.Mutex)
}

func (m *Manager) DefaultQuotaBytes() int64 { return m.defaultQuota }

// WithQuotaGuard serializes one storage mutation with quota enforcement for a
// team. The callback receives a fresh snapshot while the same maintenance gate
// used by Enforce is held, so concurrent project/branch publishers cannot each
// spend the same remaining bytes. The callback must not re-enter this method or
// Enforce for the same team.
func (m *Manager) WithQuotaGuard(teamID string, quotaMB int, mutate func(Info) error) error {
	if m == nil || strings.TrimSpace(teamID) == "" || mutate == nil {
		return fmt.Errorf("valid team quota mutation is required")
	}
	teamPart := safePart(teamID)
	gate := m.maintenanceGate(teamPart)
	gate.Lock()
	defer gate.Unlock()
	return mutate(m.Inspect(teamID, quotaMB))
}

func safePart(value string) string {
	value = strings.TrimSpace(value)
	readable := make([]rune, 0, 24)
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			readable = append(readable, r)
		}
		if len(readable) >= 24 {
			break
		}
	}
	if len(readable) == 0 {
		readable = append(readable, 'x')
	}
	sum := sha256.Sum256([]byte(value))
	return string(readable) + "-" + hex.EncodeToString(sum[:6])
}

func mergeEnv(base map[string]string, values map[string]string) map[string]string {
	out := make(map[string]string, len(base)+len(values))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range values {
		out[k] = v
	}
	return out
}

func cacheEnv(shared, target string, docker bool) map[string]string {
	env := map[string]string{
		"PIP_CACHE_DIR":    filepath.ToSlash(filepath.Join(shared, "pip")),
		"GOMODCACHE":       filepath.ToSlash(filepath.Join(shared, "go", "pkg", "mod")),
		"GOCACHE":          filepath.ToSlash(filepath.Join(shared, "go-build")),
		"CARGO_HOME":       filepath.ToSlash(filepath.Join(shared, "cargo")),
		"CARGO_TARGET_DIR": filepath.ToSlash(filepath.Join(target, "cargo-target")),
		"SCCACHE_DIR":      filepath.ToSlash(filepath.Join(shared, "sccache")),
		"NPM_CONFIG_CACHE": filepath.ToSlash(filepath.Join(shared, "npm")),
		"MAVEN_OPTS":       "-Dmaven.repo.local=" + filepath.ToSlash(filepath.Join(shared, "maven")),
		"GRADLE_USER_HOME": filepath.ToSlash(filepath.Join(shared, "gradle")),
	}
	// sccache is optional. Enabling RUSTC_WRAPPER when it is absent would make
	// every Rust build fail, so local mode only enables it after discovery.
	if !docker {
		if _, err := exec.LookPath("sccache"); err == nil {
			env["RUSTC_WRAPPER"] = "sccache"
		}
	}
	return env
}

func dependencyEnv(shared string) map[string]string {
	return map[string]string{
		"PIP_CACHE_DIR":    filepath.ToSlash(filepath.Join(shared, "pip")),
		"GOMODCACHE":       filepath.ToSlash(filepath.Join(shared, "go", "pkg", "mod")),
		"CARGO_HOME":       filepath.ToSlash(filepath.Join(shared, "cargo")),
		"SCCACHE_DIR":      filepath.ToSlash(filepath.Join(shared, "sccache")),
		"NPM_CONFIG_CACHE": filepath.ToSlash(filepath.Join(shared, "npm")),
		"MAVEN_OPTS":       "-Dmaven.repo.local=" + filepath.ToSlash(filepath.Join(shared, "maven")),
		"GRADLE_USER_HOME": filepath.ToSlash(filepath.Join(shared, "gradle")),
	}
}

func hasProjectDependencyContext(bc BuildContext) bool {
	return bc.ProjectID != "" && bc.Branch != "" && bc.Language != ""
}

func ensurePrivateDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	return os.Chmod(path, 0700)
}

// SharedDependencies prepares the runtime-level dependency cache without
// taking the exclusive branch/compiler-target lease used by Prepare.
func (m *Manager) SharedDependencies(bc BuildContext) (*SharedDependencies, error) {
	if bc.TeamID == "" {
		return nil, fmt.Errorf("team is required for shared dependencies")
	}
	if bc.Runtime == "" {
		bc.Runtime = "local"
	}
	teamPart := safePart(bc.TeamID)
	runtimePart := safePart(bc.Runtime)
	key := teamPart + "/" + runtimePart
	sharedHost := filepath.Join(m.root, teamPart, "shared", runtimePart)
	dependencyHost := ""
	dependencyKey := ""
	dependencyMeta := namespaceMeta{}
	gate := m.ownerGate(teamPart)
	gate.Lock()
	defer gate.Unlock()
	if err := os.MkdirAll(sharedHost, 0755); err != nil {
		return nil, fmt.Errorf("create shared dependency cache: %w", err)
	}
	generation, err := ensureMountGeneration(sharedHost)
	if err != nil {
		return nil, fmt.Errorf("prepare shared dependency mount: %w", err)
	}
	if hasProjectDependencyContext(bc) {
		projectPart := safePart(bc.ProjectID)
		languagePart := safePart(bc.Language)
		branchPart := safePart(bc.Branch)
		dependencyKey = strings.Join([]string{teamPart, projectPart, runtimePart, languagePart, branchPart}, "/")
		dependencyHost = filepath.Join(m.root, teamPart, "projects", projectPart, "dependencies", runtimePart, languagePart, branchPart)
		if err := ensurePrivateDirectory(dependencyHost); err != nil {
			return nil, fmt.Errorf("create project dependency cache: %w", err)
		}
		if _, err := ensureMountGeneration(dependencyHost); err != nil {
			return nil, fmt.Errorf("prepare project dependency mount: %w", err)
		}
		dependencyMeta = namespaceMeta{
			TeamID: bc.TeamID, ProjectID: bc.ProjectID, Branch: bc.Branch,
			Runtime: bc.Runtime, Language: bc.Language, LastUsed: time.Now().UTC(),
		}
		writePrivateMeta(dependencyHost, dependencyMeta)
	}
	touchCacheDirectory(sharedHost)
	m.mu.Lock()
	m.sharedActive[key]++
	if dependencyKey != "" {
		m.dependencyActive[dependencyKey]++
	}
	m.runtimeEpoch[key]++
	m.mu.Unlock()
	return &SharedDependencies{
		Key: key, ContainerKey: key + "@" + generation, SharedHost: sharedHost, DependencyHost: dependencyHost,
		LocalEnv: dependencyEnv(sharedHost), DockerEnv: dependencyEnv("/team-cache/shared"),
		DockerMounts: map[string]string{sharedHost: "/team-cache/shared"}, manager: m, owner: teamPart,
		dependencyKey: dependencyKey, dependencyMeta: dependencyMeta,
	}, nil
}

func (m *Manager) releaseShared(owner, key, sharedHost string) {
	gate := m.ownerGate(owner)
	gate.Lock()
	defer gate.Unlock()
	touchCacheDirectory(sharedHost)
	m.mu.Lock()
	if m.sharedActive[key] > 1 {
		m.sharedActive[key]--
	} else {
		delete(m.sharedActive, key)
	}
	m.runtimeEpoch[key]++
	m.mu.Unlock()
}

func (m *Manager) releaseProjectDependencies(owner, key, dependencyHost string, meta namespaceMeta) {
	gate := m.ownerGate(owner)
	gate.Lock()
	defer gate.Unlock()
	writePrivateMeta(dependencyHost, meta)
	m.mu.Lock()
	if m.dependencyActive[key] > 1 {
		m.dependencyActive[key]--
	} else {
		delete(m.dependencyActive, key)
	}
	m.mu.Unlock()
}

// Prepare acquires an exclusive namespace lease. The lease serializes builds
// that intentionally share a writable incremental target while allowing other
// branches/runtimes to compile in parallel.
func (m *Manager) Prepare(ctx context.Context, bc BuildContext) (*Prepared, error) {
	if bc.TeamID == "" || bc.ProjectID == "" || bc.Branch == "" || bc.Language == "" {
		return nil, fmt.Errorf("team, project, branch and language are required for team cache")
	}
	if bc.Runtime == "" {
		bc.Runtime = "local"
	}
	teamPart := safePart(bc.TeamID)
	projectPart := safePart(bc.ProjectID)
	runtimePart := safePart(bc.Runtime)
	languagePart := safePart(bc.Language)
	branchPart := safePart(bc.Branch)
	key := strings.Join([]string{teamPart, projectPart, runtimePart, languagePart, branchPart}, "/")

	gate := m.ownerGate(teamPart)
	gate.Lock()
	m.mu.Lock()
	lock := m.locks[key]
	if lock == nil {
		lock = &cacheLock{token: make(chan struct{}, 1)}
		lock.token <- struct{}{}
		m.locks[key] = lock
	}
	m.mu.Unlock()
	gate.Unlock()

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-lock.token:
	}

	gate.Lock()
	teamRoot := filepath.Join(m.root, teamPart)
	sharedHost := filepath.Join(teamRoot, "shared", runtimePart)
	targetHost := filepath.Join(teamRoot, "projects", projectPart, "targets", runtimePart, languagePart, branchPart)
	buildspace := filepath.Join(teamRoot, "projects", projectPart, "buildspaces", runtimePart, languagePart, branchPart)
	dependencyHost := filepath.Join(teamRoot, "projects", projectPart, "dependencies", runtimePart, languagePart, branchPart)
	for _, dir := range []string{sharedHost, targetHost, buildspace} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			gate.Unlock()
			lock.token <- struct{}{}
			return nil, fmt.Errorf("create build cache directory: %w", err)
		}
	}
	if err := ensurePrivateDirectory(dependencyHost); err != nil {
		gate.Unlock()
		lock.token <- struct{}{}
		return nil, fmt.Errorf("create project dependency cache: %w", err)
	}
	sharedGeneration, err := ensureMountGeneration(sharedHost)
	if err != nil {
		gate.Unlock()
		lock.token <- struct{}{}
		return nil, fmt.Errorf("prepare shared cache mount: %w", err)
	}
	targetGeneration, err := ensureMountGeneration(targetHost)
	if err != nil {
		gate.Unlock()
		lock.token <- struct{}{}
		return nil, fmt.Errorf("prepare target cache mount: %w", err)
	}
	if _, err := ensureMountGeneration(dependencyHost); err != nil {
		gate.Unlock()
		lock.token <- struct{}{}
		return nil, fmt.Errorf("prepare project dependency mount: %w", err)
	}
	touchCacheDirectory(sharedHost)

	meta := namespaceMeta{
		TeamID: bc.TeamID, ProjectID: bc.ProjectID, Branch: bc.Branch,
		Runtime: bc.Runtime, Language: bc.Language, LastUsed: time.Now().UTC(),
	}
	writeMeta(targetHost, meta)
	writePrivateMeta(dependencyHost, meta)
	m.mu.Lock()
	m.active[key]++
	m.runtimeEpoch[teamPart+"/"+runtimePart]++
	m.mu.Unlock()
	gate.Unlock()

	localEnv := cacheEnv(sharedHost, targetHost, false)
	dockerEnv := cacheEnv("/team-cache/shared", "/team-cache/target", true)
	return &Prepared{
		Key: key, ContainerKey: key + "@" + sharedGeneration + "." + targetGeneration,
		Buildspace: buildspace, SharedHost: sharedHost, TargetHost: targetHost, DependencyHost: dependencyHost,
		LocalEnv: localEnv, DockerEnv: dockerEnv,
		DockerMounts: map[string]string{sharedHost: "/team-cache/shared", targetHost: "/team-cache/target"},
		manager:      m, lock: lock, owner: teamPart, meta: meta,
	}, nil
}

func writeMetaMode(target string, meta namespaceMeta, mode fs.FileMode) {
	data, err := json.Marshal(meta)
	if err == nil {
		_ = safefile.WriteAtomic(target, ".cache-meta.json", data, mode)
	}
}

func writeMeta(target string, meta namespaceMeta) { writeMetaMode(target, meta, 0644) }

func writePrivateMeta(target string, meta namespaceMeta) { writeMetaMode(target, meta, 0600) }

func (p *Prepared) Release() {
	if p == nil || p.manager == nil || p.lock == nil {
		return
	}
	p.released.Do(func() {
		p.meta.LastUsed = time.Now().UTC()
		p.manager.release(p.owner, p.Key, p.lock, p.SharedHost, p.TargetHost, p.DependencyHost, p.meta)
	})
}

func (m *Manager) release(owner, key string, lock *cacheLock, sharedHost, target, dependencyHost string, meta namespaceMeta) {
	gate := m.ownerGate(owner)
	gate.Lock()
	touchCacheDirectory(sharedHost)
	writeMeta(target, meta)
	writePrivateMeta(dependencyHost, meta)
	m.mu.Lock()
	if m.active[key] > 1 {
		m.active[key]--
	} else {
		delete(m.active, key)
	}
	if parts, ok := namespaceKeyParts(key); ok {
		m.runtimeEpoch[parts[0]+"/"+parts[2]]++
	}
	m.mu.Unlock()
	gate.Unlock()
	lock.token <- struct{}{}
}

func dirSize(root string) int64 {
	info, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return unknownCacheUsage
	}
	type pendingDirectory struct {
		path  string
		depth int
	}
	queue := []pendingDirectory{{path: root}}
	total, entries := cacheEntryChargeBytes, 1
	deadline := time.Now().Add(cacheUsageMaxDuration)
	for len(queue) > 0 {
		if entries >= cacheUsageMaxEntries || time.Now().After(deadline) {
			return unknownCacheUsage
		}
		current := queue[0]
		queue = queue[1:]
		if current.depth >= cacheUsageMaxDepth {
			return unknownCacheUsage
		}
		directory, openErr := os.Open(current.path)
		if openErr != nil {
			return unknownCacheUsage
		}
		for {
			children, readErr := directory.ReadDir(256)
			for _, child := range children {
				entries++
				if entries > cacheUsageMaxEntries || time.Now().After(deadline) {
					_ = directory.Close()
					return unknownCacheUsage
				}
				childPath := filepath.Join(current.path, child.Name())
				if child.Type()&os.ModeSymlink != 0 {
					total += cacheEntryChargeBytes
					continue
				}
				if child.IsDir() {
					total += cacheEntryChargeBytes
					queue = append(queue, pendingDirectory{path: childPath, depth: current.depth + 1})
					continue
				}
				childInfo, statErr := child.Info()
				if statErr != nil {
					_ = directory.Close()
					return unknownCacheUsage
				}
				charged := childInfo.Size()
				if charged < cacheEntryChargeBytes {
					charged = cacheEntryChargeBytes
				}
				if total > unknownCacheUsage-charged {
					_ = directory.Close()
					return unknownCacheUsage
				}
				total += charged
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				_ = directory.Close()
				return unknownCacheUsage
			}
		}
		if closeErr := directory.Close(); closeErr != nil {
			return unknownCacheUsage
		}
	}
	return total
}

func (m *Manager) activeSnapshot() map[string]bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]bool, len(m.active))
	for key, count := range m.active {
		out[key] = count > 0
	}
	return out
}

func (m *Manager) dependencyActiveSnapshot() map[string]bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]bool, len(m.dependencyActive))
	for key, count := range m.dependencyActive {
		out[key] = count > 0
	}
	return out
}

func namespaceKeyParts(key string) ([]string, bool) {
	parts := strings.Split(key, "/")
	return parts, len(parts) == 5
}

func (m *Manager) runtimeEpochValue(teamPart, runtimePart string) uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.runtimeEpoch[teamPart+"/"+runtimePart]
}

// The caller must hold m.mu. Lifecycle operations that also touch the
// filesystem hold the owner gate before entering this check.
func (m *Manager) runtimeInUseLocked(teamPart, runtimePart string) bool {
	if m.sharedActive[teamPart+"/"+runtimePart] > 0 {
		return true
	}
	for key, count := range m.active {
		parts, ok := namespaceKeyParts(key)
		if ok && count > 0 && parts[0] == teamPart && parts[2] == runtimePart {
			return true
		}
	}
	return false
}

func (m *Manager) teamHasActiveNamespaceLocked(teamPart string) bool {
	for key, count := range m.active {
		parts, ok := namespaceKeyParts(key)
		if ok && count > 0 && parts[0] == teamPart {
			return true
		}
	}
	return false
}

func (m *Manager) projectHasActiveNamespaceLocked(teamPart, projectPart string) bool {
	for key, count := range m.active {
		parts, ok := namespaceKeyParts(key)
		if ok && count > 0 && parts[0] == teamPart && parts[1] == projectPart {
			return true
		}
	}
	return false
}

func (m *Manager) teamHasDependencyLeaseLocked(teamPart string) bool {
	for key, count := range m.dependencyActive {
		parts, ok := namespaceKeyParts(key)
		if ok && count > 0 && parts[0] == teamPart {
			return true
		}
	}
	return false
}

func (m *Manager) projectHasDependencyLeaseLocked(teamPart, projectPart string) bool {
	for key, count := range m.dependencyActive {
		parts, ok := namespaceKeyParts(key)
		if ok && count > 0 && parts[0] == teamPart && parts[1] == projectPart {
			return true
		}
	}
	return false
}

func (m *Manager) teamHasSharedLeaseLocked(teamPart string) bool {
	for key, count := range m.sharedActive {
		parts := strings.Split(key, "/")
		if len(parts) == 2 && count > 0 && parts[0] == teamPart {
			return true
		}
	}
	return false
}

func (m *Manager) removeInactiveNamespace(teamPart, teamRoot, key, target string) bool {
	parts, ok := namespaceKeyParts(key)
	if !ok || parts[0] != teamPart || !pathWithin(teamRoot, target) {
		return false
	}
	gate := m.ownerGate(teamPart)
	gate.Lock()
	defer gate.Unlock()
	m.mu.Lock()
	active := m.active[key] > 0
	m.mu.Unlock()
	if active {
		return false
	}
	return m.removeAll(target) == nil
}

func (m *Manager) removeInactiveLRUNamespace(teamPart, teamRoot, key, target string, expectedLastUsed time.Time, expectedGeneration string) bool {
	parts, ok := namespaceKeyParts(key)
	if !ok || parts[0] != teamPart || !pathWithin(teamRoot, target) {
		return false
	}
	gate := m.ownerGate(teamPart)
	gate.Lock()
	defer gate.Unlock()
	m.mu.Lock()
	active := m.active[key] > 0
	m.mu.Unlock()
	if active {
		return false
	}
	if !namespaceLastUsedMatches(target, key, expectedLastUsed) {
		return false
	}
	generation, generationErr := readMountGeneration(target)
	if expectedGeneration == "" {
		if generationErr == nil {
			return false
		}
	} else if generationErr != nil || generation != expectedGeneration {
		return false
	}
	return m.removeAll(target) == nil
}

func (m *Manager) removeInactiveLRUDependencyNamespace(teamPart, teamRoot, key, target string, expectedLastUsed time.Time, expectedGeneration string) bool {
	parts, ok := namespaceKeyParts(key)
	if !ok || parts[0] != teamPart || !pathWithin(teamRoot, target) {
		return false
	}
	gate := m.ownerGate(teamPart)
	gate.Lock()
	defer gate.Unlock()
	m.mu.Lock()
	active := m.active[key] > 0 || m.dependencyActive[key] > 0
	m.mu.Unlock()
	if active {
		return false
	}
	if !namespaceLastUsedMatches(target, key, expectedLastUsed) {
		return false
	}
	generation, generationErr := readMountGeneration(target)
	if expectedGeneration == "" {
		if generationErr == nil {
			return false
		}
	} else if generationErr != nil || generation != expectedGeneration {
		return false
	}
	return m.removeAll(target) == nil
}

func (m *Manager) removeExpiredNamespace(teamPart, teamRoot, key, target string, cutoff time.Time) bool {
	parts, ok := namespaceKeyParts(key)
	if !ok || parts[0] != teamPart || !pathWithin(teamRoot, target) {
		return false
	}
	gate := m.ownerGate(teamPart)
	gate.Lock()
	defer gate.Unlock()
	m.mu.Lock()
	active := m.active[key] > 0
	m.mu.Unlock()
	if active {
		return false
	}
	lastUsed, ok := namespaceLastUsed(target, key)
	if !ok || lastUsed.IsZero() || !lastUsed.Before(cutoff) {
		return false
	}
	return m.removeAll(target) == nil
}

func namespaceLastUsed(target, key string) (time.Time, bool) {
	if data, err := safefile.ReadSmallRegular(target, ".cache-meta.json", cacheMetadataMaxBytes); err == nil {
		var meta namespaceMeta
		if json.Unmarshal(data, &meta) == nil && meta.key() == key && !meta.LastUsed.IsZero() {
			return meta.LastUsed, true
		}
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		return time.Time{}, false
	}
	return info.ModTime().UTC(), true
}

func namespaceLastUsedMatches(target, key string, expected time.Time) bool {
	actual, ok := namespaceLastUsed(target, key)
	return ok && actual.Equal(expected)
}

func (m *Manager) removeInactiveSharedRuntime(teamPart, teamRoot, runtimePart, target, expectedGeneration string, expectedEpoch uint64) bool {
	if runtimePart == "" || !pathWithin(teamRoot, target) {
		return false
	}
	gate := m.ownerGate(teamPart)
	gate.Lock()
	defer gate.Unlock()
	m.mu.Lock()
	inUse := m.runtimeInUseLocked(teamPart, runtimePart)
	currentEpoch := m.runtimeEpoch[teamPart+"/"+runtimePart]
	m.mu.Unlock()
	if inUse || currentEpoch != expectedEpoch {
		return false
	}
	generation, generationErr := readMountGeneration(target)
	if expectedGeneration == "" {
		if generationErr == nil {
			return false
		}
	} else if generationErr != nil || generation != expectedGeneration {
		return false
	}
	return m.removeAll(target) == nil
}

func inspectProjectNamespaces(projectsRoot, kind string, active, additionalActive map[string]bool) ([]NamespaceInfo, int64) {
	namespaces := make([]NamespaceInfo, 0)
	var total int64
	teamPart := filepath.Base(filepath.Dir(projectsRoot))
	projects, _ := os.ReadDir(projectsRoot)
	for _, project := range projects {
		if !project.IsDir() || project.Type()&os.ModeSymlink != 0 {
			continue
		}
		projectRoot := filepath.Join(projectsRoot, project.Name(), kind)
		runtimes, _ := os.ReadDir(projectRoot)
		for _, runtimeEntry := range runtimes {
			if !runtimeEntry.IsDir() || runtimeEntry.Type()&os.ModeSymlink != 0 {
				continue
			}
			languagesRoot := filepath.Join(projectRoot, runtimeEntry.Name())
			languages, _ := os.ReadDir(languagesRoot)
			for _, languageEntry := range languages {
				if !languageEntry.IsDir() || languageEntry.Type()&os.ModeSymlink != 0 {
					continue
				}
				branchesRoot := filepath.Join(languagesRoot, languageEntry.Name())
				branches, _ := os.ReadDir(branchesRoot)
				for _, branchEntry := range branches {
					if !branchEntry.IsDir() || branchEntry.Type()&os.ModeSymlink != 0 {
						continue
					}
					path := filepath.Join(branchesRoot, branchEntry.Name())
					meta := namespaceMeta{
						TeamID: teamPart, ProjectID: project.Name(),
						Runtime: runtimeEntry.Name(), Language: languageEntry.Name(), Branch: branchEntry.Name(),
					}
					key := strings.Join([]string{teamPart, project.Name(), runtimeEntry.Name(), languageEntry.Name(), branchEntry.Name()}, "/")
					if data, readErr := safefile.ReadSmallRegular(path, ".cache-meta.json", cacheMetadataMaxBytes); readErr == nil {
						var stored namespaceMeta
						if json.Unmarshal(data, &stored) == nil && stored.key() == key {
							meta = stored
						}
					}
					if meta.LastUsed.IsZero() {
						if info, statErr := branchEntry.Info(); statErr == nil {
							meta.LastUsed = info.ModTime().UTC()
						}
					}
					size := dirSize(path)
					if total > unknownCacheUsage-size {
						total = unknownCacheUsage
					} else {
						total += size
					}
					generation, _ := readMountGeneration(path)
					namespaces = append(namespaces, NamespaceInfo{
						ProjectID: meta.ProjectID, Branch: meta.Branch, Runtime: meta.Runtime,
						Language: meta.Language, SizeBytes: size, LastUsed: meta.LastUsed,
						Active: active[key] || additionalActive[key], Key: key, generation: generation,
					})
				}
			}
		}
	}
	return namespaces, total
}

func (m *Manager) Inspect(teamID string, quotaMB int) Info {
	if quotaMB <= 0 {
		quotaMB = int(m.defaultQuota / 1_000_000)
	}
	teamPart := safePart(teamID)
	teamRoot := filepath.Join(m.root, teamPart)
	info := Info{
		TeamID: teamID, QuotaBytes: int64(quotaMB) * 1_000_000,
		Namespaces: make([]NamespaceInfo, 0), Dependencies: make([]NamespaceInfo, 0),
	}
	info.SharedBytes = dirSize(filepath.Join(teamRoot, "shared"))
	active := m.activeSnapshot()
	dependencyActive := m.dependencyActiveSnapshot()
	projectsRoot := filepath.Join(teamRoot, "projects")
	info.Namespaces, info.TargetBytes = inspectProjectNamespaces(projectsRoot, "targets", active, nil)
	info.Dependencies, info.DependencyBytes = inspectProjectNamespaces(projectsRoot, "dependencies", active, dependencyActive)
	info.ScratchBytes = scratchSize(projectsRoot)
	info.TotalBytes = info.SharedBytes + info.TargetBytes + info.DependencyBytes + info.ScratchBytes
	sort.Slice(info.Namespaces, func(i, j int) bool { return info.Namespaces[i].LastUsed.After(info.Namespaces[j].LastUsed) })
	sort.Slice(info.Dependencies, func(i, j int) bool { return info.Dependencies[i].LastUsed.After(info.Dependencies[j].LastUsed) })
	return info
}

func scratchSize(projectsRoot string) int64 {
	var total int64
	entries, _ := os.ReadDir(projectsRoot)
	for _, entry := range entries {
		if entry.IsDir() {
			total += dirSize(filepath.Join(projectsRoot, entry.Name(), "buildspaces"))
		}
	}
	return total
}

// CleanScratch removes build workspaces left behind by completed builds or an
// unclean server shutdown. A workspace with a live namespace lease is kept.
func (m *Manager) CleanScratch(teamID string) {
	teamPart := safePart(teamID)
	teamRoot := filepath.Join(m.root, teamPart)
	projectsRoot := filepath.Join(teamRoot, "projects")
	projects, _ := os.ReadDir(projectsRoot)
	for _, project := range projects {
		if !project.IsDir() {
			continue
		}
		buildspaces := filepath.Join(projectsRoot, project.Name(), "buildspaces")
		runtimes, _ := os.ReadDir(buildspaces)
		for _, runtime := range runtimes {
			if !runtime.IsDir() {
				continue
			}
			languages, _ := os.ReadDir(filepath.Join(buildspaces, runtime.Name()))
			for _, language := range languages {
				if !language.IsDir() {
					continue
				}
				branchesRoot := filepath.Join(buildspaces, runtime.Name(), language.Name())
				branches, _ := os.ReadDir(branchesRoot)
				for _, branch := range branches {
					if !branch.IsDir() {
						continue
					}
					key := strings.Join([]string{teamPart, project.Name(), runtime.Name(), language.Name(), branch.Name()}, "/")
					target := filepath.Join(branchesRoot, branch.Name())
					m.removeInactiveNamespace(teamPart, teamRoot, key, target)
				}
			}
		}
	}
}

// PruneExpired removes inactive incremental targets older than the team's
// configured retention period. Shared dependency caches remain governed by
// the quota LRU because they benefit every branch and project in the team.
func (m *Manager) PruneExpired(teamID string, retentionDays, quotaMB int) Info {
	info := m.Inspect(teamID, quotaMB)
	if retentionDays <= 0 {
		return info
	}
	cutoff := time.Now().UTC().Add(-time.Duration(retentionDays) * 24 * time.Hour)
	teamPart := safePart(teamID)
	teamRoot := filepath.Join(m.root, teamPart)
	for _, ns := range info.Namespaces {
		if ns.Active || ns.LastUsed.IsZero() || !ns.LastUsed.Before(cutoff) {
			continue
		}
		parts, ok := namespaceKeyParts(ns.Key)
		if !ok || parts[0] != teamPart {
			continue
		}
		target := filepath.Join(teamRoot, "projects", parts[1], "targets", parts[2], parts[3], parts[4])
		m.removeExpiredNamespace(teamPart, teamRoot, ns.Key, target, cutoff)
	}
	return m.Inspect(teamID, quotaMB)
}

// Enforce removes least-recently-used inactive target namespaces, then
// server-side project dependencies, before considering runtime-level shared
// caches. The returned Info reflects the final state.
func (m *Manager) Enforce(teamID string, quotaMB int) Info {
	teamPart := safePart(teamID)
	gate := m.maintenanceGate(teamPart)
	gate.Lock()
	defer gate.Unlock()
	return m.enforce(teamID, teamPart, quotaMB)
}

func (m *Manager) enforce(teamID, teamPart string, quotaMB int) Info {
	info := m.Inspect(teamID, quotaMB)
	if info.QuotaBytes <= 0 || info.TotalBytes <= info.QuotaBytes {
		return info
	}
	oldest := append([]NamespaceInfo(nil), info.Namespaces...)
	sort.Slice(oldest, func(i, j int) bool { return oldest[i].LastUsed.Before(oldest[j].LastUsed) })
	teamRoot := filepath.Join(m.root, teamPart)
	for _, ns := range oldest {
		if info.TotalBytes <= info.QuotaBytes {
			break
		}
		if ns.Active {
			continue
		}
		parts, ok := namespaceKeyParts(ns.Key)
		if !ok || parts[0] != teamPart {
			continue
		}
		target := filepath.Join(teamRoot, "projects", parts[1], "targets", parts[2], parts[3], parts[4])
		if m.removeInactiveLRUNamespace(teamPart, teamRoot, ns.Key, target, ns.LastUsed, ns.generation) {
			info.TotalBytes -= ns.SizeBytes
		}
	}
	if info.TotalBytes > info.QuotaBytes {
		oldestDependencies := append([]NamespaceInfo(nil), info.Dependencies...)
		sort.Slice(oldestDependencies, func(i, j int) bool {
			return oldestDependencies[i].LastUsed.Before(oldestDependencies[j].LastUsed)
		})
		for _, ns := range oldestDependencies {
			if info.TotalBytes <= info.QuotaBytes {
				break
			}
			if ns.Active {
				continue
			}
			parts, ok := namespaceKeyParts(ns.Key)
			if !ok || parts[0] != teamPart {
				continue
			}
			target := filepath.Join(teamRoot, "projects", parts[1], "dependencies", parts[2], parts[3], parts[4])
			if m.removeInactiveLRUDependencyNamespace(teamPart, teamRoot, ns.Key, target, ns.LastUsed, ns.generation) {
				info.TotalBytes -= ns.SizeBytes
			}
		}
	}
	if info.TotalBytes > info.QuotaBytes {
		sharedRoot := filepath.Join(teamRoot, "shared")
		entries, _ := os.ReadDir(sharedRoot)
		type candidate struct {
			path       string
			runtime    string
			generation string
			epoch      uint64
			size       int64
			mod        time.Time
		}
		var candidates []candidate
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			runtimePart := entry.Name()
			epochBefore := m.runtimeEpochValue(teamPart, runtimePart)
			p := filepath.Join(sharedRoot, entry.Name())
			stat, err := entry.Info()
			if err != nil {
				continue
			}
			generation, _ := readMountGeneration(p)
			size := dirSize(p)
			epochAfter := m.runtimeEpochValue(teamPart, runtimePart)
			if epochBefore != epochAfter {
				continue
			}
			candidates = append(candidates, candidate{
				path: p, runtime: runtimePart, generation: generation,
				epoch: epochAfter, size: size, mod: stat.ModTime(),
			})
		}
		sort.Slice(candidates, func(i, j int) bool { return candidates[i].mod.Before(candidates[j].mod) })
		for _, item := range candidates {
			if info.TotalBytes <= info.QuotaBytes {
				break
			}
			if m.removeInactiveSharedRuntime(teamPart, teamRoot, item.runtime, item.path, item.generation, item.epoch) {
				info.TotalBytes -= item.size
			}
		}
	}
	return m.Inspect(teamID, quotaMB)
}

// RequestEnforce coalesces expensive quota scans per team and runs them away
// from latency-sensitive build/WebSocket completion paths. A request arriving
// during a scan schedules exactly one trailing pass with the newest quota.
func (m *Manager) RequestEnforce(teamID string, quotaMB int) {
	if m == nil || strings.TrimSpace(teamID) == "" {
		return
	}
	teamPart := safePart(teamID)
	m.enforcementMu.Lock()
	state := m.enforcement[teamPart]
	if state != nil && state.running {
		state.dirty = true
		state.quotaMB = quotaMB
		m.enforcementMu.Unlock()
		return
	}
	state = &enforcementRequest{running: true, quotaMB: quotaMB}
	m.enforcement[teamPart] = state
	m.enforcementMu.Unlock()
	go func() {
		for {
			m.enforcementMu.Lock()
			quota := state.quotaMB
			state.dirty = false
			m.enforcementMu.Unlock()
			m.Enforce(teamID, quota)
			m.enforcementMu.Lock()
			if state.dirty {
				m.enforcementMu.Unlock()
				continue
			}
			delete(m.enforcement, teamPart)
			m.enforcementMu.Unlock()
			return
		}
	}()
}

func pathWithin(root, target string) bool {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	return target != root && strings.HasPrefix(target, root+string(filepath.Separator))
}

// Clear performs a manual, bounded cache deletion. Scope is one of all,
// shared, project, or namespace. Active namespaces are never deleted.
func (m *Manager) Clear(teamID, scope, projectID, namespaceKey string) error {
	teamPart := safePart(teamID)
	teamRoot := filepath.Join(m.root, teamPart)
	projectPart := safePart(projectID)
	var target string
	switch scope {
	case "all":
		target = teamRoot
	case "shared":
		target = filepath.Join(teamRoot, "shared")
	case "project":
		if projectID == "" {
			return fmt.Errorf("projectId is required")
		}
		target = filepath.Join(teamRoot, "projects", projectPart)
	case "namespace":
		if namespaceKey == "" {
			return fmt.Errorf("namespace is missing or active")
		}
		parts, ok := namespaceKeyParts(namespaceKey)
		if !ok || parts[0] != teamPart {
			return fmt.Errorf("invalid namespace")
		}
		target = filepath.Join(teamRoot, "projects", parts[1], "targets", parts[2], parts[3], parts[4])
	default:
		return fmt.Errorf("invalid cache scope")
	}
	if !pathWithin(m.root, target) {
		return fmt.Errorf("cache target is outside cache root")
	}
	gate := m.ownerGate(teamPart)
	gate.Lock()
	defer gate.Unlock()
	m.mu.Lock()
	activeNamespace := namespaceKey != "" && m.active[namespaceKey] > 0
	teamActive := m.teamHasActiveNamespaceLocked(teamPart)
	projectActive := m.projectHasActiveNamespaceLocked(teamPart, projectPart)
	sharedActive := m.teamHasSharedLeaseLocked(teamPart)
	teamDependencyActive := m.teamHasDependencyLeaseLocked(teamPart)
	projectDependencyActive := m.projectHasDependencyLeaseLocked(teamPart, projectPart)
	m.mu.Unlock()
	switch scope {
	case "all":
		if teamActive {
			return fmt.Errorf("cache is currently in use by a build")
		}
		if sharedActive {
			return fmt.Errorf("shared dependency cache is currently in use")
		}
		if teamDependencyActive {
			return fmt.Errorf("project dependency cache is currently in use")
		}
	case "shared":
		if teamActive {
			return fmt.Errorf("cache is currently in use by a build")
		}
		if sharedActive {
			return fmt.Errorf("shared dependency cache is currently in use")
		}
	case "project":
		if projectActive {
			return fmt.Errorf("cache is currently in use by a build")
		}
		if projectDependencyActive {
			return fmt.Errorf("project dependency cache is currently in use")
		}
	case "namespace":
		if activeNamespace {
			return fmt.Errorf("namespace is missing or active")
		}
	}
	return m.removeAll(target)
}

// MergePlanEnv is intentionally kept in this package-independent shape so the
// handler can merge it into runner steps without coupling runner to cache code.
func MergeEnv(base, additional map[string]string) map[string]string {
	return mergeEnv(base, additional)
}
