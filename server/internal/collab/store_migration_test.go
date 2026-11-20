package collab

import (
	"path/filepath"
	"testing"

	bolt "go.etcd.io/bbolt"
)

func TestBoltStoreDeletesLegacyTeamInviteCodes(t *testing.T) {
	db, err := bolt.Open(filepath.Join(t.TempDir(), "collab.db"), 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucket([]byte("collab_invites"))
		return err
	}); err != nil {
		t.Fatal(err)
	}

	NewBoltStore(db)
	if err := db.View(func(tx *bolt.Tx) error {
		if tx.Bucket([]byte("collab_invites")) != nil {
			t.Fatal("legacy team invite-code bucket remains after migration")
		}
		for _, bucket := range [][]byte{teamsBucket, membersBucket, projectsBucket, locksBucket} {
			if tx.Bucket(bucket) == nil {
				t.Fatalf("required collaboration bucket %q was not created", bucket)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
