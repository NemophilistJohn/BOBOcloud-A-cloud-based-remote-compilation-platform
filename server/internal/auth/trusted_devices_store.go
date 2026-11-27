package auth

import (
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
)

type memoryTrustedTx struct {
	items    map[string]TrustedDevice
	sessions map[string]*AuthSession
}

func (t *memoryTrustedTx) devices() ([]TrustedDevice, error) {
	out := []TrustedDevice{}
	for _, d := range t.items {
		out = append(out, d)
	}
	return out, nil
}
func (t *memoryTrustedTx) putDevice(d TrustedDevice) error { t.items[d.ID] = d; return nil }
func (t *memoryTrustedTx) deleteDevice(id string) error    { delete(t.items, id); return nil }
func (t *memoryTrustedTx) session(token string) (*AuthSession, error) {
	s := t.sessions[token]
	if s == nil {
		return nil, ErrDeviceAuthorization
	}
	c := *s
	return &c, nil
}
func (t *memoryTrustedTx) putSession(s *AuthSession) error { t.sessions[s.Token] = s; return nil }
func (t *memoryTrustedTx) deleteDeviceSessions(id string) error {
	for key, s := range t.sessions {
		if s.TrustedDeviceID == id {
			delete(t.sessions, key)
		}
	}
	return nil
}
func (s *MemoryAuthSessionStore) trustedTransaction(fn func(trustedTx) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx := &memoryTrustedTx{items: map[string]TrustedDevice{}, sessions: map[string]*AuthSession{}}
	for k, d := range s.trustedDevices {
		tx.items[k] = d
	}
	for k, item := range s.sessions {
		c := *item
		tx.sessions[k] = &c
	}
	if err := fn(tx); err != nil {
		return err
	}
	s.trustedDevices, s.sessions = tx.items, tx.sessions
	return nil
}

var trustedDevicesBucket = []byte("trusted_devices")

type boltTrustedTx struct{ tx *bolt.Tx }

func (t *boltTrustedTx) devices() ([]TrustedDevice, error) {
	out := []TrustedDevice{}
	err := t.tx.Bucket(trustedDevicesBucket).ForEach(func(_, v []byte) error {
		var d TrustedDevice
		if err := json.Unmarshal(v, &d); err != nil {
			return errors.New("corrupt device authorization")
		}
		out = append(out, d)
		return nil
	})
	return out, err
}
func (t *boltTrustedTx) putDevice(d TrustedDevice) error {
	data, err := json.Marshal(d)
	if err != nil {
		return err
	}
	return t.tx.Bucket(trustedDevicesBucket).Put([]byte(d.ID), data)
}
func (t *boltTrustedTx) deleteDevice(id string) error {
	return t.tx.Bucket(trustedDevicesBucket).Delete([]byte(id))
}
func (t *boltTrustedTx) session(token string) (*AuthSession, error) {
	var s AuthSession
	raw := t.tx.Bucket(authSessionsBucket).Get([]byte(token))
	if raw == nil {
		return nil, ErrDeviceAuthorization
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	return &s, nil
}
func (t *boltTrustedTx) putSession(s *AuthSession) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return t.tx.Bucket(authSessionsBucket).Put([]byte(s.Token), data)
}
func (t *boltTrustedTx) deleteDeviceSessions(id string) error {
	b := t.tx.Bucket(authSessionsBucket)
	c := b.Cursor()
	for k, v := c.First(); k != nil; k, v = c.Next() {
		var s AuthSession
		if err := json.Unmarshal(v, &s); err != nil {
			return err
		}
		if s.TrustedDeviceID == id {
			if err := c.Delete(); err != nil {
				return err
			}
		}
	}
	return nil
}
func (s *BoltAuthSessionStore) trustedTransaction(fn func(trustedTx) error) error {
	return s.db.Update(func(tx *bolt.Tx) error { return fn(&boltTrustedTx{tx: tx}) })
}
