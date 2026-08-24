package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"bobocloud-server/internal/cachev2"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/personalcache"
)

type cacheV2TestEnvelope struct {
	Success   bool   `json:"success"`
	ErrorCode string `json:"errorCode"`
	Data      struct {
		CacheInventory cachev2.Inventory                 `json:"cacheInventory"`
		CacheEntry     map[string]any                    `json:"cacheEntry"`
		Result         personalcache.CatalogDeleteResult `json:"result"`
		Skipped        int                               `json:"skipped"`
	} `json:"data"`
}

func decodeCacheV2TestEnvelope(t *testing.T, body []byte) cacheV2TestEnvelope {
	t.Helper()
	var response cacheV2TestEnvelope
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode cache-v2 response: %v\n%s", err, body)
	}
	return response
}

func TestCacheV2APICatalogDetailsAndRevisionBoundDeletion(t *testing.T) {
	handler, _, user := newAuthenticatedLifecycleHandler(t)
	handler.PersonalCache = personalcache.NewManager(handler.Config.DataDir, personalcache.Options{
		ReservationBytes: 8, ReservationFiles: 1, MaxFiles: 10_000, MaxGenerations: 3,
	})
	workspace := filepath.Join(handler.Config.DataDir, "users", user.ID, "workspaces", "project")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(workspace, "package-lock.json")
	workspaceID := lsp.StableWorkspaceIdentity(user.ID, "", "", "", "project")
	request := personalcache.Request{
		UserID: user.ID, WorkspaceID: workspaceID, WorkspaceName: "Project",
		RuntimeID: "node:20", RuntimeFingerprint: "sha256:test-node-20", Language: "node",
		WorkspaceRoot: workspace, QuotaBytes: 1 << 30,
	}
	for _, content := range []string{`{"lockfileVersion":3,"packages":{"":{"dependencies":{"left-pad":"1.3.0"}}}}`, `{"lockfileVersion":3,"packages":{"":{"dependencies":{"left-pad":"1.3.0","is-number":"7.0.0"}}}}`} {
		if err := os.WriteFile(manifest, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		lease, err := handler.PersonalCache.Prepare(context.Background(), request)
		if err != nil {
			t.Fatal(err)
		}
		lease.Release()
		if !lease.Published() {
			t.Fatal("dependency generation was not published")
		}
	}

	listed := serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"getCacheInventory"}`)
	if listed.Code != http.StatusOK {
		t.Fatalf("catalog status=%d body=%s", listed.Code, listed.Body.String())
	}
	catalog := decodeCacheV2TestEnvelope(t, listed.Body.Bytes()).Data.CacheInventory
	if catalog.Schema != cachev2.SchemaVersion || catalog.Revision == "" || len(catalog.Entries) != 2 {
		t.Fatalf("catalog = %+v", catalog)
	}
	var current, history cachev2.Entry
	for _, entry := range catalog.Entries {
		switch entry.State {
		case cachev2.EntryStateCurrent:
			current = entry
		case cachev2.EntryStateSuperseded:
			history = entry
		}
	}
	if current.ID == "" || history.ID == "" || current.Capabilities["delete"] || !history.Capabilities["delete"] {
		t.Fatalf("cache entry lifecycle capabilities are incorrect: current=%+v history=%+v", current, history)
	}
	invalidID := serveAuthenticatedAction(t, handler, user.APIKey, `{"action":"deleteCacheEntry","cacheId":"project-dependencies/project","expectedRevision":"`+catalog.Revision+`"}`)
	if invalidID.Code != http.StatusBadRequest || decodeCacheV2TestEnvelope(t, invalidID.Body.Bytes()).ErrorCode != "cache_id_invalid" {
		t.Fatalf("filesystem-like cache selector was accepted: status=%d body=%s", invalidID.Code, invalidID.Body.String())
	}
	missingRevisionBody, _ := json.Marshal(map[string]any{"action": "deleteCacheEntry", "cacheId": history.ID})
	missingRevision := serveAuthenticatedAction(t, handler, user.APIKey, string(missingRevisionBody))
	if missingRevision.Code != http.StatusConflict || decodeCacheV2TestEnvelope(t, missingRevision.Body.Bytes()).ErrorCode != "cache_revision_changed" {
		t.Fatalf("revision-free cache deletion status=%d body=%s", missingRevision.Code, missingRevision.Body.String())
	}

	detailsBody, _ := json.Marshal(map[string]any{"action": "getCacheEntry", "cacheId": current.ID})
	details := serveAuthenticatedAction(t, handler, user.APIKey, string(detailsBody))
	detailResponse := decodeCacheV2TestEnvelope(t, details.Body.Bytes())
	if details.Code != http.StatusOK || detailResponse.Data.CacheEntry["id"] != current.ID.String() || detailResponse.Data.CacheEntry["package_inventory"] == nil {
		t.Fatalf("details status=%d response=%+v", details.Code, detailResponse)
	}

	deleteCurrentBody, _ := json.Marshal(map[string]any{"action": "deleteCacheEntry", "cacheId": current.ID, "expectedRevision": catalog.Revision})
	deleteCurrent := serveAuthenticatedAction(t, handler, user.APIKey, string(deleteCurrentBody))
	if deleteCurrent.Code != http.StatusConflict || decodeCacheV2TestEnvelope(t, deleteCurrent.Body.Bytes()).ErrorCode != "cache_current_environment_protected" {
		t.Fatalf("current generation deletion status=%d body=%s", deleteCurrent.Code, deleteCurrent.Body.String())
	}

	staleBody, _ := json.Marshal(map[string]any{"action": "deleteCacheEntry", "cacheId": history.ID, "expectedRevision": "stale"})
	stale := serveAuthenticatedAction(t, handler, user.APIKey, string(staleBody))
	if stale.Code != http.StatusConflict || decodeCacheV2TestEnvelope(t, stale.Body.Bytes()).ErrorCode != "cache_revision_changed" {
		t.Fatalf("stale deletion status=%d body=%s", stale.Code, stale.Body.String())
	}

	deleteHistoryBody, _ := json.Marshal(map[string]any{"action": "deleteCacheEntry", "cacheId": history.ID, "expectedRevision": catalog.Revision})
	deleted := serveAuthenticatedAction(t, handler, user.APIKey, string(deleteHistoryBody))
	deletedResponse := decodeCacheV2TestEnvelope(t, deleted.Body.Bytes())
	if deleted.Code != http.StatusOK || len(deletedResponse.Data.Result.DeletedIDs) != 1 || deletedResponse.Data.Result.DeletedIDs[0] != history.ID {
		t.Fatalf("history deletion status=%d response=%+v", deleted.Code, deletedResponse)
	}

	clearBody, _ := json.Marshal(map[string]any{"action": "clearCacheScope", "scope": "workspace", "workspaceId": workspaceID, "expectedRevision": deletedResponse.Data.Result.Revision})
	cleared := serveAuthenticatedAction(t, handler, user.APIKey, string(clearBody))
	if cleared.Code != http.StatusConflict || decodeCacheV2TestEnvelope(t, cleared.Body.Bytes()).ErrorCode != "cache_scope_protected" {
		t.Fatalf("protected workspace clear status=%d body=%s", cleared.Code, cleared.Body.String())
	}
}
