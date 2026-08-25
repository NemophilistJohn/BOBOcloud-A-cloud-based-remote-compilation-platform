package session

import (
	"errors"
	"sync"
	"testing"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/storage"
)

type failOnceSessionDeleteStore struct {
	*storage.MemorySessionStore
	mu       sync.Mutex
	failures int
	err      error
}

func (store *failOnceSessionDeleteStore) Delete(runID string) error {
	store.mu.Lock()
	if store.failures > 0 {
		store.failures--
		err := store.err
		store.mu.Unlock()
		return err
	}
	store.mu.Unlock()
	return store.MemorySessionStore.Delete(runID)
}

func TestCleanupRunRetainsGenerationUntilPersistentDeleteCanRetry(t *testing.T) {
	base := storage.NewMemorySessionStore()
	if _, err := base.Create(&model.RunSession{RunID: "retry-run", Token: "generation-a"}); err != nil {
		t.Fatal(err)
	}
	if err := base.MarkStarted("retry-run"); err != nil {
		t.Fatal(err)
	}
	deleteErr := errors.New("database is temporarily unavailable")
	store := &failOnceSessionDeleteStore{MemorySessionStore: base, failures: 1, err: deleteErr}
	channels := NewChannelManager()
	owned := channels.GetOrCreate("retry-run", true)

	if err := channels.CleanupRun("retry-run", owned, store); !errors.Is(err, deleteErr) {
		t.Fatalf("first cleanup error = %v, want %v", err, deleteErr)
	}
	stored, exists := base.Get("retry-run")
	if !exists || !stored.Started {
		t.Fatal("failed cleanup lost its retryable started session")
	}
	if current := channels.GetOrCreate("retry-run", false); current != owned {
		t.Fatal("failed cleanup released its generation anchor")
	}

	if err := channels.CleanupRun("retry-run", owned, store); err != nil {
		t.Fatalf("retry cleanup failed: %v", err)
	}
	if _, exists := base.Get("retry-run"); exists {
		t.Fatal("successful retry retained the persistent session")
	}
	if current := channels.GetOrCreate("retry-run", false); current != nil {
		t.Fatal("successful retry retained the channel")
	}
}

func TestRetryPendingCleanupsRemovesStartedSession(t *testing.T) {
	base := storage.NewMemorySessionStore()
	if _, err := base.Create(&model.RunSession{RunID: "pending-retry", Token: "generation-a"}); err != nil {
		t.Fatal(err)
	}
	if err := base.MarkStarted("pending-retry"); err != nil {
		t.Fatal(err)
	}
	deleteErr := errors.New("database is temporarily unavailable")
	store := &failOnceSessionDeleteStore{MemorySessionStore: base, failures: 1, err: deleteErr}
	channels := NewChannelManager()
	owned := channels.GetOrCreate("pending-retry", true)
	owned.Close()

	if err := channels.CleanupRun("pending-retry", owned, store); !errors.Is(err, deleteErr) {
		t.Fatalf("first cleanup error = %v, want %v", err, deleteErr)
	}
	if err := channels.RetryPendingCleanups(store); err != nil {
		t.Fatalf("pending cleanup retry failed: %v", err)
	}
	if _, exists := base.Get("pending-retry"); exists {
		t.Fatal("pending cleanup retry retained the started session")
	}
	if current := channels.GetOrCreate("pending-retry", false); current != nil {
		t.Fatal("pending cleanup retry retained the channel generation")
	}
}

func TestPendingCleanupCannotDeleteReplacementGeneration(t *testing.T) {
	base := storage.NewMemorySessionStore()
	if _, err := base.Create(&model.RunSession{RunID: "pending-aba", Token: "generation-a"}); err != nil {
		t.Fatal(err)
	}
	deleteErr := errors.New("database is temporarily unavailable")
	store := &failOnceSessionDeleteStore{MemorySessionStore: base, failures: 1, err: deleteErr}
	channels := NewChannelManager()
	oldChannel := channels.GetOrCreate("pending-aba", true)
	if err := channels.CleanupRun("pending-aba", oldChannel, store); !errors.Is(err, deleteErr) {
		t.Fatalf("first cleanup error = %v, want %v", err, deleteErr)
	}

	// Simulate a completed lifecycle transition before an old retry snapshot is
	// processed. Removing the exact generation must also retire its pending job.
	if !channels.RemoveIfCurrent("pending-aba", oldChannel) {
		t.Fatal("old generation was not removed")
	}
	if err := base.Delete("pending-aba"); err != nil {
		t.Fatal(err)
	}
	if _, err := base.Create(&model.RunSession{RunID: "pending-aba", Token: "generation-b"}); err != nil {
		t.Fatal(err)
	}
	newChannel := channels.GetOrCreate("pending-aba", true)

	if err := channels.RetryPendingCleanups(store); err != nil {
		t.Fatalf("stale pending retry returned an error: %v", err)
	}
	stored, exists := base.Get("pending-aba")
	if !exists || stored.Token != "generation-b" {
		t.Fatalf("stale pending cleanup deleted the replacement session: %+v", stored)
	}
	if current := channels.GetOrCreate("pending-aba", false); current != newChannel {
		t.Fatal("stale pending cleanup removed the replacement channel")
	}
}

func TestLateCleanupCannotDeleteNewRunWithSameID(t *testing.T) {
	store := storage.NewMemorySessionStore()
	channels := NewChannelManager()
	if _, err := store.Create(&model.RunSession{RunID: "reused-run", Token: "generation-a"}); err != nil {
		t.Fatal(err)
	}
	oldChannel := channels.GetOrCreate("reused-run", true)
	if err := channels.CleanupRun("reused-run", oldChannel, store); err != nil {
		t.Fatal(err)
	}

	if _, err := store.Create(&model.RunSession{RunID: "reused-run", Token: "generation-b"}); err != nil {
		t.Fatal(err)
	}
	newChannel := channels.GetOrCreate("reused-run", true)
	if newChannel == oldChannel {
		t.Fatal("new run reused the old channel generation")
	}
	if err := channels.CleanupRun("reused-run", oldChannel, store); err != nil {
		t.Fatalf("late old cleanup returned an error: %v", err)
	}

	stored, exists := store.Get("reused-run")
	if !exists || stored.Token != "generation-b" {
		t.Fatalf("late cleanup deleted or replaced the new session: %+v", stored)
	}
	if current := channels.GetOrCreate("reused-run", false); current != newChannel {
		t.Fatal("late cleanup removed the new channel")
	}
}
