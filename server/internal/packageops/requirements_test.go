package packageops

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bobocloud-server/internal/model"
)

func TestPlanPythonRequirementsCreatesRootManifestWithMissingOldHash(t *testing.T) {
	root := t.TempDir()
	plan, err := PlanPythonRequirements(root, "", nil, []model.ProjectPackageChange{{Operation: "add", Name: "Requests", Version: "2.32.4"}})
	if err != nil {
		t.Fatal(err)
	}
	change := plan.LocalChange
	if change.Path != "requirements.txt" || change.OldExists || change.OldSHA256 != "" || change.NewContent != "requests==2.32.4\n" {
		t.Fatalf("new manifest plan = %+v", change)
	}
	hash := sha256.Sum256([]byte(change.NewContent))
	if change.NewSHA256 != hex.EncodeToString(hash[:]) {
		t.Fatalf("new manifest hash = %q", change.NewSHA256)
	}
}

func TestPlanPythonRequirementsRemovalPreservesUnrelatedLayout(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "requirements.txt")
	original := "# core\n\nnumpy==2.1.0\n\nrequests==2.32.4  # transport\n\n"
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPythonRequirements(root, "", []string{"requirements.txt"}, []model.ProjectPackageChange{{Operation: "remove", Name: "numpy"}})
	if err != nil {
		t.Fatal(err)
	}
	want := "# core\n\n\nrequests==2.32.4  # transport\n\n"
	if plan.LocalChange.NewContent != want {
		t.Fatalf("layout was not preserved:\nwant %q\n got %q", want, plan.LocalChange.NewContent)
	}
	if !plan.LocalChange.OldExists || plan.LocalChange.OldSHA256 == "" {
		t.Fatalf("existing manifest identity missing: %+v", plan.LocalChange)
	}
}

func TestPlanPythonRequirementsRejectsEnvironmentMarkersAnywhere(t *testing.T) {
	for _, fixture := range []struct {
		name    string
		content string
		change  model.ProjectPackageChange
	}{
		{
			name:    "target line",
			content: "Requests[security]>=2 ; python_version >= '3.9' # keep\n",
			change:  model.ProjectPackageChange{Operation: "update", Name: "requests", Version: "2.32.4", Features: []string{"security"}},
		},
		{
			name:    "unrelated line",
			content: "requests==2.32.4\ncolorama==0.4.6 ; sys_platform == 'win32'\n",
			change:  model.ProjectPackageChange{Operation: "add", Name: "numpy", Version: "2.1.0"},
		},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "requirements.txt")
			if err := os.WriteFile(path, []byte(fixture.content), 0600); err != nil {
				t.Fatal(err)
			}
			_, err := PlanPythonRequirements(root, "requirements.txt", []string{"requirements.txt"}, []model.ProjectPackageChange{fixture.change})
			if err == nil || !strings.Contains(err.Error(), "environment-marked requirements") {
				t.Fatalf("environment marker was accepted: %v", err)
			}
			if data, readErr := os.ReadFile(path); readErr != nil || string(data) != fixture.content {
				t.Fatalf("source manifest changed: data=%q err=%v", data, readErr)
			}
		})
	}
}

func TestPlanPythonRequirementsAllowsSemicolonInComment(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "requirements.txt"), []byte("requests==2.32.4 # retained; ordinary comment\n"), 0600); err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPythonRequirements(root, "requirements.txt", []string{"requirements.txt"}, []model.ProjectPackageChange{{Operation: "update", Name: "requests", Version: "2.32.5"}})
	if err != nil {
		t.Fatal(err)
	}
	want := "requests==2.32.5 # retained; ordinary comment\n"
	if plan.LocalChange.NewContent != want {
		t.Fatalf("updated requirement = %q, want %q", plan.LocalChange.NewContent, want)
	}
}

func TestPlanPythonRequirementsAllowsExplicitMissingPackageReinstall(t *testing.T) {
	root := t.TempDir()
	content := "# keep\n\nnumpy==2.1.0 # pinned\n"
	if err := os.WriteFile(filepath.Join(root, "requirements.txt"), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	change := []model.ProjectPackageChange{{Operation: "update", Name: "NumPy", Version: "2.1.0"}}
	if _, err := PlanPythonRequirements(root, "requirements.txt", []string{"requirements.txt"}, change); err == nil || !strings.Contains(err.Error(), "do not modify") {
		t.Fatalf("ordinary same-version update was not a no-op: %v", err)
	}
	plan, err := PlanPythonRequirementsWithOptions(root, "requirements.txt", []string{"requirements.txt"}, change, RequirementsPlanOptions{AllowReinstall: map[string]bool{"numpy": true}})
	if err != nil {
		t.Fatal(err)
	}
	if !plan.Reinstall || plan.LocalChange.Path != "" || plan.ManifestBinding.Path != "requirements.txt" || plan.ManifestBinding.SHA256 == "" || plan.ManifestContent != content || len(plan.Changes) != 1 || plan.Changes[0].Operation != "update" {
		t.Fatalf("reinstall plan = %+v", plan)
	}
}

func TestPlanPythonRequirementsRequiresSelectionForAmbiguousManifests(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"requirements-dev.txt", "requirements-prod.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("requests==2.32.4\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	_, err := PlanPythonRequirements(root, "", []string{"requirements-dev.txt", "requirements-prod.txt"}, []model.ProjectPackageChange{{Operation: "add", Name: "numpy", Version: "2.1.0"}})
	if err == nil || !strings.Contains(err.Error(), "manifestPath is required") {
		t.Fatalf("ambiguous manifests were accepted: %v", err)
	}
	_, err = PlanPythonRequirements(root, "nested/requirements.txt", nil, []model.ProjectPackageChange{{Operation: "add", Name: "numpy", Version: "2.1.0"}})
	if err == nil || !strings.Contains(err.Error(), "only the root") {
		t.Fatalf("nested implicit manifest creation was accepted: %v", err)
	}
}

func TestPlanPythonRequirementsRejectsHashLockedAndContinuedDeclarations(t *testing.T) {
	for _, fixture := range []struct {
		name    string
		content string
		change  model.ProjectPackageChange
		want    string
	}{
		{
			name: "hash locked", content: "requests==2.32.4 \\\n    --hash=sha256:abcdef\n",
			change: model.ProjectPackageChange{Operation: "update", Name: "requests", Version: "2.32.5"}, want: "hash-locked",
		},
		{
			name: "continued without hash", content: "requests==2.32.4 \\\n    ; python_version >= '3.10'\n",
			change: model.ProjectPackageChange{Operation: "update", Name: "requests", Version: "2.32.5"}, want: "continued requirements",
		},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "requirements.txt")
			if err := os.WriteFile(path, []byte(fixture.content), 0600); err != nil {
				t.Fatal(err)
			}
			_, err := PlanPythonRequirements(root, "requirements.txt", []string{"requirements.txt"}, []model.ProjectPackageChange{fixture.change})
			if err == nil || !strings.Contains(err.Error(), fixture.want) {
				t.Fatalf("unsafe lock edit was accepted: %v", err)
			}
			data, readErr := os.ReadFile(path)
			if readErr != nil || string(data) != fixture.content {
				t.Fatalf("source manifest changed: %q %v", data, readErr)
			}
		})
	}
}

func TestPlanPythonRequirementsRequiresExplicitExtrasOnUpdate(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "requirements.txt")
	if err := os.WriteFile(path, []byte("requests[security]==2.32.4\n"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := PlanPythonRequirements(root, "requirements.txt", []string{"requirements.txt"}, []model.ProjectPackageChange{{Operation: "update", Name: "requests", Version: "2.32.5"}})
	if err == nil || !strings.Contains(err.Error(), "choose them explicitly") {
		t.Fatalf("extras were silently discarded: %v", err)
	}
}

func TestPlanPythonRequirementsRejectsLinkedWorkspaceComponents(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	if err := os.Mkdir(outside, 0700); err != nil {
		t.Fatal(err)
	}
	outsideManifest := filepath.Join(outside, "requirements.txt")
	if err := os.WriteFile(outsideManifest, []byte("sentinel-secret==1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	change := []model.ProjectPackageChange{{Operation: "add", Name: "numpy", Version: "2.1.0"}}

	t.Run("workspace root", func(t *testing.T) {
		linkedRoot := filepath.Join(base, "linked-root")
		if err := os.Symlink(outside, linkedRoot); err != nil {
			t.Skipf("directory symlink unavailable: %v", err)
		}
		if _, err := PlanPythonRequirements(linkedRoot, "requirements.txt", []string{"requirements.txt"}, change); err == nil {
			t.Fatal("linked workspace root was accepted")
		}
	})

	t.Run("parent directory", func(t *testing.T) {
		root := filepath.Join(base, "parent-workspace")
		if err := os.Mkdir(root, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
			t.Skipf("directory symlink unavailable: %v", err)
		}
		if _, err := PlanPythonRequirements(root, "linked/requirements.txt", nil, change); err == nil {
			t.Fatal("linked requirements parent was accepted")
		}
	})

	t.Run("target file", func(t *testing.T) {
		root := filepath.Join(base, "target-workspace")
		if err := os.Mkdir(root, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outsideManifest, filepath.Join(root, "requirements.txt")); err != nil {
			t.Skipf("file symlink unavailable: %v", err)
		}
		if _, err := PlanPythonRequirements(root, "requirements.txt", []string{"requirements.txt"}, change); err == nil {
			t.Fatal("linked requirements target was accepted")
		}
	})

	t.Run("real nested path", func(t *testing.T) {
		root := filepath.Join(base, "real-workspace")
		nested := filepath.Join(root, "nested")
		if err := os.MkdirAll(nested, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(nested, "requirements.txt"), []byte("requests==2.32.4\n"), 0600); err != nil {
			t.Fatal(err)
		}
		plan, err := PlanPythonRequirements(root, "nested/requirements.txt", []string{"nested/requirements.txt"}, change)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(plan.LocalChange.NewContent, "numpy==2.1.0") {
			t.Fatalf("real nested manifest was not read: %+v", plan.LocalChange)
		}
	})
}

func TestPlanPythonRequirementsRejectsNonSimpleFiles(t *testing.T) {
	fixtures := []struct {
		name    string
		content string
	}{
		{name: "short requirement include", content: "-r base.txt\n"},
		{name: "long requirement include", content: "--requirement=base.txt\n"},
		{name: "short constraint include", content: "-c constraints.txt\n"},
		{name: "long constraint include", content: "--constraint constraints.txt\n"},
		{name: "index override", content: "--index-url https://example.invalid/simple\n"},
		{name: "extra index", content: "--extra-index-url https://example.invalid/simple\n"},
		{name: "find links", content: "--find-links ./wheels\n"},
		{name: "trusted host", content: "--trusted-host example.invalid\n"},
		{name: "editable", content: "-e git+https://example.invalid/repository.git#egg=demo\n"},
		{name: "direct reference", content: "demo @ https://example.invalid/demo.whl\n"},
		{name: "bare URL", content: "https://example.invalid/demo.whl\n"},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "requirements.txt")
			if err := os.WriteFile(path, []byte(fixture.content), 0600); err != nil {
				t.Fatal(err)
			}
			_, err := PlanPythonRequirements(root, "requirements.txt", []string{"requirements.txt"}, []model.ProjectPackageChange{{Operation: "add", Name: "numpy", Version: "2.1.0"}})
			if err == nil || !strings.Contains(err.Error(), "read-only") {
				t.Fatalf("non-simple requirements were accepted: %v", err)
			}
			if data, readErr := os.ReadFile(path); readErr != nil || string(data) != fixture.content {
				t.Fatalf("source manifest changed: data=%q err=%v", data, readErr)
			}
		})
	}
}
