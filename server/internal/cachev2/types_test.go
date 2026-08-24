package cachev2

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func validTestEntry(t *testing.T) Entry {
	t.Helper()
	id, err := NewCacheID()
	if err != nil {
		t.Fatal(err)
	}
	created := time.Date(2026, 8, 24, 1, 2, 3, 0, time.UTC)
	return Entry{
		Schema:             SchemaVersion,
		ID:                 id,
		OwnerKind:          OwnerKindUser,
		OwnerID:            "root",
		Category:           CategoryDependencies,
		State:              EntryStateCurrent,
		WorkspaceID:        "project-a",
		RuntimeFingerprint: "sha256:image",
		Language:           "python",
		DependencyDigest:   "lock-digest",
		Generation:         "generation-1",
		SizeBytes:          1024,
		Files:              12,
		CreatedAt:          created,
		LastUsedAt:         created.Add(time.Minute),
		ActiveReaders:      1,
	}
}

func TestEntryAndInventoryDTOValidate(t *testing.T) {
	entry := validTestEntry(t)
	if err := entry.Validate(); err != nil {
		t.Fatal(err)
	}
	inventory := Inventory{
		Schema:        SchemaVersion,
		Revision:      "pcv2_test-revision",
		OwnerKind:     OwnerKindUser,
		OwnerID:       "root",
		QuotaBytes:    1 << 30,
		UsedBytes:     entry.SizeBytes,
		ReservedBytes: 4096,
		QuotaFiles:    1000,
		UsedFiles:     entry.Files,
		ReservedFiles: 8,
		GeneratedAt:   time.Now().UTC(),
		Entries:       []Entry{entry},
	}
	if err := inventory.Validate(); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(inventory)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "host_path") || strings.Contains(string(payload), entry.WorkspaceID+"/") {
		t.Fatalf("inventory leaked a host path: %s", payload)
	}
	var decoded Inventory
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if err := decoded.Validate(); err != nil {
		t.Fatalf("decoded inventory is invalid: %v", err)
	}
}

func TestEntryValidationRejectsInvalidIdentityStateAndUsage(t *testing.T) {
	tests := map[string]func(*Entry){
		"schema":   func(entry *Entry) { entry.Schema = 1 },
		"id":       func(entry *Entry) { entry.ID = "project/python" },
		"owner":    func(entry *Entry) { entry.OwnerID = "" },
		"category": func(entry *Entry) { entry.Category = "unknown" },
		"state":    func(entry *Entry) { entry.State = "installing" },
		"bytes":    func(entry *Entry) { entry.SizeBytes = -1 },
		"files":    func(entry *Entry) { entry.Files = -1 },
		"readers":  func(entry *Entry) { entry.ActiveReaders = -1 },
		"time":     func(entry *Entry) { entry.LastUsedAt = entry.CreatedAt.Add(-time.Second) },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			entry := validTestEntry(t)
			mutate(&entry)
			if err := entry.Validate(); err == nil {
				t.Fatal("invalid entry was accepted")
			}
		})
	}
}

func TestInventoryValidationRejectsCrossOwnerEntriesAndNegativeUsage(t *testing.T) {
	entry := validTestEntry(t)
	inventory := Inventory{Schema: SchemaVersion, OwnerKind: OwnerKindUser, OwnerID: "other", Entries: []Entry{entry}}
	if err := inventory.Validate(); err == nil {
		t.Fatal("cross-owner inventory entry was accepted")
	}
	inventory = Inventory{Schema: SchemaVersion, OwnerKind: OwnerKindUser, OwnerID: "root", ReservedBytes: -1}
	if err := inventory.Validate(); err == nil {
		t.Fatal("negative inventory usage was accepted")
	}
}

func TestCategoryRelativePathsAreStable(t *testing.T) {
	wants := map[Category]string{
		CategoryDependencies: "artifacts/dependencies",
		CategoryResults:      "artifacts/results",
		CategoryToolchains:   "mutable/toolchains",
		CategoryIncremental:  "mutable/incremental",
	}
	for category, want := range wants {
		path, err := category.RelativePath()
		if err != nil || path != want {
			t.Fatalf("category %q path = %q, %v; want %q", category, path, err, want)
		}
	}
	if _, err := Category("bad").RelativePath(); !errors.Is(err, ErrInvalidCategory) {
		t.Fatalf("invalid category error = %v", err)
	}
}
