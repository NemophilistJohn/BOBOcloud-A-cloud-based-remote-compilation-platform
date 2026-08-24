package cachev2

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"bobocloud-server/internal/safefile"
)

const (
	CacheIDPrefix   = "cv2_"
	CacheIDFileName = ".cache-id"
	cacheIDBytes    = 16
	maxCacheIDBytes = 128
)

var ErrInvalidCacheID = errors.New("invalid cache ID")

// CacheID is an opaque, random public identity. It deliberately carries no
// owner, path, category, timestamp, or cache-key information.
type CacheID string

func NewCacheID() (CacheID, error) {
	return newCacheID(rand.Reader)
}

func newCacheID(source io.Reader) (CacheID, error) {
	random := make([]byte, cacheIDBytes)
	if _, err := io.ReadFull(source, random); err != nil {
		return "", fmt.Errorf("generate cache ID: %w", err)
	}
	return CacheID(CacheIDPrefix + hex.EncodeToString(random)), nil
}

func ParseCacheID(value string) (CacheID, error) {
	if len(value) != len(CacheIDPrefix)+(cacheIDBytes*2) || value[:len(CacheIDPrefix)] != CacheIDPrefix {
		return "", ErrInvalidCacheID
	}
	payload := value[len(CacheIDPrefix):]
	decoded, err := hex.DecodeString(payload)
	if err != nil || len(decoded) != cacheIDBytes || hex.EncodeToString(decoded) != payload {
		return "", ErrInvalidCacheID
	}
	return CacheID(value), nil
}

func (id CacheID) String() string {
	return string(id)
}

func (id CacheID) Valid() bool {
	_, err := ParseCacheID(string(id))
	return err == nil
}

func (id CacheID) MarshalText() ([]byte, error) {
	if !id.Valid() {
		return nil, ErrInvalidCacheID
	}
	return []byte(id), nil
}

func (id *CacheID) UnmarshalText(data []byte) error {
	if id == nil {
		return ErrInvalidCacheID
	}
	parsed, err := ParseCacheID(string(data))
	if err != nil {
		return err
	}
	*id = parsed
	return nil
}

// ReadPersistentCacheID reads the server-owned identity of one cache root.
func ReadPersistentCacheID(root string) (CacheID, error) {
	data, err := safefile.ReadSmallRegular(root, CacheIDFileName, maxCacheIDBytes)
	if err != nil {
		return "", fmt.Errorf("read persistent cache ID: %w", err)
	}
	id, err := ParseCacheID(strings.TrimSpace(string(data)))
	if err != nil {
		return "", fmt.Errorf("read persistent cache ID: %w", err)
	}
	return id, nil
}

// EnsurePersistentCacheID creates an opaque ID once and returns the same value
// on every later process restart. Publication is atomic and never replaces an
// existing invalid identity.
func EnsurePersistentCacheID(root string) (CacheID, error) {
	if id, err := ReadPersistentCacheID(root); err == nil {
		return id, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	id, err := NewCacheID()
	if err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(root, ".cache-id-*")
	if err != nil {
		return "", fmt.Errorf("create temporary cache ID: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err = temporary.Chmod(0600); err == nil {
		_, err = temporary.WriteString(id.String() + "\n")
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", fmt.Errorf("write temporary cache ID: %w", err)
	}
	if err = os.Link(temporaryName, filepath.Join(root, CacheIDFileName)); err == nil {
		return id, nil
	}
	if errors.Is(err, os.ErrExist) {
		return ReadPersistentCacheID(root)
	}
	return "", fmt.Errorf("publish persistent cache ID: %w", err)
}
