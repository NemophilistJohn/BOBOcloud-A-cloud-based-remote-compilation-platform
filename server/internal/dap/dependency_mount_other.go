//go:build !linux

package dap

// Non-Linux development builds retain strict launch-time source validation.
// Production Docker hosts use the DAP-owned kernel bind anchor implementation.
func pinDAPDependencyMount(_ string, _ string, source string) (string, func(), error) {
	validated, err := validateDAPDependencySource(source)
	return validated, func() {}, err
}

func CleanupDependencyMountOrphans(_ string) error { return nil }
