package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/resourcecontrol"
	"bobocloud-server/internal/resourcegovernor"
)

var lspRuntimeImageIdentity = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)

type runtimeDependencyQueryRunner func(context.Context, string, string, string, string, lsp.DependencyAPIQuery) (lsp.DependencyAPIIndexPage, error)

type runtimeDependencyQueryContext struct {
	ownerID            string
	scopeID            string
	imageID            string
	language           string
	runtimeID          string
	dependencyRevision string
}

// runtimeDependenciesForSession binds discovery to the authenticated session's
// immutable selected image. The language-server toolkit image may contain a
// different library set and therefore cannot supply this catalog.
func (h *WSHandler) runtimeDependenciesForSession(ctx context.Context, ownerID, scopeID, runtimeID, image, language, dependencyRevision string) (string, func(context.Context, lsp.DependencyAPIQuery) (lsp.DependencyAPIIndexPage, error)) {
	language = canonicalRuntimeLanguage(language)
	if h == nil || h.RuntimeMetadata == nil || runtimeID == "" || runtimeID == "local" || image == "" ||
		dependencyRevision == "" || (language != "python" && language != "node") {
		return "", nil
	}
	metadataCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	metadata := h.RuntimeMetadata.Resolve(metadataCtx, runtimeID, image, configuredRuntimeVersion(runtimeID))
	cancel()
	if !lspRuntimeImageIdentity.MatchString(metadata.ImageID) {
		return "", nil
	}
	fingerprint := sha256.Sum256([]byte(strings.Join([]string{"runtime-api-v1", runtimeID, language, metadata.ImageID}, "\x00")))
	revision := hex.EncodeToString(fingerprint[:])
	queryContext := runtimeDependencyQueryContext{
		ownerID: ownerID, scopeID: scopeID, imageID: metadata.ImageID,
		language: language, runtimeID: runtimeID, dependencyRevision: dependencyRevision,
	}
	return revision, newGovernedRuntimeDependencyQuery(ctx, h.Resources, queryContext, lsp.RuntimeDependencyAPIQuery)
}

func newGovernedRuntimeDependencyQuery(sessionContext context.Context, resources *resourcecontrol.Controller, bound runtimeDependencyQueryContext, run runtimeDependencyQueryRunner) func(context.Context, lsp.DependencyAPIQuery) (lsp.DependencyAPIIndexPage, error) {
	if sessionContext == nil {
		sessionContext = context.Background()
	}
	// This cache belongs to one authenticated session and its exact image and
	// dependency revision. Store serialized bounded pages so callers cannot
	// mutate a later response through a shared slice.
	var cacheMu sync.Mutex
	cache := make(map[string][]byte)
	order := make([]string, 0, 16)
	return func(ctx context.Context, query lsp.DependencyAPIQuery) (lsp.DependencyAPIIndexPage, error) {
		if ctx == nil {
			ctx = context.Background()
		}
		if err := ctx.Err(); err != nil {
			return lsp.DependencyAPIIndexPage{}, err
		}
		if err := sessionContext.Err(); err != nil {
			return lsp.DependencyAPIIndexPage{}, err
		}
		if err := lsp.ValidateDependencyAPIQuery(query); err != nil {
			return lsp.DependencyAPIIndexPage{}, err
		}
		if query.Kind != "catalog" && query.Kind != "module" {
			return lsp.DependencyAPIIndexPage{}, lsp.ErrDependencyAPIIndexUnavailable
		}
		keyBytes, _ := json.Marshal(query)
		key := string(keyBytes)
		cacheMu.Lock()
		cached := cache[key]
		cacheMu.Unlock()
		if cached != nil {
			var page lsp.DependencyAPIIndexPage
			if json.Unmarshal(cached, &page) == nil {
				return page, nil
			}
		}
		probeContext, cancel := context.WithCancel(ctx)
		stopCancellation := context.AfterFunc(sessionContext, cancel)
		defer func() { stopCancellation(); cancel() }()
		var lease *resourcecontrol.Lease
		if resources != nil {
			var err error
			lease, err = resources.TryAcquireAdmission(resourcecontrol.Admission{
				Workload: resourcecontrol.WorkloadMaintenance,
				OwnerID:  bound.ownerID, ScopeID: bound.scopeID, WorkloadID: "lsp-runtime-index:" + auth.GenerateToken(),
				Minimum: resourcegovernor.Resources{
					DockerContainers: 1, MemoryBytes: 128 << 20, CPUMillicores: 500, PIDs: 32,
				},
			})
			if err != nil {
				return lsp.DependencyAPIIndexPage{}, fmt.Errorf("runtime dependency discovery admission: %w", err)
			}
		}
		// The probe runner proves container removal before returning, including
		// cancellation. The lease covers the real container cleanup interval.
		defer releaseHandlerResource(lease)
		page, err := run(probeContext, bound.imageID, bound.language, bound.runtimeID, bound.dependencyRevision, query)
		if err != nil {
			return lsp.DependencyAPIIndexPage{}, err
		}
		if err := probeContext.Err(); err != nil {
			return lsp.DependencyAPIIndexPage{}, err
		}
		if encoded, marshalErr := json.Marshal(page); marshalErr == nil && len(encoded) <= 192<<10 {
			cacheMu.Lock()
			if _, exists := cache[key]; !exists {
				if len(order) >= 16 {
					delete(cache, order[0])
					order = order[1:]
				}
				order = append(order, key)
			}
			cache[key] = encoded
			cacheMu.Unlock()
		}
		return page, nil
	}
}
