package lsp

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNumericContainerUser(t *testing.T) {
	if got := numericContainerUser("1001", "1002"); got != "1001:1002" {
		t.Fatalf("unexpected container user: %q", got)
	}
	for _, invalid := range [][2]string{{"", "1"}, {"-1", "1"}, {"root", "1"}, {"1", "staff"}} {
		if got := numericContainerUser(invalid[0], invalid[1]); got != "" {
			t.Fatalf("accepted invalid uid/gid %q/%q: %q", invalid[0], invalid[1], got)
		}
	}
}

func TestDockerEnvironmentUsesAnalysisCacheHome(t *testing.T) {
	spec := LaunchSpec{Mode: ModeStandard, CacheDir: t.TempDir(), Server: ServerSpec{}}
	dockerEnv := commandEnvironment(spec, true)
	if dockerEnv["HOME"] != "/analysis-cache/home" {
		t.Fatalf("Docker HOME is not writable analysis cache: %+v", dockerEnv)
	}
	if _, exists := commandEnvironment(spec, false)["HOME"]; exists {
		t.Fatal("host language server HOME was unexpectedly replaced")
	}
}

func TestValidateDockerMountSourceRejectsReplacementLink(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	outside := filepath.Join(root, "outside")
	if err := os.Mkdir(source, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(outside, 0755); err != nil {
		t.Fatal(err)
	}
	if resolved, err := validateDockerMountSource(source); err != nil || resolved != source {
		t.Fatalf("real source resolved=%q err=%v", resolved, err)
	}
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, source); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := validateDockerMountSource(source); err == nil {
		t.Fatal("replacement symlink was accepted as a Docker mount")
	}
}
