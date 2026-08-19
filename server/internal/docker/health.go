package docker

import (
	"context"
	"fmt"
	"os/exec"
)

// CheckReady verifies that the configured Docker client can reach its daemon.
// It performs no image pull, container creation, or state disclosure.
func (dp *Pool) CheckReady(ctx context.Context) error {
	if dp == nil {
		return fmt.Errorf("docker pool is not initialized")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	dp.mu.Lock()
	closed := dp.closed
	dp.mu.Unlock()
	if closed {
		return fmt.Errorf("docker pool is shut down")
	}
	if err := exec.CommandContext(ctx, "docker", "info", "--format", "{{.ServerVersion}}").Run(); err != nil {
		return fmt.Errorf("docker daemon is unavailable: %w", err)
	}
	return nil
}
