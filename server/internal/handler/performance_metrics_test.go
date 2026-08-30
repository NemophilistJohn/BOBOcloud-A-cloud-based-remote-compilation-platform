package handler

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/metrics"
	"bobocloud-server/internal/session"
	"bobocloud-server/internal/storage"
)

func TestPerformanceMetricsRequireAdminAndExposeStageSnapshot(t *testing.T) {
	users := auth.NewMemoryUserStore()
	member := &auth.User{ID: "member", Username: "member", APIKey: "member-key", Role: auth.RoleMember}
	admin := &auth.User{ID: "admin", Username: "admin", APIKey: "admin-key", Role: auth.RoleAdmin}
	for _, user := range []*auth.User{member, admin} {
		if err := users.Create(user); err != nil {
			t.Fatal(err)
		}
	}
	handler := NewHTTPHandler(config.Default(), storage.NewMemorySessionStore(), session.NewChannelManager(), true, auth.NewAPIKeyAuth(users), users, nil, nil, nil)
	handler.Metrics = metrics.New(true, 16)
	handler.Metrics.Observe("queue.wait", 12*time.Millisecond)
	handler.Metrics.Cache("dependency.cache", true)
	handler.Metrics.ObserveAdmission(metrics.WorkloadRun, metrics.AdmissionRejected, metrics.AdmissionReasonQueueFull, 3*time.Millisecond)
	handler.Metrics.ObserveQueueDepth(metrics.WorkloadRun, 2)
	handler.Metrics.ObserveResourceUsage(metrics.ResourceSlots, 4, 20)

	denied := serveAuthenticatedAction(t, handler, member.APIKey, `{"action":"getPerformanceMetrics"}`)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("member metrics status=%d body=%s", denied.Code, denied.Body.String())
	}
	allowed := serveAuthenticatedAction(t, handler, admin.APIKey, `{"action":"getPerformanceMetrics"}`)
	if allowed.Code != http.StatusOK || !containsAll(allowed.Body.String(),
		`"queue.wait"`, `"dependency.cache"`, `"hit_rate":1`, `"governance"`,
		`"queue_full"`, `"slots"`, `"in_use":4`, `"current":2`,
	) {
		t.Fatalf("admin metrics status=%d body=%s", allowed.Code, allowed.Body.String())
	}
}

func containsAll(value string, needles ...string) bool {
	for _, needle := range needles {
		if !strings.Contains(value, needle) {
			return false
		}
	}
	return true
}
