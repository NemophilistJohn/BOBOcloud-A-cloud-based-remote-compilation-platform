package social

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

func fixture(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "social.db")
	db, err := bolt.Open(path, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	store, err := NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	return store, path
}

func offer(now time.Time) Entry {
	expires := now.Add(OfferTTL)
	return Entry{Message: Message{ID: "offer", Sender: Contact{UID: "u_sender", Name: "Sender"},
		Kind: "project", Status: "pending", CreatedAt: now, ExpiresAt: &expires},
		SenderID: "private-sender", SnapshotID: strings.Repeat("a", 64)}
}

func TestInboxExpiryAndArchiveRetentionAreExactWithoutCleanup(t *testing.T) {
	store, _ := fixture(t)
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	entry := offer(now)
	if err := store.Put("recipient", entry, now); err != nil {
		t.Fatal(err)
	}
	inbox, err := store.List("recipient", now)
	if err != nil || len(inbox.Pending) != 1 || inbox.Unread != 1 {
		t.Fatalf("pending inbox = %+v, %v", inbox, err)
	}
	if _, err := store.Get("someone-else", entry.ID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another recipient could read offer: %v", err)
	}
	inbox, err = store.List("recipient", now.Add(OfferTTL))
	if err != nil || len(inbox.Pending) != 0 || len(inbox.Archived) != 1 || inbox.Unread != 0 ||
		inbox.Archived[0].Status != "expired" || !inbox.Archived[0].ArchivedAt.Equal(*entry.ExpiresAt) {
		t.Fatalf("expired inbox = %+v, %v", inbox, err)
	}
	if _, err := store.Finish("recipient", entry.ID, "cloud", "", now.Add(OfferTTL), now.Add(OfferTTL)); !errors.Is(err, ErrInactive) {
		t.Fatalf("expired offer actionable: %v", err)
	}
	inbox, err = store.List("recipient", now.Add(OfferTTL+ArchiveTTL))
	if err != nil || len(inbox.Archived) != 0 {
		t.Fatalf("archive retention extended by delayed cleanup: %+v, %v", inbox, err)
	}
	if _, err := store.Get("recipient", entry.ID, now.Add(OfferTTL+ArchiveTTL)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired archive still readable: %v", err)
	}
}

func TestReadOfferRemainsPendingAndDecisionIsIdempotent(t *testing.T) {
	store, _ := fixture(t)
	now := time.Now().UTC()
	entry := offer(now)
	if err := store.Put("recipient", entry, now); err != nil {
		t.Fatal(err)
	}
	seen, err := store.Finish("recipient", entry.ID, "read", "", now, now)
	if err != nil || !seen.Read || seen.Status != "pending" {
		t.Fatalf("reading archived an offer: %+v, %v", seen, err)
	}
	accepted, err := store.Finish("recipient", entry.ID, "cloud", "received-offer", now, now)
	if err != nil || accepted.Status != "accepted" || accepted.ProjectKey != "received-offer" {
		t.Fatalf("accept = %+v, %v", accepted, err)
	}
	retry, err := store.Finish("recipient", entry.ID, "cloud", "another-target", now, now.Add(time.Second))
	if err != nil || retry.ProjectKey != "received-offer" {
		t.Fatalf("retry changed committed decision: %+v, %v", retry, err)
	}
	if _, err := store.Finish("recipient", entry.ID, "reject", "", now, now); !errors.Is(err, ErrInactive) {
		t.Fatalf("accepted offer could be rejected: %v", err)
	}
}

func TestNoteReadArchivesAndDecisionLockRejectsConcurrentWork(t *testing.T) {
	store, _ := fixture(t)
	now := time.Now().UTC()
	entry := Entry{Message: Message{ID: "note", Kind: "note", Status: "pending", CreatedAt: now}, SenderID: "sender"}
	if err := store.Put("recipient", entry, now); err != nil {
		t.Fatal(err)
	}
	release, err := store.LockDecision("recipient", entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.LockDecision("recipient", entry.ID); !errors.Is(err, ErrBusy) {
		t.Fatalf("concurrent decision was accepted: %v", err)
	}
	release()
	release, err = store.LockDecision("recipient", entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	seen, err := store.Finish("recipient", entry.ID, "read", "", now, now)
	if err != nil || seen.Status != "read" || seen.ArchivedAt == nil {
		t.Fatalf("note did not archive when read: %+v, %v", seen, err)
	}
}

func TestInboxPersistenceBoundsAndSnapshotReferences(t *testing.T) {
	store, path := fixture(t)
	now := time.Now().UTC()
	entry := offer(now)
	if err := store.Put("recipient", entry, now); err != nil {
		t.Fatal(err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := bolt.Open(path, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	reloaded, err := NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	store = reloaded
	if inbox, err := reloaded.List("recipient", now); err != nil || len(inbox.Pending) != 1 {
		t.Fatalf("metadata did not survive a store reload: %+v %v", inbox, err)
	}
	if live, err := store.SnapshotLive(entry.SnapshotID, now); err != nil || !live {
		t.Fatalf("pending snapshot was not referenced: %v %v", live, err)
	}
	for i := 1; i < maxPendingPerSender; i++ {
		next := entry
		next.ID = string(rune('a' + i))
		if err := store.Put("recipient", next, now); err != nil {
			t.Fatal(err)
		}
	}
	entry.ID = "full"
	if err := store.Put("recipient", entry, now); !errors.Is(err, ErrInboxFull) {
		t.Fatalf("sender exhausted inbox limit without rejection: %v", err)
	}
	if live, err := store.Prune(now.Add(OfferTTL)); err != nil || len(live) != 0 {
		t.Fatalf("expired snapshots remained pinned: %v %v", live, err)
	}
	if live, err := store.SnapshotLive(entry.SnapshotID, now.Add(OfferTTL)); err != nil || live {
		t.Fatalf("expiry still references project bytes: %v %v", live, err)
	}
}

func TestInvitationDeduplicationAndRecipientCleanup(t *testing.T) {
	store, _ := fixture(t)
	now := time.Now().UTC()
	entry := offer(now)
	entry.Kind, entry.TeamID, entry.SnapshotID = "invite", "team", ""
	if err := store.Put("recipient", entry, now); err != nil {
		t.Fatal(err)
	}
	entry.ID = "another"
	if err := store.Put("recipient", entry, now); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate invitation allowed: %v", err)
	}
	if err := store.RecordSync("recipient", now); err != nil {
		t.Fatal(err)
	}
	if err := store.RemoveRecipient("recipient"); err != nil {
		t.Fatal(err)
	}
	if inbox, err := store.List("recipient", now); err != nil || len(inbox.Pending) != 0 {
		t.Fatalf("deleted recipient retained inbox: %+v %v", inbox, err)
	}
	stamps, err := store.SyncTimes()
	if err != nil || len(stamps) != 0 {
		t.Fatalf("deleted recipient retained presence: %+v %v", stamps, err)
	}
}
