package packageops

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/model"
)

func persistentStoreTestPlan() ExecutionPlan {
	return ExecutionPlan{
		Public: model.ProjectPackageChangePlan{
			Source:           model.PackageCenterSource{ID: "pypi-tuna", Name: "TUNA", CatalogAuthority: "PyPI"},
			ManifestBindings: []model.ProjectPackageManifestBinding{{Path: "requirements.txt", SHA256: strings.Repeat("a", 64)}},
			LocalChanges:     []model.ProjectPackageLocalChange{{Path: "requirements.txt", NewContent: "secret-package==1\n", NewSHA256: strings.Repeat("a", 64)}},
		},
		UserID: "alice", WorkspaceID: "workspace-a", FolderKey: "folder-a",
		RuntimeID: "python:3.12", RuntimeFingerprint: "python:3.12\x00python:3.12-slim\x00sha256:image-a",
		Language: "python", InstallURL: "https://secret.example/simple/",
	}
}

func persistentStoreTestLimits() StoreLimits {
	return StoreLimits{MaxPlans: 8, MaxPlansPerUser: 4, MaxBytes: 1 << 20, MaxBytesPerUser: 1 << 20, MaxResultBytes: 8 << 10}
}

func TestPersistentPlanStoreReplaysCompletedResultAfterRestartWithoutSensitivePayload(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "completed")
	store, err := NewPersistentStoreWithLimits(time.Minute, time.Hour, persistentStoreTestLimits(), directory)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := store.Put(persistentStoreTestPlan())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := store.BeginCompletionIntent(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := store.CompleteWithResult(stored.Public.PlanID, "alice", model.ProjectPackageChangeResult{Applied: true, Stdout: "secret-output", Stderr: "secret-error"}); err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(filepath.Join(directory, persistentPlanName(stored.Public.PlanID)))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"secret-package", "secret-output", "secret-error", "secret.example", "newContent", "installURL"} {
		if strings.Contains(string(payload), forbidden) {
			t.Fatalf("persistent record leaked %q: %s", forbidden, payload)
		}
	}
	if runtime.GOOS != "windows" {
		if info, statErr := os.Stat(filepath.Join(directory, persistentPlanName(stored.Public.PlanID))); statErr != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("record permissions = %v error=%v", info.Mode().Perm(), statErr)
		}
	}

	restarted, err := NewPersistentStoreWithLimits(time.Minute, time.Hour, persistentStoreTestLimits(), directory)
	if err != nil {
		t.Fatal(err)
	}
	if _, completed, err := restarted.ClaimOrCompleted(stored.Public.PlanID, "bob"); !errors.Is(err, ErrPlanNotFound) || completed != nil {
		t.Fatalf("completed result crossed user boundary: result=%+v err=%v", completed, err)
	}
	identity, completed, err := restarted.ClaimOrCompleted(stored.Public.PlanID, "alice")
	if err != nil || completed == nil || !completed.Applied || completed.PlanID != stored.Public.PlanID {
		t.Fatalf("restart replay = plan:%+v result:%+v err:%v", identity, completed, err)
	}
	if identity.WorkspaceID != "workspace-a" || identity.FolderKey != "folder-a" || identity.RuntimeID != "python:3.12" || identity.RuntimeFingerprint != "python:3.12\x00python:3.12-slim\x00sha256:image-a" || identity.Language != "python" || identity.Public.Source.ID != "pypi-tuna" || len(identity.Public.ManifestBindings) != 1 || identity.InstallURL != "" || len(identity.Public.LocalChanges) != 0 {
		t.Fatalf("restart identity = %+v", identity)
	}
	identity.Public.ManifestBindings[0].SHA256 = "mutated"
	again, _, err := restarted.ClaimOrCompleted(stored.Public.PlanID, "alice")
	if err != nil || again.Public.ManifestBindings[0].SHA256 != strings.Repeat("a", 64) {
		t.Fatalf("persistent replay shares mutable identity: %+v err=%v", again, err)
	}
}

func TestPersistentPlanStoreRestoresPendingIntentForReconciliation(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "completed")
	store, err := NewPersistentStoreWithLimits(time.Minute, time.Hour, persistentStoreTestLimits(), directory)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := store.Put(persistentStoreTestPlan())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := store.BeginCompletionIntent(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewPersistentStoreWithLimits(time.Minute, time.Hour, persistentStoreTestLimits(), directory)
	if err != nil {
		t.Fatal(err)
	}
	identity, completed, err := restarted.ClaimOrCompleted(stored.Public.PlanID, "alice")
	if !errors.Is(err, ErrPlanReconciliation) || completed != nil || identity.WorkspaceID != "workspace-a" || len(identity.Public.ManifestBindings) != 1 {
		t.Fatalf("pending restart = plan:%+v result:%+v err:%v", identity, completed, err)
	}
	if err := restarted.MarkCompleted(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	completedRestart, err := NewPersistentStoreWithLimits(time.Minute, time.Hour, persistentStoreTestLimits(), directory)
	if err != nil {
		t.Fatal(err)
	}
	if _, result, err := completedRestart.ClaimOrCompleted(stored.Public.PlanID, "alice"); err != nil || result == nil || !result.Applied {
		t.Fatalf("reconciled completion was not durable: result=%+v err=%v", result, err)
	}
}

func TestPersistentPlanStoreCompletionWriteFailureRemainsInUse(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "completed")
	store, err := NewPersistentStoreWithLimits(time.Minute, time.Hour, persistentStoreTestLimits(), directory)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := store.Put(persistentStoreTestPlan())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := store.BeginCompletionIntent(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(root, "backup")
	if err := os.Rename(directory, backup); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(directory, []byte("blocks-directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := store.CompleteWithResult(stored.Public.PlanID, "alice", model.ProjectPackageChangeResult{Applied: true}); err == nil {
		t.Fatal("completion unexpectedly succeeded with an unavailable persistence directory")
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); !errors.Is(err, ErrPlanInUse) {
		t.Fatalf("failed completion reopened execution: %v", err)
	}
	if err := os.Remove(directory); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(backup, directory); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkCompleted(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, completed, err := store.ClaimOrCompleted(stored.Public.PlanID, "alice"); err != nil || completed == nil || !completed.Applied {
		t.Fatalf("completion retry did not close the operation: result=%+v err=%v", completed, err)
	}
}

func TestPersistentPlanStoreCleansExpiredCorruptAndDeletedUserRecords(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "completed")
	store, err := NewPersistentStoreWithLimits(time.Minute, time.Hour, persistentStoreTestLimits(), directory)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := store.Put(persistentStoreTestPlan())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := store.BeginCompletionIntent(stored.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, persistentPlanName(stored.Public.PlanID))
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record persistentPlanRecord
	if err := json.Unmarshal(payload, &record); err != nil {
		t.Fatal(err)
	}
	recordedAt := time.Now().Add(-2 * time.Hour).UTC()
	record.CreatedAt = recordedAt.Add(-time.Minute).UnixMilli()
	record.RecordedAt = recordedAt.UnixMilli()
	record.ExpiresAt = recordedAt.Add(time.Hour).UnixMilli()
	payload, _ = json.Marshal(record)
	if err := os.WriteFile(path, payload, 0600); err != nil {
		t.Fatal(err)
	}
	corruptID := "pkg_" + strings.Repeat("b", 32)
	if err := os.WriteFile(filepath.Join(directory, persistentPlanName(corruptID)), []byte("not-json"), 0600); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewPersistentStoreWithLimits(time.Minute, time.Hour, persistentStoreTestLimits(), directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(restarted.plans) != 0 {
		t.Fatalf("expired or corrupt records were loaded: %+v", restarted.plans)
	}
	for _, name := range []string{persistentPlanName(stored.Public.PlanID), persistentPlanName(corruptID)} {
		if _, err := os.Stat(filepath.Join(directory, name)); !os.IsNotExist(err) {
			t.Fatalf("invalid record %s remains: %v", name, err)
		}
	}

	active, err := restarted.Put(persistentStoreTestPlan())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Claim(active.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := restarted.BeginCompletionIntent(active.Public.PlanID, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := restarted.DeleteUser("alice"); err != nil {
		t.Fatal(err)
	}
	if len(restarted.plans) != 0 {
		t.Fatalf("deleted user retained plans: %+v", restarted.plans)
	}
	if _, err := os.Stat(filepath.Join(directory, persistentPlanName(active.Public.PlanID))); !os.IsNotExist(err) {
		t.Fatalf("deleted user retained persistent record: %v", err)
	}
}
