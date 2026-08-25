package nodetoolchain

import "testing"

func TestPNPMExecutablePinsNode20And22CompatibleRelease(t *testing.T) {
	executable, err := PNPMExecutable(DefaultPNPMVersion)
	if err != nil {
		t.Fatal(err)
	}
	if executable != "corepack pnpm@10.32.1" {
		t.Fatalf("pnpm executable = %q", executable)
	}
}

func TestNormalizePNPMVersionRejectsMutableOrIncompatibleSelectors(t *testing.T) {
	for _, value := range []string{"", "latest", "10", "10.34", "^10.34.5", "10.34.x", "10.34.5-beta.1", "11.23.0", "8.15.9", "10.034.5", "10.34.5; id"} {
		t.Run(value, func(t *testing.T) {
			if normalized, err := NormalizePNPMVersion(value); err == nil {
				t.Fatalf("NormalizePNPMVersion(%q) = %q, want error", value, normalized)
			}
		})
	}
}

func TestNormalizePNPMVersionAllowsPinnedPNPMNineOrTen(t *testing.T) {
	for _, value := range []string{"9.15.9", "10.32.1"} {
		if normalized, err := NormalizePNPMVersion(value); err != nil || normalized != value {
			t.Fatalf("NormalizePNPMVersion(%q) = %q, %v", value, normalized, err)
		}
	}
}
