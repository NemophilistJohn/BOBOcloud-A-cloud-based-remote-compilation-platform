package cachev2

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestCacheIDUsesOnlyOpaqueRandomBytes(t *testing.T) {
	id, err := newCacheID(bytes.NewReader(make([]byte, cacheIDBytes)))
	if err != nil {
		t.Fatal(err)
	}
	want := CacheIDPrefix + strings.Repeat("0", cacheIDBytes*2)
	if id.String() != want || !id.Valid() {
		t.Fatalf("cache ID = %q, want %q", id, want)
	}
	parsed, err := ParseCacheID(id.String())
	if err != nil || parsed != id {
		t.Fatalf("parsed ID = %q, %v", parsed, err)
	}
}

func TestNewCacheIDIsUniqueAndCanonical(t *testing.T) {
	seen := make(map[CacheID]bool)
	for index := 0; index < 512; index++ {
		id, err := NewCacheID()
		if err != nil {
			t.Fatal(err)
		}
		if !id.Valid() || seen[id] {
			t.Fatalf("invalid or duplicate cache ID %q", id)
		}
		seen[id] = true
	}
}

func TestParseCacheIDRejectsAliasesAndBusinessData(t *testing.T) {
	for _, value := range []string{
		"", "cv2_", "CV2_" + strings.Repeat("0", cacheIDBytes*2),
		CacheIDPrefix + strings.Repeat("A", cacheIDBytes*2),
		CacheIDPrefix + strings.Repeat("0", cacheIDBytes*2-1),
		CacheIDPrefix + strings.Repeat("g", cacheIDBytes*2),
		"cv2_root_python_project",
	} {
		if _, err := ParseCacheID(value); !errors.Is(err, ErrInvalidCacheID) {
			t.Errorf("invalid cache ID %q error = %v", value, err)
		}
	}
}

func TestCacheIDJSONRejectsInvalidValues(t *testing.T) {
	type document struct {
		ID CacheID `json:"id"`
	}
	id, err := NewCacheID()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(document{ID: id})
	if err != nil {
		t.Fatal(err)
	}
	var decoded document
	if err := json.Unmarshal(payload, &decoded); err != nil || decoded.ID != id {
		t.Fatalf("decoded ID = %q, %v", decoded.ID, err)
	}
	if err := json.Unmarshal([]byte(`{"id":"project/python"}`), &decoded); err == nil {
		t.Fatal("invalid cache ID was accepted from JSON")
	}
}

func TestNewCacheIDPropagatesEntropyFailure(t *testing.T) {
	if _, err := newCacheID(errorReader{}); err == nil {
		t.Fatal("entropy failure was ignored")
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) {
	return 0, io.ErrUnexpectedEOF
}
