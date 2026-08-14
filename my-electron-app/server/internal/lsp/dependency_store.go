package lsp

import (
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
)

const (
	personalDependencyStoreDirectory = "analysis-dependencies"
	personalDependencyOwnerDirectory = "users"
	personalDependencyMaxUserIDBytes = 128
	personalDependencyInspectEntries = 50_000
	personalDependencyInspectDepth   = 32
	windowsReparsePointAttribute     = 0x400
)

var (
	ErrPersonalDependencyStoreInUse = errors.New("personal analysis dependencies are currently in use")
	personalDependencyStates        sync.Map
)

type personalDependencyState struct {
	mu       sync.Mutex
	active   int
	clearing bool
}

type PersonalDependencyLease struct {
	Root     string
	state    *personalDependencyState
	released sync.Once
}

func (lease *PersonalDependencyLease) Release() {
	if lease == nil || lease.state == nil {
		return
	}
	lease.released.Do(func() {
		lease.state.mu.Lock()
		if lease.state.active > 0 {
			lease.state.active--
		}
		lease.state.mu.Unlock()
	})
}

// PersonalDependencyInspection is a bounded view of one user's server-owned
// analyzer dependencies. A truncated result must not be used as an exact quota
// value; it is intended for lightweight administration and status reporting.
type PersonalDependencyInspection struct {
	Root      string `json:"-"`
	Exists    bool   `json:"exists"`
	Bytes     int64  `json:"bytes"`
	Entries   int    `json:"entries"`
	Truncated bool   `json:"truncated"`
}

// PersonalDependencyRoot resolves and prepares a server-owned dependency
// directory inside the user's existing quota/account lifecycle root. Runtime
// publishers and analyzers must use AcquirePersonalDependencyStore so Clear
// cannot invalidate a path while it is in use. Client workspace or persistence
// paths are never incorporated.
func PersonalDependencyRoot(dataDir, userID string) (string, error) {
	dataRoot, components, root, err := personalDependencyLocation(dataDir, userID)
	if err != nil {
		return "", err
	}

	state := personalDependencyStateFor(root)
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.clearing {
		return "", ErrPersonalDependencyStoreInUse
	}
	if err := ensurePersonalDependencyRoot(dataRoot, components); err != nil {
		return "", err
	}
	return root, nil
}

// AcquirePersonalDependencyStore pins the server-owned root while a publisher
// or analyzer can access it. ClearPersonalDependencies fails closed until every
// lease has been released after the corresponding process exits.
func AcquirePersonalDependencyStore(dataDir, userID string) (*PersonalDependencyLease, error) {
	dataRoot, components, root, err := personalDependencyLocation(dataDir, userID)
	if err != nil {
		return nil, err
	}
	state := personalDependencyStateFor(root)
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.clearing {
		return nil, ErrPersonalDependencyStoreInUse
	}
	if err := ensurePersonalDependencyRoot(dataRoot, components); err != nil {
		return nil, err
	}
	state.active++
	return &PersonalDependencyLease{Root: root, state: state}, nil
}

func personalDependencyStateFor(root string) *personalDependencyState {
	key := filepath.Clean(root)
	created := &personalDependencyState{}
	actual, _ := personalDependencyStates.LoadOrStore(key, created)
	return actual.(*personalDependencyState)
}

func ensurePersonalDependencyRoot(dataRoot string, components []string) error {
	if err := ensurePersonalDependencyDataRoot(dataRoot); err != nil {
		return err
	}
	for _, component := range components {
		if err := ensurePersonalDependencyDirectory(component); err != nil {
			return err
		}
	}
	return nil
}

// InspectPersonalDependencies returns bounded storage usage for one user.
// Missing stores are reported with Exists=false and are not created.
func InspectPersonalDependencies(dataDir, userID string) (PersonalDependencyInspection, error) {
	dataRoot, components, root, err := personalDependencyLocation(dataDir, userID)
	if err != nil {
		return PersonalDependencyInspection{}, err
	}
	result := PersonalDependencyInspection{Root: root}
	state := personalDependencyStateFor(root)
	state.mu.Lock()
	defer state.mu.Unlock()

	exists, err := validatePersonalDependencyChain(dataRoot, components)
	if err != nil || !exists {
		return result, err
	}
	result.Exists = true
	if err := inspectPersonalDependencyDirectory(root, &result, personalDependencyInspectEntries, personalDependencyInspectDepth); err != nil {
		return PersonalDependencyInspection{}, err
	}
	return result, nil
}

// ClearPersonalDependencies removes one user's analyzer dependencies. The
// caller must stop that user's analyzer sessions before invoking this method.
func ClearPersonalDependencies(dataDir, userID string) error {
	dataRoot, components, root, err := personalDependencyLocation(dataDir, userID)
	if err != nil {
		return err
	}

	state := personalDependencyStateFor(root)
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.active > 0 || state.clearing {
		return ErrPersonalDependencyStoreInUse
	}
	state.clearing = true
	defer func() { state.clearing = false }()

	exists, err := validatePersonalDependencyChain(dataRoot, components)
	if err != nil || !exists {
		return err
	}
	if err := os.RemoveAll(root); err != nil {
		return fmt.Errorf("clear personal analysis dependencies: %w", err)
	}
	return nil
}

func personalDependencyLocation(dataDir, userID string) (string, []string, string, error) {
	dataDir = strings.TrimSpace(dataDir)
	if dataDir == "" || strings.ContainsRune(dataDir, '\x00') {
		return "", nil, "", fmt.Errorf("dependency data directory is required")
	}
	dataRoot, err := filepath.Abs(filepath.Clean(dataDir))
	if err != nil {
		return "", nil, "", fmt.Errorf("resolve dependency data directory: %w", err)
	}
	segment, err := personalDependencyOwnerSegment(userID)
	if err != nil {
		return "", nil, "", err
	}
	ownersRoot := filepath.Join(dataRoot, personalDependencyOwnerDirectory)
	ownerRoot := filepath.Join(ownersRoot, segment)
	root := filepath.Join(ownerRoot, personalDependencyStoreDirectory)
	relative, err := filepath.Rel(dataRoot, root)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", nil, "", fmt.Errorf("personal dependency path escaped the data directory")
	}
	return dataRoot, []string{ownersRoot, ownerRoot, root}, root, nil
}

func personalDependencyOwnerSegment(userID string) (string, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" || len(userID) > personalDependencyMaxUserIDBytes || strings.ContainsRune(userID, '\x00') {
		return "", fmt.Errorf("valid dependency user is required")
	}
	for _, char := range userID {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' && char != '_' {
			return "", fmt.Errorf("dependency user identity contains an unsafe character")
		}
	}
	return userID, nil
}

func ensurePersonalDependencyDataRoot(dataRoot string) error {
	info, err := os.Lstat(dataRoot)
	created := false
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(dataRoot, 0700); err != nil {
			return fmt.Errorf("create dependency data directory: %w", err)
		}
		created = true
		info, err = os.Lstat(dataRoot)
	}
	if err != nil {
		return fmt.Errorf("inspect dependency data directory: %w", err)
	}
	if err := validatePersonalDependencyComponent(dataRoot, info); err != nil {
		return err
	}
	if created {
		if err := os.Chmod(dataRoot, 0700); err != nil {
			return fmt.Errorf("secure dependency data directory: %w", err)
		}
	}
	return nil
}

func ensurePersonalDependencyDirectory(directory string) error {
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.Mkdir(directory, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("create personal dependency directory: %w", err)
		}
		info, err = os.Lstat(directory)
	}
	if err != nil {
		return fmt.Errorf("inspect personal dependency directory: %w", err)
	}
	if err := validatePersonalDependencyComponent(directory, info); err != nil {
		return err
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return fmt.Errorf("secure personal dependency directory: %w", err)
	}
	return nil
}

func validatePersonalDependencyChain(dataRoot string, components []string) (bool, error) {
	for _, component := range append([]string{dataRoot}, components...) {
		info, err := os.Lstat(component)
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, fmt.Errorf("inspect personal dependency path: %w", err)
		}
		if err := validatePersonalDependencyComponent(component, info); err != nil {
			return false, err
		}
	}
	return true, nil
}

func validatePersonalDependencyComponent(component string, info os.FileInfo) error {
	if personalDependencyLinkOrReparse(info) {
		return fmt.Errorf("personal dependency path component is a link or reparse point: %s", component)
	}
	if !info.IsDir() {
		return fmt.Errorf("personal dependency path component is not a directory: %s", component)
	}
	return nil
}

// FileInfo.Sys differs by platform. Reflection lets the shared implementation
// reject Windows reparse points without weakening Unix builds or adding a
// platform-specific file for this small storage boundary.
func personalDependencyLinkOrReparse(info os.FileInfo) bool {
	if info == nil || info.Mode()&os.ModeSymlink != 0 {
		return true
	}
	value := reflect.ValueOf(info.Sys())
	for value.IsValid() && (value.Kind() == reflect.Pointer || value.Kind() == reflect.Interface) {
		if value.IsNil() {
			return false
		}
		value = value.Elem()
	}
	if !value.IsValid() || value.Kind() != reflect.Struct {
		return false
	}
	for _, name := range []string{"FileAttributes", "Attributes"} {
		field := value.FieldByName(name)
		if !field.IsValid() {
			continue
		}
		switch field.Kind() {
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			return field.Uint()&windowsReparsePointAttribute != 0
		}
	}
	return false
}

type personalDependencyScanDirectory struct {
	path  string
	depth int
}

func inspectPersonalDependencyDirectory(root string, result *PersonalDependencyInspection, maxEntries, maxDepth int) error {
	if maxEntries <= 0 || maxDepth <= 0 {
		result.Truncated = true
		return nil
	}
	queue := []personalDependencyScanDirectory{{path: root}}
	for len(queue) > 0 {
		if result.Entries >= maxEntries {
			result.Truncated = true
			break
		}
		current := queue[0]
		queue = queue[1:]
		directory, err := os.Open(current.path)
		if err != nil {
			return fmt.Errorf("inspect personal dependency usage: %w", err)
		}
		remaining := maxEntries - result.Entries
		entries, readErr := directory.ReadDir(remaining + 1)
		closeErr := directory.Close()
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return fmt.Errorf("inspect personal dependency usage: %w", readErr)
		}
		if closeErr != nil {
			return fmt.Errorf("inspect personal dependency usage: %w", closeErr)
		}
		if len(entries) > remaining {
			entries = entries[:remaining]
			result.Truncated = true
		}
		for _, entry := range entries {
			result.Entries++
			info, err := entry.Info()
			if err != nil {
				return fmt.Errorf("inspect personal dependency entry: %w", err)
			}
			if info.IsDir() && !personalDependencyLinkOrReparse(info) {
				if current.depth+1 >= maxDepth {
					result.Truncated = true
				} else {
					queue = append(queue, personalDependencyScanDirectory{path: filepath.Join(current.path, entry.Name()), depth: current.depth + 1})
				}
				continue
			}
			if info.Mode().IsRegular() {
				size := info.Size()
				if size > 0 && result.Bytes > math.MaxInt64-size {
					result.Bytes = math.MaxInt64
					result.Truncated = true
				} else if size > 0 {
					result.Bytes += size
				}
			}
		}
		if result.Truncated && result.Entries >= maxEntries {
			break
		}
	}
	return nil
}
