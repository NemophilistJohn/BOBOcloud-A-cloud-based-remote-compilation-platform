package handler

import (
	"context"
	"net/http"
	"time"
)

// ReadinessProbe verifies dependencies that must be available before this
// process can accept cloud-compilation traffic. Its error is intentionally not
// returned to an unauthenticated caller.
type ReadinessProbe func(context.Context) error

const readinessProbeTimeout = 2 * time.Second

const readinessProbeCacheTTL = time.Second

type probeResponse struct {
	Status string `json:"status"`
}

// handleHealthProbe serves the two unauthenticated process probes. Liveness
// deliberately avoids dependency checks; readiness is bounded and reports no
// infrastructure details to callers.
func (h *HTTPHandler) handleHealthProbe(w http.ResponseWriter, r *http.Request) bool {
	var readiness bool
	switch r.URL.Path {
	case "/healthz":
	case "/readyz":
		readiness = true
	default:
		return false
	}
	w.Header().Set("Cache-Control", "no-store")

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, probeResponse{Status: "method_not_allowed"})
		return true
	}

	if !readiness {
		writeJSON(w, http.StatusOK, probeResponse{Status: "ok"})
		return true
	}
	if h == nil || !serverAccepting(h.Accepting) {
		writeJSON(w, http.StatusServiceUnavailable, probeResponse{Status: "not_ready"})
		return true
	}

	if h.Config == nil || h.Sessions == nil || h.Channels == nil || h.Readiness == nil {
		writeJSON(w, http.StatusServiceUnavailable, probeResponse{Status: "not_ready"})
		return true
	}
	// Do not let an untrusted client cancelling its request poison the cached
	// result for the next probe. The probe has its own hard deadline.
	ctx, cancel := context.WithTimeout(context.Background(), readinessProbeTimeout)
	defer cancel()
	if err := h.checkReadiness(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, probeResponse{Status: "not_ready"})
		return true
	}

	writeJSON(w, http.StatusOK, probeResponse{Status: "ready"})
	return true
}

func (h *HTTPHandler) checkReadiness(ctx context.Context) error {
	h.readinessMu.Lock()
	defer h.readinessMu.Unlock()

	now := time.Now()
	if !h.readinessCheckedAt.IsZero() && now.Sub(h.readinessCheckedAt) < readinessProbeCacheTTL {
		return h.readinessErr
	}
	h.readinessErr = h.Readiness(ctx)
	h.readinessCheckedAt = now
	return h.readinessErr
}
