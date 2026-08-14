//go:build linux

package lsp

import (
	"os"
	"strconv"
)

// containerUser keeps bind-mounted caches owned by the account running the
// service. Root deployments deliberately resolve to 0:0.
func containerUser() string {
	return numericContainerUser(strconv.Itoa(os.Geteuid()), strconv.Itoa(os.Getegid()))
}
