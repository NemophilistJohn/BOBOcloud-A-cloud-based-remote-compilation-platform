//go:build !windows

package safefile

import "os"

func pathComponentRedirected(_ string, info os.FileInfo) bool {
	return info.Mode()&os.ModeSymlink != 0
}
