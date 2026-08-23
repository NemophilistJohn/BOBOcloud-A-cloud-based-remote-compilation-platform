//go:build !linux

package personalcache

func cloneDependencyTreeFast(_, _ string) (bool, error) { return false, nil }
