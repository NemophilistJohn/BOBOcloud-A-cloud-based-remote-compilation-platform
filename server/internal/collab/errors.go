package collab

import "fmt"

const (
	ErrorCodePushConflict  = "push_conflict"
	ErrorCodePushFailed    = "push_failed"
	ErrorCodeMergeConflict = "merge_conflict"
	ErrorCodeNoChanges     = "no_changes"
	ErrorCodeLockHeld      = "lock_held"
	ErrorCodeLockStale     = "lock_stale"
)

const (
	SuggestedActionRetryCommit      = "retry_commit"
	SuggestedActionResolveConflicts = "resolve_conflicts"
	SuggestedActionEditFiles        = "edit_files"
	SuggestedActionWaitForLock      = "wait_for_lock"
	SuggestedActionRefreshLock      = "refresh_lock"
)

// ErrorDetails is the stable client contract for collaboration failures.
// The underlying cause is intentionally kept server-side so Git diagnostics do
// not become user-facing copy or a client parsing dependency.
type ErrorDetails struct {
	Retryable       bool      `json:"retryable"`
	SuggestedAction string    `json:"suggestedAction"`
	PendingCommit   string    `json:"pendingCommit,omitempty"`
	ConflictCount   int       `json:"conflictCount,omitempty"`
	Lock            *FileLock `json:"lock,omitempty"`
}

type OperationError struct {
	Code    string
	Message string
	Details ErrorDetails
	cause   error
}

func (e *OperationError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func (e *OperationError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

func operationError(code, message string, details ErrorDetails, cause error) error {
	return &OperationError{Code: code, Message: message, Details: details, cause: cause}
}

func pendingPushError(code, message, pendingCommit string, cause error) error {
	return operationError(code, message, ErrorDetails{
		Retryable:       true,
		SuggestedAction: SuggestedActionRetryCommit,
		PendingCommit:   pendingCommit,
	}, cause)
}

func mergeConflictError(conflictCount int, pendingCommit string, cause error) error {
	return operationError(
		ErrorCodeMergeConflict,
		fmt.Sprintf("Remote changes conflict with this commit in %d file(s).", conflictCount),
		ErrorDetails{
			Retryable:       false,
			SuggestedAction: SuggestedActionResolveConflicts,
			PendingCommit:   pendingCommit,
			ConflictCount:   conflictCount,
		},
		cause,
	)
}

func staleLockError(lock *FileLock) error {
	var current *FileLock
	if lock != nil {
		copy := *lock
		current = &copy
	}
	return operationError(ErrorCodeLockStale, "This file lock has been replaced. Refresh the lock state before continuing.", ErrorDetails{
		Retryable:       true,
		SuggestedAction: SuggestedActionRefreshLock,
		Lock:            current,
	}, nil)
}
