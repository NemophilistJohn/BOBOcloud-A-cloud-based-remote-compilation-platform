package handler

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// websocketOriginAllowed keeps native Electron clients working (they omit the
// Origin header) while requiring browser clients to use the request's exact
// HTTP origin. Forwarded headers are intentionally ignored until the server
// has an explicit trusted-proxy policy.
func websocketOriginAllowed(r *http.Request) bool {
	if r == nil {
		return false
	}
	origins := r.Header.Values("Origin")
	if len(origins) == 0 {
		return true
	}
	if len(origins) != 1 {
		return false
	}
	rawOrigin := strings.TrimSpace(origins[0])
	if rawOrigin == "" {
		return false
	}

	origin, err := url.Parse(rawOrigin)
	if err != nil || origin.Opaque != "" || origin.User != nil || origin.Host == "" ||
		origin.Path != "" || origin.RawPath != "" || origin.RawQuery != "" ||
		origin.ForceQuery || origin.Fragment != "" {
		return false
	}
	originScheme := strings.ToLower(origin.Scheme)
	if originScheme != "http" && originScheme != "https" {
		return false
	}

	requestScheme := "http"
	if r.TLS != nil {
		requestScheme = "https"
	}
	if originScheme != requestScheme {
		return false
	}

	originHost, originPort, ok := normalizedWebSocketAuthority(origin.Host, originScheme)
	if !ok {
		return false
	}
	requestHost, requestPort, ok := normalizedWebSocketAuthority(r.Host, requestScheme)
	return ok && strings.EqualFold(originHost, requestHost) && originPort == requestPort
}

// runWebSocketOriginAllowed preserves the current renderer-owned run channel:
// Electron loads index.html through file://, and Chromium serializes that
// origin as either file:// or null depending on the platform/version. The run
// handshake still requires its one-time server token. Main-process LSP, DAP,
// and terminal sockets deliberately do not inherit this exception.
func runWebSocketOriginAllowed(r *http.Request) bool {
	if r != nil {
		origins := r.Header.Values("Origin")
		if len(origins) == 1 {
			origin := strings.TrimSpace(origins[0])
			if strings.EqualFold(origin, "file://") || origin == "null" {
				return true
			}
		}
	}
	return websocketOriginAllowed(r)
}

func normalizedWebSocketAuthority(authority, scheme string) (host, port string, ok bool) {
	if strings.TrimSpace(authority) == "" || strings.TrimSpace(authority) != authority {
		return "", "", false
	}
	parsed, err := url.Parse("//" + authority)
	if err != nil || parsed.Opaque != "" || parsed.User != nil || parsed.Host == "" ||
		parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" ||
		parsed.ForceQuery || parsed.Fragment != "" {
		return "", "", false
	}
	host = parsed.Hostname()
	if host == "" {
		return "", "", false
	}
	port = parsed.Port()
	if port == "" {
		switch scheme {
		case "http":
			return host, "80", true
		case "https":
			return host, "443", true
		default:
			return "", "", false
		}
	}
	portNumber, err := strconv.ParseUint(port, 10, 16)
	if err != nil || portNumber == 0 {
		return "", "", false
	}
	return host, strconv.FormatUint(portNumber, 10), true
}
