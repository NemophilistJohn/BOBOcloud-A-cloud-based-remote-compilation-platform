// Package runtimepolicy contains resource floors that must be shared by
// admission accounting and the actual runtime sandbox.
package runtimepolicy

import "strings"

const CompilerMemoryFloorBytes = int64(1_000_000_000)

// MinimumMemoryBytes returns a runtime-specific lower bound. Runtime and
// language identities are preferred; image prefixes preserve compatibility for
// older callers that only supplied a Docker image.
func MinimumMemoryBytes(runtimeID, language, image string) int64 {
	runtimeID = strings.ToLower(strings.TrimSpace(runtimeID))
	language = strings.ToLower(strings.TrimSpace(language))
	image = strings.ToLower(strings.TrimSpace(image))
	if language == "rust" || language == "java" ||
		runtimeID == "rust" || strings.HasPrefix(runtimeID, "rust:") ||
		runtimeID == "java" || strings.HasPrefix(runtimeID, "java:") ||
		strings.HasPrefix(image, "rust:") || strings.HasPrefix(image, "openjdk:") ||
		strings.HasPrefix(image, "eclipse-temurin:") {
		return CompilerMemoryFloorBytes
	}
	return 0
}
