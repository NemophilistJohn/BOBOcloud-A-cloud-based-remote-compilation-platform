package auth

import (
	"strings"
	"testing"
)

func TestGeneratedBootstrapPasswordHasStrongRandomPayload(t *testing.T) {
	first, err := GeneratePassword()
	if err != nil {
		t.Fatal(err)
	}
	second, err := GeneratePassword()
	if err != nil {
		t.Fatal(err)
	}
	if first == second || !strings.HasPrefix(first, "Bobo-") || len(first) != len("Bobo-")+24 {
		t.Fatalf("generated password shape is invalid: first=%q second=%q", first, second)
	}
	if err := ValidatePassword(first); err != nil {
		t.Fatalf("generated password failed validation: %v", err)
	}
}

func TestGeneratedSessionTokenReportsEntropyResult(t *testing.T) {
	token, err := GenerateSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, "bobsess_") || len(token) != len("bobsess_")+48 {
		t.Fatalf("generated session token shape = %q", token)
	}
}
