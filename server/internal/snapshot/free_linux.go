package snapshot

import (
	"math"

	"golang.org/x/sys/unix"
)

func freeBytes(path string) (int64, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return 0, err
	}
	if stat.Bsize <= 0 {
		return 0, ErrCapacity
	}
	if uint64(stat.Bavail) > uint64(math.MaxInt64/stat.Bsize) {
		return math.MaxInt64, nil
	}
	return int64(stat.Bavail) * stat.Bsize, nil
}
