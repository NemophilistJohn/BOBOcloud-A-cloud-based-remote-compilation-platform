package handler

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/resourcecontrol"
	"bobocloud-server/internal/resourcegovernor"
)

func newRuntimeDependencyResourceController(t *testing.T) *resourcecontrol.Controller {
	t.Helper()
	governor, err := resourcegovernor.New(resourcegovernor.NodeResources{Capacity: resourcegovernor.Resources{
		Slots: 2, DockerContainers: 1, MemoryBytes: 512 << 20, CPUMillicores: 1000, PIDs: 64,
	}})
	if err != nil {
		t.Fatal(err)
	}
	profiles := make(resourcecontrol.Profiles)
	for workload := resourcecontrol.WorkloadRun; workload <= resourcecontrol.WorkloadNotebook; workload++ {
		profiles[workload] = resourcegovernor.Resources{Slots: 1}
	}
	controller, err := resourcecontrol.New(governor, profiles, nil)
	if err != nil {
		t.Fatal(err)
	}
	return controller
}

func testRuntimeDependencyContext() runtimeDependencyQueryContext {
	return runtimeDependencyQueryContext{
		ownerID: "alice", scopeID: "project-alpha", imageID: "sha256:" + strings.Repeat("a", 64),
		language: "python", runtimeID: "python:3.13", dependencyRevision: "published-revision",
	}
}

func testRuntimeDependencyPage() lsp.DependencyAPIIndexPage {
	return lsp.DependencyAPIIndexPage{
		Schema: lsp.DependencyAPIIndexSchema, LanguageID: "python", RuntimeID: "python:3.13", Revision: "published-revision",
		QueryKind: "module", Module: "numpy", Roots: []string{"numpy"}, Complete: true,
		Entries: []lsp.DependencyAPIIndexEntry{{Module: "numpy", Kind: "module", Symbols: []lsp.DependencyAPIIndexSymbol{{Name: "array", Kind: "function"}}}},
	}
}

func TestRuntimeDependencySessionBindsSelectedImmutableRuntime(t *testing.T) {
	imageID := "sha256:" + strings.Repeat("b", 64)
	var metadataCalls int
	handler := &WSHandler{RuntimeMetadata: RuntimeMetadataProviderFunc(func(ctx context.Context, runtimeID, image, version string) RuntimeMetadata {
		metadataCalls++
		if runtimeID != "python:3.13" || image != "selected-python:3.13" || ctx.Err() != nil {
			t.Fatalf("metadata did not use the selected runtime: runtime=%q image=%q err=%v", runtimeID, image, ctx.Err())
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("metadata resolution must be bounded")
		}
		return RuntimeMetadata{ImageID: imageID}
	})}
	revision, query := handler.runtimeDependenciesForSession(context.Background(), "alice", "project-alpha", "python:3.13", "selected-python:3.13", "python", "revision-a")
	if len(revision) != 64 || query == nil || metadataCalls != 1 {
		t.Fatalf("selected runtime unavailable: revision=%q query=%v calls=%d", revision, query != nil, metadataCalls)
	}
	// Published dependencies have a separate revision. The runtime identity is
	// stable for those changes, but changes whenever the selected image changes.
	sameRevision, _ := handler.runtimeDependenciesForSession(context.Background(), "alice", "project-alpha", "python:3.13", "selected-python:3.13", "python", "revision-b")
	if sameRevision != revision {
		t.Fatal("runtime identity must not absorb the published dependency revision")
	}
	imageID = "sha256:" + strings.Repeat("c", 64)
	changedRevision, _ := handler.runtimeDependenciesForSession(context.Background(), "alice", "project-alpha", "python:3.13", "selected-python:3.13", "python", "revision-b")
	if changedRevision == revision {
		t.Fatal("runtime identity did not invalidate after immutable image change")
	}
	imageID = "selected-python:3.13"
	if revision, query = handler.runtimeDependenciesForSession(context.Background(), "alice", "project-alpha", "python:3.13", "selected-python:3.13", "python", "revision-b"); revision != "" || query != nil {
		t.Fatal("mutable image tags must not identify runtime catalogs")
	}
	metadataCalls = 0
	for _, test := range []struct{ runtime, image, language, dependencyRevision string }{
		{"local", "selected-python:3.13", "python", "revision"},
		{"python:3.13", "", "python", "revision"},
		{"go:1.25", "go:1.25", "go", "revision"},
		{"python:3.13", "selected-python:3.13", "python", ""},
	} {
		revision, query := handler.runtimeDependenciesForSession(context.Background(), "alice", "project-alpha", test.runtime, test.image, test.language, test.dependencyRevision)
		if revision != "" || query != nil {
			t.Fatalf("unavailable runtime unexpectedly has a probe: %+v", test)
		}
	}
	if metadataCalls != 0 {
		t.Fatal("unsupported runtime reached metadata discovery")
	}
}

func TestRuntimeDependencyQueryChargesResourcesAndCachesDetachedPages(t *testing.T) {
	controller := newRuntimeDependencyResourceController(t)
	bound := testRuntimeDependencyContext()
	var calls atomic.Int32
	query := newGovernedRuntimeDependencyQuery(context.Background(), controller, bound, func(ctx context.Context, image, language, runtime, revision string, request lsp.DependencyAPIQuery) (lsp.DependencyAPIIndexPage, error) {
		calls.Add(1)
		if image != bound.imageID || language != bound.language || runtime != bound.runtimeID || revision != bound.dependencyRevision || request.Module != "numpy" {
			t.Fatalf("probe identity differs from its authenticated session")
		}
		snapshot := controller.Snapshot()
		used := snapshot.Used
		if used.Slots != 1 || used.DockerContainers != 1 || used.MemoryBytes != 128<<20 || used.CPUMillicores != 500 || used.PIDs != 32 {
			t.Fatalf("runtime probe resources not reserved: %+v", used)
		}
		if len(snapshot.Leases) != 1 || snapshot.Leases[0].Metadata.OwnerID != "alice" || snapshot.Leases[0].Metadata.Workload != "maintenance" {
			t.Fatalf("runtime probe admission lost owner/workload binding: %+v", snapshot.Leases)
		}
		return testRuntimeDependencyPage(), nil
	})
	request := lsp.DependencyAPIQuery{Kind: "module", Module: "numpy"}
	page, err := query(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot := controller.Snapshot(); len(snapshot.Leases) != 0 || snapshot.Used.DockerContainers != 0 {
		t.Fatalf("successful probe leaked resources: %+v", snapshot)
	}
	page.Roots[0] = "mutated"
	page.Entries[0].Symbols[0].Name = "mutated"
	page, err = query(context.Background(), request)
	if err != nil || calls.Load() != 1 || page.Roots[0] != "numpy" || page.Entries[0].Symbols[0].Name != "array" {
		t.Fatalf("cached metadata is not detached: page=%+v calls=%d err=%v", page, calls.Load(), err)
	}
	page.Entries[0].Symbols[0].Name = "second-mutation"
	page, err = query(context.Background(), request)
	if err != nil || page.Entries[0].Symbols[0].Name != "array" {
		t.Fatal("cached response aliases an earlier cache-hit response")
	}
}

func TestRuntimeDependencyQueryPressureSkipsProbeWithoutQueueing(t *testing.T) {
	controller := newRuntimeDependencyResourceController(t)
	occupied, err := controller.TryAcquireAdmission(resourcecontrol.Admission{Workload: resourcecontrol.WorkloadRun, OwnerID: "bob", ScopeID: "other-project", WorkloadID: "interactive-run", Minimum: resourcegovernor.Resources{DockerContainers: 1}})
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Release()
	var calls atomic.Int32
	query := newGovernedRuntimeDependencyQuery(context.Background(), controller, testRuntimeDependencyContext(), func(context.Context, string, string, string, string, lsp.DependencyAPIQuery) (lsp.DependencyAPIIndexPage, error) {
		calls.Add(1)
		return testRuntimeDependencyPage(), nil
	})
	if _, err := query(context.Background(), lsp.DependencyAPIQuery{Kind: "catalog"}); err == nil {
		t.Fatal("runtime metadata probe was admitted under Docker pressure")
	}
	if calls.Load() != 0 || controller.QueueSnapshot().Total != 0 || len(controller.Snapshot().Leases) != 1 {
		t.Fatal("skipped background discovery launched work or retained a waiting lease")
	}
}

func TestRuntimeDependencyQuerySessionCancellationWaitsForCleanup(t *testing.T) {
	controller := newRuntimeDependencyResourceController(t)
	sessionContext, cancelSession := context.WithCancel(context.Background())
	defer cancelSession()
	started, cleanupStarted, finishCleanup := make(chan struct{}), make(chan struct{}), make(chan struct{})
	query := newGovernedRuntimeDependencyQuery(sessionContext, controller, testRuntimeDependencyContext(), func(ctx context.Context, _, _, _, _ string, _ lsp.DependencyAPIQuery) (lsp.DependencyAPIIndexPage, error) {
		close(started)
		<-ctx.Done()
		close(cleanupStarted)
		<-finishCleanup
		return lsp.DependencyAPIIndexPage{}, ctx.Err()
	})
	done := make(chan error, 1)
	go func() { _, err := query(context.Background(), lsp.DependencyAPIQuery{Kind: "catalog"}); done <- err }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("runtime probe did not start")
	}
	cancelSession()
	select {
	case <-cleanupStarted:
	case <-time.After(3 * time.Second):
		close(finishCleanup)
		t.Fatal("session cancellation did not reach runtime probe")
	}
	if snapshot := controller.Snapshot(); snapshot.Used.DockerContainers != 1 || len(snapshot.Leases) != 1 {
		close(finishCleanup)
		t.Fatalf("runtime resources released before actual container cleanup: %+v", snapshot)
	}
	close(finishCleanup)
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("query cancellation = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("query did not finish after cleanup")
	}
	if snapshot := controller.Snapshot(); len(snapshot.Leases) != 0 || snapshot.Used.MemoryBytes != 0 {
		t.Fatalf("canceled probe leaked resources: %+v", snapshot)
	}
}

func TestRuntimeDependencyQueryRejectsStaleCacheAndInvalidQuery(t *testing.T) {
	sessionContext, cancelSession := context.WithCancel(context.Background())
	var calls atomic.Int32
	query := newGovernedRuntimeDependencyQuery(sessionContext, nil, testRuntimeDependencyContext(), func(context.Context, string, string, string, string, lsp.DependencyAPIQuery) (lsp.DependencyAPIIndexPage, error) {
		calls.Add(1)
		return testRuntimeDependencyPage(), nil
	})
	for _, invalid := range []lsp.DependencyAPIQuery{{Kind: "project"}, {Kind: "module", Module: "../outside"}, {Kind: "module"}} {
		if _, err := query(context.Background(), invalid); err == nil {
			t.Fatalf("invalid query reached runtime probe: %+v", invalid)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid query invoked runner")
	}
	request := lsp.DependencyAPIQuery{Kind: "module", Module: "numpy"}
	if _, err := query(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	canceledRequest, cancelRequest := context.WithCancel(context.Background())
	cancelRequest()
	if _, err := query(canceledRequest, request); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled request read cached response: %v", err)
	}
	cancelSession()
	if _, err := query(context.Background(), request); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled session read cached response: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("stale session launched a new probe: %d", calls.Load())
	}
}
