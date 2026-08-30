package docker

import "testing"

func TestMemoryLimitForRuntimeNeverLowersConfiguredLimit(t *testing.T) {
	tests := []struct {
		name, runtimeID, image, configured, want string
	}{
		{"python default", "python:3.10", "python:3.10-slim", "512m", "512m"},
		{"rust floor", "rust:1.82", "bobocloud-cross-rust:1.82", "768m", "1g"},
		{"java custom image", "java:21", "custom-jdk:21", "512MiB", "1g"},
		{"legacy image fallback", "", "eclipse-temurin:21", "256m", "1g"},
		{"operator higher limit", "rust:1.82", "rust:1.82-slim", "2g", "2g"},
		{"invalid preserved", "java:21", "openjdk:21-slim", "oops", "oops"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := memoryLimitForRuntime(test.runtimeID, test.image, test.configured); got != test.want {
				t.Fatalf("memory limit = %q, want %q", got, test.want)
			}
		})
	}
}
