// Package social persists account-scoped inbox metadata. Project data is stored
// separately under a content-addressed snapshot ID.
package social

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
)

const (
	OfferTTL            = 72 * time.Hour
	ArchiveTTL          = 7 * 24 * time.Hour
	maxPending          = 100
	maxPendingPerSender = 20
	maxRetained         = 300
)

var (
	inboxBucket    = []byte("social-inboxes-v1")
	presenceBucket = []byte("social-last-sync-v1")
	ErrNotFound    = errors.New("inbox message not found")
	ErrInboxFull   = errors.New("inbox capacity reached")
	ErrInactive    = errors.New("inbox offer is no longer active")
	ErrBusy        = errors.New("inbox offer is already being handled")
	ErrDuplicate   = errors.New("an invitation for this team is already pending")
)

type Contact struct {
	UID        string     `json:"uid"`
	Name       string     `json:"name"`
	Avatar     string     `json:"avatar,omitempty"`
	LastSyncAt *time.Time `json:"lastSyncAt,omitempty"`
}

type Message struct {
	ID         string     `json:"id"`
	Sender     Contact    `json:"sender"`
	Kind       string     `json:"kind"`
	Title      string     `json:"title,omitempty"`
	Note       string     `json:"note,omitempty"`
	Status     string     `json:"status"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
	ArchivedAt *time.Time `json:"archivedAt,omitempty"`
	Read       bool       `json:"read"`
	Bytes      int64      `json:"bytes,omitempty"`
}

type Entry struct {
	Message
	SenderID   string `json:"senderId"`
	ProjectKey string `json:"projectKey,omitempty"`
	TeamID     string `json:"teamId,omitempty"`
	SnapshotID string `json:"snapshotId,omitempty"`
	Decision   string `json:"decision,omitempty"`
	ImportKey  string `json:"importKey,omitempty"`
}

type Inbox struct {
	Pending  []Message `json:"pending"`
	Archived []Message `json:"archived"`
	Unread   int       `json:"unread"`
}

type Store struct {
	db *bolt.DB

	mu   sync.Mutex
	busy map[[2]string]struct{}
}

func NewStore(db *bolt.DB) (*Store, error) {
	err := db.Update(func(tx *bolt.Tx) error {
		if _, err := tx.CreateBucketIfNotExists(inboxBucket); err != nil {
			return err
		}
		_, err := tx.CreateBucketIfNotExists(presenceBucket)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &Store{db: db, busy: make(map[[2]string]struct{})}, nil
}

// effective projects expiry from its exact deadline. The cleanup job can lag
// without making an expired message actionable or extending its archive window.
func (e Entry) effective(now time.Time) Entry {
	if e.Status == "pending" && e.ExpiresAt != nil && !now.Before(*e.ExpiresAt) {
		e.Status, e.ArchivedAt, e.Read = "expired", e.ExpiresAt, true
	}
	return e
}

func (e Entry) retained(now time.Time) bool {
	return e.ArchivedAt == nil || now.Before(e.ArchivedAt.Add(ArchiveTTL))
}

func decode(value []byte) (Entry, error) {
	var entry Entry
	err := json.Unmarshal(value, &entry)
	return entry, err
}

func entries(bucket *bolt.Bucket, visit func(key []byte, entry Entry) error) error {
	if bucket == nil {
		return nil
	}
	return bucket.ForEach(func(key, value []byte) error {
		entry, err := decode(value)
		if err != nil {
			return err
		}
		return visit(key, entry)
	})
}

func checkCapacity(bucket *bolt.Bucket, entry Entry, now time.Time) error {
	var pending, pair, retained int
	err := entries(bucket, func(_ []byte, existing Entry) error {
		existing = existing.effective(now)
		if !existing.retained(now) {
			return nil
		}
		retained++
		if existing.Status != "pending" {
			return nil
		}
		pending++
		if existing.SenderID == entry.SenderID {
			pair++
		}
		if entry.Kind == "invite" && existing.Kind == "invite" && entry.TeamID == existing.TeamID {
			return ErrDuplicate
		}
		return nil
	})
	if err != nil {
		return err
	}
	if pending >= maxPending || pair >= maxPendingPerSender || retained >= maxRetained {
		return ErrInboxFull
	}
	return nil
}

// CheckCapacity avoids expensive snapshot work when the inbox is already full.
// Put rechecks the limit in the same transaction that publishes the offer.
func (s *Store) CheckCapacity(recipient string, entry Entry, now time.Time) error {
	return s.db.View(func(tx *bolt.Tx) error {
		return checkCapacity(tx.Bucket(inboxBucket).Bucket([]byte(recipient)), entry, now)
	})
}

func (s *Store) Put(recipient string, entry Entry, now time.Time) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.Bucket(inboxBucket).CreateBucketIfNotExists([]byte(recipient))
		if err != nil {
			return err
		}
		if err := checkCapacity(bucket, entry, now); err != nil {
			return err
		}
		if bucket.Get([]byte(entry.ID)) != nil {
			return fmt.Errorf("inbox message already exists")
		}
		return put(bucket, entry)
	})
}

func put(bucket *bolt.Bucket, entry Entry) error {
	value, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	return bucket.Put([]byte(entry.ID), value)
}

func (s *Store) List(recipient string, now time.Time) (Inbox, error) {
	result := Inbox{Pending: []Message{}, Archived: []Message{}}
	err := s.db.View(func(tx *bolt.Tx) error {
		return entries(tx.Bucket(inboxBucket).Bucket([]byte(recipient)), func(_ []byte, entry Entry) error {
			entry = entry.effective(now)
			if !entry.retained(now) {
				return nil
			}
			if entry.Status == "pending" {
				result.Pending = append(result.Pending, entry.Message)
				if !entry.Read {
					result.Unread++
				}
			} else {
				result.Archived = append(result.Archived, entry.Message)
			}
			return nil
		})
	})
	sort.Slice(result.Pending, func(i, j int) bool {
		return result.Pending[i].CreatedAt.After(result.Pending[j].CreatedAt)
	})
	sort.Slice(result.Archived, func(i, j int) bool {
		return result.Archived[i].ArchivedAt.After(*result.Archived[j].ArchivedAt)
	})
	return result, err
}

func get(bucket *bolt.Bucket, id string) (Entry, error) {
	if bucket == nil {
		return Entry{}, ErrNotFound
	}
	value := bucket.Get([]byte(id))
	if value == nil {
		return Entry{}, ErrNotFound
	}
	return decode(value)
}

func (s *Store) Get(recipient, id string, now time.Time) (Entry, error) {
	var entry Entry
	err := s.db.View(func(tx *bolt.Tx) error {
		var err error
		entry, err = get(tx.Bucket(inboxBucket).Bucket([]byte(recipient)), id)
		if err == nil {
			entry = entry.effective(now)
			if !entry.retained(now) {
				return ErrNotFound
			}
		}
		return err
	})
	return entry, err
}

// DeleteArchived shares the decision lock so deletion cannot race an active
// acceptance or import. Only the recipient's archived metadata is removed.
func (s *Store) DeleteArchived(recipient, id string, now time.Time) error {
	unlock, err := s.LockDecision(recipient, id)
	if err != nil {
		return err
	}
	defer unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(inboxBucket).Bucket([]byte(recipient))
		entry, err := get(bucket, id)
		if errors.Is(err, ErrNotFound) {
			return nil // Deleting an already absent row is safe to retry.
		}
		if err != nil {
			return err
		}
		if entry.effective(now).Status == "pending" {
			return ErrInactive
		}
		return bucket.Delete([]byte(id))
	})
}

// LockDecision does not hold a Bolt transaction during filesystem or team work.
// The lock belongs to one recipient/message; concurrent decisions fail promptly.
func (s *Store) LockDecision(recipient, id string) (func(), error) {
	key := [2]string{recipient, id}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, busy := s.busy[key]; busy {
		return nil, ErrBusy
	}
	s.busy[key] = struct{}{}
	return func() {
		s.mu.Lock()
		delete(s.busy, key)
		s.mu.Unlock()
	}, nil
}

// Finish runs while holding LockDecision. started is the time the handler
// validated eligibility; a bounded download/import can finish after that time.
func (s *Store) Finish(recipient, id, decision, projectKey string, started, now time.Time) (Entry, error) {
	var entry Entry
	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(inboxBucket).Bucket([]byte(recipient))
		var err error
		entry, err = get(bucket, id)
		if err != nil {
			return err
		}
		if entry.Decision == decision && decision != "" || decision == "read" && entry.Read {
			return nil
		}
		if entry.effective(started).Status != "pending" {
			return ErrInactive
		}
		entry.Read = true
		switch decision {
		case "read":
			if entry.Kind == "note" {
				entry.Status = "read"
			}
		case "reject":
			entry.Status = "rejected"
		case "cloud", "local", "invite":
			entry.Status = "accepted"
		default:
			return fmt.Errorf("invalid inbox decision")
		}
		if entry.Status != "pending" {
			entry.Decision, entry.ArchivedAt = decision, &now
			entry.ProjectKey = projectKey
		}
		return put(bucket, entry)
	})
	return entry, err
}

// PrepareCloud records the deterministic import target before its completed
// tree is published. A retry can distinguish our import from an existing
// unrelated project even if acknowledgement or display metadata was lost.
func (s *Store) PrepareCloud(recipient, id, key string, started time.Time) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(inboxBucket).Bucket([]byte(recipient))
		entry, err := get(bucket, id)
		if err != nil {
			return err
		}
		if entry.Kind != "project" || entry.effective(started).Status != "pending" {
			return ErrInactive
		}
		entry.ImportKey = key
		return put(bucket, entry)
	})
}

func (s *Store) SyncTimes() (map[string]time.Time, error) {
	result := make(map[string]time.Time)
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(presenceBucket).ForEach(func(id, value []byte) error {
			stamp, err := time.Parse(time.RFC3339Nano, string(value))
			if err == nil {
				result[string(id)] = stamp
			}
			return err
		})
	})
	return result, err
}

func (s *Store) RecordSync(userID string, now time.Time) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(presenceBucket)
		key := []byte(userID)
		last, _ := time.Parse(time.RFC3339Nano, string(bucket.Get(key)))
		if now.Sub(last) < 30*time.Second {
			return nil
		}
		return bucket.Put(key, []byte(now.UTC().Format(time.RFC3339Nano)))
	})
}

// Prune removes rows after their archive window and returns the IDs that
// still need project data. Archived metadata never pins a project snapshot.
func (s *Store) Prune(now time.Time) (map[string]bool, error) {
	live := make(map[string]bool)
	err := s.db.Update(func(tx *bolt.Tx) error {
		root := tx.Bucket(inboxBucket)
		return root.ForEach(func(recipient, _ []byte) error {
			bucket := root.Bucket(recipient)
			var expired []string
			if err := entries(bucket, func(key []byte, entry Entry) error {
				entry = entry.effective(now)
				if !entry.retained(now) {
					expired = append(expired, string(key))
				} else if entry.Status == "pending" && entry.SnapshotID != "" {
					live[entry.SnapshotID] = true
				}
				return nil
			}); err != nil {
				return err
			}
			for _, key := range expired {
				if err := bucket.Delete([]byte(key)); err != nil {
					return err
				}
			}
			return nil
		})
	})
	return live, err
}

// SnapshotLive rechecks current metadata during GC so a new offer referencing
// an already-existing snapshot cannot race a stale cleanup manifest.
func (s *Store) SnapshotLive(id string, now time.Time) (bool, error) {
	found := errors.New("snapshot referenced")
	err := s.db.View(func(tx *bolt.Tx) error {
		root := tx.Bucket(inboxBucket)
		return root.ForEach(func(recipient, _ []byte) error {
			return entries(root.Bucket(recipient), func(_ []byte, entry Entry) error {
				if entry.SnapshotID == id && entry.effective(now).Status == "pending" {
					return found
				}
				return nil
			})
		})
	})
	if errors.Is(err, found) {
		return true, nil
	}
	return false, err
}

func (s *Store) RemoveRecipient(userID string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		key := []byte(userID)
		if err := tx.Bucket(presenceBucket).Delete(key); err != nil {
			return err
		}
		root := tx.Bucket(inboxBucket)
		if root.Bucket(key) != nil {
			return root.DeleteBucket(key)
		}
		return nil
	})
}
