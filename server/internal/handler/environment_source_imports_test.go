package handler

import (
	"os"
	"path/filepath"
	"testing"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
)

func TestParsePythonImportsIgnoresStringsCommentsStdlibAndLocalModules(t *testing.T) {
	root := t.TempDir()
	source := `
"""import hidden_docstring"""
# import hidden_comment
import os, numpy as np
from matplotlib.animation import FuncAnimation
value = "import hidden_string"
from . import relative_module
import local_helper
`
	if err := os.WriteFile(filepath.Join(root, "main.py"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "local_helper.py"), []byte("value = 1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	manifests, packages, _, err := inspectPythonSourceDependencies(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifests) != 1 || manifests[0].Path != "main.py" || manifests[0].Kind != "source-imports" {
		t.Fatalf("manifests = %+v", manifests)
	}
	if len(packages) != 2 || packages[0].Name != "matplotlib" || packages[1].Name != "numpy" {
		t.Fatalf("packages = %+v", packages)
	}
}

func TestResolvePythonSourceDistributionUsesExactImportOwnership(t *testing.T) {
	items := []model.ProjectEnvironmentPackage{{Name: "PIL", Scope: "runtime", Source: "main.py", Trust: "source-static"}}
	inventory := []personalcache.InventoryPackage{{Name: "pillow", Version: "11.0", Imports: []string{"PIL"}}}
	resolved := resolvePythonSourceDistributions(items, inventory)
	if len(resolved) != 1 || resolved[0].Name != "pillow" || resolved[0].Trust != "source-static" {
		t.Fatalf("resolved = %+v", resolved)
	}
}

func TestResolvePythonSourceDistributionKeepsAmbiguousNamespaceUnknown(t *testing.T) {
	items := []model.ProjectEnvironmentPackage{{Name: "google", Scope: "runtime", Source: "main.py", Trust: "source-static"}}
	inventory := []personalcache.InventoryPackage{
		{Name: "google-alpha", Imports: []string{"google"}},
		{Name: "google-beta", Imports: []string{"google"}},
	}
	resolved := resolvePythonSourceDistributions(items, inventory)
	classified := classifyEnvironmentPackages(resolved, []model.ProjectEnvironmentPackage{{Name: "google-alpha", Version: "1"}, {Name: "google-beta", Version: "2"}}, "python", true)
	if len(classified.Missing) != 0 || len(classified.Unknown) != 1 || classified.Unknown[0].Trust != "source-ambiguous" {
		t.Fatalf("classified = %+v", classified)
	}
}
