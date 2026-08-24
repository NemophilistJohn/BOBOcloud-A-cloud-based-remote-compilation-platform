package packageops

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"bobocloud-server/internal/model"
)

var (
	ErrPlanNotFound       = errors.New("package change plan was not found or has expired")
	ErrPlanInUse          = errors.New("package change plan is already being applied")
	ErrPlanReconciliation = errors.New("package change plan completion requires reconciliation")
	ErrPlanCompleted      = errors.New("package change plan was already applied")
	ErrPlanNotClaimed     = errors.New("package change plan is not being applied")
	ErrPlanCapacity       = errors.New("package change plan capacity is exhausted")
	ErrPlanResultTooLarge = errors.New("package change result exceeds the retained result limit")
)

const (
	defaultMaxPlansPerUser = 32
	defaultMaxPlanBytes    = int64(64 << 20)
	defaultMaxUserBytes    = int64(16 << 20)
	defaultMaxResultBytes  = int64(1 << 20)
	minimumMaxResultBytes  = int64(4 << 10)
	storedPlanOverhead     = int64(512)
	maxEncodedUnixMillis   = int64(1<<63 - 1)
)

type StoreLimits struct {
	MaxPlans        int
	MaxPlansPerUser int
	MaxBytes        int64
	MaxBytesPerUser int64
	MaxResultBytes  int64
}

type ExecutionPlan struct {
	Public             model.ProjectPackageChangePlan
	UserID             string
	WorkspaceID        string
	FolderKey          string
	RuntimeID          string
	RuntimeFingerprint string
	Language           string
	InstallURL         string
	CreatedAt          time.Time
	ExpiresAt          time.Time
}

type storedPlan struct {
	plan              ExecutionPlan
	completedResult   []byte
	active            bool
	completionPending bool
	bytes             int64
}

type Store struct {
	mu             sync.Mutex
	ttl            time.Duration
	completedTTL   time.Duration
	limits         StoreLimits
	persistentDir  string
	plans          map[string]*storedPlan
	planCounts     map[string]int
	planBytes      map[string]int64
	totalPlanBytes int64
	now            func() time.Time
}

func NewStore(ttl time.Duration, maxPlans int) *Store {
	return NewStoreWithLimits(ttl, StoreLimits{MaxPlans: maxPlans})
}

func NewStoreWithLimits(ttl time.Duration, limits StoreLimits) *Store {
	return newStoreWithLimits(ttl, ttl, limits)
}

func newStoreWithLimits(ttl, completedTTL time.Duration, limits StoreLimits) *Store {
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	if completedTTL <= 0 {
		completedTTL = ttl
	}
	if limits.MaxPlans <= 0 {
		limits.MaxPlans = 512
	}
	if limits.MaxPlansPerUser <= 0 {
		limits.MaxPlansPerUser = defaultMaxPlansPerUser
	}
	if limits.MaxPlansPerUser > limits.MaxPlans {
		limits.MaxPlansPerUser = limits.MaxPlans
	}
	if limits.MaxBytes <= 0 {
		limits.MaxBytes = defaultMaxPlanBytes
	}
	if limits.MaxBytesPerUser <= 0 {
		limits.MaxBytesPerUser = defaultMaxUserBytes
	}
	if limits.MaxBytesPerUser > limits.MaxBytes {
		limits.MaxBytesPerUser = limits.MaxBytes
	}
	if limits.MaxResultBytes <= 0 {
		limits.MaxResultBytes = defaultMaxResultBytes
	} else if limits.MaxResultBytes < minimumMaxResultBytes {
		limits.MaxResultBytes = minimumMaxResultBytes
	}
	maxResultBytes := limits.MaxBytes
	if limits.MaxBytesPerUser < maxResultBytes {
		maxResultBytes = limits.MaxBytesPerUser
	}
	maxResultBytes -= storedPlanOverhead
	if maxResultBytes < minimumMaxResultBytes {
		maxResultBytes = minimumMaxResultBytes
	}
	if limits.MaxResultBytes > maxResultBytes {
		limits.MaxResultBytes = maxResultBytes
	}
	return &Store{
		ttl: ttl, completedTTL: completedTTL, limits: limits, plans: make(map[string]*storedPlan),
		planCounts: make(map[string]int), planBytes: make(map[string]int64), now: time.Now,
	}
}

func (s *Store) Put(plan ExecutionPlan) (ExecutionPlan, error) {
	if s == nil {
		return ExecutionPlan{}, ErrPlanNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked()
	id, err := randomPlanID()
	if err != nil {
		return ExecutionPlan{}, err
	}
	now := s.now().UTC()
	plan.CreatedAt, plan.ExpiresAt = now, now.Add(s.ttl)
	plan.Public.PlanID = id
	plan.Public.ExpiresAt = plan.ExpiresAt.UnixMilli()
	storedCopy, payload, err := cloneExecutionPlan(plan)
	if err != nil {
		return ExecutionPlan{}, err
	}
	planBytes := executionPlanBytes(storedCopy, payload)
	markerPayload, err := completedMarkerPayload(id)
	if err != nil {
		return ExecutionPlan{}, err
	}
	completedIdentity := completedPlanIdentity(storedCopy, storedCopy.ExpiresAt)
	// Reserve against the longest int64 timestamp encoding so completion cannot
	// cross an epoch digit boundary and exceed the admitted byte budget.
	completedIdentity.Public.ExpiresAt = maxEncodedUnixMillis
	completedIdentity, completedPublicPayload, err := cloneExecutionPlan(completedIdentity)
	if err != nil {
		return ExecutionPlan{}, err
	}
	completedPayloadBytes := s.limits.MaxResultBytes
	if int64(len(markerPayload)) > completedPayloadBytes {
		completedPayloadBytes = int64(len(markerPayload))
	}
	completedBytes := executionPlanBytes(completedIdentity, completedPublicPayload) + completedPayloadBytes
	reservedBytes := planBytes
	if completedBytes > reservedBytes {
		reservedBytes = completedBytes
	}
	if len(s.plans) >= s.limits.MaxPlans || s.planCounts[plan.UserID] >= s.limits.MaxPlansPerUser ||
		reservedBytes > s.limits.MaxBytes || reservedBytes > s.limits.MaxBytesPerUser ||
		s.totalPlanBytes > s.limits.MaxBytes-reservedBytes || s.planBytes[plan.UserID] > s.limits.MaxBytesPerUser-reservedBytes {
		return ExecutionPlan{}, ErrPlanCapacity
	}
	s.plans[id] = &storedPlan{plan: storedCopy, bytes: reservedBytes}
	s.planCounts[plan.UserID]++
	s.planBytes[plan.UserID] += reservedBytes
	s.totalPlanBytes += reservedBytes
	return plan, nil
}

func (s *Store) Claim(id, userID string) (ExecutionPlan, error) {
	plan, completed, err := s.ClaimOrCompleted(id, userID)
	if err != nil {
		return ExecutionPlan{}, err
	}
	if completed != nil {
		return ExecutionPlan{}, ErrPlanCompleted
	}
	return plan, nil
}

// ClaimOrCompleted atomically distinguishes a new execution claim from a
// retained successful result. A completed result is returned together with the
// minimal plan identity needed to validate the replay request.
func (s *Store) ClaimOrCompleted(id, userID string) (plan ExecutionPlan, completed *model.ProjectPackageChangeResult, err error) {
	if s == nil {
		return ExecutionPlan{}, nil, ErrPlanNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked()
	stored := s.plans[id]
	if stored == nil || stored.plan.UserID != userID {
		return ExecutionPlan{}, nil, ErrPlanNotFound
	}
	if stored.completedResult != nil {
		result, decodeErr := decodeChangeResult(stored.completedResult)
		if decodeErr != nil {
			return ExecutionPlan{}, nil, decodeErr
		}
		identity, _, cloneErr := cloneExecutionPlan(stored.plan)
		if cloneErr != nil {
			return ExecutionPlan{}, nil, cloneErr
		}
		return identity, &result, nil
	}
	if stored.completionPending && !stored.active {
		identity, _, cloneErr := cloneExecutionPlan(stored.plan)
		if cloneErr != nil {
			return ExecutionPlan{}, nil, cloneErr
		}
		return identity, nil, ErrPlanReconciliation
	}
	if stored.active || stored.completionPending {
		return ExecutionPlan{}, nil, ErrPlanInUse
	}
	result, _, err := cloneExecutionPlan(stored.plan)
	if err != nil {
		return ExecutionPlan{}, nil, err
	}
	stored.active = true
	return result, nil, nil
}

// BeginCompletionIntent durably records the identity of a claimed operation
// before any dependency generation can be published.
func (s *Store) BeginCompletionIntent(id, userID string) error {
	if s == nil {
		return ErrPlanNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked()
	stored := s.plans[id]
	if stored == nil || stored.plan.UserID != userID {
		return ErrPlanNotFound
	}
	if stored.completedResult != nil {
		return nil
	}
	if !stored.active {
		return ErrPlanNotClaimed
	}
	if stored.completionPending {
		return nil
	}
	now := s.now().UTC()
	intent := stored.plan
	intent.ExpiresAt = now.Add(s.completedTTL)
	intent.Public.ExpiresAt = intent.ExpiresAt.UnixMilli()
	if err := s.persistStateLocked(intent, now, persistentPlanPending); err != nil {
		return err
	}
	stored.plan.ExpiresAt = intent.ExpiresAt
	stored.plan.Public.ExpiresAt = intent.Public.ExpiresAt
	stored.completionPending = true
	return nil
}

// CancelCompletionIntent makes a known-failed, unpublished operation retryable.
func (s *Store) CancelCompletionIntent(id, userID string) error {
	if s == nil {
		return ErrPlanNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	stored := s.plans[id]
	if stored == nil || stored.plan.UserID != userID {
		return ErrPlanNotFound
	}
	if stored.completedResult != nil || !stored.completionPending {
		return nil
	}
	if err := s.removePersistentLocked(id); err != nil {
		return err
	}
	stored.completionPending = false
	return nil
}

func (s *Store) Release(id string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if stored := s.plans[id]; stored != nil {
		if stored.completedResult != nil || stored.completionPending {
			return
		}
		if !stored.plan.ExpiresAt.After(s.now()) {
			s.deleteLocked(id)
		} else {
			stored.active = false
		}
	}
}

// CompleteWithResult changes an active plan into a user-bound completed
// tombstone. A repeated completion by the same user is idempotent and keeps the
// first successful result authoritative.
func (s *Store) CompleteWithResult(id, userID string, result model.ProjectPackageChangeResult) error {
	if s == nil {
		return ErrPlanNotFound
	}
	result.PlanID = id
	payload, err := json.Marshal(result)
	completionErr := err
	if err != nil {
		payload, err = completedMarkerPayload(id)
		if err != nil {
			return errors.Join(completionErr, err)
		}
	} else if int64(len(payload)) > s.limits.MaxResultBytes {
		completionErr = ErrPlanResultTooLarge
		payload, err = completedMarkerPayload(id)
		if err != nil {
			return errors.Join(completionErr, err)
		}
	}
	alreadyCompleted, err := s.completeWithPayload(id, userID, payload)
	if err != nil {
		return err
	}
	if alreadyCompleted {
		return nil
	}
	return completionErr
}

// MarkCompleted records a bounded success marker after an irreversible apply.
// Unlike CompleteWithResult, the fixed marker is not subject to MaxResultBytes;
// Put reserves enough space for it before the plan is admitted.
func (s *Store) MarkCompleted(id, userID string) error {
	if s == nil {
		return ErrPlanNotFound
	}
	payload, err := completedMarkerPayload(id)
	if err != nil {
		return err
	}
	_, err = s.completeWithPayload(id, userID, payload)
	return err
}

func (s *Store) completeWithPayload(id, userID string, payload []byte) (alreadyCompleted bool, err error) {
	if s == nil {
		return false, ErrPlanNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked()
	stored := s.plans[id]
	if stored == nil || stored.plan.UserID != userID {
		return false, ErrPlanNotFound
	}
	if stored.completedResult != nil {
		return true, nil
	}
	if !stored.active && !stored.completionPending {
		return false, ErrPlanNotClaimed
	}
	now := s.now().UTC()
	identity := completedPlanIdentity(stored.plan, now.Add(s.completedTTL))
	stored.completionPending = true
	if err := s.persistStateLocked(identity, now, persistentPlanCompleted); err != nil {
		return false, err
	}
	stored.plan = identity
	stored.completedResult = append([]byte(nil), payload...)
	stored.active = false
	stored.completionPending = false
	return false, nil
}

func (s *Store) Complete(id string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	if stored := s.plans[id]; stored == nil || (stored.completedResult == nil && !stored.completionPending) {
		s.deleteLocked(id)
	}
	s.mu.Unlock()
}

func (s *Store) cleanupLocked() {
	now := s.now()
	for id, stored := range s.plans {
		if !stored.active && !stored.plan.ExpiresAt.After(now) {
			s.deleteLocked(id)
		}
	}
}

// DeleteUser removes active plans and durable completion records owned by a
// deleted account. It is idempotent and never crosses the user binding.
func (s *Store) DeleteUser(userID string) error {
	if s == nil || userID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var cleanupErrors []error
	for id, stored := range s.plans {
		if stored.plan.UserID != userID {
			continue
		}
		if err := s.removePersistentLocked(id); err != nil {
			cleanupErrors = append(cleanupErrors, err)
		}
		s.deleteLocked(id)
	}
	return errors.Join(cleanupErrors...)
}

func (s *Store) deleteLocked(id string) {
	stored := s.plans[id]
	if stored == nil {
		return
	}
	delete(s.plans, id)
	if err := s.removePersistentLocked(id); err != nil {
		slog.Warn("Could not remove package completion record", "plan_id", id, "error", err)
	}
	userID := stored.plan.UserID
	s.totalPlanBytes -= stored.bytes
	if s.totalPlanBytes < 0 {
		s.totalPlanBytes = 0
	}
	if s.planCounts[userID] <= 1 {
		delete(s.planCounts, userID)
	} else {
		s.planCounts[userID]--
	}
	if s.planBytes[userID] <= stored.bytes {
		delete(s.planBytes, userID)
	} else {
		s.planBytes[userID] -= stored.bytes
	}
}

func cloneExecutionPlan(plan ExecutionPlan) (ExecutionPlan, []byte, error) {
	payload, err := json.Marshal(plan.Public)
	if err != nil {
		return ExecutionPlan{}, nil, err
	}
	var public model.ProjectPackageChangePlan
	if err := json.Unmarshal(payload, &public); err != nil {
		return ExecutionPlan{}, nil, err
	}
	plan.Public = public
	return plan, payload, nil
}

func executionPlanBytes(plan ExecutionPlan, publicPayload []byte) int64 {
	return storedPlanOverhead + int64(len(publicPayload)+len(plan.UserID)+len(plan.WorkspaceID)+len(plan.FolderKey)+len(plan.RuntimeID)+len(plan.RuntimeFingerprint)+len(plan.Language)+len(plan.InstallURL))
}

func completedPlanIdentity(plan ExecutionPlan, expiresAt time.Time) ExecutionPlan {
	expiresAt = expiresAt.UTC()
	return ExecutionPlan{
		Public: model.ProjectPackageChangePlan{
			PlanID:           plan.Public.PlanID,
			ExpiresAt:        expiresAt.UnixMilli(),
			Source:           plan.Public.Source,
			ManifestBindings: append([]model.ProjectPackageManifestBinding(nil), plan.Public.ManifestBindings...),
		},
		UserID:             plan.UserID,
		WorkspaceID:        plan.WorkspaceID,
		FolderKey:          plan.FolderKey,
		RuntimeID:          plan.RuntimeID,
		RuntimeFingerprint: plan.RuntimeFingerprint,
		Language:           plan.Language,
		CreatedAt:          plan.CreatedAt,
		ExpiresAt:          expiresAt,
	}
}

func completedMarkerPayload(id string) ([]byte, error) {
	return json.Marshal(model.ProjectPackageChangeResult{PlanID: id, Applied: true})
}

func decodeChangeResult(payload []byte) (model.ProjectPackageChangeResult, error) {
	var result model.ProjectPackageChangeResult
	if err := json.Unmarshal(payload, &result); err != nil {
		return model.ProjectPackageChangeResult{}, err
	}
	return result, nil
}

func randomPlanID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return "pkg_" + hex.EncodeToString(value), nil
}
