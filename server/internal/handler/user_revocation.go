package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/lifecycle"
)

const userRevocationCleanupTimeout = 10 * time.Second

func bindUserOperation(parent context.Context, manager *lifecycle.Manager, store auth.UserStore, userID string) (context.Context, func(), error) {
	if parent == nil {
		parent = context.Background()
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, nil, fmt.Errorf("authenticated user identity is required")
	}
	if manager == nil {
		if err := revalidateActiveUser(store, userID); err != nil {
			return nil, nil, err
		}
		return parent, func() {}, nil
	}
	ctx, lease, err := manager.BindOperation(parent, userID)
	if err != nil {
		return nil, nil, err
	}
	if err := revalidateActiveUser(store, userID); err != nil {
		lease.Release()
		return nil, nil, err
	}
	return ctx, lease.Release, nil
}

func revalidateActiveUser(store auth.UserStore, userID string) error {
	if store == nil {
		return nil
	}
	user, err := store.Get(strings.TrimSpace(userID))
	if err != nil {
		return fmt.Errorf("invalid or expired credential")
	}
	if user.Disabled {
		return fmt.Errorf("account disabled")
	}
	return nil
}

func (h *HTTPHandler) revokeUserWork(ctx context.Context, userID string) error {
	if h == nil {
		return nil
	}
	if h.Lifecycle != nil {
		h.Lifecycle.RevokeUser(userID, lifecycle.ErrUserRevoked)
	}
	var revokeErrors []error
	if err := cancelUserRunSessions(h.Sessions, h.Channels, userID); err != nil {
		revokeErrors = append(revokeErrors, fmt.Errorf("cancel run sessions: %w", err))
	}
	if h.LSP != nil {
		if err := h.LSP.StopUserContext(ctx, userID); err != nil {
			revokeErrors = append(revokeErrors, fmt.Errorf("stop LSP sessions: %w", err))
		}
	}
	if h.DAP != nil {
		if err := h.DAP.StopUserContext(ctx, userID); err != nil {
			revokeErrors = append(revokeErrors, fmt.Errorf("stop DAP sessions: %w", err))
		}
	}
	if err := errors.Join(revokeErrors...); err != nil {
		slog.Warn("User access revoked with deferred cleanup", "user_id", userID, "error", err)
		return err
	}
	return nil
}

func (h *HTTPHandler) revokeUserWorkBounded(userID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), userRevocationCleanupTimeout)
	defer cancel()
	return h.revokeUserWork(ctx, userID)
}
