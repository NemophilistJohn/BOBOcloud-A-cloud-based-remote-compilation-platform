//go:build linux

package docker

import (
	"os"
	"strconv"
)

// containerUser keeps bind-mounted cache roots owned by the account running
// the service. Hardened containers drop DAC_OVERRIDE, so a root process would
// not be able to write a 0700 cache owned by that account.
func containerUser() string {
	return strconv.FormatUint(uint64(os.Geteuid()), 10) + ":" + strconv.FormatUint(uint64(os.Getegid()), 10)
}
