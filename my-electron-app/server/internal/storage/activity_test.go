package storage

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

func forEachActivityStore(t *testing.T, run func(t *testing.T, store CompileActivityStore)) {
	t.Helper()
	t.Run("memory", func(t *testing.T) {
		run(t, NewMemoryCompileActivityStore())
	})
	t.Run("bolt", func(t *testing.T) {
		db, err := bolt.Open(filepath.Join(t.TempDir(), "activity.db"), 0600, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = db.Close() })
		run(t, NewBoltCompileActivityStore(db))
	})
}

func TestCompileActivityAggregatesUTCDateConcurrently(t *testing.T) {
	forEachActivityStore(t, func(t *testing.T, store CompileActivityStore) {
		first := time.Date(2026, time.August, 12, 23, 59, 0, 0, time.UTC)
		second := first.Add(2 * time.Minute)
		if err := store.Increment("user-one", first); err != nil {
			t.Fatal(err)
		}
		const concurrent = 64
		var wg sync.WaitGroup
		for range concurrent {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := store.Increment("user-one", second); err != nil {
					t.Errorf("increment: %v", err)
				}
			}()
		}
		wg.Wait()

		days, err := store.List("user-one", first, second)
		if err != nil {
			t.Fatal(err)
		}
		if len(days) != 2 || days[0].Date != "2026-08-12" || days[0].Count != 1 ||
			days[1].Date != "2026-08-13" || days[1].Count != concurrent {
			t.Fatalf("unexpected daily activity: %+v", days)
		}
	})
}

func TestCompileActivityRetentionAndDelete(t *testing.T) {
	forEachActivityStore(t, func(t *testing.T, store CompileActivityStore) {
		now := time.Date(2026, time.August, 13, 12, 0, 0, 0, time.UTC)
		outside := now.AddDate(0, 0, -CompileActivityRetentionDays)
		oldestKept := now.AddDate(0, 0, -(CompileActivityRetentionDays - 1))
		for _, at := range []time.Time{outside, oldestKept, now} {
			if err := store.Increment("user-one", at); err != nil {
				t.Fatal(err)
			}
		}
		days, err := store.List("user-one", outside, now)
		if err != nil {
			t.Fatal(err)
		}
		if len(days) != 2 || days[0].Date != activityDate(oldestKept) || days[1].Date != activityDate(now) {
			t.Fatalf("retention should keep exactly %d UTC days: %+v", CompileActivityRetentionDays, days)
		}
		inactiveOutside := now.AddDate(0, 0, -(CompileActivityRetentionDays + 30))
		if err := store.Increment("inactive-user", inactiveOutside); err != nil {
			t.Fatal(err)
		}
		if err := store.Cleanup(now); err != nil {
			t.Fatal(err)
		}
		inactiveDays, err := store.List("inactive-user", inactiveOutside, now)
		if err != nil || len(inactiveDays) != 0 {
			t.Fatalf("global cleanup retained inactive user's expired activity: days=%+v err=%v", inactiveDays, err)
		}
		if err := store.DeleteByUser("user-one"); err != nil {
			t.Fatal(err)
		}
		days, err = store.List("user-one", oldestKept, now)
		if err != nil || len(days) != 0 {
			t.Fatalf("delete retained activity: days=%+v err=%v", days, err)
		}
	})
}
