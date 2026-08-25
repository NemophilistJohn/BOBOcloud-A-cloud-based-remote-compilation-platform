package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWebSocketOriginAllowsElectronWithoutOrigin(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://cloud.example/socket", nil)
	if !websocketOriginAllowed(request) {
		t.Fatal("Electron request without Origin was rejected")
	}
	request.Header.Set("Origin", " ")
	if websocketOriginAllowed(request) {
		t.Fatal("request with an empty Origin header was accepted")
	}
	request.Header["Origin"] = []string{"", ""}
	if websocketOriginAllowed(request) {
		t.Fatal("request with multiple Origin headers was accepted")
	}
}

func TestWebSocketOriginMatchesSchemeHostAndNormalizedPort(t *testing.T) {
	tests := []struct {
		name       string
		target     string
		host       string
		origin     string
		want       bool
		forwarded  string
		xForwarded string
	}{
		{name: "http implicit port", target: "http://cloud.example/socket", origin: "http://cloud.example", want: true},
		{name: "http explicit request default port", target: "http://cloud.example/socket", host: "cloud.example:80", origin: "http://cloud.example", want: true},
		{name: "http explicit origin default port", target: "http://cloud.example/socket", origin: "http://cloud.example:80", want: true},
		{name: "https implicit port", target: "https://cloud.example/socket", origin: "https://cloud.example", want: true},
		{name: "https explicit request default port", target: "https://cloud.example/socket", host: "cloud.example:443", origin: "https://cloud.example", want: true},
		{name: "https explicit origin default port", target: "https://cloud.example/socket", origin: "https://cloud.example:443", want: true},
		{name: "matching nondefault port", target: "https://cloud.example:8443/socket", origin: "https://cloud.example:8443", want: true},
		{name: "hostname case is insensitive", target: "https://cloud.example/socket", origin: "https://CLOUD.EXAMPLE", want: true},
		{name: "ipv6 authority", target: "https://[2001:db8::1]:8443/socket", origin: "https://[2001:db8::1]:8443", want: true},
		{name: "scheme differs", target: "http://cloud.example/socket", origin: "https://cloud.example", want: false},
		{name: "host differs", target: "https://cloud.example/socket", origin: "https://other.example", want: false},
		{name: "port differs", target: "https://cloud.example:8443/socket", origin: "https://cloud.example:9443", want: false},
		{name: "origin path", target: "https://cloud.example/socket", origin: "https://cloud.example/path", want: false},
		{name: "origin credentials", target: "https://cloud.example/socket", origin: "https://user@cloud.example", want: false},
		{name: "unsupported scheme", target: "https://cloud.example/socket", origin: "ws://cloud.example", want: false},
		{name: "opaque origin", target: "https://cloud.example/socket", origin: "null", want: false},
		{name: "invalid port", target: "https://cloud.example/socket", origin: "https://cloud.example:not-a-port", want: false},
		{
			name: "untrusted forwarded scheme is ignored", target: "http://cloud.example/socket", origin: "https://cloud.example", want: false,
			forwarded: "for=192.0.2.1;proto=https;host=cloud.example", xForwarded: "https",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.target, nil)
			if test.host != "" {
				request.Host = test.host
			}
			request.Header.Set("Origin", test.origin)
			if test.forwarded != "" {
				request.Header.Set("Forwarded", test.forwarded)
			}
			if test.xForwarded != "" {
				request.Header.Set("X-Forwarded-Proto", test.xForwarded)
			}
			if got := websocketOriginAllowed(request); got != test.want {
				t.Fatalf("websocketOriginAllowed() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestProtocolUpgradersUseWebSocketOriginPolicy(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://cloud.example/socket", nil)
	request.Header.Set("Origin", "https://cloud.example")
	for name, check := range map[string]func(*http.Request) bool{
		"run":      wsUpgrader.CheckOrigin,
		"lsp":      lspUpgrader.CheckOrigin,
		"dap":      dapUpgrader.CheckOrigin,
		"terminal": terminalUpgrader.CheckOrigin,
	} {
		if check(request) {
			t.Fatalf("%s upgrader accepted a cross-scheme browser Origin", name)
		}
	}
}

func TestRunWebSocketPreservesElectronFileRendererOrigin(t *testing.T) {
	for _, origin := range []string{"file://", "null"} {
		request := httptest.NewRequest(http.MethodGet, "http://cloud.example/ws", nil)
		request.Header.Set("Origin", origin)
		if !wsUpgrader.CheckOrigin(request) {
			t.Fatalf("run upgrader rejected Electron renderer Origin %q", origin)
		}
		for name, check := range map[string]func(*http.Request) bool{
			"lsp": lspUpgrader.CheckOrigin, "dap": dapUpgrader.CheckOrigin, "terminal": terminalUpgrader.CheckOrigin,
		} {
			if check(request) {
				t.Fatalf("%s upgrader inherited the renderer-only Origin exception", name)
			}
		}
	}
}
