package handler

import (
	"context"
	"net/http"
	"time"

	"bobocloud-server/internal/dap"
	"bobocloud-server/internal/model"
)

func (h *HTTPHandler) dapInfo(parent context.Context) map[string]any {
	if h == nil || h.DAP == nil || h.Config == nil || !h.Config.DAPEnabled {
		return map[string]any{
			"dap": map[string]any{
				"enabled": false, "protocol": "dap", "transport": "websocket",
				"wsPath": "/dap", "catalogVersion": dap.CatalogVersion, "virtualRootUri": dap.VirtualRootURI,
				"adapters": []dap.Capability{},
			},
		}
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	return map[string]any{
		"dap": map[string]any{
			"enabled": true, "protocol": "dap", "transport": "websocket",
			"wsPath": "/dap", "catalogVersion": h.DAP.CatalogVersion(), "virtualRootUri": dap.VirtualRootURI,
			"adapters": h.DAP.Capabilities(ctx),
		},
	}
}

func (h *HTTPHandler) handleDAPInfo(w http.ResponseWriter, r *http.Request) {
	data := h.dapInfo(r.Context())
	dapData, _ := data["dap"].(map[string]any)
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: dapData})
}
