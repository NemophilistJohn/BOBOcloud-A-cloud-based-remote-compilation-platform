//go:build !linux

package personalcache

// Production project dependency readers run on Linux and receive a kernel
// bind anchor. Development platforms retain the validated canonical path.
func pinPublishedDependency(_ string, source string) (string, func(), error) {
	return source, func() {}, nil
}

func cleanupPublishedDependencyPins(_ string) {}
