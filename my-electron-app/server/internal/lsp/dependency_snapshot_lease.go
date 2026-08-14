package lsp

import (
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type dependencySnapshotRef struct {
	gate       *dependencySnapshotGate
	generation string
}

func managedSnapshotLocation(path string) (root, generation string, ok bool) {
	path = filepath.Clean(path)
	base := filepath.Base(path)
	if base != "node_modules" && base != "modules-2" {
		return "", "", false
	}
	generation = filepath.Dir(path)
	revision := filepath.Base(generation)
	if len(revision) != 32 || filepath.Base(filepath.Dir(generation)) != "generations" {
		return "", "", false
	}
	if _, err := hex.DecodeString(revision); err != nil {
		return "", "", false
	}
	root = filepath.Dir(filepath.Dir(generation))
	return root, generation, true
}

// acquireDependencySnapshotMounts pins immutable published generations before
// a process starts. Its release callback must run only after Process.Wait.
func acquireDependencySnapshotMounts(view AnalysisDependencyView) (func(), error) {
	refs := make([]dependencySnapshotRef, 0, 1)
	for _, mount := range view.Mounts {
		if !mount.Managed {
			continue
		}
		root, generation, ok := managedSnapshotLocation(mount.HostPath)
		if !ok {
			return nil, fmt.Errorf("invalid managed dependency snapshot path")
		}
		gate := snapshotGate(root)
		gate.mu.Lock()
		info, err := os.Lstat(mount.HostPath)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			gate.mu.Unlock()
			for _, ref := range refs {
				releaseDependencySnapshotRef(ref)
			}
			return nil, fmt.Errorf("managed dependency snapshot is no longer available")
		}
		generation = filepath.Clean(generation)
		gate.refs[generation]++
		gate.mu.Unlock()
		refs = append(refs, dependencySnapshotRef{gate: gate, generation: generation})
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			for _, ref := range refs {
				releaseDependencySnapshotRef(ref)
			}
		})
	}, nil
}

func releaseDependencySnapshotRef(ref dependencySnapshotRef) {
	ref.gate.mu.Lock()
	if ref.gate.refs[ref.generation] > 1 {
		ref.gate.refs[ref.generation]--
	} else {
		delete(ref.gate.refs, ref.generation)
	}
	ref.gate.mu.Unlock()
}

func StableWorkspaceIdentity(userID, teamID, projectID, branch, folderKey string) string {
	if strings.TrimSpace(teamID) != "" {
		return strings.Join([]string{"team", teamID, "project", projectID, "branch", branch}, "\x00")
	}
	return strings.Join([]string{"user", userID, "folder", folderKey}, "\x00")
}
