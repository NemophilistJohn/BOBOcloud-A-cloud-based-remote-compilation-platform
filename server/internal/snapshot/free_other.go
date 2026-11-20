//go:build !linux && !windows

package snapshot

func freeBytes(string) (int64, error) { return 0, ErrCapacity }
