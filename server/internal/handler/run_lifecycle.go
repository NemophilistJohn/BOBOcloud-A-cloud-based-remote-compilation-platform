package handler

import (
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

const runCancellationTombstoneTTL = 5 * time.Minute

const maxRunIDLength = 128

type runCancellationKey struct {
	userID string
	runID  string
}

var runCancellationTombstones = make(map[runCancellationKey]time.Time)

func pruneRunCancellationTombstonesLocked(now time.Time) {
	for key, expiresAt := range runCancellationTombstones {
		if !now.Before(expiresAt) {
			delete(runCancellationTombstones, key)
		}
	}
}

func rememberRunCancellationLocked(userID, runID string, now time.Time) {
	pruneRunCancellationTombstonesLocked(now)
	runCancellationTombstones[runCancellationKey{userID: userID, runID: runID}] = now.Add(runCancellationTombstoneTTL)
}

func runCancellationRememberedLocked(userID, runID string, now time.Time) bool {
	pruneRunCancellationTombstonesLocked(now)
	expiresAt, exists := runCancellationTombstones[runCancellationKey{userID: userID, runID: runID}]
	return exists && now.Before(expiresAt)
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
		rememberRunCancellationLocked(userID, runID, time.Now())
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

	rememberRunCancellationLocked(userID, runID, time.Now())
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
