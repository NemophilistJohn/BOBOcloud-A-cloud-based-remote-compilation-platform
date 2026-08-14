package storage

import (
	"encoding/binary"
	"fmt"
	"sort"
	"sync"
	"time"

	"bobocloud-server/internal/model"

	bolt "go.etcd.io/bbolt"
)

// CompileActivityRetentionDays covers the 53 columns shown by the account
// heatmap. Dates are normalized to UTC so a request is assigned to exactly one
// day regardless of the client time zone.
const CompileActivityRetentionDays = 53 * 7

var compileActivityBucket = []byte("compile_activity_v1")

// CompileActivityStore keeps only daily request totals. It deliberately does
// not depend on the bounded run history.
type CompileActivityStore interface {
	Increment(userID string, at time.Time) error
	List(userID string, from, through time.Time) ([]model.CompileActivityDay, error)
	Cleanup(at time.Time) error
	DeleteByUser(userID string) error
}

func activityDate(at time.Time) string {
	return at.UTC().Format("2006-01-02")
}

func activityRange(from, through time.Time) (string, string, error) {
	start := activityDate(from)
	end := activityDate(through)
	if start > end {
		return "", "", fmt.Errorf("activity range starts after it ends")
	}
	return start, end, nil
}

func activityCutoff(at time.Time) string {
	return activityDate(at.UTC().AddDate(0, 0, -(CompileActivityRetentionDays - 1)))
}

// MemoryCompileActivityStore is used by single-process and test deployments.
type MemoryCompileActivityStore struct {
	mu     sync.Mutex
	counts map[string]map[string]uint64
}

func NewMemoryCompileActivityStore() *MemoryCompileActivityStore {
	return &MemoryCompileActivityStore{counts: make(map[string]map[string]uint64)}
}

func (s *MemoryCompileActivityStore) Increment(userID string, at time.Time) error {
	if userID == "" {
		return fmt.Errorf("user ID is required")
	}
	day := activityDate(at)
	cutoff := activityCutoff(at)
	s.mu.Lock()
	defer s.mu.Unlock()
	userCounts := s.counts[userID]
	if userCounts == nil {
		userCounts = make(map[string]uint64)
		s.counts[userID] = userCounts
	}
	userCounts[day]++
	pruneUserActivity(userCounts, cutoff)
	return nil
}

func pruneUserActivity(userCounts map[string]uint64, cutoff string) {
	for date := range userCounts {
		if date < cutoff {
			delete(userCounts, date)
		}
	}
}

func (s *MemoryCompileActivityStore) pruneLocked(cutoff string) {
	for userID, userCounts := range s.counts {
		pruneUserActivity(userCounts, cutoff)
		if len(userCounts) == 0 {
			delete(s.counts, userID)
		}
	}
}

func (s *MemoryCompileActivityStore) List(userID string, from, through time.Time) ([]model.CompileActivityDay, error) {
	start, end, err := activityRange(from, through)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]model.CompileActivityDay, 0)
	for date, count := range s.counts[userID] {
		if date >= start && date <= end {
			result = append(result, model.CompileActivityDay{Date: date, Count: count})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Date < result[j].Date })
	return result, nil
}

func (s *MemoryCompileActivityStore) DeleteByUser(userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.counts, userID)
	return nil
}

func (s *MemoryCompileActivityStore) Cleanup(at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(activityCutoff(at))
	return nil
}

// BoltCompileActivityStore stores each user's ISO date keys in a nested
// bucket. Increment and retention cleanup happen in the same write transaction.
type BoltCompileActivityStore struct {
	db *bolt.DB
}

func NewBoltCompileActivityStore(db *bolt.DB) *BoltCompileActivityStore {
	err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(compileActivityBucket)
		return err
	})
	if err != nil {
		return &BoltCompileActivityStore{db: db}
	}
	return &BoltCompileActivityStore{db: db}
}

func (s *BoltCompileActivityStore) Increment(userID string, at time.Time) error {
	if userID == "" {
		return fmt.Errorf("user ID is required")
	}
	day := []byte(activityDate(at))
	cutoff := []byte(activityCutoff(at))
	return s.db.Update(func(tx *bolt.Tx) error {
		root := tx.Bucket(compileActivityBucket)
		if root == nil {
			return fmt.Errorf("compile activity bucket is unavailable")
		}
		bucket, err := root.CreateBucketIfNotExists([]byte(userID))
		if err != nil {
			return err
		}
		var count uint64
		if current := bucket.Get(day); len(current) == 8 {
			count = binary.BigEndian.Uint64(current)
		}
		value := make([]byte, 8)
		binary.BigEndian.PutUint64(value, count+1)
		if err := bucket.Put(day, value); err != nil {
			return err
		}
		cursor := bucket.Cursor()
		for key, _ := cursor.First(); key != nil && string(key) < string(cutoff); key, _ = cursor.Next() {
			if err := cursor.Delete(); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *BoltCompileActivityStore) List(userID string, from, through time.Time) ([]model.CompileActivityDay, error) {
	start, end, err := activityRange(from, through)
	if err != nil {
		return nil, err
	}
	result := make([]model.CompileActivityDay, 0)
	err = s.db.View(func(tx *bolt.Tx) error {
		root := tx.Bucket(compileActivityBucket)
		if root == nil {
			return nil
		}
		bucket := root.Bucket([]byte(userID))
		if bucket == nil {
			return nil
		}
		cursor := bucket.Cursor()
		for key, value := cursor.Seek([]byte(start)); key != nil && string(key) <= end; key, value = cursor.Next() {
			if len(value) != 8 {
				continue
			}
			result = append(result, model.CompileActivityDay{Date: string(key), Count: binary.BigEndian.Uint64(value)})
		}
		return nil
	})
	return result, err
}

func (s *BoltCompileActivityStore) Cleanup(at time.Time) error {
	cutoff := []byte(activityCutoff(at))
	return s.db.Update(func(tx *bolt.Tx) error {
		root := tx.Bucket(compileActivityBucket)
		if root == nil {
			return nil
		}
		return root.ForEach(func(userID, value []byte) error {
			if value != nil {
				return nil
			}
			bucket := root.Bucket(userID)
			if bucket == nil {
				return nil
			}
			cursor := bucket.Cursor()
			for key, _ := cursor.First(); key != nil && string(key) < string(cutoff); key, _ = cursor.Next() {
				if err := cursor.Delete(); err != nil {
					return err
				}
			}
			return nil
		})
	})
}

func (s *BoltCompileActivityStore) DeleteByUser(userID string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		root := tx.Bucket(compileActivityBucket)
		if root == nil {
			return nil
		}
		err := root.DeleteBucket([]byte(userID))
		if err == bolt.ErrBucketNotFound {
			return nil
		}
		return err
	})
}
