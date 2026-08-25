package personalcache

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDependencyFingerprintRequiresRealWorkspace(t *testing.T) {
	if _, err := DependencyFingerprint("", "python", nil); err == nil {
		t.Fatal("empty workspace root was accepted")
	}
	if _, err := DependencyFingerprint(filepath.Join(t.TempDir(), "missing"), "python", nil); err == nil {
		t.Fatal("missing workspace root was accepted")
	}
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "workspace-link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	if _, err := DependencyFingerprint(link, "python", nil); err == nil {
		t.Fatal("symlinked workspace root was accepted")
	}
}

func TestDependencyFingerprintNormalizesAndBoundsSetupCommands(t *testing.T) {
	root := t.TempDir()
	empty, err := DependencyFingerprint(root, "python", nil)
	if err != nil {
		t.Fatal(err)
	}
	withBlanks, err := DependencyFingerprint(root, "python", []string{" ", "\t"})
	if err != nil || withBlanks.Digest != empty.Digest || withBlanks.Source != empty.Source || len(withBlanks.Manifests) != len(empty.Manifests) {
		t.Fatalf("blank setup commands changed fingerprint: empty=%+v blanks=%+v err=%v", empty, withBlanks, err)
	}
	if _, err := DependencyFingerprint(root, "python", make([]string, maxSetupCommands+1)); err == nil {
		t.Fatal("too many setup commands were accepted")
	}
	if _, err := DependencyFingerprint(root, "python", []string{strings.Repeat("x", maxSetupCommandBytes+1)}); err == nil {
		t.Fatal("oversized setup command was accepted")
	}
	if _, err := DependencyFingerprint(root, "python", []string{"pip install demo\nwhoami"}); err == nil {
		t.Fatal("setup command with control characters was accepted")
	}
}

func TestDependencyFingerprintChangesWithLockContents(t *testing.T) {
	root := t.TempDir()
	lock := filepath.Join(root, "requirements.txt")
	if err := os.WriteFile(lock, []byte("numpy==2.1.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	first, err := DependencyFingerprint(root, "python", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lock, []byte("numpy==2.2.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	second, err := DependencyFingerprint(root, "python", nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.Digest == second.Digest || first.Source != "manifest" || second.Source != "manifest" {
		t.Fatalf("manifest change did not isolate cache: first=%+v second=%+v", first, second)
	}
}

func TestDependencyFingerprintIncludesReferencedAndCommonManifestFiles(t *testing.T) {
	root := t.TempDir()
	custom := filepath.Join(root, "deps.txt")
	if err := os.WriteFile(custom, []byte("numpy==2.1.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	first, err := DependencyFingerprint(root, "python", []string{"python -m pip install -r deps.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Manifests) != 1 || first.Manifests[0] != "deps.txt" {
		t.Fatalf("referenced dependency file was not fingerprinted: %+v", first)
	}
	if err := os.WriteFile(custom, []byte("numpy==2.2.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	second, err := DependencyFingerprint(root, "python", []string{"python -m pip install -r deps.txt"})
	if err != nil || second.Digest == first.Digest {
		t.Fatalf("referenced dependency change did not isolate digest: first=%+v second=%+v err=%v", first, second, err)
	}
	if err := os.WriteFile(filepath.Join(root, "uv.lock"), []byte("version = 1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	locked, err := DependencyFingerprint(root, "python", nil)
	if err != nil || locked.Source != "lock" {
		t.Fatalf("uv.lock was not treated as a lock file: %+v err=%v", locked, err)
	}
}

func TestDependencyFingerprintIncludesRuntimeImageIdentity(t *testing.T) {
	root := t.TempDir()
	first, err := DependencyFingerprintWithRuntime(root, "python", nil, "python:3.11\x00sha256:first")
	if err != nil {
		t.Fatal(err)
	}
	second, err := DependencyFingerprintWithRuntime(root, "python", nil, "python:3.11\x00sha256:second")
	if err != nil || first.Digest == second.Digest {
		t.Fatalf("runtime image identity did not isolate dependency cache: first=%+v second=%+v err=%v", first, second, err)
	}
}

func TestDependencyFingerprintRejectsOversizedManifestBeforeReadingIt(t *testing.T) {
	root := t.TempDir()
	manifest := filepath.Join(root, "requirements.txt")
	file, err := os.Create(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxFingerprintBytes + 1); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := DependencyFingerprint(root, "python", nil); err == nil {
		t.Fatal("oversized manifest was accepted")
	}
}

func TestDependencyFingerprintFromSnapshotUsesReviewedBytes(t *testing.T) {
	first, err := DependencyFingerprintFromSnapshot("python", nil, "python:3.11\x00sha256:image", []ManifestSnapshot{{
		Path: "requirements.txt", Content: []byte("numpy==2.1.0\n"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	second, err := DependencyFingerprintFromSnapshot("python", nil, "python:3.11\x00sha256:image", []ManifestSnapshot{{
		Path: "requirements.txt", Content: []byte("numpy==2.2.0\n"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if first.Digest == second.Digest || first.Source != "manifest" || len(first.Manifests) != 1 || first.Manifests[0] != "requirements.txt" {
		t.Fatalf("reviewed manifest bytes did not define the dependency identity: first=%+v second=%+v", first, second)
	}
	if _, err := DependencyFingerprintFromSnapshot("python", nil, "", []ManifestSnapshot{{Path: "../requirements.txt", Content: []byte("x")}}); err == nil {
		t.Fatal("escaping snapshot path was accepted")
	}
	if _, err := DependencyFingerprintFromSnapshot("python", nil, "", []ManifestSnapshot{
		{Path: "requirements.txt", Content: []byte("x")},
		{Path: "requirements.txt", Content: []byte("y")},
	}); err == nil {
		t.Fatal("duplicate snapshot path was accepted")
	}
}

func TestNodeDependencyFingerprintUsesOnlyTheManagedRootPackage(t *testing.T) {
	root := t.TempDir()
	packageJSON := []byte(`{"name":"app","dependencies":{"lodash":"4.17.21"}}`)
	lockfile := []byte(`{"lockfileVersion":3,"packages":{"node_modules/lodash":{"version":"4.17.21"}}}`)
	for relative, content := range map[string][]byte{
		"package.json":          packageJSON,
		"package-lock.json":     lockfile,
		"examples/package.json": []byte(`{"name":"unrelated-example","dependencies":{"react":"19.0.0"}}`),
	} {
		path := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	runtimeFingerprint := "node:20\x00node:20-slim\x00sha256:image"
	fromWorkspace, err := DependencyFingerprintWithRuntime(root, "node", nil, runtimeFingerprint)
	if err != nil {
		t.Fatal(err)
	}
	fromReviewedPlan, err := DependencyFingerprintFromSnapshot("node", nil, runtimeFingerprint, []ManifestSnapshot{
		{Path: "package.json", Content: packageJSON},
		{Path: "package-lock.json", Content: lockfile, Lock: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if fromWorkspace.Digest != fromReviewedPlan.Digest || strings.Join(fromWorkspace.Manifests, ",") != "package-lock.json,package.json" {
		t.Fatalf("Node plan and consumer fingerprints diverged: workspace=%+v reviewed=%+v", fromWorkspace, fromReviewedPlan)
	}
	if _, err := DependencyFingerprintFromSnapshot("node", nil, runtimeFingerprint, []ManifestSnapshot{{
		Path: "examples/package.json", Content: []byte(`{"name":"example"}`),
	}}); err == nil {
		t.Fatal("nested Node package snapshot was accepted")
	}
}

func TestNodeMaterializationPolicyKeepsWorkspaceAndSnapshotIdentityAligned(t *testing.T) {
	root := t.TempDir()
	packageJSON := []byte(`{"name":"app","dependencies":{"lodash":"4.17.21"}}`)
	lockfile := []byte(`{"lockfileVersion":3,"packages":{"node_modules/lodash":{"version":"4.17.21"}}}`)
	for relative, content := range map[string][]byte{
		"package.json":      packageJSON,
		"package-lock.json": lockfile,
	} {
		if err := os.WriteFile(filepath.Join(root, relative), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	runtimeFingerprint := "node:20\x00node:20-slim\x00sha256:image"
	snapshots := []ManifestSnapshot{
		{Path: "package.json", Content: packageJSON},
		{Path: "package-lock.json", Content: lockfile},
	}
	var digests []string
	for _, installScripts := range []bool{true, false} {
		policy := NodeDependencyMaterializationPolicy(installScripts, "10.32.1")
		if !strings.Contains(policy, ";pnpm=10.32.1") {
			t.Fatalf("Node materialization policy omitted pnpm pin: %q", policy)
		}
		workspaceFingerprint, err := DependencyFingerprintWithRuntimeAndPolicy(root, "node", nil, runtimeFingerprint, policy)
		if err != nil {
			t.Fatal(err)
		}
		snapshotFingerprint, err := DependencyFingerprintFromSnapshotWithPolicy("node", nil, runtimeFingerprint, policy, snapshots)
		if err != nil {
			t.Fatal(err)
		}
		if workspaceFingerprint.Digest != snapshotFingerprint.Digest {
			t.Fatalf("Node workspace and reviewed snapshot diverged for policy %q: workspace=%+v snapshot=%+v", policy, workspaceFingerprint, snapshotFingerprint)
		}
		digests = append(digests, workspaceFingerprint.Digest)
	}
	if digests[0] == digests[1] {
		t.Fatalf("Node install-scripts policy did not isolate generations: %v", digests)
	}
	if got := nodePackageManagerFromRootManifests([]string{"package.json", "package-lock.json"}); got != "npm" {
		t.Fatalf("npm manager identity = %q", got)
	}
	if got := nodePackageManagerFromRootManifests([]string{"package.json", "pnpm-lock.yaml"}); got != "pnpm" {
		t.Fatalf("pnpm manager identity = %q", got)
	}
	if got := nodeManagerMaterializationPolicy(NodeDependencyMaterializationPolicy(true, "10.32.1"), "npm"); strings.Contains(got, "pnpm=") {
		t.Fatalf("npm materialization identity retained unrelated pnpm pin: %q", got)
	}
	if _, err := DependencyFingerprintWithRuntimeAndPolicy(root, "node", nil, runtimeFingerprint, strings.Repeat("x", maxMaterializationPolicyBytes+1)); err == nil {
		t.Fatal("oversized Node materialization policy was accepted")
	}
}

func TestPNPMVersionPinIsolatesOnlyPNPMDependencyGenerations(t *testing.T) {
	runtimeFingerprint := "node:20\x00node:20-slim\x00sha256:image"
	packageJSON := []byte(`{"name":"app","dependencies":{"lodash":"4.17.21"}}`)
	pnpmLock := []byte("lockfileVersion: '9.0'\n")
	pnpmSnapshots := []ManifestSnapshot{
		{Path: "package.json", Content: packageJSON},
		{Path: "pnpm-lock.yaml", Content: pnpmLock},
	}
	pnpmCurrent, err := DependencyFingerprintFromSnapshotWithPolicy("node", nil, runtimeFingerprint, NodeDependencyMaterializationPolicy(true, "10.32.1"), pnpmSnapshots)
	if err != nil {
		t.Fatal(err)
	}
	pnpmPrevious, err := DependencyFingerprintFromSnapshotWithPolicy("node", nil, runtimeFingerprint, NodeDependencyMaterializationPolicy(true, "10.31.0"), pnpmSnapshots)
	if err != nil {
		t.Fatal(err)
	}
	if pnpmCurrent.Digest == pnpmPrevious.Digest {
		t.Fatalf("pnpm version pin reused dependency generation %s", pnpmCurrent.Digest)
	}

	npmLock := []byte(`{"lockfileVersion":3,"packages":{}}`)
	npmSnapshots := []ManifestSnapshot{
		{Path: "package.json", Content: packageJSON},
		{Path: "package-lock.json", Content: npmLock},
	}
	npmCurrent, err := DependencyFingerprintFromSnapshotWithPolicy("node", nil, runtimeFingerprint, NodeDependencyMaterializationPolicy(true, "10.32.1"), npmSnapshots)
	if err != nil {
		t.Fatal(err)
	}
	npmPrevious, err := DependencyFingerprintFromSnapshotWithPolicy("node", nil, runtimeFingerprint, NodeDependencyMaterializationPolicy(true, "10.31.0"), npmSnapshots)
	if err != nil {
		t.Fatal(err)
	}
	if npmCurrent.Digest != npmPrevious.Digest {
		t.Fatalf("npm generation changed with unrelated pnpm pin: current=%s previous=%s", npmCurrent.Digest, npmPrevious.Digest)
	}
}

func TestPythonFingerprintRemainsCompatibleWithNodeMaterializationPolicy(t *testing.T) {
	root := t.TempDir()
	content := []byte("numpy==2.1.0\n")
	if err := os.WriteFile(filepath.Join(root, "requirements.txt"), content, 0600); err != nil {
		t.Fatal(err)
	}
	runtimeFingerprint := "python:3.11\x00sha256:image"
	legacyWorkspace, err := DependencyFingerprintWithRuntime(root, "python", nil, runtimeFingerprint)
	if err != nil {
		t.Fatal(err)
	}
	policyWorkspace, err := DependencyFingerprintWithRuntimeAndPolicy(root, "python", nil, runtimeFingerprint, NodeDependencyMaterializationPolicy(false, "10.32.1"))
	if err != nil {
		t.Fatal(err)
	}
	legacySnapshot, err := DependencyFingerprintFromSnapshot("python", nil, runtimeFingerprint, []ManifestSnapshot{{Path: "requirements.txt", Content: content}})
	if err != nil {
		t.Fatal(err)
	}
	policySnapshot, err := DependencyFingerprintFromSnapshotWithPolicy("python", nil, runtimeFingerprint, NodeDependencyMaterializationPolicy(false, "10.32.1"), []ManifestSnapshot{{Path: "requirements.txt", Content: content}})
	if err != nil {
		t.Fatal(err)
	}
	const compatibleDigest = "eebcdc0bcc8e23a7d69750143272efd3"
	for name, fingerprint := range map[string]Fingerprint{
		"legacy workspace": legacyWorkspace,
		"policy workspace": policyWorkspace,
		"legacy snapshot":  legacySnapshot,
		"policy snapshot":  policySnapshot,
	} {
		if fingerprint.Digest != compatibleDigest {
			t.Fatalf("%s Python digest changed: got %s want %s", name, fingerprint.Digest, compatibleDigest)
		}
	}
}
