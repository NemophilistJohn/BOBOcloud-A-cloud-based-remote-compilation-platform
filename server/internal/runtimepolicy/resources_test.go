package runtimepolicy

import "testing"

func TestMinimumMemoryBytesRecognizesRuntimeIdentityAndLegacyImages(t *testing.T) {
	tests := []struct {
		runtimeID, language, image string
		want                       int64
	}{
		{"rust:1.82", "", "custom-cross:1", CompilerMemoryFloorBytes},
		{"java:21", "", "custom-jdk:21", CompilerMemoryFloorBytes},
		{"", "java", "custom-jdk:21", CompilerMemoryFloorBytes},
		{"", "", "eclipse-temurin:21", CompilerMemoryFloorBytes},
		{"python:3.10", "python", "python:3.10-slim", 0},
	}
	for _, test := range tests {
		if got := MinimumMemoryBytes(test.runtimeID, test.language, test.image); got != test.want {
			t.Fatalf("MinimumMemoryBytes(%q, %q, %q) = %d, want %d", test.runtimeID, test.language, test.image, got, test.want)
		}
	}
}
