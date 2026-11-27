package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"time"
)

// Device authorization outlives an individual login session. Only the desktop
// main process holds the random device secret; the server persists its digest.
type TrustedDevice struct {
	ID         string    `json:"id"`
	UserID     string    `json:"userId"`
	SecretHash string    `json:"secretHash"`
	Name       string    `json:"name"`
	Platform   string    `json:"platform"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
}

var ErrLastDevice = errors.New("accounts.error.lastDevice")
var ErrDeviceAuthorization = errors.New("accounts.error.authorizationRequired")

type TrustedSessionStore interface {
	TrustSession(token, deviceID, secret string) (*TrustedDevice, error)
	ResumeTrusted(deviceID, secret string, ttl time.Duration) (*AuthSession, error)
	ForgetTrusted(deviceID, secret string) (string, error)
	ListTrusted(userID string) ([]TrustedDevice, error)
	RevokeTrusted(userID, deviceID, keepDeviceID string) error
	RevokeUserDevices(userID, keepDeviceID string) error
}

type trustedTx interface {
	devices() ([]TrustedDevice, error)
	putDevice(TrustedDevice) error
	deleteDevice(string) error
	session(string) (*AuthSession, error)
	putSession(*AuthSession) error
	deleteDeviceSessions(string) error
}

type trustedOperations struct {
	transaction func(func(trustedTx) error) error
}

func secretDigest(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func validDeviceSecret(secret string) bool {
	_, err := hex.DecodeString(secret)
	return len(secret) == 64 && err == nil
}

func findDevice(tx trustedTx, id, secret string) (*TrustedDevice, error) {
	if !validDeviceSecret(secret) {
		return nil, ErrDeviceAuthorization
	}
	items, err := tx.devices()
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if item.ID == id && subtle.ConstantTimeCompare([]byte(item.SecretHash), []byte(secretDigest(secret))) == 1 {
			return &item, nil
		}
	}
	return nil, ErrDeviceAuthorization
}

func (s *trustedOperations) TrustSession(token, deviceID, secret string) (*TrustedDevice, error) {
	if !validDeviceSecret(secret) {
		return nil, ErrDeviceAuthorization
	}
	var device *TrustedDevice
	err := s.transaction(func(tx trustedTx) error {
		sess, err := tx.session(token)
		if err != nil || !time.Now().Before(sess.ExpiresAt) {
			return ErrDeviceAuthorization
		}
		if sess.TrustedDeviceID != "" {
			device, err = findDevice(tx, sess.TrustedDeviceID, secret)
			if err != nil {
				return err
			}
			return nil
		}
		if deviceID != "" {
			device, err = findDevice(tx, deviceID, secret)
			if err != nil || device.UserID != sess.UserID {
				return ErrDeviceAuthorization
			}
		} else {
			items, err := tx.devices()
			if err != nil {
				return err
			}
			for _, item := range items {
				if item.UserID == sess.UserID && subtle.ConstantTimeCompare([]byte(item.SecretHash), []byte(secretDigest(secret))) == 1 {
					copy := item
					device = &copy
					break
				}
			}
			if device == nil {
				device = &TrustedDevice{ID: GenerateUUID(), UserID: sess.UserID, SecretHash: secretDigest(secret),
					Name: sess.DeviceName, Platform: sess.DevicePlatform, CreatedAt: time.Now().UTC()}
			}
		}
		device.LastSeenAt = time.Now().UTC()
		if err := tx.putDevice(*device); err != nil {
			return err
		}
		sess.TrustedDeviceID = device.ID
		return tx.putSession(sess)
	})
	return device, err
}

func (s *trustedOperations) ResumeTrusted(id, secret string, ttl time.Duration) (*AuthSession, error) {
	var sess *AuthSession
	err := s.transaction(func(tx trustedTx) error {
		device, err := findDevice(tx, id, secret)
		if err != nil {
			return err
		}
		token, err := GenerateSessionToken()
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		device.LastSeenAt = now
		if err := tx.putDevice(*device); err != nil {
			return err
		}
		// One resumable device has one live application session. Logging out
		// removes that session without deleting its authorization.
		if err := tx.deleteDeviceSessions(id); err != nil {
			return err
		}
		sess = &AuthSession{ID: GenerateUUID(), Token: token, UserID: device.UserID, TrustedDeviceID: id,
			DeviceName: device.Name, DevicePlatform: device.Platform, CreatedAt: now, LastSeenAt: now, ExpiresAt: now.Add(ttl)}
		return tx.putSession(sess)
	})
	return sess, err
}

func (s *trustedOperations) ListTrusted(userID string) ([]TrustedDevice, error) {
	items := []TrustedDevice{}
	err := s.transaction(func(tx trustedTx) error {
		all, err := tx.devices()
		if err != nil {
			return err
		}
		for _, device := range all {
			if device.UserID == userID {
				device.SecretHash = ""
				items = append(items, device)
			}
		}
		return nil
	})
	return items, err
}

func removeTrusted(tx trustedTx, device TrustedDevice, protectLast bool) error {
	if protectLast {
		all, err := tx.devices()
		if err != nil {
			return err
		}
		count := 0
		for _, d := range all {
			if d.UserID == device.UserID {
				count++
			}
		}
		if count <= 1 {
			return ErrLastDevice
		}
	}
	if err := tx.deleteDeviceSessions(device.ID); err != nil {
		return err
	}
	return tx.deleteDevice(device.ID)
}

func (s *trustedOperations) ForgetTrusted(id, secret string) (string, error) {
	var userID string
	err := s.transaction(func(tx trustedTx) error {
		device, err := findDevice(tx, id, secret)
		if err != nil {
			return err
		}
		userID = device.UserID
		// Count and revoke share the same lock/DB write transaction: concurrent
		// removals from two computers cannot remove the last authorization.
		return removeTrusted(tx, *device, true)
	})
	return userID, err
}

func (s *trustedOperations) RevokeTrusted(userID, id, keepID string) error {
	return s.transaction(func(tx trustedTx) error {
		if id == keepID {
			return ErrLastDevice
		}
		all, err := tx.devices()
		if err != nil {
			return err
		}
		for _, d := range all {
			if d.ID == id && d.UserID == userID {
				return removeTrusted(tx, d, true)
			}
		}
		return ErrDeviceAuthorization
	})
}

func (s *trustedOperations) RevokeUserDevices(userID, keepID string) error {
	return s.transaction(func(tx trustedTx) error {
		all, err := tx.devices()
		if err != nil {
			return err
		}
		for _, d := range all {
			if d.UserID == userID && d.ID != keepID {
				if err := removeTrusted(tx, d, false); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
