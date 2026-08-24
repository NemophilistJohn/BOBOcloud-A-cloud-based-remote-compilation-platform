package cachev2

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"bobocloud-server/internal/safefile"
)

const (
	SchemaVersion        = 2
	SchemaFormat         = "bobocloud-cache"
	SchemaMarkerFileName = ".cache-schema.json"
	schemaMarkerMaxBytes = 4096
)

var (
	ErrSchemaMarkerMissing = errors.New("cache-v2 schema marker is missing")
	ErrIncompatibleSchema  = errors.New("incompatible cache schema")
	layoutInitialization   sync.Map
)

// SchemaMarker prevents an unmarked or legacy directory from being adopted as
// cache-v2 storage.
type SchemaMarker struct {
	Schema    int       `json:"schema"`
	Format    string    `json:"format"`
	OwnerKind OwnerKind `json:"owner_kind"`
	OwnerID   string    `json:"owner_id"`
	CreatedAt time.Time `json:"created_at"`
}

func (marker SchemaMarker) Validate() error {
	if marker.Schema != SchemaVersion || marker.Format != SchemaFormat {
		return fmt.Errorf("%w: schema=%d format=%q", ErrIncompatibleSchema, marker.Schema, marker.Format)
	}
	if !marker.OwnerKind.Valid() {
		return fmt.Errorf("%w: invalid owner kind %q", ErrIncompatibleSchema, marker.OwnerKind)
	}
	if err := ValidatePathSegment(marker.OwnerID); err != nil {
		return fmt.Errorf("%w: invalid owner ID", ErrIncompatibleSchema)
	}
	if marker.CreatedAt.IsZero() {
		return fmt.Errorf("%w: marker creation time is missing", ErrIncompatibleSchema)
	}
	return nil
}

func ReadSchemaMarker(root string) (SchemaMarker, error) {
	data, err := safefile.ReadSmallRegular(root, SchemaMarkerFileName, schemaMarkerMaxBytes)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return SchemaMarker{}, fmt.Errorf("%w: %v", ErrSchemaMarkerMissing, err)
		}
		return SchemaMarker{}, fmt.Errorf("read cache schema marker: %w", err)
	}
	var marker SchemaMarker
	if err := json.Unmarshal(data, &marker); err != nil {
		return SchemaMarker{}, fmt.Errorf("%w: decode marker: %v", ErrIncompatibleSchema, err)
	}
	if err := marker.Validate(); err != nil {
		return SchemaMarker{}, err
	}
	return marker, nil
}

// EnsureUserLayout initializes an empty namespace or validates an existing
// cache-v2 namespace. Missing markers in non-empty roots fail closed.
func EnsureUserLayout(dataDir, userID string) (Layout, SchemaMarker, error) {
	layout, err := NewUserLayout(dataDir, userID)
	if err != nil {
		return Layout{}, SchemaMarker{}, err
	}
	for _, directory := range []string{
		layout.DataDir,
		filepath.Join(layout.DataDir, UsersDirectoryName),
		layout.UserRoot,
		layout.Root,
	} {
		if err := ensureRealDirectory(directory); err != nil {
			return Layout{}, SchemaMarker{}, err
		}
	}
	gate := initializationGate(layout.Root)
	gate.Lock()
	defer gate.Unlock()

	marker, err := ReadSchemaMarker(layout.Root)
	if errors.Is(err, ErrSchemaMarkerMissing) {
		empty, emptyErr := directoryEmpty(layout.Root)
		if emptyErr != nil {
			return Layout{}, SchemaMarker{}, emptyErr
		}
		if !empty {
			return Layout{}, SchemaMarker{}, ErrSchemaMarkerMissing
		}
		marker = SchemaMarker{
			Schema:    SchemaVersion,
			Format:    SchemaFormat,
			OwnerKind: OwnerKindUser,
			OwnerID:   userID,
			CreatedAt: time.Now().UTC(),
		}
		if createErr := createSchemaMarker(layout.Root, marker); createErr != nil {
			if !errors.Is(createErr, os.ErrExist) {
				return Layout{}, SchemaMarker{}, createErr
			}
			marker, err = ReadSchemaMarker(layout.Root)
		} else {
			err = nil
		}
	}
	if err != nil {
		return Layout{}, SchemaMarker{}, err
	}
	if marker.OwnerKind != OwnerKindUser || marker.OwnerID != userID {
		return Layout{}, SchemaMarker{}, fmt.Errorf("%w: marker owner does not match cache root", ErrIncompatibleSchema)
	}

	for _, directory := range layout.RequiredDirectories() {
		if err := ensureRealDirectory(directory); err != nil {
			return Layout{}, SchemaMarker{}, err
		}
	}
	return layout, marker, nil
}

func createSchemaMarker(root string, marker SchemaMarker) error {
	data, err := json.Marshal(marker)
	if err != nil {
		return fmt.Errorf("encode cache schema marker: %w", err)
	}
	data = append(data, '\n')
	file, err := os.CreateTemp(root, ".cache-schema-*")
	if err != nil {
		return fmt.Errorf("create temporary cache schema marker: %w", err)
	}
	temporaryName := file.Name()
	defer os.Remove(temporaryName)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("write cache schema marker: %w", err)
	}
	if err := os.Link(temporaryName, filepath.Join(root, SchemaMarkerFileName)); err != nil {
		return fmt.Errorf("publish cache schema marker: %w", err)
	}
	return nil
}

func initializationGate(root string) *sync.Mutex {
	value, _ := layoutInitialization.LoadOrStore(filepath.Clean(root), &sync.Mutex{})
	return value.(*sync.Mutex)
}

func directoryEmpty(path string) (bool, error) {
	directory, err := os.Open(path)
	if err != nil {
		return false, fmt.Errorf("open cache root: %w", err)
	}
	defer directory.Close()
	_, err = directory.Readdirnames(1)
	if errors.Is(err, io.EOF) {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect cache root: %w", err)
	}
	return false, nil
}
