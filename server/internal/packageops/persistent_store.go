package packageops

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/safefile"
)

const (
	persistentPlanSchema       = "project-package-operation/v1"
	persistentPlanPending      = "pending"
	persistentPlanCompleted    = "completed"
	maxPersistentPlanBytes     = int64(32 << 10)
	minimumPersistentScanLimit = 1024
)

var packagePlanIDPattern = regexp.MustCompile(`^pkg_[0-9a-f]{32}$`)

type persistentPlanRecord struct {
	Schema             string                                `json:"schema"`
	State              string                                `json:"state"`
	PlanID             string                                `json:"planId"`
	UserID             string                                `json:"userId"`
	WorkspaceID        string                                `json:"workspaceId"`
	FolderKey          string                                `json:"folderKey"`
	RuntimeID          string                                `json:"runtimeId"`
	RuntimeFingerprint string                                `json:"runtimeFingerprint,omitempty"`
	Language           string                                `json:"language"`
	SourceID           string                                `json:"sourceId"`
	ManifestBindings   []model.ProjectPackageManifestBinding `json:"manifestBindings"`
	CreatedAt          int64                                 `json:"createdAt"`
	RecordedAt         int64                                 `json:"recordedAt"`
	ExpiresAt          int64                                 `json:"expiresAt"`
}

type loadedPersistentPlan struct {
	record persistentPlanRecord
	plan   ExecutionPlan
	name   string
}

// NewPersistentStoreWithLimits restores bounded completion records from one
// administrator-owned directory. Ordinary unclaimed plans remain in memory.
func NewPersistentStoreWithLimits(planTTL, completedTTL time.Duration, limits StoreLimits, directory string) (*Store, error) {
	store := newStoreWithLimits(planTTL, completedTTL, limits)
	directory = filepath.Clean(strings.TrimSpace(directory))
	if directory == "." || directory == "" {
		return nil, fmt.Errorf("package completion directory is required")
	}
	if err := ensurePersistentPlanDirectory(directory); err != nil {
		return nil, err
	}
	store.persistentDir = directory
	if err := store.loadPersistentPlans(); err != nil {
		return nil, err
	}
	return store, nil
}

func ensurePersistentPlanDirectory(directory string) error {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return fmt.Errorf("create package completion directory: %w", err)
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("package completion directory must be a real directory")
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return fmt.Errorf("secure package completion directory: %w", err)
	}
	return nil
}

func (s *Store) persistStateLocked(plan ExecutionPlan, recordedAt time.Time, state string) error {
	if s.persistentDir == "" {
		return nil
	}
	record := persistentPlanRecord{
		Schema: persistentPlanSchema, State: state, PlanID: plan.Public.PlanID,
		UserID: plan.UserID, WorkspaceID: plan.WorkspaceID, FolderKey: plan.FolderKey,
		RuntimeID: plan.RuntimeID, RuntimeFingerprint: plan.RuntimeFingerprint, Language: plan.Language, SourceID: plan.Public.Source.ID,
		ManifestBindings: append([]model.ProjectPackageManifestBinding(nil), plan.Public.ManifestBindings...),
		CreatedAt:        plan.CreatedAt.UTC().UnixMilli(), RecordedAt: recordedAt.UTC().UnixMilli(), ExpiresAt: plan.ExpiresAt.UTC().UnixMilli(),
	}
	if err := validatePersistentPlanRecord(record, s.completedTTL, recordedAt); err != nil {
		return fmt.Errorf("validate package completion record: %w", err)
	}
	payload, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if int64(len(payload)) > maxPersistentPlanBytes {
		return fmt.Errorf("package completion record exceeds %d bytes", maxPersistentPlanBytes)
	}
	if err := safefile.WriteAtomic(s.persistentDir, persistentPlanName(record.PlanID), append(payload, '\n'), 0600); err != nil {
		return fmt.Errorf("persist package completion record: %w", err)
	}
	return syncPersistentDirectory(s.persistentDir)
}

func (s *Store) removePersistentLocked(id string) error {
	if s == nil || s.persistentDir == "" || !packagePlanIDPattern.MatchString(id) {
		return nil
	}
	err := os.Remove(filepath.Join(s.persistentDir, persistentPlanName(id)))
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove package completion record: %w", err)
	}
	return nil
}

func (s *Store) loadPersistentPlans() error {
	directory, err := os.Open(s.persistentDir)
	if err != nil {
		return fmt.Errorf("open package completion directory: %w", err)
	}
	defer directory.Close()
	scanLimit := s.limits.MaxPlans * 16
	if scanLimit < minimumPersistentScanLimit {
		scanLimit = minimumPersistentScanLimit
	}
	loaded := make([]loadedPersistentPlan, 0)
	scanned := 0
	for {
		entries, readErr := directory.ReadDir(128)
		for _, entry := range entries {
			scanned++
			if scanned > scanLimit {
				return fmt.Errorf("package completion directory exceeds the bounded scan limit")
			}
			name := entry.Name()
			if strings.HasPrefix(name, ".bobo-meta-") {
				if err := os.Remove(filepath.Join(s.persistentDir, name)); err != nil && !os.IsNotExist(err) {
					return err
				}
				continue
			}
			planID := strings.TrimSuffix(name, ".json")
			if name != persistentPlanName(planID) || !packagePlanIDPattern.MatchString(planID) {
				continue
			}
			payload, readFileErr := safefile.ReadSmallRegular(s.persistentDir, name, maxPersistentPlanBytes)
			if readFileErr != nil {
				if err := removeInvalidPersistentPlan(s.persistentDir, name); err != nil {
					return err
				}
				continue
			}
			record, decodeErr := decodePersistentPlanRecord(payload)
			now := s.now().UTC()
			if decodeErr != nil || record.PlanID != planID || validatePersistentPlanRecord(record, s.completedTTL, now) != nil {
				if err := removeInvalidPersistentPlan(s.persistentDir, name); err != nil {
					return err
				}
				continue
			}
			if !time.UnixMilli(record.ExpiresAt).After(now) {
				if err := removeInvalidPersistentPlan(s.persistentDir, name); err != nil {
					return err
				}
				continue
			}
			plan := executionPlanFromPersistentRecord(record)
			loaded = append(loaded, loadedPersistentPlan{record: record, plan: plan, name: name})
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return fmt.Errorf("scan package completion directory: %w", readErr)
		}
	}
	sort.Slice(loaded, func(i, j int) bool {
		if loaded[i].record.RecordedAt == loaded[j].record.RecordedAt {
			return loaded[i].record.PlanID < loaded[j].record.PlanID
		}
		return loaded[i].record.RecordedAt > loaded[j].record.RecordedAt
	})
	for _, item := range loaded {
		reserved, reserveErr := s.completedReservationBytes(item.plan)
		if reserveErr != nil || !s.canReserveLocked(item.plan.UserID, reserved) {
			if err := removeInvalidPersistentPlan(s.persistentDir, item.name); err != nil {
				return err
			}
			continue
		}
		stored := &storedPlan{plan: item.plan, bytes: reserved}
		if item.record.State == persistentPlanCompleted {
			stored.completedResult, _ = completedMarkerPayload(item.record.PlanID)
		} else {
			stored.completionPending = true
		}
		s.plans[item.record.PlanID] = stored
		s.planCounts[item.plan.UserID]++
		s.planBytes[item.plan.UserID] += reserved
		s.totalPlanBytes += reserved
		_ = os.Chmod(filepath.Join(s.persistentDir, item.name), 0600)
	}
	return nil
}

func (s *Store) completedReservationBytes(plan ExecutionPlan) (int64, error) {
	budgetPlan := plan
	budgetPlan.Public.ExpiresAt = maxEncodedUnixMillis
	cloned, payload, err := cloneExecutionPlan(budgetPlan)
	if err != nil {
		return 0, err
	}
	return executionPlanBytes(cloned, payload) + s.limits.MaxResultBytes, nil
}

func (s *Store) canReserveLocked(userID string, bytes int64) bool {
	return len(s.plans) < s.limits.MaxPlans && s.planCounts[userID] < s.limits.MaxPlansPerUser &&
		bytes <= s.limits.MaxBytes && bytes <= s.limits.MaxBytesPerUser &&
		s.totalPlanBytes <= s.limits.MaxBytes-bytes && s.planBytes[userID] <= s.limits.MaxBytesPerUser-bytes
}

func decodePersistentPlanRecord(payload []byte) (persistentPlanRecord, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var record persistentPlanRecord
	if err := decoder.Decode(&record); err != nil {
		return persistentPlanRecord{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return persistentPlanRecord{}, fmt.Errorf("package completion record contains trailing data")
	}
	return record, nil
}

func validatePersistentPlanRecord(record persistentPlanRecord, ttl time.Duration, now time.Time) error {
	if record.Schema != persistentPlanSchema || (record.State != persistentPlanPending && record.State != persistentPlanCompleted) || !packagePlanIDPattern.MatchString(record.PlanID) {
		return fmt.Errorf("invalid package completion record identity")
	}
	for _, value := range []string{record.UserID, record.FolderKey, record.RuntimeID, record.Language, record.SourceID} {
		if !validPersistentIdentity(value) {
			return fmt.Errorf("invalid package completion binding")
		}
	}
	if !validPersistentWorkspaceIdentity(record.WorkspaceID) {
		return fmt.Errorf("invalid package completion workspace binding")
	}
	if !validPersistentRuntimeFingerprint(record.RuntimeFingerprint, record.RuntimeID) {
		return fmt.Errorf("invalid package completion runtime fingerprint")
	}
	if len(record.ManifestBindings) != 1 || !validPersistentManifestBinding(record.ManifestBindings[0]) {
		return fmt.Errorf("invalid package completion manifest binding")
	}
	createdAt, recordedAt, expiresAt := time.UnixMilli(record.CreatedAt), time.UnixMilli(record.RecordedAt), time.UnixMilli(record.ExpiresAt)
	if record.CreatedAt <= 0 || record.RecordedAt <= 0 || record.ExpiresAt <= 0 || createdAt.After(recordedAt) || !expiresAt.After(recordedAt) || expiresAt.After(recordedAt.Add(ttl+time.Second)) || recordedAt.After(now.Add(5*time.Minute)) {
		return fmt.Errorf("invalid package completion lifetime")
	}
	return nil
}

func validPersistentIdentity(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len([]byte(value)) > 512 {
		return false
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return false
		}
	}
	return true
}

func validPersistentWorkspaceIdentity(value string) bool {
	if strings.TrimSpace(value) == "" || len([]byte(value)) > 512 {
		return false
	}
	for _, char := range value {
		if unicode.IsControl(char) && char != 0 {
			return false
		}
	}
	return true
}

func validPersistentRuntimeFingerprint(value, runtimeID string) bool {
	if value == "" {
		return true
	}
	if len([]byte(value)) > 2048 {
		return false
	}
	parts := strings.Split(value, "\x00")
	if len(parts) != 3 || parts[0] != strings.TrimSpace(parts[0]) || parts[0] != strings.TrimSpace(runtimeID) || parts[1] != strings.TrimSpace(parts[1]) || parts[1] == "" || parts[2] != strings.TrimSpace(parts[2]) {
		return false
	}
	for _, part := range parts {
		for _, char := range part {
			if unicode.IsControl(char) {
				return false
			}
		}
	}
	return true
}

func validPersistentManifestBinding(binding model.ProjectPackageManifestBinding) bool {
	clean := path.Clean(strings.TrimSpace(binding.Path))
	if clean == "." || clean != binding.Path || strings.HasPrefix(clean, "/") || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, "\\") || len(clean) > 512 || !isRequirementsManifest(clean) {
		return false
	}
	decoded, err := hex.DecodeString(binding.SHA256)
	return err == nil && len(decoded) == 32 && binding.SHA256 == strings.ToLower(binding.SHA256)
}

func executionPlanFromPersistentRecord(record persistentPlanRecord) ExecutionPlan {
	expiresAt := time.UnixMilli(record.ExpiresAt).UTC()
	return ExecutionPlan{
		Public: model.ProjectPackageChangePlan{
			PlanID: record.PlanID, ExpiresAt: record.ExpiresAt, Source: model.PackageCenterSource{ID: record.SourceID},
			ManifestBindings: append([]model.ProjectPackageManifestBinding(nil), record.ManifestBindings...),
		},
		UserID: record.UserID, WorkspaceID: record.WorkspaceID, FolderKey: record.FolderKey,
		RuntimeID: record.RuntimeID, RuntimeFingerprint: record.RuntimeFingerprint, Language: record.Language,
		CreatedAt: time.UnixMilli(record.CreatedAt).UTC(), ExpiresAt: expiresAt,
	}
}

func persistentPlanName(id string) string { return id + ".json" }

func removeInvalidPersistentPlan(directory, name string) error {
	err := os.Remove(filepath.Join(directory, name))
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove invalid package completion record: %w", err)
	}
	return nil
}
