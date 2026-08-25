//go:build !linux

package personalcache

import "context"

// Production project dependency readers run on Linux and receive a kernel
// bind anchor. Development platforms retain the validated canonical path.
func pinPublishedDependency(_ string, source string) (string, func(), error) {
	return source, func() {}, nil
}

func cleanupPublishedDependencyPins(root string) {
	_ = cleanupPublishedDependencyPinsContext(context.Background(), root)
}

func cleanupPublishedDependencyPinsContext(ctx context.Context, _ string) error {
	if ctx == nil {
		return nil
	}
	return ctx.Err()
}
