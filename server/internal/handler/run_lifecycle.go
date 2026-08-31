package handler

import (
	"container/heap"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
)

// HTTP cancellation and WebSocket attachment must make a single decision
// about a pending run. Without this lock, cancellation can observe Started=false
// immediately before the WebSocket marks and starts the same session.
var runSessionLifecycleMu sync.Mutex

const (
	runCancellationTombstoneTTL        = 5 * time.Minute
	runCancellationTombstoneMaxEntries = 32_768
	runCancellationTombstoneMaxPerUser = 512
	runCancellationCapacityErrorCode   = "run_cancellation_capacity"
)

var (
	errRunCancellationGlobalCapacity  = errors.New("global run cancellation capacity reached")
	errRunCancellationPerUserCapacity = errors.New("user run cancellation capacity reached")
)

const maxRunIDLength = 128

type runCancellationKey struct {
	userID string
	runID  string
}

type runCancellationTombstone struct {
	key       runCancellationKey
	expiresAt time.Time
	heapIndex int
}

type runCancellationExpiryHeap []*runCancellationTombstone

func (items runCancellationExpiryHeap) Len() int { return len(items) }
func (items runCancellationExpiryHeap) Less(left, right int) bool {
	if items[left].expiresAt.Equal(items[right].expiresAt) {
		if items[left].key.userID == items[right].key.userID {
			return items[left].key.runID < items[right].key.runID
		}
		return items[left].key.userID < items[right].key.userID
	}
	return items[left].expiresAt.Before(items[right].expiresAt)
}
func (items runCancellationExpiryHeap) Swap(left, right int) {
	items[left], items[right] = items[right], items[left]
	items[left].heapIndex, items[right].heapIndex = left, right
}
func (items *runCancellationExpiryHeap) Push(value any) {
	entry := value.(*runCancellationTombstone)
	entry.heapIndex = len(*items)
	*items = append(*items, entry)
}
func (items *runCancellationExpiryHeap) Pop() any {
	previous := *items
	last := len(previous) - 1
	entry := previous[last]
	previous[last] = nil
	entry.heapIndex = -1
	*items = previous[:last]
	return entry
}

// runCancellationStore is guarded by runSessionLifecycleMu in production.
// Expiry cleanup is amortized O(log n) per tombstone and never scans the map.
type runCancellationStore struct {
	ttl        time.Duration
	maxEntries int
	maxPerUser int
	entries    map[runCancellationKey]*runCancellationTombstone
	perUser    map[string]int
	expiry     runCancellationExpiryHeap
}

func newRunCancellationStore(maxEntries, maxPerUser int, ttl time.Duration) *runCancellationStore {
	if maxEntries <= 0 {
		maxEntries = 1
	}
	if maxPerUser <= 0 || maxPerUser > maxEntries {
		maxPerUser = maxEntries
	}
	if ttl <= 0 {
		ttl = runCancellationTombstoneTTL
	}
	store := &runCancellationStore{
		ttl: ttl, maxEntries: maxEntries, maxPerUser: maxPerUser,
		entries: make(map[runCancellationKey]*runCancellationTombstone),
		perUser: make(map[string]int),
	}
	heap.Init(&store.expiry)
	return store
}

func (store *runCancellationStore) pruneExpired(now time.Time) {
	for store.expiry.Len() > 0 {
		entry := store.expiry[0]
		if now.Before(entry.expiresAt) {
			return
		}
		heap.Pop(&store.expiry)
		delete(store.entries, entry.key)
		if store.perUser[entry.key.userID] > 1 {
			store.perUser[entry.key.userID]--
		} else {
			delete(store.perUser, entry.key.userID)
		}
	}
}

func (store *runCancellationStore) remember(userID, runID string, now time.Time) error {
	store.pruneExpired(now)
	key := runCancellationKey{userID: userID, runID: runID}
	if existing := store.entries[key]; existing != nil {
		existing.expiresAt = now.Add(store.ttl)
		heap.Fix(&store.expiry, existing.heapIndex)
		return nil
	}
	if store.perUser[userID] >= store.maxPerUser {
		return errRunCancellationPerUserCapacity
	}
	if len(store.entries) >= store.maxEntries {
		return errRunCancellationGlobalCapacity
	}
	entry := &runCancellationTombstone{key: key, expiresAt: now.Add(store.ttl), heapIndex: -1}
	store.entries[key] = entry
	store.perUser[userID]++
	heap.Push(&store.expiry, entry)
	return nil
}

func (store *runCancellationStore) remembered(userID, runID string, now time.Time) bool {
	store.pruneExpired(now)
	_, exists := store.entries[runCancellationKey{userID: userID, runID: runID}]
	return exists
}

var runCancellationTombstones = newRunCancellationStore(
	runCancellationTombstoneMaxEntries,
	runCancellationTombstoneMaxPerUser,
	runCancellationTombstoneTTL,
)

func rememberRunCancellationLocked(userID, runID string, now time.Time) error {
	return runCancellationTombstones.remember(userID, runID, now)
}

func runCancellationRememberedLocked(userID, runID string, now time.Time) bool {
	return runCancellationTombstones.remembered(userID, runID, now)
}

func runCancellationRemembered(userID, runID string) bool {
	runSessionLifecycleMu.Lock()
	defer runSessionLifecycleMu.Unlock()
	return runCancellationRememberedLocked(userID, runID, time.Now())
}

func normalizeRunID(raw string) (string, error) {
	runID := strings.TrimSpace(raw)
	if runID == "" {
		return "", fmt.Errorf("runId is required")
	}
	if len(runID) > maxRunIDLength {
		return "", fmt.Errorf("runId is too long (maximum %d characters)", maxRunIDLength)
	}
	for _, ch := range runID {
		if (ch >= 'a' && ch <= 'z') ||
			(ch >= 'A' && ch <= 'Z') ||
			(ch >= '0' && ch <= '9') ||
			ch == '-' || ch == '_' || ch == '.' || ch == ':' {
			continue
		}
		return "", fmt.Errorf("runId contains invalid characters")
	}
	return runID, nil
}

// CleanupExpiredRuns atomically removes expired pending sessions and their
// channels with respect to cancellation and WebSocket attachment.
func CleanupExpiredRuns(store storage.SessionStore, channels *session.ChannelManager, ttl time.Duration) ([]string, error) {
	if store == nil || channels == nil {
		return nil, nil
	}
	runSessionLifecycleMu.Lock()
	defer runSessionLifecycleMu.Unlock()
	return cleanupExpiredRunsLocked(store, channels, ttl)
}

// cancelUserRunSessions seals both pending handshakes and active channels under
// the same lock used by attach/cancel. Active execution observes the WebSocket
// close through its registered user context and releases its container lease.
func cancelUserRunSessions(store storage.SessionStore, channels *session.ChannelManager, userID string) error {
	if store == nil || channels == nil || strings.TrimSpace(userID) == "" {
		return nil
	}
	runSessionLifecycleMu.Lock()
	defer runSessionLifecycleMu.Unlock()
	sessions, err := store.GetByUser(userID)
	if err != nil {
		return err
	}
	var cleanupErrors []error
	for _, runSession := range sessions {
		if runSession == nil {
			continue
		}
		channel := channels.GetOrCreate(runSession.RunID, false)
		if channel != nil {
			channel.Close()
		}
		if err := channels.CleanupRun(runSession.RunID, channel, store); err != nil {
			cleanupErrors = append(cleanupErrors, err)
		}
	}
	return errors.Join(cleanupErrors...)
}

func cleanupExpiredRunsLocked(store storage.SessionStore, channels *session.ChannelManager, ttl time.Duration) ([]string, error) {
	if err := channels.RetryPendingCleanups(store); err != nil {
		slog.Error("Failed to retry pending run session cleanup", "error", err)
	}
	expired, err := store.CleanupExpired(ttl)
	if err != nil {
		return nil, fmt.Errorf("cleanup expired run sessions: %w", err)
	}
	for _, runID := range expired {
		if channel := channels.GetOrCreate(runID, false); channel != nil {
			channel.Close()
			channels.RemoveIfCurrent(runID, channel)
		}
	}
	return expired, nil
}

func (h *HTTPHandler) handleCancelRun(w http.ResponseWriter, r *http.Request, req *model.Request) {
	runID, err := normalizeRunID(req.RunID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error()})
		return
	}
	if h.Sessions == nil || h.Channels == nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Run sessions are unavailable"})
		return
	}

	userID := auth.UserIDFromContext(r.Context())
	runSessionLifecycleMu.Lock()
	sess, exists, lookupErr := h.Sessions.Lookup(runID)
	if lookupErr != nil {
		runSessionLifecycleMu.Unlock()
		slog.Error("Failed to read run session for cancellation", "run_id", runID, "error", lookupErr)
		writeJSON(w, http.StatusServiceUnavailable, model.Response{
			Success:   false,
			Error:     "Run session storage is temporarily unavailable",
			ErrorCode: "run_session_storage_unavailable",
		})
		return
	}
	if !exists {
		if capacityErr := rememberRunCancellationLocked(userID, runID, time.Now()); capacityErr != nil {
			runSessionLifecycleMu.Unlock()
			writeRunCancellationCapacityError(w, capacityErr)
			return
		}
		channel := h.Channels.GetOrCreate(runID, false)
		if channel != nil {
			channel.Close()
		}
		cleanupErr := h.Channels.CleanupRun(runID, channel, h.Sessions)
		runSessionLifecycleMu.Unlock()
		if cleanupErr != nil {
			slog.Error("Failed to clean absent run session", "run_id", runID, "error", cleanupErr)
			writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Run session cleanup is temporarily unavailable", ErrorCode: "run_session_cleanup_failed"})
			return
		}
		writeCancelRunResult(w, "absent", false, "Run session is already absent")
		return
	}
	if sess.UserID != userID {
		runSessionLifecycleMu.Unlock()
		writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Run session belongs to another user"})
		return
	}
	if sess.Started {
		runSessionLifecycleMu.Unlock()
		writeCancelRunResult(w, "started", true, "Run has already started; cancel it over WebSocket")
		return
	}

	if capacityErr := rememberRunCancellationLocked(userID, runID, time.Now()); capacityErr != nil {
		runSessionLifecycleMu.Unlock()
		writeRunCancellationCapacityError(w, capacityErr)
		return
	}
	channel := h.Channels.GetOrCreate(runID, false)
	if channel != nil {
		channel.Close()
	}
	cleanupErr := h.Channels.CleanupRun(runID, channel, h.Sessions)
	runSessionLifecycleMu.Unlock()
	if cleanupErr != nil {
		slog.Error("Failed to cancel pending run session", "run_id", runID, "error", cleanupErr)
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Run session cleanup is temporarily unavailable", ErrorCode: "run_session_cleanup_failed"})
		return
	}

	writeCancelRunResult(w, "cancelled", false, "Pending run cancelled")
}

func writeRunCancellationCapacityError(w http.ResponseWriter, err error) {
	status := http.StatusServiceUnavailable
	if errors.Is(err, errRunCancellationPerUserCapacity) {
		status = http.StatusTooManyRequests
	}
	w.Header().Set("Retry-After", fmt.Sprintf("%d", int(runCancellationTombstoneTTL/time.Second)))
	writeJSON(w, status, model.Response{
		Success: false, Error: "Pending run cancellation capacity is exhausted; retry after existing cancellations expire",
		ErrorCode: runCancellationCapacityErrorCode,
	})
}

func writeCancelRunResult(w http.ResponseWriter, status string, requiresWebSocketCancel bool, message string) {
	writeJSON(w, http.StatusOK, model.Response{
		Success: true,
		Message: message,
		Data: map[string]any{
			"status":                  status,
			"requiresWebSocketCancel": requiresWebSocketCancel,
		},
	})
}

func writeRunCancelledBeforeStart(w http.ResponseWriter) {
	writeJSON(w, http.StatusConflict, model.Response{
		Success: false,
		Error:   "Run was cancelled before it started",
		Data: map[string]any{
			"status": "cancelled",
		},
	})
}

func writeRunIDConflict(w http.ResponseWriter, runID string) {
	writeJSON(w, http.StatusConflict, model.Response{
		Success: false,
		Error:   "Run ID already exists",
		RunID:   runID,
	})
}
