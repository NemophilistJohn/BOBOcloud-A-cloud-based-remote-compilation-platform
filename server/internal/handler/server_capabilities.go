package handler

import "context"

const (
	serverCapabilitiesSchemaVersion = 1
	serverInfoProtocolVersion       = 1
)

// serverCapabilityDescriptor is intentionally limited to client-facing feature
// gates. It must not carry host paths, credentials, user data, Docker state, or
// raw adapter commands.
type serverCapabilityDescriptor struct {
	SchemaVersion       int                       `json:"schemaVersion"`
	Protocol            serverProtocolDescriptor  `json:"protocol"`
	Release             serverReleaseDescriptor   `json:"release"`
	Transport           serverTransportDescriptor `json:"transport"`
	Capabilities        serverFeatureCapabilities `json:"capabilities"`
	Limits              serverCapabilityLimits    `json:"limits"`
	CatalogRevisions    serverCatalogRevisions    `json:"catalogRevisions"`
	CatalogFingerprints serverCatalogFingerprints `json:"catalogFingerprints"`
}

type serverProtocolDescriptor struct {
	Name    string `json:"name"`
	Version int    `json:"version"`
}

type serverReleaseDescriptor struct {
	Version string `json:"version"`
}

type serverTransportDescriptor struct {
	HTTP      serverTransportEndpoint `json:"http"`
	WebSocket serverTransportEndpoint `json:"websocket"`
}

type serverTransportEndpoint struct {
	Scheme string   `json:"scheme"`
	Paths  []string `json:"paths"`
}

type serverFeatureCapabilities struct {
	Run                bool                    `json:"run"`
	Tasks              bool                    `json:"tasks"`
	Terminal           bool                    `json:"terminal"`
	ProjectEnvironment bool                    `json:"projectEnvironment"`
	PackageCenter      bool                    `json:"packageCenter"`
	CacheV2            bool                    `json:"cacheV2"`
	Collaboration      bool                    `json:"collaboration"`
	LSP                serverServiceCapability `json:"lsp"`
	DAP                serverServiceCapability `json:"dap"`
}

type serverServiceCapability struct {
	Enabled   bool     `json:"enabled"`
	Languages []string `json:"languages,omitempty"`
}

type serverCapabilityLimits struct {
	RunMaxConcurrent               int                 `json:"runMaxConcurrent"`
	TerminalMaxSessionSeconds      int                 `json:"terminalMaxSessionSeconds"`
	PackageOperationTimeoutSeconds int                 `json:"packageOperationTimeoutSeconds"`
	LSP                            serverSessionLimits `json:"lsp"`
	DAP                            serverSessionLimits `json:"dap"`
}

type serverSessionLimits struct {
	MaxSessions int `json:"maxSessions"`
	MaxPerUser  int `json:"maxPerUser"`
}

type serverCatalogRevisions struct {
	LSP int    `json:"lsp"`
	DAP string `json:"dap"`
}

type serverCatalogFingerprints struct {
	LSP string `json:"lsp"`
	DAP string `json:"dap"`
}

func (h *HTTPHandler) serverInfoData(ctx context.Context) map[string]any {
	data := h.dapInfo(ctx)
	if data == nil {
		data = make(map[string]any)
	}
	data["serverCapabilities"] = h.serverCapabilities()
	return data
}

func (h *HTTPHandler) serverCapabilities() serverCapabilityDescriptor {
	descriptor := serverCapabilityDescriptor{
		SchemaVersion: serverCapabilitiesSchemaVersion,
		Protocol: serverProtocolDescriptor{
			Name:    "bobocloud",
			Version: serverInfoProtocolVersion,
		},
		Release: serverReleaseDescriptor{},
		Transport: serverTransportDescriptor{
			HTTP:      serverTransportEndpoint{Scheme: "http", Paths: []string{"/"}},
			WebSocket: serverTransportEndpoint{Scheme: "ws", Paths: []string{"/ws", "/terminal", "/lsp", "/dap"}},
		},
		Capabilities: serverFeatureCapabilities{
			LSP: serverServiceCapability{Languages: []string{}},
			DAP: serverServiceCapability{},
		},
	}
	if h == nil {
		return descriptor
	}

	descriptor.Release.Version = h.Version
	if h.Config == nil {
		return descriptor
	}

	cfg := h.Config
	if cfg.TLSEnabled {
		descriptor.Transport.HTTP.Scheme = "https"
		descriptor.Transport.WebSocket.Scheme = "wss"
	}
	descriptor.Capabilities.Run = h.Sessions != nil && h.Channels != nil
	descriptor.Capabilities.Tasks = descriptor.Capabilities.Run
	descriptor.Capabilities.Terminal = h.Terminal != nil
	descriptor.Capabilities.ProjectEnvironment = h.DependencyViews != nil
	descriptor.Capabilities.PackageCenter = cfg.PackageCenterEnabled && h.PackageCatalog != nil && h.PersonalCache != nil && h.EnvironmentSetup != nil
	descriptor.Capabilities.CacheV2 = h.PersonalCache != nil
	descriptor.Capabilities.Collaboration = h.Collaboration != nil
	descriptor.Limits.RunMaxConcurrent = cfg.DockerMaxContainers
	descriptor.Limits.PackageOperationTimeoutSeconds = cfg.PackageOperationTimeoutSeconds
	if descriptor.Capabilities.Terminal {
		descriptor.Limits.TerminalMaxSessionSeconds = cfg.TerminalMaxSessionSeconds
	}

	if cfg.LSPEnabled && h.LSP != nil {
		descriptor.Capabilities.LSP.Enabled = true
		descriptor.Capabilities.LSP.Languages = append([]string(nil), h.LSP.Languages()...)
		descriptor.Limits.LSP = serverSessionLimits{
			MaxSessions: cfg.LSPMaxSessions,
			MaxPerUser:  cfg.LSPMaxSessionsPerUser,
		}
		descriptor.CatalogRevisions.LSP = h.LSP.CatalogVersion()
		descriptor.CatalogFingerprints.LSP = h.LSP.CatalogFingerprint()
	}
	if cfg.DAPEnabled && h.DAP != nil {
		descriptor.Capabilities.DAP.Enabled = true
		descriptor.Limits.DAP = serverSessionLimits{
			MaxSessions: cfg.DAPMaxSessions,
			MaxPerUser:  cfg.DAPMaxSessionsPerUser,
		}
		descriptor.CatalogRevisions.DAP = h.DAP.CatalogVersion()
		descriptor.CatalogFingerprints.DAP = h.DAP.CatalogFingerprint()
	}

	return descriptor
}
