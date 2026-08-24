//go:build !linux

package packageops

func syncPersistentDirectory(string) error { return nil }
