package resourceunit

import "testing"

func TestParseBytes(t *testing.T) {
	tests := map[string]int64{
		"512m":   512_000_000,
		"512MiB": 512 << 20,
		"1.5g":   1_500_000_000,
		"1024":   1024,
	}
	for input, want := range tests {
		got, err := ParseBytes(input)
		if err != nil || got != want {
			t.Fatalf("ParseBytes(%q) = %d, %v; want %d", input, got, err, want)
		}
	}
	for _, input := range []string{"", "0", "-1m", "1tb", "NaN"} {
		if _, err := ParseBytes(input); err == nil {
			t.Fatalf("ParseBytes(%q) unexpectedly succeeded", input)
		}
	}
}
