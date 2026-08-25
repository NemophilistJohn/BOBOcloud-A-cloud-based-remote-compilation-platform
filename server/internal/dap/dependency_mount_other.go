//go:build !linux

package dap

import "context"

// Non-Linux development builds retain strict launch-time source validation.
// Production Docker hosts use the DAP-owned kernel bind anchor implementation.
func pinDAPDependencyMount(_ string, _ string, source string) (string, func(), error) {
	validated, err := validateDAPDependencySource(source)
	return validated, func() {}, err
}

func CleanupDependencyMountOrphans(mountRoot string) error {
	return CleanupDependencyMountOrphansContext(context.Background(), mountRoot)
}

func CleanupDependencyMountOrphansContext(ctx context.Context, _ string) error {
	if ctx == nil {
		return nil
	}
	return ctx.Err()
}
