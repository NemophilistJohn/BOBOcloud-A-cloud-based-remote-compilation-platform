package cachev2

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

type OwnerKind string

const (
	OwnerKindUser OwnerKind = "user"
	OwnerKindTeam OwnerKind = "team"
)

func (kind OwnerKind) Valid() bool {
	return kind == OwnerKindUser || kind == OwnerKindTeam
}

type Category string

const (
	CategoryDependencies Category = "dependencies"
	CategoryResults      Category = "results"
	CategoryToolchains   Category = "toolchains"
	CategoryIncremental  Category = "incremental"
)

var ErrInvalidCategory = errors.New("invalid cache category")

func (category Category) Valid() bool {
	switch category {
	case CategoryDependencies, CategoryResults, CategoryToolchains, CategoryIncremental:
		return true
	default:
		return false
	}
}

func (category Category) RelativePath() (string, error) {
	switch category {
	case CategoryDependencies:
		return DependenciesRelativePath, nil
	case CategoryResults:
		return ResultsRelativePath, nil
	case CategoryToolchains:
		return ToolchainsRelativePath, nil
	case CategoryIncremental:
		return IncrementalRelativePath, nil
	default:
		return "", fmt.Errorf("%w: %q", ErrInvalidCategory, category)
	}
}

type EntryState string

const (
	EntryStateCurrent    EntryState = "current"
	EntryStateReady      EntryState = "ready"
	EntryStateSuperseded EntryState = "superseded"
	EntryStateOrphaned   EntryState = "orphaned"
	EntryStateRetired    EntryState = "retired"
)

func (state EntryState) Valid() bool {
	switch state {
	case EntryStateCurrent, EntryStateReady, EntryStateSuperseded, EntryStateOrphaned, EntryStateRetired:
		return true
	default:
		return false
	}
}

// PackageInventorySummary is cheap catalog metadata. Packages are intentionally
// omitted and must be requested lazily for one dependency entry.
type PackageInventorySummary struct {
	State    string `json:"state"`
	Exact    bool   `json:"exact"`
	Deferred bool   `json:"deferred"`
	Count    int    `json:"count"`
	Revision string `json:"revision,omitempty"`
}

// Entry is the host-path-free cache record returned to handlers and clients.
type Entry struct {
	Schema               int                      `json:"schema"`
	ID                   CacheID                  `json:"id"`
	ParentID             CacheID                  `json:"parent_id,omitempty"`
	OwnerKind            OwnerKind                `json:"owner_kind"`
	OwnerID              string                   `json:"owner_id"`
	Category             Category                 `json:"category"`
	State                EntryState               `json:"state"`
	WorkspaceID          string                   `json:"workspace_id,omitempty"`
	WorkspaceName        string                   `json:"workspace_name,omitempty"`
	RuntimeID            string                   `json:"runtime_id,omitempty"`
	RuntimeFingerprint   string                   `json:"runtime_fingerprint,omitempty"`
	Language             string                   `json:"language,omitempty"`
	Tool                 string                   `json:"tool,omitempty"`
	ToolchainFingerprint string                   `json:"toolchain_fingerprint,omitempty"`
	DependencyDigest     string                   `json:"dependency_digest,omitempty"`
	ContentDigest        string                   `json:"content_digest,omitempty"`
	SourcePolicyDigest   string                   `json:"source_policy_digest,omitempty"`
	BuildTarget          string                   `json:"build_target,omitempty"`
	Profile              string                   `json:"profile,omitempty"`
	Generation           string                   `json:"generation,omitempty"`
	SizeBytes            int64                    `json:"size_bytes"`
	Files                int64                    `json:"files"`
	CreatedAt            time.Time                `json:"created_at"`
	LastUsedAt           time.Time                `json:"last_used_at"`
	ActiveReaders        int                      `json:"active_readers"`
	Writing              bool                     `json:"writing"`
	PackageInventory     *PackageInventorySummary `json:"package_inventory,omitempty"`
	Capabilities         map[string]bool          `json:"capabilities,omitempty"`
}

func (entry Entry) Validate() error {
	if entry.Schema != SchemaVersion {
		return fmt.Errorf("entry schema must be %d", SchemaVersion)
	}
	if !entry.ID.Valid() {
		return ErrInvalidCacheID
	}
	if entry.ParentID != "" && !entry.ParentID.Valid() {
		return ErrInvalidCacheID
	}
	if !entry.OwnerKind.Valid() || strings.TrimSpace(entry.OwnerID) == "" {
		return fmt.Errorf("entry owner is required")
	}
	if !entry.Category.Valid() {
		return fmt.Errorf("%w: %q", ErrInvalidCategory, entry.Category)
	}
	if !entry.State.Valid() {
		return fmt.Errorf("invalid cache entry state %q", entry.State)
	}
	if entry.SizeBytes < 0 || entry.Files < 0 || entry.ActiveReaders < 0 {
		return fmt.Errorf("cache entry usage cannot be negative")
	}
	if !entry.CreatedAt.IsZero() && !entry.LastUsedAt.IsZero() && entry.LastUsedAt.Before(entry.CreatedAt) {
		return fmt.Errorf("cache entry last-used time precedes creation")
	}
	return nil
}

// Inventory is the common quota and listing DTO for user and team owners.
type Inventory struct {
	Schema           int             `json:"schema"`
	Revision         string          `json:"revision"`
	OwnerKind        OwnerKind       `json:"owner_kind"`
	OwnerID          string          `json:"owner_id"`
	QuotaBytes       int64           `json:"quota_bytes"`
	UsedBytes        int64           `json:"used_bytes"`
	ReservedBytes    int64           `json:"reserved_bytes"`
	QuotaFiles       int64           `json:"quota_files"`
	UsedFiles        int64           `json:"used_files"`
	ReservedFiles    int64           `json:"reserved_files"`
	ManagedBytes     int64           `json:"managed_bytes"`
	ManagedFiles     int64           `json:"managed_files"`
	ReclaimableBytes int64           `json:"reclaimable_bytes"`
	ScanTruncated    bool            `json:"scan_truncated,omitempty"`
	GeneratedAt      time.Time       `json:"generated_at"`
	Entries          []Entry         `json:"entries"`
	Capabilities     map[string]bool `json:"capabilities,omitempty"`
}

func (inventory Inventory) Validate() error {
	if inventory.Schema != SchemaVersion {
		return fmt.Errorf("inventory schema must be %d", SchemaVersion)
	}
	if !inventory.OwnerKind.Valid() || strings.TrimSpace(inventory.OwnerID) == "" {
		return fmt.Errorf("inventory owner is required")
	}
	if strings.TrimSpace(inventory.Revision) == "" {
		return fmt.Errorf("inventory revision is required")
	}
	if inventory.QuotaBytes < 0 || inventory.UsedBytes < 0 || inventory.ReservedBytes < 0 ||
		inventory.QuotaFiles < 0 || inventory.UsedFiles < 0 || inventory.ReservedFiles < 0 ||
		inventory.ManagedBytes < 0 || inventory.ManagedFiles < 0 || inventory.ReclaimableBytes < 0 {
		return fmt.Errorf("cache inventory usage cannot be negative")
	}
	for index, entry := range inventory.Entries {
		if err := entry.Validate(); err != nil {
			return fmt.Errorf("inventory entry %d: %w", index, err)
		}
		if entry.OwnerKind != inventory.OwnerKind || entry.OwnerID != inventory.OwnerID {
			return fmt.Errorf("inventory entry %d belongs to another owner", index)
		}
	}
	return nil
}
