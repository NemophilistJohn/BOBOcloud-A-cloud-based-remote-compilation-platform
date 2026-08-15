package dap

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// ChildTicketBroker binds an adapter reverse startDebugging request to one
// short-lived browser connection. The ticket is random, one-use, user-bound,
// and never written to logs or exposed as a Docker port.
type ChildTicketBroker struct {
	mu      sync.Mutex
	tickets map[string]childTicket
	now     func() time.Time
	ttl     time.Duration
}

type childTicket struct {
	userID  string
	parent  *Session
	request json.RawMessage
	expires time.Time
}

type ClaimedChildTicket struct {
	Parent  *Session
	Request json.RawMessage
}

func NewChildTicketBroker() *ChildTicketBroker {
	return &ChildTicketBroker{tickets: make(map[string]childTicket), now: time.Now, ttl: 30 * time.Second}
}

func (b *ChildTicketBroker) Offer(userID string, parent *Session, request []byte) (string, error) {
	if b == nil || parent == nil || strings.TrimSpace(userID) == "" {
		return "", fmt.Errorf("DAP child session is unavailable")
	}
	var value map[string]any
	if err := json.Unmarshal(request, &value); err != nil {
		return "", fmt.Errorf("invalid DAP child request: %w", err)
	}
	if value["type"] != "request" || value["command"] != "startDebugging" {
		return "", fmt.Errorf("only startDebugging can create a DAP child ticket")
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate DAP child ticket: %w", err)
	}
	ticket := base64.RawURLEncoding.EncodeToString(random)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.cleanupLocked()
	b.tickets[ticket] = childTicket{userID: userID, parent: parent, request: append(json.RawMessage(nil), request...), expires: b.now().Add(b.ttl)}
	return ticket, nil
}

func (b *ChildTicketBroker) Claim(userID, ticket string) (ClaimedChildTicket, error) {
	if b == nil {
		return ClaimedChildTicket{}, fmt.Errorf("DAP child session is unavailable")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.cleanupLocked()
	value, ok := b.tickets[strings.TrimSpace(ticket)]
	if !ok {
		return ClaimedChildTicket{}, fmt.Errorf("DAP child ticket is invalid or expired")
	}
	if value.userID != strings.TrimSpace(userID) {
		return ClaimedChildTicket{}, fmt.Errorf("DAP child ticket does not belong to this user")
	}
	select {
	case <-value.parent.Done():
		return ClaimedChildTicket{}, fmt.Errorf("DAP parent session has ended")
	default:
	}
	delete(b.tickets, strings.TrimSpace(ticket))
	return ClaimedChildTicket{Parent: value.parent, Request: append(json.RawMessage(nil), value.request...)}, nil
}

func (b *ChildTicketBroker) cleanupLocked() {
	now := b.now()
	for ticket, value := range b.tickets {
		if !now.Before(value.expires) {
			delete(b.tickets, ticket)
		}
	}
}
