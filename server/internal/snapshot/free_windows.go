package snapshot

import (
	"math"

	"golang.org/x/sys/windows"
)

func freeBytes(path string) (int64, error) {
	value, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var available uint64
	if err := windows.GetDiskFreeSpaceEx(value, &available, nil, nil); err != nil {
		return 0, err
	}
	return int64(min(available, math.MaxInt64)), nil
}
