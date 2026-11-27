package auth

import (
	"errors"
	bolt "go.etcd.io/bbolt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTrustedDevicesLogoutResumeAndAtomicLastDevice(t *testing.T) {
	for _, backend := range []string{"memory", "bolt"} {
		t.Run(backend, func(t *testing.T) {
			var sessions AuthSessionStore
			if backend == "memory" {
				sessions = NewMemoryAuthSessionStore()
			} else {
				db, err := bolt.Open(filepath.Join(t.TempDir(), "auth.db"), 0600, nil)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { db.Close() })
				sessions = NewBoltAuthSessionStore(db)
			}
			store := sessions.(TrustedSessionStore)
			secret := strings.Repeat("a", 64)
			first, _ := sessions.CreateForDevice("user", "Laptop", "Windows", time.Hour)
			device, err := store.TrustSession(first.Token, "", secret)
			if err != nil {
				t.Fatal(err)
			}
			if err := sessions.Delete(first.Token); err != nil {
				t.Fatal(err)
			}
			resumed, err := store.ResumeTrusted(device.ID, secret, time.Hour)
			if err != nil || resumed.UserID != "user" {
				t.Fatalf("logout destroyed device authorization: %v", err)
			}
			if _, err = store.ResumeTrusted(device.ID, strings.Repeat("b", 64), time.Hour); !errors.Is(err, ErrDeviceAuthorization) {
				t.Fatal("wrong device secret resumed")
			}
			if _, err = store.ForgetTrusted(device.ID, secret); !errors.Is(err, ErrLastDevice) {
				t.Fatal("last device was removable")
			}
			second, _ := sessions.CreateForDevice("user", "Other PC", "Linux", time.Hour)
			otherSecret := strings.Repeat("c", 64)
			other, err := store.TrustSession(second.Token, "", otherSecret)
			if err != nil {
				t.Fatal(err)
			}
			var wg sync.WaitGroup
			errs := make(chan error, 2)
			for _, pair := range [][2]string{{device.ID, secret}, {other.ID, otherSecret}} {
				wg.Add(1)
				go func(pair [2]string) { defer wg.Done(); _, err := store.ForgetTrusted(pair[0], pair[1]); errs <- err }(pair)
			}
			wg.Wait()
			close(errs)
			success, blocked := 0, 0
			for err := range errs {
				if err == nil {
					success++
				} else if errors.Is(err, ErrLastDevice) {
					blocked++
				} else {
					t.Fatal(err)
				}
			}
			if success != 1 || blocked != 1 {
				t.Fatalf("last-device race: removed=%d blocked=%d", success, blocked)
			}
			remaining, err := store.ListTrusted("user")
			if err != nil || len(remaining) != 1 {
				t.Fatalf("devices remaining: %v %v", remaining, err)
			}
			if remaining[0].SecretHash != "" {
				t.Fatal("device list exposed credential digest")
			}
			removedID, removedSecret := device.ID, secret
			if remaining[0].ID == device.ID {
				removedID, removedSecret = other.ID, otherSecret
			}
			if _, err := store.ResumeTrusted(removedID, removedSecret, time.Hour); !errors.Is(err, ErrDeviceAuthorization) {
				t.Fatal("removed authorization resumed")
			}
			if err := sessions.DeleteByUser("user"); err != nil {
				t.Fatal(err)
			}
			left, _ := store.ListTrusted("user")
			if len(left) != 0 {
				t.Fatal("account disable/delete retained trusted devices")
			}
		})
	}
}
