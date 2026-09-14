//go:build !linux

package docker

// Non-Linux Docker daemons do not expose the host service UID/GID in a
// portable way. Keep the existing image user there; production deployment is
// Linux and uses container_identity_linux.go.
func containerUser() string { return "" }
