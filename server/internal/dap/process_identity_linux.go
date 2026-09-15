//go:build linux

package dap

import (
	"os"
	"strconv"
)

// containerUser keeps bind-mounted DAP workspaces and caches owned by the
// account running the server. A root deployment intentionally resolves to
// 0:0, while normal production runs use the non-root service UID:GID.
func containerUser() string {
	return numericContainerUser(strconv.Itoa(os.Geteuid()), strconv.Itoa(os.Getegid()))
}
