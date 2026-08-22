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
