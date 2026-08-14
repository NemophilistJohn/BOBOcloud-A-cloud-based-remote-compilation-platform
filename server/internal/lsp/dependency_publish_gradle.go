package lsp

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"bobocloud-server/internal/safefile"
)

const DefaultGradleDependencyStoreBytes int64 = 1 << 30

// PublishGradleDependencySnapshot copies a quiescent modules-2 cache into a
// server-private immutable generation and atomically makes it current.
func PublishGradleDependencySnapshot(base, runtimeID, modulesRoot string) (DependencySnapshotResult, error) {
	return PublishGradleDependencySnapshotWithPolicy(base, runtimeID, modulesRoot, DependencySnapshotPolicy{MaxAdditionalBytes: -1})
}

func PublishGradleDependencySnapshotWithPolicy(base, runtimeID, modulesRoot string, policy DependencySnapshotPolicy) (DependencySnapshotResult, error) {
	info, err := os.Lstat(modulesRoot)
	if errors.Is(err, fs.ErrNotExist) {
		return DependencySnapshotResult{}, nil
	}
	if err != nil {
		return DependencySnapshotResult{}, fmt.Errorf("inspect Gradle dependencies: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return DependencySnapshotResult{}, fmt.Errorf("Gradle dependency root must be a real directory")
	}
	base, err = filepath.Abs(strings.TrimSpace(base))
	if err != nil || strings.TrimSpace(base) == "" || runtimePathPart(runtimeID) == "" {
		return DependencySnapshotResult{}, fmt.Errorf("invalid Gradle dependency snapshot root")
	}

	usage, treeFingerprint, err := dependencyTreeState(modulesRoot)
	if err != nil {
		return DependencySnapshotResult{}, err
	}
	hash := sha256.Sum256([]byte("gradle\x00" + strings.TrimSpace(runtimeID) + "\x00" + treeFingerprint))
	revision := hex.EncodeToString(hash[:16])
	generation, err := GradleDependencyGenerationRoot(base, runtimeID, revision)
	if err != nil {
		return DependencySnapshotResult{}, err
	}
	runtimeRoot := filepath.Dir(filepath.Dir(generation))

	storeGate := snapshotStoreGate(base)
	storeGate.Lock()
	defer storeGate.Unlock()
	workspaceGate := snapshotWorkspaceGate(base, "gradle\x00"+strings.TrimSpace(runtimeID))
	workspaceGate.Lock()
	defer workspaceGate.Unlock()
	gate := snapshotGate(runtimeRoot)
	gate.mu.Lock()
	current := currentGradleDependencySnapshot(base, runtimeID)
	if current == generation {
		gate.mu.Unlock()
		return DependencySnapshotResult{Path: filepath.Join(generation, "modules-2"), Revision: revision, Size: usage.LogicalBytes}, nil
	}
	previousRevision := ""
	if current != "" {
		previousRevision = filepath.Base(current)
	}
	gate.mu.Unlock()

	incoming := usage
	if _, modules := gradleDependencySnapshot(generation); modules != "" {
		incoming = nodeSnapshotUsage{}
	}
	items, total, err := listGradleStoredGenerations(base)
	if err != nil {
		return DependencySnapshotResult{}, fmt.Errorf("inspect Gradle dependency storage: %w", err)
	}
	if err := reserveDependencySnapshotStorage(items, total, generation, incoming, policy, DefaultGradleDependencyStoreBytes); err != nil {
		return DependencySnapshotResult{}, err
	}

	gate.mu.Lock()
	defer gate.mu.Unlock()
	if currentGradleDependencySnapshot(base, runtimeID) == generation {
		return DependencySnapshotResult{Path: filepath.Join(generation, "modules-2"), Revision: revision, Size: usage.LogicalBytes}, nil
	}
	if _, modules := gradleDependencySnapshot(generation); modules == "" {
		if err := os.RemoveAll(generation); err != nil {
			return DependencySnapshotResult{}, fmt.Errorf("replace incomplete Gradle dependency generation: %w", err)
		}
		generations := filepath.Dir(generation)
		if err := os.MkdirAll(generations, 0700); err != nil {
			return DependencySnapshotResult{}, fmt.Errorf("create Gradle dependency generation root: %w", err)
		}
		staging, err := os.MkdirTemp(generations, ".publish-")
		if err != nil {
			return DependencySnapshotResult{}, fmt.Errorf("create Gradle dependency staging directory: %w", err)
		}
		defer os.RemoveAll(staging)
		if err := copyDependencyTree(modulesRoot, filepath.Join(staging, "modules-2"), usage, treeFingerprint); err != nil {
			return DependencySnapshotResult{}, fmt.Errorf("copy Gradle dependency snapshot: %w", err)
		}
		usageData, err := json.Marshal(usage)
		if err != nil {
			return DependencySnapshotResult{}, fmt.Errorf("encode Gradle dependency snapshot metadata: %w", err)
		}
		if err := safefile.WriteAtomic(staging, nodeSnapshotUsageFile, append(usageData, '\n'), 0600); err != nil {
			return DependencySnapshotResult{}, fmt.Errorf("write Gradle dependency snapshot metadata: %w", err)
		}
		if err := CompleteGradleDependencySnapshot(staging); err != nil {
			return DependencySnapshotResult{}, err
		}
		if err := os.Rename(staging, generation); err != nil {
			if _, modules := gradleDependencySnapshot(generation); modules == "" {
				return DependencySnapshotResult{}, fmt.Errorf("publish Gradle dependency snapshot: %w", err)
			}
		}
	}
	if err := ActivateGradleDependencySnapshot(base, runtimeID, revision); err != nil {
		return DependencySnapshotResult{}, err
	}
	pruneNodeDependencySnapshotsLocked(gate, filepath.Dir(generation), revision)
	return DependencySnapshotResult{
		Path: filepath.Join(generation, "modules-2"), Revision: revision,
		Size: usage.LogicalBytes, Changed: previousRevision != revision,
	}, nil
}

func listGradleStoredGenerations(base string) ([]nodeStoredGeneration, nodeSnapshotUsage, error) {
	gradleRoot := filepath.Join(base, "gradle")
	runtimes, err := os.ReadDir(gradleRoot)
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
		runtimeRoot := filepath.Join(gradleRoot, runtime.Name())
		currentRoot := currentGradleDependencySnapshot(base, runtime.Name())
		currentRevision := ""
		currentModTime := int64(0)
		if currentRoot != "" {
			currentRevision = filepath.Base(currentRoot)
			if marker, markerErr := os.Lstat(filepath.Join(runtimeRoot, GradleDependencyCurrentFile)); markerErr == nil && marker.Mode().IsRegular() {
				currentModTime = marker.ModTime().UnixNano()
			}
		}
		generations, readErr := os.ReadDir(filepath.Join(runtimeRoot, "generations"))
		if errors.Is(readErr, fs.ErrNotExist) {
			continue
		}
		if readErr != nil {
			return nil, nodeSnapshotUsage{}, readErr
		}
		for _, entry := range generations {
			if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !validGradleGeneration(entry.Name()) {
				continue
			}
			generation := filepath.Join(runtimeRoot, "generations", entry.Name())
			usage, usageErr := readGradleSnapshotUsage(generation)
			if usageErr != nil {
				return nil, nodeSnapshotUsage{}, usageErr
			}
			info, infoErr := entry.Info()
			if infoErr != nil {
				continue
			}
			isCurrent := entry.Name() == currentRevision
			modTime := info.ModTime().UnixNano()
			if isCurrent && currentModTime > modTime {
				modTime = currentModTime
			}
			total = total.add(usage)
			items = append(items, nodeStoredGeneration{
				path: generation, workspaceRoot: runtimeRoot, revision: entry.Name(), usage: usage,
				modTime: modTime, current: isCurrent,
			})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].modTime < items[j].modTime })
	return items, total, nil
}

func readGradleSnapshotUsage(generation string) (nodeSnapshotUsage, error) {
	data, err := safefile.ReadSmallRegular(generation, nodeSnapshotUsageFile, nodeSnapshotMetadataMaxBytes)
	if err == nil {
		var usage nodeSnapshotUsage
		if jsonErr := json.Unmarshal(data, &usage); jsonErr == nil && validNodeSnapshotUsage(usage) {
			return usage, nil
		}
	}
	modules := filepath.Join(generation, "modules-2")
	if info, statErr := os.Lstat(modules); statErr == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
		usage, _, scanErr := dependencyTreeState(modules)
		return usage, scanErr
	}
	usage, _, scanErr := dependencyTreeState(generation)
	return usage, scanErr
}
