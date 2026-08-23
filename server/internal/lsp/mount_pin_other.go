//go:build !linux

package lsp

// Non-Linux development builds retain launch-time path validation. Production
// dependency-aware analyzers run in Linux Docker where mount sources are
// anchored before the Docker daemon sees them.
func pinDockerDependencyMounts(_ string, _ string, mounts []AnalysisDependencyMount) ([]AnalysisDependencyMount, func(), error) {
	return append([]AnalysisDependencyMount(nil), mounts...), func() {}, nil
}

func CleanupDependencyMountOrphans(_ string) error { return nil }
