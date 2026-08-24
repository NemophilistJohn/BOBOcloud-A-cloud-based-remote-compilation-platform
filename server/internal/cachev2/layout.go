package cachev2

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	RootDirectoryName         = "cache-v2"
	UsersDirectoryName        = "users"
	ArtifactsDirectoryName    = "artifacts"
	DependenciesDirectoryName = "dependencies"
	ResultsDirectoryName      = "results"
	MutableDirectoryName      = "mutable"
	ToolchainsDirectoryName   = "toolchains"
	IncrementalDirectoryName  = "incremental"
	RegistryDirectoryName     = "registry"
	TransactionsDirectoryName = "transactions"
	RetiredDirectoryName      = "retired"

	DependenciesRelativePath = ArtifactsDirectoryName + "/" + DependenciesDirectoryName
	ResultsRelativePath      = ArtifactsDirectoryName + "/" + ResultsDirectoryName
	ToolchainsRelativePath   = MutableDirectoryName + "/" + ToolchainsDirectoryName
	IncrementalRelativePath  = MutableDirectoryName + "/" + IncrementalDirectoryName
)

const (
	maxLogicalSegmentBytes = 4096
	maxPathSegmentBytes    = 255
	safeSegmentPrefixBytes = 24
	safeSegmentDigestBytes = 12
)

var ErrInvalidPathSegment = errors.New("invalid cache path segment")

// Layout contains host-only paths for one user's cache-v2 namespace.
type Layout struct {
	DataDir      string
	UserID       string
	UserRoot     string
	Root         string
	SchemaMarker string
	Artifacts    string
	Dependencies string
	Results      string
	Mutable      string
	Toolchains   string
	Incremental  string
	Registry     string
	Transactions string
	Retired      string
}

// NewUserLayout resolves a user's cache-v2 paths without touching the filesystem.
func NewUserLayout(dataDir, userID string) (Layout, error) {
	if strings.TrimSpace(dataDir) == "" || strings.ContainsRune(dataDir, '\x00') {
		return Layout{}, fmt.Errorf("data directory is required")
	}
	if err := ValidatePathSegment(userID); err != nil {
		return Layout{}, fmt.Errorf("user ID: %w", err)
	}

	dataDir = filepath.Clean(dataDir)
	userRoot := filepath.Join(dataDir, UsersDirectoryName, userID)
	root := filepath.Join(userRoot, RootDirectoryName)
	return Layout{
		DataDir:      dataDir,
		UserID:       userID,
		UserRoot:     userRoot,
		Root:         root,
		SchemaMarker: filepath.Join(root, SchemaMarkerFileName),
		Artifacts:    filepath.Join(root, ArtifactsDirectoryName),
		Dependencies: filepath.Join(root, filepath.FromSlash(DependenciesRelativePath)),
		Results:      filepath.Join(root, filepath.FromSlash(ResultsRelativePath)),
		Mutable:      filepath.Join(root, MutableDirectoryName),
		Toolchains:   filepath.Join(root, filepath.FromSlash(ToolchainsRelativePath)),
		Incremental:  filepath.Join(root, filepath.FromSlash(IncrementalRelativePath)),
		Registry:     filepath.Join(root, RegistryDirectoryName),
		Transactions: filepath.Join(root, TransactionsDirectoryName),
		Retired:      filepath.Join(root, RetiredDirectoryName),
	}, nil
}

// RequiredDirectories returns the managed directories in parent-before-child order.
func (layout Layout) RequiredDirectories() []string {
	return []string{
		layout.Artifacts,
		layout.Dependencies,
		layout.Results,
		layout.Mutable,
		layout.Toolchains,
		layout.Incremental,
		layout.Registry,
		layout.Transactions,
		layout.Retired,
	}
}

// CategoryRoot resolves the content root for a public cache category.
func (layout Layout) CategoryRoot(category Category) (string, error) {
	switch category {
	case CategoryDependencies:
		return layout.Dependencies, nil
	case CategoryResults:
		return layout.Results, nil
	case CategoryToolchains:
		return layout.Toolchains, nil
	case CategoryIncremental:
		return layout.Incremental, nil
	default:
		return "", fmt.Errorf("%w: %q", ErrInvalidCategory, category)
	}
}

// SafeSegment converts an arbitrary logical identity into one portable,
// deterministic path segment. The digest prevents collisions after sanitizing.
func SafeSegment(value string) (string, error) {
	if strings.TrimSpace(value) == "" || len(value) > maxLogicalSegmentBytes || !utf8.ValidString(value) || strings.ContainsRune(value, '\x00') {
		return "", ErrInvalidPathSegment
	}

	readable := make([]byte, 0, safeSegmentPrefixBytes)
	for index := 0; index < len(value) && len(readable) < safeSegmentPrefixBytes; index++ {
		char := value[index]
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' {
			readable = append(readable, char)
		}
	}
	if len(readable) == 0 {
		readable = append(readable, 'x')
	}
	digest := sha256.Sum256([]byte(value))
	return string(readable) + "-" + hex.EncodeToString(digest[:safeSegmentDigestBytes]), nil
}

// ValidatePathSegment validates an already-segmented owner identifier. Logical
// workspace/runtime identities should use SafeSegment instead.
func ValidatePathSegment(value string) error {
	if value == "" || strings.TrimSpace(value) != value || len(value) > maxPathSegmentBytes || !utf8.ValidString(value) {
		return ErrInvalidPathSegment
	}
	if value == "." || value == ".." || strings.ContainsAny(value, "/\\\x00<>:\"|?*") || strings.HasSuffix(value, ".") {
		return ErrInvalidPathSegment
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return ErrInvalidPathSegment
		}
	}
	base := strings.ToUpper(strings.SplitN(value, ".", 2)[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		(len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9') {
		return ErrInvalidPathSegment
	}
	return nil
}

func ensureRealDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return fmt.Errorf("create cache directory %q: %w", path, err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect cache directory %q: %w", path, err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("cache directory %q must be a real directory", path)
	}
	return nil
}
