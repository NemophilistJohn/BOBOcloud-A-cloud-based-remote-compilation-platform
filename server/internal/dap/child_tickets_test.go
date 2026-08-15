package dap

import (
	"testing"
	"time"
)

func TestChildTicketsAreOneUseBoundAndExpire(t *testing.T) {
	broker := NewChildTicketBroker()
	now := time.Now()
	broker.now = func() time.Time { return now }
	broker.ttl = time.Second
	parent := &Session{done: make(chan struct{})}
	request := []byte(`{"seq":7,"type":"request","command":"startDebugging","arguments":{"configuration":{"__pendingTargetId":"target"}}}`)
	ticket, err := broker.Offer("user-a", parent, request)
	if err != nil || ticket == "" {
		t.Fatalf("offer = %q, %v", ticket, err)
	}
	if _, err := broker.Claim("user-b", ticket); err == nil {
		t.Fatal("a different user claimed the ticket")
	}
	claimed, err := broker.Claim("user-a", ticket)
	if err != nil || claimed.Parent != parent || string(claimed.Request) != string(request) {
		t.Fatalf("claim = %#v, %v", claimed, err)
	}
	if _, err := broker.Claim("user-a", ticket); err == nil {
		t.Fatal("ticket was reusable")
	}
	ticket, err = broker.Offer("user-a", parent, request)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Second)
	if _, err := broker.Claim("user-a", ticket); err == nil {
		t.Fatal("expired ticket was accepted")
	}
}
