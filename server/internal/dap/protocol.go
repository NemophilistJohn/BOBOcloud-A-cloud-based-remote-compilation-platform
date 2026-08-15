package dap

import (
	"encoding/json"
	"fmt"
	"sync"
)

type Envelope struct {
	Seq        int             `json:"seq"`
	Type       string          `json:"type"`
	Command    string          `json:"command,omitempty"`
	Event      string          `json:"event,omitempty"`
	RequestSeq int             `json:"request_seq,omitempty"`
	Success    bool            `json:"success,omitempty"`
	Arguments  json.RawMessage `json:"arguments,omitempty"`
}

type Gateway struct {
	mu                  sync.Mutex
	spec                AdapterSpec
	mapper              *PathMapper
	pending             map[int]string
	reversePending      map[int]string
	lastClientSeq       int
	initializeSent      bool
	initializeCompleted bool
	targetRequestSent   bool
	adapterInitialized  bool
	terminated          bool
	disconnectRequested bool
}

func NewGateway(spec AdapterSpec) *Gateway {
	return &Gateway{spec: spec, mapper: NewPathMapper(), pending: make(map[int]string), reversePending: make(map[int]string)}
}

type ClientResult struct {
	Payload       []byte
	LocalResponse []byte
	Disconnect    bool
}

func parseEnvelope(payload []byte) (Envelope, error) {
	var envelope Envelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return envelope, fmt.Errorf("invalid DAP JSON: %w", err)
	}
	if envelope.Seq < 0 {
		return envelope, fmt.Errorf("DAP seq must not be negative")
	}
	return envelope, nil
}

func ErrorResponse(request Envelope, message string) []byte {
	payload, _ := json.Marshal(map[string]any{
		"seq": 0, "type": "response", "request_seq": request.Seq,
		"success": false, "command": request.Command, "message": message,
	})
	return payload
}

func (g *Gateway) HandleClient(payload []byte) (ClientResult, error) {
	envelope, err := parseEnvelope(payload)
	if err != nil {
		return ClientResult{}, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if envelope.Type != "request" && envelope.Type != "response" {
		return ClientResult{}, fmt.Errorf("the DAP client may send request or response messages")
	}
	if envelope.Seq <= 0 {
		return ClientResult{}, fmt.Errorf("DAP messages require a positive seq")
	}
	if envelope.Seq <= g.lastClientSeq {
		return ClientResult{LocalResponse: ErrorResponse(envelope, "DAP request seq must increase monotonically")}, nil
	}
	g.lastClientSeq = envelope.Seq
	if envelope.Type == "response" {
		command, exists := g.reversePending[envelope.RequestSeq]
		if !exists || command != envelope.Command {
			return ClientResult{}, fmt.Errorf("client response does not match an adapter reverse request")
		}
		delete(g.reversePending, envelope.RequestSeq)
		return ClientResult{Payload: payload}, nil
	}
	if envelope.Command == "" {
		return ClientResult{}, fmt.Errorf("DAP request requires a command")
	}
	if g.disconnectRequested {
		return ClientResult{LocalResponse: ErrorResponse(envelope, "the debug session is disconnecting")}, nil
	}
	if !g.initializeSent && envelope.Command != "initialize" {
		return ClientResult{LocalResponse: ErrorResponse(envelope, "initialize must be the first DAP request")}, nil
	}
	if envelope.Command == "initialize" {
		if g.initializeSent {
			return ClientResult{LocalResponse: ErrorResponse(envelope, "initialize was already sent")}, nil
		}
		g.initializeSent = true
	} else if !g.initializeCompleted {
		return ClientResult{LocalResponse: ErrorResponse(envelope, "wait for the initialize response before continuing")}, nil
	}
	switch envelope.Command {
	case "attach":
		if !g.spec.SupportsAttach {
			return ClientResult{LocalResponse: ErrorResponse(envelope, "this managed adapter does not support attach sessions")}, nil
		}
		if g.targetRequestSent {
			return ClientResult{LocalResponse: ErrorResponse(envelope, "a debug target request was already sent")}, nil
		}
	case "launch":
		if !g.spec.SupportsLaunch {
			return ClientResult{LocalResponse: ErrorResponse(envelope, "this managed adapter does not support launch sessions")}, nil
		}
		if g.targetRequestSent {
			return ClientResult{LocalResponse: ErrorResponse(envelope, "a debug target was already launched")}, nil
		}
	case "setBreakpoints", "setFunctionBreakpoints", "setExceptionBreakpoints", "configurationDone":
		if !g.targetRequestSent || !g.adapterInitialized {
			return ClientResult{LocalResponse: ErrorResponse(envelope, "the adapter is not ready for breakpoint configuration")}, nil
		}
	}
	if g.terminated && envelope.Command != "disconnect" {
		return ClientResult{LocalResponse: ErrorResponse(envelope, "the debug session has terminated")}, nil
	}
	rewritten, err := g.mapper.RewriteInbound(payload, g.spec)
	if err != nil {
		return ClientResult{LocalResponse: ErrorResponse(envelope, err.Error())}, nil
	}
	if envelope.Command == "launch" || envelope.Command == "attach" {
		g.targetRequestSent = true
	}
	if envelope.Command == "disconnect" {
		g.disconnectRequested = true
	}
	g.pending[envelope.Seq] = envelope.Command
	return ClientResult{Payload: rewritten, Disconnect: envelope.Command == "disconnect"}, nil
}

func (g *Gateway) HandleServer(payload []byte) ([]byte, error) {
	envelope, err := parseEnvelope(payload)
	if err != nil {
		return nil, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	switch envelope.Type {
	case "response":
		command, exists := g.pending[envelope.RequestSeq]
		if !exists || command != envelope.Command {
			return nil, fmt.Errorf("adapter response does not match an active DAP request")
		}
		delete(g.pending, envelope.RequestSeq)
		if envelope.Command == "initialize" && envelope.Success {
			g.initializeCompleted = true
		}
	case "event":
		switch envelope.Event {
		case "initialized":
			g.adapterInitialized = true
		case "terminated":
			g.terminated = true
		}
	case "request":
		if envelope.Command == "" || envelope.Seq <= 0 {
			return nil, fmt.Errorf("adapter reverse request requires a positive seq and command")
		}
		if _, exists := g.reversePending[envelope.Seq]; exists {
			return nil, fmt.Errorf("adapter reused an active reverse request seq")
		}
		g.reversePending[envelope.Seq] = envelope.Command
	default:
		return nil, fmt.Errorf("adapter emitted an invalid DAP message type %q", envelope.Type)
	}
	return g.mapper.RewriteOutbound(payload)
}

// IsChildStartRequest reports the adapter reverse request that creates a
// child debug session. It intentionally does not consume the request: the
// parent Gateway still validates the response sent back by the browser.
func IsChildStartRequest(payload []byte) (Envelope, bool) {
	envelope, err := parseEnvelope(payload)
	if err != nil || envelope.Type != "request" || envelope.Command != "startDebugging" || envelope.Seq <= 0 {
		return Envelope{}, false
	}
	return envelope, true
}

func (g *Gateway) SessionEnded() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.terminated || g.disconnectRequested
}
