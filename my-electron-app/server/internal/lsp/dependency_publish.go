package lsp

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"bobocloud-server/internal/safefile"
)

const (
	nodeSnapshotRootName                    = "node"
	nodeSnapshotCurrentFile                 = ".current"
	nodeSnapshotUsageFile                   = ".snapshot-usage.json"
	nodeSnapshotMetadataMaxBytes      int64 = 4096
	nodeDependencyManifestMaxBytes    int64 = 16 << 20
	nodeSnapshotMaxBytes              int64 = 512 << 20
	DefaultNodeDependencyStoreBytes         = 2 << 30
	DefaultNodeDependencyStoreEntries       = 200_000
	NodeDependencyEntryChargeBytes    int64 = 4 << 10
	nodeSnapshotMaxFiles                    = 200_000
	nodeSnapshotKeepVersions                = 3
)

var (
	ErrDependencySnapshotTooLarge  = errors.New("dependency snapshot exceeds the analysis cache limit")
	ErrDependencySnapshotInUse     = errors.New("dependency snapshot is currently in use")
	ErrDependencySnapshotStoreFull = errors.New("analysis dependency storage quota is exhausted")
	dependencySnapshotGates        sync.Map
	dependencyWorkspaceGates       sync.Map
	dependencyStoreGates           sync.Map
)

type DependencySnapshotPolicy struct {
	// MaxStoreBytes caps charged bytes, not only file payload bytes. Every
	// filesystem entry is charged at least NodeDependencyEntryChargeBytes.
	MaxStoreBytes int64
	// MaxStoreEntries caps files, directories, and symbolic links across all
	// stored generations. A non-positive value uses the safe default.
	MaxStoreEntries int64
	// MaxAdditionalBytes caps the charged bytes for one new generation. A
	// negative value disables only this per-publish limit.
	MaxAdditionalBytes int64
}

type nodeSnapshotUsage struct {
	LogicalBytes int64 `json:"logicalBytes"`
	ChargedBytes int64 `json:"chargedBytes"`
	Entries      int64 `json:"entries"`
}

func (u nodeSnapshotUsage) add(other nodeSnapshotUsage) nodeSnapshotUsage {
	return nodeSnapshotUsage{
		LogicalBytes: u.LogicalBytes + other.LogicalBytes,
		ChargedBytes: u.ChargedBytes + other.ChargedBytes,
		Entries:      u.Entries + other.Entries,
	}
}

func (u nodeSnapshotUsage) subtract(other nodeSnapshotUsage) nodeSnapshotUsage {
	return nodeSnapshotUsage{
		LogicalBytes: u.LogicalBytes - other.LogicalBytes,
		ChargedBytes: u.ChargedBytes - other.ChargedBytes,
		Entries:      u.Entries - other.Entries,
	}
}

type dependencySnapshotGate struct {
	mu   sync.Mutex
	refs map[string]int
}

func snapshotGate(root string) *dependencySnapshotGate {
	root = filepath.Clean(root)
	created := &dependencySnapshotGate{refs: make(map[string]int)}
	actual, _ := dependencySnapshotGates.LoadOrStore(root, created)
	return actual.(*dependencySnapshotGate)
}

func snapshotWorkspaceGate(base, workspaceID string) *sync.Mutex {
	hash := sha256.Sum256([]byte(filepath.Clean(base) + "\x00" + strings.TrimSpace(workspaceID)))
	key := hex.EncodeToString(hash[:16])
	created := &sync.Mutex{}
	actual, _ := dependencyWorkspaceGates.LoadOrStore(key, created)
	return actual.(*sync.Mutex)
}

func snapshotStoreGate(base string) *sync.Mutex {
	key := filepath.Clean(base)
	created := &sync.Mutex{}
	actual, _ := dependencyStoreGates.LoadOrStore(key, created)
	return actual.(*sync.Mutex)
}

// DependencySnapshotResult describes a content-addressed dependency snapshot.
// Path is server-private and must never be included in a client response.
type DependencySnapshotResult struct {
	Path     string `json:"-"`
	Revision string `json:"revision"`
	Size     int64  `json:"size"`
	Changed  bool   `json:"changed"`
}

func nodeSnapshotWorkspaceRoot(base, workspaceID, runtimeID string) string {
	workspaceHash := sha256.Sum256([]byte(strings.TrimSpace(workspaceID)))
	runtime := runtimePathPart(runtimeID)
	if runtime == "" {
		runtime = "local"
	}
	return filepath.Join(base, nodeSnapshotRootName, runtime, hex.EncodeToString(workspaceHash[:8]))
}

func nodeDependencyFingerprint(manifestRoot, runtimeID, runtimeFingerprint, treeFingerprint string) (string, error) {
	hash := sha256.New()
	_, _ = io.WriteString(hash, strings.TrimSpace(runtimeID)+"\x00")
	_, _ = io.WriteString(hash, strings.TrimSpace(runtimeFingerprint)+"\x00")
	for _, name := range []string{
		"package.json",
		"package-lock.json",
		"npm-shrinkwrap.json",
		"pnpm-lock.yaml",
		"yarn.lock",
		"bun.lock",
		"bun.lockb",
	} {
		data, err := safefile.ReadSmallRegular(manifestRoot, name, nodeDependencyManifestMaxBytes)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", fmt.Errorf("read Node dependency manifest: %w", err)
		}
		_, _ = io.WriteString(hash, name+"\x00")
		_, _ = hash.Write(data)
		_, _ = io.WriteString(hash, "\x00")
	}
	// The installed tree is authoritative. Lock files alone do not describe
	// --no-save installs, optional/native packages, or a mutable image tag.
	_, _ = io.WriteString(hash, "installed-tree\x00"+treeFingerprint+"\x00")
	return hex.EncodeToString(hash.Sum(nil)[:16]), nil
}

func dependencyTreeState(root string) (nodeSnapshotUsage, string, error) {
	var usage nodeSnapshotUsage
	hash := sha256.New()
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		usage.Entries++
		if usage.Entries > nodeSnapshotMaxFiles {
			return ErrDependencySnapshotTooLarge
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if entry.Type()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if err := addNodeSnapshotUsage(&usage, 0, NodeDependencyEntryChargeBytes); err != nil {
				return err
			}
			_, _ = fmt.Fprintf(hash, "l\x00%s\x00%s\x00", relative, link)
		} else if entry.IsDir() {
			if err := addNodeSnapshotUsage(&usage, 0, NodeDependencyEntryChargeBytes); err != nil {
				return err
			}
			_, _ = fmt.Fprintf(hash, "d\x00%s\x00", relative)
		} else if entry.Type().IsRegular() {
			info, infoErr := entry.Info()
			if infoErr != nil {
				return infoErr
			}
			charge := info.Size()
			if charge < NodeDependencyEntryChargeBytes {
				charge = NodeDependencyEntryChargeBytes
			}
			if err := addNodeSnapshotUsage(&usage, info.Size(), charge); err != nil {
				return err
			}
			_, _ = fmt.Fprintf(hash, "f\x00%s\x00%d\x00%d\x00", relative, info.Mode().Perm(), info.Size())
			input, openErr := os.Open(path)
			if openErr != nil {
				return openErr
			}
			openedInfo, statErr := input.Stat()
			if statErr != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo) || openedInfo.Size() != info.Size() {
				_ = input.Close()
				return fmt.Errorf("Node dependency file changed while opening %q", relative)
			}
			copied, copyErr := io.CopyN(hash, input, info.Size())
			if copyErr == nil && copied == info.Size() {
				var extra int64
				extra, copyErr = io.CopyN(io.Discard, input, 1)
				if errors.Is(copyErr, io.EOF) && extra == 0 {
					copyErr = nil
				} else if copyErr == nil || extra != 0 {
					copyErr = fmt.Errorf("Node dependency file grew while reading")
				}
			}
			closeErr := input.Close()
			if copyErr != nil || copied != info.Size() {
				if copyErr == nil {
					copyErr = io.ErrUnexpectedEOF
				}
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
			_, _ = io.WriteString(hash, "\x00")
		} else {
			return fmt.Errorf("unsupported Node dependency entry %q", relative)
		}
		return nil
	})
	if err != nil {
		return usage, "", err
	}
	return usage, hex.EncodeToString(hash.Sum(nil)), nil
}

func addNodeSnapshotUsage(usage *nodeSnapshotUsage, logical, charged int64) error {
	if usage == nil || logical < 0 || charged < 0 || logical > nodeSnapshotMaxBytes || charged > nodeSnapshotMaxBytes {
		return ErrDependencySnapshotTooLarge
	}
	if usage.LogicalBytes > nodeSnapshotMaxBytes-logical || usage.ChargedBytes > nodeSnapshotMaxBytes-charged {
		return ErrDependencySnapshotTooLarge
	}
	usage.LogicalBytes += logical
	usage.ChargedBytes += charged
	return nil
}

func dependencyTreeSize(root string) (int64, error) {
	usage, _, err := dependencyTreeState(root)
	return usage.LogicalBytes, err
}

func copyDependencyTree(source, target string, expected nodeSnapshotUsage, expectedFingerprint string) error {
	var copiedUsage nodeSnapshotUsage
	hash := sha256.New()
	err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		copiedUsage.Entries++
		if copiedUsage.Entries > nodeSnapshotMaxFiles {
			return ErrDependencySnapshotTooLarge
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if err := addNodeSnapshotUsage(&copiedUsage, 0, NodeDependencyEntryChargeBytes); err != nil {
				return err
			}
			_, _ = fmt.Fprintf(hash, "d\x00%s\x00", filepath.ToSlash(relative))
			return os.MkdirAll(destination, info.Mode().Perm())
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if err := addNodeSnapshotUsage(&copiedUsage, 0, NodeDependencyEntryChargeBytes); err != nil {
				return err
			}
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			_, _ = fmt.Fprintf(hash, "l\x00%s\x00%s\x00", filepath.ToSlash(relative), link)
			return os.Symlink(link, destination)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("unsupported Node dependency entry %q", relative)
		}
		charge := info.Size()
		if charge < NodeDependencyEntryChargeBytes {
			charge = NodeDependencyEntryChargeBytes
		}
		if err := addNodeSnapshotUsage(&copiedUsage, info.Size(), charge); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(hash, "f\x00%s\x00%d\x00%d\x00", filepath.ToSlash(relative), info.Mode().Perm(), info.Size())
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		openedInfo, statErr := input.Stat()
		if statErr != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo) || openedInfo.Size() != info.Size() {
			_ = input.Close()
			return fmt.Errorf("Node dependency file changed while opening %q", relative)
		}
		output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			_ = input.Close()
			return err
		}
		copied, copyErr := io.CopyN(io.MultiWriter(output, hash), input, info.Size())
		if copyErr == nil && copied == info.Size() {
			var extra int64
			extra, copyErr = io.CopyN(io.Discard, input, 1)
			if errors.Is(copyErr, io.EOF) && extra == 0 {
				copyErr = nil
			} else if copyErr == nil || extra != 0 {
				copyErr = fmt.Errorf("Node dependency file grew while copying")
			}
		}
		inputCloseErr := input.Close()
		outputCloseErr := output.Close()
		if copyErr != nil || copied != info.Size() {
			if copyErr == nil {
				copyErr = io.ErrUnexpectedEOF
			}
			return copyErr
		}
		if inputCloseErr != nil {
			return inputCloseErr
		}
		_, _ = io.WriteString(hash, "\x00")
		return outputCloseErr
	})
	if err != nil {
		return err
	}
	if copiedUsage != expected {
		return fmt.Errorf("Node dependency tree changed while copying")
	}
	if fingerprint := hex.EncodeToString(hash.Sum(nil)); fingerprint != expectedFingerprint {
		return fmt.Errorf("Node dependency tree contents changed while copying")
	}
	return nil
}

func writeCurrentSnapshot(root, revision string) error {
	temporary, err := os.CreateTemp(root, ".current-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err = temporary.WriteString(revision + "\n"); err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	target := filepath.Join(root, nodeSnapshotCurrentFile)
	if err := os.Rename(name, target); err == nil {
		return nil
	}
	// Windows cannot atomically replace an existing file with os.Rename. The
	// server deployment is Linux, but keeping the fallback makes local tests and
	// development deterministic. A missing marker only makes the view empty.
	if err := os.Remove(target); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Rename(name, target)
}

type nodeStoredGeneration struct {
	path          string
	workspaceRoot string
	revision      string
	usage         nodeSnapshotUsage
	modTime       int64
	current       bool
}

func validNodeSnapshotUsage(usage nodeSnapshotUsage) bool {
	if usage.Entries <= 0 || usage.Entries > nodeSnapshotMaxFiles {
		return false
	}
	minimumCharge := usage.Entries * NodeDependencyEntryChargeBytes
	return usage.LogicalBytes >= 0 && usage.LogicalBytes <= nodeSnapshotMaxBytes &&
		usage.ChargedBytes >= usage.LogicalBytes && usage.ChargedBytes >= minimumCharge &&
		usage.ChargedBytes <= nodeSnapshotMaxBytes
}

func readNodeSnapshotUsage(generation string) (nodeSnapshotUsage, error) {
	data, err := safefile.ReadSmallRegular(generation, nodeSnapshotUsageFile, nodeSnapshotMetadataMaxBytes)
	if err == nil {
		var usage nodeSnapshotUsage
		if jsonErr := json.Unmarshal(data, &usage); jsonErr == nil && validNodeSnapshotUsage(usage) {
			return usage, nil
		}
	}
	usage, _, scanErr := dependencyTreeState(filepath.Join(generation, "node_modules"))
	return usage, scanErr
}

func readCurrentNodeSnapshot(workspaceRoot string) string {
	data, err := safefile.ReadSmallRegular(workspaceRoot, nodeSnapshotCurrentFile, nodeSnapshotMetadataMaxBytes)
	if err != nil {
		return ""
	}
	revision := strings.TrimSpace(string(data))
	if len(revision) != 32 {
		return ""
	}
	if _, err := hex.DecodeString(revision); err != nil {
		return ""
	}
	return revision
}

func listNodeStoredGenerations(base string) ([]nodeStoredGeneration, nodeSnapshotUsage, error) {
	nodeRoot := filepath.Join(base, nodeSnapshotRootName)
	runtimes, err := os.ReadDir(nodeRoot)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nodeSnapshotUsage{}, nil
	}
	if err != nil {
		return nil, nodeSnapshotUsage{}, err
	}
	items := make([]nodeStoredGeneration, 0)
	var total nodeSnapshotUsage
	for _, runtime := range runtimes {
		if !runtime.IsDir() || runtime.Type()&os.ModeSymlink != 0 {
			continue
		}
		workspaces, readErr := os.ReadDir(filepath.Join(nodeRoot, runtime.Name()))
		if readErr != nil {
			continue
		}
		for _, workspace := range workspaces {
			if !workspace.IsDir() || workspace.Type()&os.ModeSymlink != 0 {
				continue
			}
			workspaceRoot := filepath.Join(nodeRoot, runtime.Name(), workspace.Name())
			current := readCurrentNodeSnapshot(workspaceRoot)
			currentModTime := int64(0)
			if current != "" {
				if markerInfo, markerErr := os.Lstat(filepath.Join(workspaceRoot, nodeSnapshotCurrentFile)); markerErr == nil && markerInfo.Mode().IsRegular() {
					currentModTime = markerInfo.ModTime().UnixNano()
				}
			}
			generations, readErr := os.ReadDir(filepath.Join(workspaceRoot, "generations"))
			if readErr != nil {
				continue
			}
			for _, generation := range generations {
				if !generation.IsDir() || generation.Type()&os.ModeSymlink != 0 || strings.HasPrefix(generation.Name(), ".") {
					continue
				}
				path := filepath.Join(workspaceRoot, "generations", generation.Name())
				usage, usageErr := readNodeSnapshotUsage(path)
				if usageErr != nil {
					return nil, nodeSnapshotUsage{}, fmt.Errorf("inspect Node dependency generation %s: %w", generation.Name(), usageErr)
				}
				info, infoErr := generation.Info()
				if infoErr != nil {
					continue
				}
				total = total.add(usage)
				modTime := info.ModTime().UnixNano()
				isCurrent := generation.Name() == current
				if isCurrent && currentModTime > modTime {
					modTime = currentModTime
				}
				items = append(items, nodeStoredGeneration{
					path: path, workspaceRoot: workspaceRoot, revision: generation.Name(), usage: usage,
					modTime: modTime, current: isCurrent,
				})
			}
		}
	}
	return items, total, nil
}

func nodeSnapshotUsageWithinStoreLimit(usage nodeSnapshotUsage, maxBytes, maxEntries int64) bool {
	return usage.ChargedBytes <= maxBytes && usage.Entries <= maxEntries
}

func reserveNodeSnapshotStorage(base, protected string, incoming nodeSnapshotUsage, policy DependencySnapshotPolicy) error {
	items, total, err := listNodeStoredGenerations(base)
	if err != nil {
		return fmt.Errorf("inspect analysis dependency storage: %w", err)
	}
	return reserveDependencySnapshotStorage(items, total, protected, incoming, policy, DefaultNodeDependencyStoreBytes)
}

func reserveDependencySnapshotStorage(items []nodeStoredGeneration, total nodeSnapshotUsage, protected string, incoming nodeSnapshotUsage, policy DependencySnapshotPolicy, defaultMaxBytes int64) error {
	maxBytes := policy.MaxStoreBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}
	maxEntries := policy.MaxStoreEntries
	if maxEntries <= 0 {
		maxEntries = DefaultNodeDependencyStoreEntries
	}
	if policy.MaxAdditionalBytes >= 0 && incoming.ChargedBytes > policy.MaxAdditionalBytes {
		return ErrDependencySnapshotStoreFull
	}
	combined := total.add(incoming)
	if nodeSnapshotUsageWithinStoreLimit(combined, maxBytes, maxEntries) {
		return nil
	}
	sort.Slice(items, func(i, j int) bool { return items[i].modTime < items[j].modTime })
	for _, item := range items {
		if nodeSnapshotUsageWithinStoreLimit(total.add(incoming), maxBytes, maxEntries) {
			break
		}
		if filepath.Clean(item.path) == filepath.Clean(protected) {
			continue
		}
		gate := snapshotGate(item.workspaceRoot)
		gate.mu.Lock()
		active := gate.refs[item.path] > 0 || gate.refs[filepath.Join(item.path, "node_modules")] > 0
		if !active {
			if removeErr := os.RemoveAll(item.path); removeErr == nil {
				// A current marker is only a soft retention hint. Once no analyzer
				// holds the generation, quota pressure may evict it; clear the
				// marker while holding the same gate used by snapshot resolution.
				if item.current && readCurrentNodeSnapshot(item.workspaceRoot) == item.revision {
					_ = os.Remove(filepath.Join(item.workspaceRoot, nodeSnapshotCurrentFile))
				}
				total = total.subtract(item.usage)
			}
		}
		gate.mu.Unlock()
	}
	if !nodeSnapshotUsageWithinStoreLimit(total.add(incoming), maxBytes, maxEntries) {
		return ErrDependencySnapshotStoreFull
	}
	return nil
}

// PublishNodeDependencySnapshot atomically publishes the modules produced by a
// run. Generations are immutable so an active analyzer never observes a tree
// being replaced underneath its read-only bind mount.
func PublishNodeDependencySnapshot(base, workspaceID, manifestRoot, runtimeID, runtimeFingerprint, modulesRoot string) (DependencySnapshotResult, error) {
	return PublishNodeDependencySnapshotWithPolicy(base, workspaceID, manifestRoot, runtimeID, runtimeFingerprint, modulesRoot, DependencySnapshotPolicy{MaxAdditionalBytes: -1})
}

func PublishNodeDependencySnapshotWithPolicy(base, workspaceID, manifestRoot, runtimeID, runtimeFingerprint, modulesRoot string, policy DependencySnapshotPolicy) (DependencySnapshotResult, error) {
	info, err := os.Lstat(modulesRoot)
	if errors.Is(err, fs.ErrNotExist) {
		return DependencySnapshotResult{}, nil
	}
	if err != nil {
		return DependencySnapshotResult{}, fmt.Errorf("inspect Node dependencies: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return DependencySnapshotResult{}, fmt.Errorf("Node dependency root must be a real directory")
	}
	base, err = filepath.Abs(base)
	if err != nil || strings.TrimSpace(workspaceID) == "" || strings.TrimSpace(manifestRoot) == "" {
		return DependencySnapshotResult{}, fmt.Errorf("invalid Node dependency snapshot root")
	}
	storeGate := snapshotStoreGate(base)
	storeGate.Lock()
	defer storeGate.Unlock()
	workspaceGate := snapshotWorkspaceGate(base, workspaceID)
	workspaceGate.Lock()
	defer workspaceGate.Unlock()
	usage, treeFingerprint, err := dependencyTreeState(modulesRoot)
	if err != nil {
		return DependencySnapshotResult{}, err
	}
	revision, err := nodeDependencyFingerprint(manifestRoot, runtimeID, runtimeFingerprint, treeFingerprint)
	if err != nil {
		return DependencySnapshotResult{}, err
	}
	root := nodeSnapshotWorkspaceRoot(base, workspaceID, runtimeID)
	gate := snapshotGate(root)
	gate.mu.Lock()
	current := nodeDependencySnapshotLocked(root)
	if current != "" && filepath.Base(filepath.Dir(current)) == revision {
		gate.mu.Unlock()
		return DependencySnapshotResult{Path: current, Revision: revision}, nil
	}
	previousRevision := ""
	if current != "" {
		previousRevision = filepath.Base(filepath.Dir(current))
	}
	gate.mu.Unlock()
	generations := filepath.Join(root, "generations")
	if err := os.MkdirAll(generations, 0755); err != nil {
		return DependencySnapshotResult{}, fmt.Errorf("create Node dependency snapshot root: %w", err)
	}
	generation := filepath.Join(generations, revision)
	incoming := usage
	if generationInfo, statErr := os.Stat(filepath.Join(generation, "node_modules")); statErr == nil && generationInfo.IsDir() {
		incoming = nodeSnapshotUsage{}
	}
	if err := reserveNodeSnapshotStorage(base, generation, incoming, policy); err != nil {
		return DependencySnapshotResult{}, err
	}
	gate.mu.Lock()
	defer gate.mu.Unlock()
	if current := nodeDependencySnapshotLocked(root); current != "" && filepath.Base(filepath.Dir(current)) == revision {
		return DependencySnapshotResult{Path: current, Revision: revision}, nil
	}
	// Changed describes the active dependency view, not whether storage was
	// allocated. Re-activating a retained A generation after B must restart
	// analyzers just as publishing a new generation does.
	changed := previousRevision != revision
	if generationInfo, statErr := os.Stat(filepath.Join(generation, "node_modules")); statErr != nil || !generationInfo.IsDir() {
		staging, err := os.MkdirTemp(generations, ".publish-")
		if err != nil {
			return DependencySnapshotResult{}, fmt.Errorf("create Node dependency staging directory: %w", err)
		}
		defer os.RemoveAll(staging)
		stagingModules := filepath.Join(staging, "node_modules")
		if err := os.Rename(modulesRoot, stagingModules); err != nil {
			if err := copyDependencyTree(modulesRoot, stagingModules, usage, treeFingerprint); err != nil {
				return DependencySnapshotResult{}, fmt.Errorf("copy Node dependency snapshot: %w", err)
			}
		}
		usageData, err := json.Marshal(usage)
		if err != nil {
			return DependencySnapshotResult{}, fmt.Errorf("encode Node dependency snapshot metadata: %w", err)
		}
		if err := safefile.WriteAtomic(staging, nodeSnapshotUsageFile, append(usageData, '\n'), 0600); err != nil {
			return DependencySnapshotResult{}, fmt.Errorf("write Node dependency snapshot metadata: %w", err)
		}
		if err := os.Rename(staging, generation); err != nil {
			if existing, statErr := os.Stat(filepath.Join(generation, "node_modules")); statErr != nil || !existing.IsDir() {
				return DependencySnapshotResult{}, fmt.Errorf("publish Node dependency snapshot: %w", err)
			}
		}
	}
	if err := writeCurrentSnapshot(root, revision); err != nil {
		return DependencySnapshotResult{}, fmt.Errorf("activate Node dependency snapshot: %w", err)
	}
	pruneNodeDependencySnapshotsLocked(gate, generations, revision)
	return DependencySnapshotResult{Path: filepath.Join(generation, "node_modules"), Revision: revision, Size: usage.LogicalBytes, Changed: changed}, nil
}

// DeleteNodeDependencyWorkspace removes every runtime generation for one
// personal workspace. It shares the same gates as publish/acquire so an active
// analyzer can never lose a bind source underneath it.
func DeleteNodeDependencyWorkspace(base, workspaceID string) error {
	base, err := filepath.Abs(base)
	if err != nil || strings.TrimSpace(workspaceID) == "" {
		return fmt.Errorf("invalid Node dependency snapshot root")
	}
	storeGate := snapshotStoreGate(base)
	storeGate.Lock()
	defer storeGate.Unlock()
	workspaceGate := snapshotWorkspaceGate(base, workspaceID)
	workspaceGate.Lock()
	defer workspaceGate.Unlock()

	workspaceHash := sha256.Sum256([]byte(strings.TrimSpace(workspaceID)))
	workspacePart := hex.EncodeToString(workspaceHash[:8])
	nodeRoot := filepath.Join(base, nodeSnapshotRootName)
	runtimes, err := os.ReadDir(nodeRoot)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("list Node dependency snapshots: %w", err)
	}
	roots := make([]string, 0, len(runtimes))
	for _, runtime := range runtimes {
		if !runtime.IsDir() || runtime.Type()&os.ModeSymlink != 0 {
			continue
		}
		root := filepath.Join(nodeRoot, runtime.Name(), workspacePart)
		info, statErr := os.Lstat(root)
		if errors.Is(statErr, fs.ErrNotExist) {
			continue
		}
		if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("invalid Node dependency workspace snapshot")
		}
		roots = append(roots, root)
	}
	sort.Strings(roots)
	gates := make([]*dependencySnapshotGate, 0, len(roots))
	for _, root := range roots {
		gate := snapshotGate(root)
		gate.mu.Lock()
		gates = append(gates, gate)
	}
	defer func() {
		for index := len(gates) - 1; index >= 0; index-- {
			gates[index].mu.Unlock()
		}
	}()
	for _, gate := range gates {
		for _, count := range gate.refs {
			if count > 0 {
				return ErrDependencySnapshotInUse
			}
		}
	}
	for _, root := range roots {
		if err := os.RemoveAll(root); err != nil {
			return fmt.Errorf("delete Node dependency snapshots: %w", err)
		}
	}
	return nil
}

// NodeDependencySnapshot resolves only a server-issued marker and never accepts
// a path from the client.
func NodeDependencySnapshot(base, workspaceID, runtimeID string) string {
	root := nodeSnapshotWorkspaceRoot(base, workspaceID, runtimeID)
	gate := snapshotGate(root)
	gate.mu.Lock()
	defer gate.mu.Unlock()
	return nodeDependencySnapshotLocked(root)
}

func nodeDependencySnapshotLocked(root string) string {
	revision := readCurrentNodeSnapshot(root)
	if revision == "" {
		return ""
	}
	target := filepath.Join(root, "generations", revision, "node_modules")
	if info, err := os.Stat(target); err == nil && info.IsDir() {
		return target
	}
	return ""
}

func pruneNodeDependencySnapshotsLocked(gate *dependencySnapshotGate, root, current string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	type generationInfo struct {
		name string
		path string
		mod  int64
	}
	items := make([]generationInfo, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		info, err := entry.Info()
		if err == nil {
			items = append(items, generationInfo{name: entry.Name(), path: filepath.Join(root, entry.Name()), mod: info.ModTime().UnixNano()})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mod > items[j].mod })
	kept := 1 // the current immutable generation is always retained
	for _, item := range items {
		if item.name == current {
			continue
		}
		if kept < nodeSnapshotKeepVersions {
			kept++
			continue
		}
		if gate.refs[filepath.Clean(item.path)] > 0 {
			continue
		}
		_ = os.RemoveAll(item.path)
	}
}
