//go:build !linux

package dap

// Docker's Linux user namespace is not available to the host-native builds
// covered by this package. Leave the flag out on those platforms.
func containerUser() string { return "" }
