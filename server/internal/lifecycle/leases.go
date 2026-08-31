package lifecycle

import (
	"context"
	"errors"
	"strings"
	"sync"
)

var (
	ErrResourcesInUse = errors.New("workspace resources are currently in use; retry after active runs or terminals finish")
	ErrUserRevoked    = errors.New("user access was revoked")
)

type Manager struct {
	mu              sync.Mutex
	users           map[string]*userState
	nextOperationID uint64
}

type userState struct {
	activeTotal      int
	activeWorkspaces map[string]int
	activeRequests   int
	userDeletion     bool
	userMutation     bool
	workspaceChanges map[string]bool
	operations       map[uint64]context.CancelCauseFunc
}

type Lease struct {
	release func()
	once    sync.Once
}

func (lease *Lease) Release() {
	if lease == nil || lease.release == nil {
		return
	}
	lease.once.Do(lease.release)
}

func NewManager() *Manager {
	return &Manager{users: make(map[string]*userState)}
}

func normalize(value string) string { return strings.TrimSpace(value) }

func (manager *Manager) state(userID string) *userState {
	state := manager.users[userID]
	if state == nil {
		state = &userState{
			activeWorkspaces: make(map[string]int),
			workspaceChanges: make(map[string]bool),
			operations:       make(map[uint64]context.CancelCauseFunc),
		}
		manager.users[userID] = state
	}
	return state
}

// BindOperation roots cancellable user work in the shared account lifecycle.
// It adds no authorization round trip: handlers bind once after authentication,
// then keep passing the returned context through admission and execution.
func (manager *Manager) BindOperation(parent context.Context, userID string) (context.Context, *Lease, error) {
	if parent == nil {
		parent = context.Background()
	}
	if manager == nil {
		return parent, &Lease{}, nil
	}
	userID = normalize(userID)
	if userID == "" {
		return nil, nil, ErrResourcesInUse
	}
	ctx, cancel := context.WithCancelCause(parent)
	manager.mu.Lock()
	state := manager.state(userID)
	if state.userDeletion {
		manager.mu.Unlock()
		cancel(ErrUserRevoked)
		return nil, nil, ErrResourcesInUse
	}
	manager.nextOperationID++
	operationID := manager.nextOperationID
	state.operations[operationID] = cancel
	manager.mu.Unlock()

	return ctx, &Lease{release: func() {
		manager.mu.Lock()
		state := manager.users[userID]
		if state != nil {
			delete(state.operations, operationID)
			manager.prune(userID, state)
		}
		manager.mu.Unlock()
		cancel(context.Canceled)
	}}, nil
}

// RevokeUser cancels every pending or active operation currently owned by a
// user. The durable disabled/deleted bit remains the admission authority; this
// registry only provides prompt teardown for work that was already accepted.
func (manager *Manager) RevokeUser(userID string, cause error) int {
	if manager == nil {
		return 0
	}
	userID = normalize(userID)
	if userID == "" {
		return 0
	}
	if cause == nil {
		cause = ErrUserRevoked
	}
	manager.mu.Lock()
	state := manager.users[userID]
	if state == nil {
		manager.mu.Unlock()
		return 0
	}
	cancels := make([]context.CancelCauseFunc, 0, len(state.operations))
	for operationID, cancel := range state.operations {
		cancels = append(cancels, cancel)
		delete(state.operations, operationID)
	}
	manager.prune(userID, state)
	manager.mu.Unlock()
	for _, cancel := range cancels {
		cancel(cause)
	}
	return len(cancels)
}

// AcquireRequest guards the complete authenticated HTTP request. It is
// intentionally independent of resource activity/mutation leases so handlers
// can acquire their more specific lease without conflicting with themselves.
func (manager *Manager) AcquireRequest(userID string) (*Lease, error) {
	if manager == nil {
		return &Lease{}, nil
	}
	userID = normalize(userID)
	if userID == "" {
		return nil, ErrResourcesInUse
	}
	manager.mu.Lock()
	state := manager.state(userID)
	if state.userDeletion {
		manager.mu.Unlock()
		return nil, ErrResourcesInUse
	}
	state.activeRequests++
	manager.mu.Unlock()
	return &Lease{release: func() {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		state := manager.state(userID)
		if state.activeRequests > 0 {
			state.activeRequests--
		}
		manager.prune(userID, state)
	}}, nil
}

// BeginUserDeletion excludes every authenticated request as well as resource
// activity for the target account. This is separate from BeginUserMutation so
// a request can safely use cache/workspace mutation leases internally.
func (manager *Manager) BeginUserDeletion(userID string) (*Lease, error) {
	if manager == nil {
		return &Lease{}, nil
	}
	userID = normalize(userID)
	if userID == "" {
		return nil, ErrResourcesInUse
	}
	manager.mu.Lock()
	state := manager.state(userID)
	if state.userDeletion || state.activeRequests > 0 || state.userMutation || state.activeTotal > 0 || len(state.workspaceChanges) > 0 || len(state.operations) > 0 {
		manager.mu.Unlock()
		return nil, ErrResourcesInUse
	}
	state.userDeletion = true
	manager.mu.Unlock()
	return &Lease{release: func() {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		state := manager.state(userID)
		state.userDeletion = false
		manager.prune(userID, state)
	}}, nil
}

// AcquireActivity pins a user's writable resources for a run or terminal.
// workspaceKey may be empty for user-wide activities such as an interactive
// runtime terminal; those still block cache/account deletion.
func (manager *Manager) AcquireActivity(userID, workspaceKey string) (*Lease, error) {
	if manager == nil {
		return &Lease{}, nil
	}
	userID, workspaceKey = normalize(userID), normalize(workspaceKey)
	if userID == "" {
		return nil, ErrResourcesInUse
	}
	manager.mu.Lock()
	state := manager.state(userID)
	if state.userDeletion || state.userMutation || (workspaceKey != "" && state.workspaceChanges[workspaceKey]) {
		manager.mu.Unlock()
		return nil, ErrResourcesInUse
	}
	state.activeTotal++
	if workspaceKey != "" {
		state.activeWorkspaces[workspaceKey]++
	}
	manager.mu.Unlock()
	return &Lease{release: func() {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		state := manager.state(userID)
		if state.activeTotal > 0 {
			state.activeTotal--
		}
		if workspaceKey != "" {
			if state.activeWorkspaces[workspaceKey] > 1 {
				state.activeWorkspaces[workspaceKey]--
			} else {
				delete(state.activeWorkspaces, workspaceKey)
			}
		}
		manager.prune(userID, state)
	}}, nil
}

// BeginWorkspaceMutation blocks new activity for one workspace and succeeds
// only when no existing run owns it.
func (manager *Manager) BeginWorkspaceMutation(userID, workspaceKey string) (*Lease, error) {
	if manager == nil {
		return &Lease{}, nil
	}
	userID, workspaceKey = normalize(userID), normalize(workspaceKey)
	if userID == "" || workspaceKey == "" {
		return nil, ErrResourcesInUse
	}
	manager.mu.Lock()
	state := manager.state(userID)
	if state.userDeletion || state.userMutation || state.workspaceChanges[workspaceKey] || state.activeWorkspaces[workspaceKey] > 0 {
		manager.mu.Unlock()
		return nil, ErrResourcesInUse
	}
	state.workspaceChanges[workspaceKey] = true
	manager.mu.Unlock()
	return &Lease{release: func() {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		state := manager.state(userID)
		delete(state.workspaceChanges, workspaceKey)
		manager.prune(userID, state)
	}}, nil
}

// BeginUserMutation excludes all runs and terminals for cache/account changes.
func (manager *Manager) BeginUserMutation(userID string) (*Lease, error) {
	if manager == nil {
		return &Lease{}, nil
	}
	userID = normalize(userID)
	if userID == "" {
		return nil, ErrResourcesInUse
	}
	manager.mu.Lock()
	state := manager.state(userID)
	if state.userDeletion || state.userMutation || state.activeTotal > 0 || len(state.workspaceChanges) > 0 {
		manager.mu.Unlock()
		return nil, ErrResourcesInUse
	}
	state.userMutation = true
	manager.mu.Unlock()
	return &Lease{release: func() {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		state := manager.state(userID)
		state.userMutation = false
		manager.prune(userID, state)
	}}, nil
}

func (manager *Manager) prune(userID string, state *userState) {
	if state.activeTotal == 0 && state.activeRequests == 0 && !state.userDeletion && !state.userMutation && len(state.activeWorkspaces) == 0 && len(state.workspaceChanges) == 0 && len(state.operations) == 0 {
		delete(manager.users, userID)
	}
}
