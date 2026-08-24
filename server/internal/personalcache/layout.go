package personalcache

import (
	"fmt"
	"strings"

	"bobocloud-server/internal/cachev2"
)

func (m *Manager) ensureUserLayout(userID string) (cachev2.Layout, error) {
	if m == nil || strings.TrimSpace(userID) == "" {
		return cachev2.Layout{}, fmt.Errorf("personal cache user ID is required")
	}
	layout, _, err := cachev2.EnsureUserLayout(m.dataDir, userID)
	if err != nil {
		return cachev2.Layout{}, fmt.Errorf("initialize personal cache-v2 layout: %w", err)
	}
	return layout, nil
}
