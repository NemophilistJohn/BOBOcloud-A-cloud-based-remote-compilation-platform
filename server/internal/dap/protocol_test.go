package dap

import (
	"encoding/json"
	"testing"
)

func request(seq int, command string, arguments any) []byte {
	payload, _ := json.Marshal(map[string]any{"seq": seq, "type": "request", "command": command, "arguments": arguments})
	return payload
}

func response(seq, requestSeq int, command string, success bool) []byte {
	payload, _ := json.Marshal(map[string]any{"seq": seq, "type": "response", "request_seq": requestSeq, "command": command, "success": success})
	return payload
}

func event(seq int, name string) []byte {
	payload, _ := json.Marshal(map[string]any{"seq": seq, "type": "event", "event": name})
	return payload
}

func initializedGateway(t *testing.T, spec AdapterSpec) *Gateway {
	t.Helper()
	gateway := NewGateway(spec)
	result, err := gateway.HandleClient(request(1, "initialize", map[string]any{}))
	if err != nil || len(result.Payload) == 0 {
		t.Fatalf("initialize request: %v", err)
	}
	if _, err := gateway.HandleServer(response(1, 1, "initialize", true)); err != nil {
		t.Fatalf("initialize response: %v", err)
	}
	return gateway
}

func TestGatewayInvalidLaunchCanBeCorrected(t *testing.T) {
	gateway := initializedGateway(t, AdapterSpec{ID: "python-debugpy", SupportsLaunch: true})
	bad, err := gateway.HandleClient(request(2, "launch", map[string]any{"program": "/outside/main.py"}))
	if err != nil || len(bad.LocalResponse) == 0 {
		t.Fatalf("invalid launch did not return a local response: %v", err)
	}
	good, err := gateway.HandleClient(request(3, "launch", map[string]any{"program": "bobocloud-dap:///main.py"}))
	if err != nil || len(good.Payload) == 0 || len(good.LocalResponse) != 0 {
		t.Fatalf("corrected launch was not forwarded: result=%+v err=%v", good, err)
	}
}

func TestGatewayAllowsEarlyInitializedAndBreakpointAfterTarget(t *testing.T) {
	gateway := initializedGateway(t, AdapterSpec{ID: "node-js-debug", SupportsLaunch: true})
	if _, err := gateway.HandleServer(event(2, "initialized")); err != nil {
		t.Fatalf("early initialized event: %v", err)
	}
	before, _ := gateway.HandleClient(request(2, "setBreakpoints", map[string]any{}))
	if len(before.LocalResponse) == 0 {
		t.Fatal("breakpoints were accepted before a target request")
	}
	launch, _ := gateway.HandleClient(request(3, "launch", map[string]any{"program": "main.js"}))
	if len(launch.Payload) == 0 {
		t.Fatal("launch was not forwarded")
	}
	after, _ := gateway.HandleClient(request(4, "setBreakpoints", map[string]any{"source": map[string]any{"path": "main.js"}}))
	if len(after.Payload) == 0 || len(after.LocalResponse) != 0 {
		t.Fatalf("breakpoints were rejected after initialized+launch: %+v", after)
	}
}

func TestGatewayTracksAdapterReverseRequests(t *testing.T) {
	gateway := initializedGateway(t, AdapterSpec{SupportsLaunch: true})
	reverse := request(41, "runInTerminal", map[string]any{})
	if _, err := gateway.HandleServer(reverse); err != nil {
		t.Fatal(err)
	}
	clientResponse := response(2, 41, "runInTerminal", false)
	result, err := gateway.HandleClient(clientResponse)
	if err != nil || len(result.Payload) == 0 {
		t.Fatalf("reverse response was not forwarded: %v", err)
	}
	if _, err := gateway.HandleClient(response(3, 41, "runInTerminal", false)); err == nil {
		t.Fatal("duplicate reverse response was accepted")
	}
}

func TestGatewayRejectsDuplicateActiveAdapterReverseSeq(t *testing.T) {
	gateway := initializedGateway(t, AdapterSpec{SupportsLaunch: true})
	reverse := request(41, "runInTerminal", map[string]any{})
	if _, err := gateway.HandleServer(reverse); err != nil {
		t.Fatal(err)
	}
	if _, err := gateway.HandleServer(reverse); err == nil {
		t.Fatal("duplicate active adapter reverse request seq was accepted")
	}
}

func TestGatewayAttachCountsAsTargetRequest(t *testing.T) {
	gateway := initializedGateway(t, AdapterSpec{SupportsAttach: true})
	if _, err := gateway.HandleServer(event(2, "initialized")); err != nil {
		t.Fatal(err)
	}
	attach, _ := gateway.HandleClient(request(2, "attach", map[string]any{}))
	if len(attach.Payload) == 0 {
		t.Fatal("attach was not forwarded")
	}
	configured, _ := gateway.HandleClient(request(3, "configurationDone", map[string]any{}))
	if len(configured.Payload) == 0 {
		t.Fatal("configurationDone was rejected after attach")
	}
}

func TestGatewayMarksDisconnectAsExpectedSessionEnd(t *testing.T) {
	gateway := initializedGateway(t, AdapterSpec{SupportsLaunch: true})
	result, err := gateway.HandleClient(request(2, "disconnect", map[string]any{"terminateDebuggee": true}))
	if err != nil || !result.Disconnect || !gateway.SessionEnded() {
		t.Fatalf("disconnect result = %+v, ended=%v, err=%v", result, gateway.SessionEnded(), err)
	}
	after, err := gateway.HandleClient(request(3, "threads", map[string]any{}))
	if err != nil || len(after.LocalResponse) == 0 || len(after.Payload) != 0 {
		t.Fatalf("request after disconnect was not rejected locally: %+v, %v", after, err)
	}
}
