package packageops

import (
	"encoding/json"
	"strings"
	"testing"

	"bobocloud-server/internal/model"
)

func TestPlanNodePackageJSONAddsRuntimeDependencyAndPreservesRootFields(t *testing.T) {
	original := "{\n  \"name\": \"demo\",\n  \"private\": true,\n  \"scripts\": {\"start\": \"node index.js\"}\n}\n"
	plan, err := PlanNodePackageJSON("", []byte(original), nil, []model.ProjectPackageChange{{Operation: "add", Name: "express", Version: "5.1.0"}})
	if err != nil {
		t.Fatal(err)
	}
	if plan.ManagerHint.Manager != "npm" || plan.ManagerHint.Evidence != "default" {
		t.Fatalf("manager hint = %+v", plan.ManagerHint)
	}
	if plan.LocalChange.Path != "package.json" || !plan.LocalChange.OldExists || plan.LocalChange.OldSHA256 == "" || plan.LocalChange.NewSHA256 == "" {
		t.Fatalf("local change identity = %+v", plan.LocalChange)
	}
	if plan.LocalChange.NewSHA256 != plan.ManifestBinding.SHA256 || plan.ManifestContent != plan.LocalChange.NewContent {
		t.Fatalf("manifest identities diverged: plan=%+v", plan)
	}
	if !strings.Contains(plan.ManifestContent, "  \"scripts\": {\"start\": \"node index.js\"},\n  \"dependencies\": {\n    \"express\": \"5.1.0\"\n  }\n") {
		t.Fatalf("root layout or unknown fields changed unexpectedly:\n%s", plan.ManifestContent)
	}
	assertNodeDependency(t, plan.ManifestContent, "dependencies", "express", "5.1.0")
}

func TestPlanNodePackageJSONUpdatesDevDependencyWithoutMovingItsScope(t *testing.T) {
	original := "{\r\n    \"name\": \"demo\",\r\n    \"custom\": 1e3,\r\n    \"devDependencies\": {\r\n        \"eslint\" : \"^8.0.0\",\r\n        \"typescript\" : \"5.7.2\"\r\n    }\r\n}\r\n"
	plan, err := PlanNodePackageJSON("package.json", []byte(original), []string{"package-lock.json"}, []model.ProjectPackageChange{{Operation: "update", Name: "eslint", Version: "9.22.0"}})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Changes[0].Scope != "dev" {
		t.Fatalf("updated scope = %q, want dev", plan.Changes[0].Scope)
	}
	if plan.ManagerHint != (NodePackageManagerHint{Manager: "npm", Evidence: "lockfile"}) {
		t.Fatalf("manager hint = %+v", plan.ManagerHint)
	}
	if !strings.Contains(plan.ManifestContent, "\"custom\": 1e3") || !strings.Contains(plan.ManifestContent, "\r\n") || strings.Contains(strings.ReplaceAll(plan.ManifestContent, "\r\n", ""), "\n") {
		t.Fatalf("root values or CRLF layout changed unexpectedly:\n%q", plan.ManifestContent)
	}
	assertNodeDependency(t, plan.ManifestContent, "devDependencies", "eslint", "9.22.0")
	assertNodeDependency(t, plan.ManifestContent, "devDependencies", "typescript", "5.7.2")
}

func TestPlanNodePackageJSONMovesDependencyToOptionalScope(t *testing.T) {
	original := `{"name":"demo","dependencies":{"fsevents":"2.3.2","chalk":"5.4.1"}}`
	plan, err := PlanNodePackageJSON("package.json", []byte(original), []string{"pnpm-lock.yaml"}, []model.ProjectPackageChange{{Operation: "update", Name: "fsevents", Version: "2.3.3", Scope: "optional"}})
	if err != nil {
		t.Fatal(err)
	}
	if plan.ManagerHint.Manager != "pnpm" || plan.Changes[0].Scope != "optional" {
		t.Fatalf("plan metadata = %+v", plan)
	}
	assertNodeDependencyMissing(t, plan.ManifestContent, "dependencies", "fsevents")
	assertNodeDependency(t, plan.ManifestContent, "dependencies", "chalk", "5.4.1")
	assertNodeDependency(t, plan.ManifestContent, "optionalDependencies", "fsevents", "2.3.3")
}

func TestPlanNodePackageJSONRemovesDependencyWithInferredScope(t *testing.T) {
	original := `{"devDependencies":{"vitest":"3.0.8","eslint":"9.21.0"},"description":"keep"}`
	plan, err := PlanNodePackageJSON("package.json", []byte(original), nil, []model.ProjectPackageChange{{Operation: "remove", Name: "vitest"}})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Changes[0].Scope != "dev" || plan.Changes[0].Version != "" {
		t.Fatalf("normalized removal = %+v", plan.Changes[0])
	}
	assertNodeDependencyMissing(t, plan.ManifestContent, "devDependencies", "vitest")
	assertNodeDependency(t, plan.ManifestContent, "devDependencies", "eslint", "9.21.0")
	if !strings.Contains(plan.ManifestContent, `"description":"keep"`) {
		t.Fatalf("unknown root field changed: %s", plan.ManifestContent)
	}
}

func TestPlanNodePackageJSONSupportsScopedPrereleasePackage(t *testing.T) {
	plan, err := PlanNodePackageJSON("apps/web/package.json", []byte("{}"), []string{"pnpm-workspace.yaml"}, []model.ProjectPackageChange{{Operation: "add", Name: "@types/node", Version: "22.14.0-beta.1+build.5", Scope: "dev"}})
	if err != nil {
		t.Fatal(err)
	}
	if plan.LocalChange.Path != "apps/web/package.json" || plan.ManagerHint.Manager != "pnpm" {
		t.Fatalf("nested manifest plan = %+v", plan)
	}
	assertNodeDependency(t, plan.ManifestContent, "devDependencies", "@types/node", "22.14.0-beta.1+build.5")
}

func TestPlanNodePackageJSONUsesPackageManagerField(t *testing.T) {
	plan, err := PlanNodePackageJSON("package.json", []byte(`{"packageManager":"pnpm@10.6.2+sha512.deadbeef"}`), nil, []model.ProjectPackageChange{{Operation: "add", Name: "react", Version: "19.0.0"}})
	if err != nil {
		t.Fatal(err)
	}
	if plan.ManagerHint != (NodePackageManagerHint{Manager: "pnpm", Evidence: "packageManager"}) {
		t.Fatalf("manager hint = %+v", plan.ManagerHint)
	}
}

func TestPlanNodePackageJSONRejectsManagerConflicts(t *testing.T) {
	fixtures := []struct {
		name      string
		content   string
		manifests []string
	}{
		{name: "two lock managers", content: `{}`, manifests: []string{"package-lock.json", "pnpm-lock.yaml"}},
		{name: "field and lock", content: `{"packageManager":"pnpm@10.0.0"}`, manifests: []string{"package-lock.json"}},
		{name: "unsupported field", content: `{"packageManager":"yarn@4.7.0"}`},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			_, err := PlanNodePackageJSON("package.json", []byte(fixture.content), fixture.manifests, []model.ProjectPackageChange{{Operation: "add", Name: "react", Version: "19.0.0"}})
			if err == nil {
				t.Fatal("manager conflict was accepted")
			}
		})
	}
}

func TestPlanNodePackageJSONRejectsUnsafeOrInvalidInput(t *testing.T) {
	validChange := model.ProjectPackageChange{Operation: "add", Name: "react", Version: "19.0.0"}
	fixtures := []struct {
		name       string
		path       string
		content    string
		manifests  []string
		changes    []model.ProjectPackageChange
		wantErrSub string
	}{
		{name: "traversal", path: "../package.json", content: `{}`, changes: []model.ProjectPackageChange{validChange}, wantErrSub: "invalid package.json"},
		{name: "absolute", path: "C:/project/package.json", content: `{}`, changes: []model.ProjectPackageChange{validChange}, wantErrSub: "invalid package.json"},
		{name: "wrong manifest", path: "package-lock.json", content: `{}`, changes: []model.ProjectPackageChange{validChange}, wantErrSub: "invalid package.json"},
		{name: "wrong manifest case", path: "Package.JSON", content: `{}`, changes: []model.ProjectPackageChange{validChange}, wantErrSub: "invalid package.json"},
		{name: "unsafe candidate", path: "package.json", content: `{}`, manifests: []string{"../pnpm-lock.yaml"}, changes: []model.ProjectPackageChange{validChange}, wantErrSub: "project-relative"},
		{name: "invalid JSON", path: "package.json", content: `{"name":`, changes: []model.ProjectPackageChange{validChange}, wantErrSub: "valid UTF-8 JSON"},
		{name: "array root", path: "package.json", content: `[]`, changes: []model.ProjectPackageChange{validChange}, wantErrSub: "root must be an object"},
		{name: "duplicate root key", path: "package.json", content: `{"name":"a","name":"b"}`, changes: []model.ProjectPackageChange{validChange}, wantErrSub: "duplicate"},
		{name: "non-string dependency", path: "package.json", content: `{"dependencies":{"react":19}}`, changes: []model.ProjectPackageChange{{Operation: "update", Name: "react", Version: "19.0.0"}}, wantErrSub: "string versions"},
		{name: "uppercase name", path: "package.json", content: `{}`, changes: []model.ProjectPackageChange{{Operation: "add", Name: "React", Version: "19.0.0"}}, wantErrSub: "invalid npm package name"},
		{name: "URL version", path: "package.json", content: `{}`, changes: []model.ProjectPackageChange{{Operation: "add", Name: "react", Version: "https://example.invalid/react.tgz"}}, wantErrSub: "exact npm package version"},
		{name: "range version", path: "package.json", content: `{}`, changes: []model.ProjectPackageChange{{Operation: "add", Name: "react", Version: "^19.0.0"}}, wantErrSub: "exact npm package version"},
		{name: "invalid scope", path: "package.json", content: `{}`, changes: []model.ProjectPackageChange{{Operation: "add", Name: "react", Version: "19.0.0", Scope: "peer"}}, wantErrSub: "runtime, dev, or optional"},
		{name: "features", path: "package.json", content: `{}`, changes: []model.ProjectPackageChange{{Operation: "add", Name: "react", Version: "19.0.0", Features: []string{"dom"}}}, wantErrSub: "do not support package features"},
		{name: "duplicate change", path: "package.json", content: `{}`, changes: []model.ProjectPackageChange{validChange, validChange}, wantErrSub: "more than once"},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			_, err := PlanNodePackageJSON(fixture.path, []byte(fixture.content), fixture.manifests, fixture.changes)
			if err == nil || !strings.Contains(err.Error(), fixture.wantErrSub) {
				t.Fatalf("error = %v, want substring %q", err, fixture.wantErrSub)
			}
		})
	}
}

func TestPlanNodePackageJSONRejectsAmbiguousAndNoOpChanges(t *testing.T) {
	fixtures := []struct {
		name    string
		content string
		change  model.ProjectPackageChange
		want    string
	}{
		{name: "duplicate scopes", content: `{"dependencies":{"react":"19.0.0"},"devDependencies":{"react":"19.0.0"}}`, change: model.ProjectPackageChange{Operation: "remove", Name: "react"}, want: "more than one"},
		{name: "add existing", content: `{"dependencies":{"react":"19.0.0"}}`, change: model.ProjectPackageChange{Operation: "add", Name: "react", Version: "19.0.1"}, want: "already declared"},
		{name: "add case variant", content: `{"dependencies":{"React":"19.0.0"}}`, change: model.ProjectPackageChange{Operation: "add", Name: "react", Version: "19.0.1"}, want: "already declared"},
		{name: "update missing", content: `{}`, change: model.ProjectPackageChange{Operation: "update", Name: "react", Version: "19.0.1"}, want: "not declared"},
		{name: "remove wrong scope", content: `{"devDependencies":{"react":"19.0.0"}}`, change: model.ProjectPackageChange{Operation: "remove", Name: "react", Scope: "runtime"}, want: "not dependencies"},
		{name: "same version", content: `{"dependencies":{"react":"19.0.0"}}`, change: model.ProjectPackageChange{Operation: "update", Name: "react", Version: "19.0.0"}, want: "do not modify"},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			_, err := PlanNodePackageJSON("package.json", []byte(fixture.content), nil, []model.ProjectPackageChange{fixture.change})
			if err == nil || !strings.Contains(err.Error(), fixture.want) {
				t.Fatalf("error = %v, want substring %q", err, fixture.want)
			}
		})
	}
}

func assertNodeDependency(t *testing.T, content, field, name, want string) {
	t.Helper()
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(content), &root); err != nil {
		t.Fatalf("invalid planned JSON: %v\n%s", err, content)
	}
	var dependencies map[string]string
	if err := json.Unmarshal(root[field], &dependencies); err != nil {
		t.Fatalf("invalid %s: %v\n%s", field, err, content)
	}
	if dependencies[name] != want {
		t.Fatalf("%s[%q] = %q, want %q", field, name, dependencies[name], want)
	}
}

func assertNodeDependencyMissing(t *testing.T, content, field, name string) {
	t.Helper()
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(content), &root); err != nil {
		t.Fatalf("invalid planned JSON: %v\n%s", err, content)
	}
	var dependencies map[string]string
	if err := json.Unmarshal(root[field], &dependencies); err != nil {
		t.Fatalf("invalid %s: %v\n%s", field, err, content)
	}
	if _, exists := dependencies[name]; exists {
		t.Fatalf("%s still contains %q", field, name)
	}
}
