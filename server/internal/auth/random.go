package auth

import (
	"crypto/rand"
	"fmt"
	"io"
)

func randomBytes(size int) ([]byte, error) {
	if size <= 0 {
		return nil, fmt.Errorf("random byte size must be positive")
	}
	value := make([]byte, size)
	if _, err := io.ReadFull(rand.Reader, value); err != nil {
		return nil, fmt.Errorf("read cryptographic randomness: %w", err)
	}
	return value, nil
}

func mustRandomBytes(size int) []byte {
	value, err := randomBytes(size)
	if err != nil {
		// Continuing would mint predictable credentials and identifiers. Entropy
		// failure is a process integrity failure, not a recoverable fallback.
		panic(err)
	}
	return value
}
