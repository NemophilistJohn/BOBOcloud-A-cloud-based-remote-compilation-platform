package personalcache

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAcquireEntryInspectionReadRetainsGenerationWithoutTouchingLRU(t *testing.T) {
	manager := newTestManager(t.TempDir(), Options{ReservationBytes: 8, ReservationFiles: 1})
	request := Request{
		UserID: "u1", WorkspaceID: "project", WorkspaceName: "Project",
		RuntimeID: "node:22", RuntimeFingerprint: trustedTestRuntimeFingerprint,
		Language: "node", WorkspaceRoot: t.TempDir(),
	}
	published, err := manager.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	packageJSON := filepath.Join(published.HostRoot, "node_modules", "demo", "package.json")
	if err := os.MkdirAll(filepath.Dir(packageJSON), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(packageJSON, []byte(`{"name":"demo","version":"1.0.0"}`), 0600); err != nil {
		t.Fatal(err)
	}
	published.Release()
	entries := manager.Inspect(request.UserID, 0).Entries
	if len(entries) != 1 {
		t.Fatalf("published entries = %+v", entries)
	}

	lastUsed := entries[0].LastUsed
	reader, entry, exists, err := manager.AcquireEntryInspectionRead(request.UserID, entries[0].Path)
	if err != nil || !exists || reader == nil || entry.Generation == "" || entry.Generation != reader.Generation {
		t.Fatalf("path read: reader=%v entry=%+v exists=%v err=%v", reader != nil, entry, exists, err)
	}
	activeEntries := manager.Inspect(request.UserID, 0).Entries
	if len(activeEntries) != 1 || !activeEntries[0].Active || !activeEntries[0].LastUsed.Equal(lastUsed) {
		reader.Release()
		t.Fatalf("inspection read changed LRU or failed to retain entry: before=%s entries=%+v", lastUsed, activeEntries)
	}
	if err := manager.Delete(request.UserID, entry.Path); !errors.Is(err, ErrCacheInUse) {
		reader.Release()
		t.Fatalf("active management reader delete error = %v", err)
	}

	refresh, err := manager.Prepare(context.Background(), request)
	if err != nil {
		reader.Release()
		t.Fatal(err)
	}
	if !reader.Stable() {
		reader.Release()
		refresh.Abort()
		refresh.Release()
		t.Fatal("staging writer changed the retained published generation")
	}
	refresh.Release()
	if reader.Stable() {
		reader.Release()
		t.Fatal("published replacement did not invalidate the old management reader")
	}
	if info := manager.Enforce(request.UserID, 1); len(info.Entries) != 1 {
		reader.Release()
		t.Fatalf("LRU evicted an active management reader: %+v", info)
	}
	reader.Release()
	if info := manager.Enforce(request.UserID, 1); len(info.Entries) != 0 {
		t.Fatalf("released management reader remained pinned: %+v", info)
	}
}
