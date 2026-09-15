package handler

import (
	"context"
	"sort"
	"strings"
	"time"

	"bobocloud-server/internal/config"
	"bobocloud-server/internal/files"
	"bobocloud-server/internal/lsp"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
	"bobocloud-server/internal/runner"
	"bobocloud-server/internal/safefile"
)

// buildResultPreflight is the read-only portion of a reusable build lookup.
// It is intentionally separate from BuildLease: the lease is acquired only
// after central resource admission and before Docker acquisition, while this
// snapshot/fingerprint probe can tell the execution path whether a compile
// stage is likely to be skipped.
type buildResultPreflight struct {
	request     personalcache.BuildRequest
	fingerprint string
	hit         bool
}

func buildResultEligible(cfg *config.Config, sess *model.RunSession, plugin runner.LanguagePlugin, useDocker bool) bool {
	if cfg == nil || sess == nil || plugin == nil || !useDocker || sess.TeamID != "" ||
		!cfg.PersonalBuildCacheEnabled || cfg.PersonalBuildResultReuse != config.PersonalBuildResultReuseCompileOnly {
		return false
	}
	switch plugin.Language() {
	case "c", "cpp", "go", "rust", "java":
		return true
	default:
		return false
	}
}

// preflightBuildResult performs only bounded reads. Any inability to prove a
// hit is a normal miss and falls back to the regular post-admission path; a
// source mutation is rechecked after the BuildLease is acquired.
func (h *WSHandler) preflightBuildResult(ctx context.Context, sess *model.RunSession, runtime model.RuntimeDef, plugin runner.LanguagePlugin, target model.BuildTarget, entryRel, projectPath string) (*buildResultPreflight, error) {
	if h == nil || h.PersonalCache == nil || !buildResultEligible(h.Config, sess, plugin, true) {
		return nil, nil
	}
	started := time.Now()
	defer func() { h.observeStage("cache.personal.build_preflight", started) }()
	if strings.TrimSpace(projectPath) == "" {
		return nil, nil
	}
	projectPath, err := safefile.RealDirectory(projectPath)
	if err != nil {
		// The authoritative workspace resolution already ran after admission;
		// keep this advisory probe fail-open if the directory disappears while
		// the request is being prepared.
		return nil, nil
	}
	runtimeFingerprint := resolvedRuntimeFingerprint(ctx, h.RuntimeMetadata, runtime.RuntimeID, runtime.DockerImage, runtime.Version)
	if strings.TrimSpace(runtimeFingerprint) == "" {
		return nil, nil
	}
	dependencyDigest := ""
	folderKey := strings.TrimSpace(sess.FolderKey)
	if folderKey == "" {
		folderKey = strings.TrimSpace(sess.FolderName)
	}
	targetID := strings.TrimSpace(target.ID)
	if targetID == "" {
		targetID = "native"
	}
	request := personalcache.BuildRequest{
		UserID: sess.UserID, WorkspaceID: lsp.StableWorkspaceIdentity(sess.UserID, "", "", "", folderKey), WorkspaceName: sess.FolderName,
		RuntimeID: runtime.RuntimeID, RuntimeFingerprint: runtimeFingerprint, Language: plugin.Language(),
		DependencyDigest: dependencyDigest, Target: targetID,
	}
	// Most requests are cold. A marker/binding read is bounded by a handful of
	// small files, so avoid the expensive dependency walk, source snapshot, and
	// plan construction unless there is a currently bound result candidate.
	candidateRequest, candidate, candidateOK := h.PersonalCache.ProbeBuildResultCandidate(request)
	if !candidateOK {
		return &buildResultPreflight{request: request}, nil
	}
	// The stored digest tells us which dependency generation the candidate was
	// built against. Re-read manifests only after a candidate exists, then bind
	// the request to the fresh digest before calculating the source fingerprint.
	if projectLockDependencyLanguage(plugin.Language()) {
		dependencyFingerprint, fingerprintErr := personalcache.DependencyFingerprintWithRuntimeAndPolicy(projectPath, plugin.Language(), sess.SetupCommands, runtimeFingerprint, "")
		if fingerprintErr != nil {
			return nil, fingerprintErr
		}
		dependencyDigest = dependencyFingerprint.Digest
	}
	request.DependencyDigest = dependencyDigest
	if candidateRequest.DependencyDigest != dependencyDigest {
		return &buildResultPreflight{request: request}, nil
	}
	limits := workspaceCopyLimits(h.Config)
	snapshot, err := files.SnapshotProjectFiles(ctx, projectPath, limits)
	if err != nil || snapshot.Truncated || snapshot.LimitReached {
		return nil, err
	}
	projectFiles := make([]string, 0, len(snapshot.Files))
	for relative := range snapshot.Files {
		projectFiles = append(projectFiles, relative)
	}
	sort.Strings(projectFiles)
	plan, err := plugin.Plan(&runner.PlanRequest{
		EntryRelPath: entryRel, ProjectFiles: projectFiles, HostWorkDir: projectPath,
		ProjectRoot: "/workspace", CompileArgs: sess.CompileArgs, RunArgs: sess.RunArgs,
		BuildTarget: target,
		Timeouts:    runner.TimeoutConfig{CompileSec: h.Config.DefaultCompileTimeout, RustCompileSec: h.Config.RustCompileTimeout, RunSec: h.Config.DefaultRunTimeout},
	})
	if err != nil || !reusableCompilePlan(plan) {
		return nil, err
	}
	fingerprint, err := executionBuildFingerprint(ctx, projectPath, runtimeFingerprint, dependencyDigest, plan, projectFiles)
	if err != nil {
		return nil, err
	}
	return &buildResultPreflight{
		request: request, fingerprint: fingerprint,
		hit: candidate == fingerprint,
	}, nil
}
