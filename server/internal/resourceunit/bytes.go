// Package resourceunit parses the resource-limit units shared by Docker and
// node admission. Keeping one parser prevents enforcement and accounting from
// silently disagreeing about the same configured limit.
package resourceunit

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// ParseBytes accepts the decimal and binary suffixes supported by BOBOCLOUD's
// memory-limit configuration. The result is rounded up so admission never
// accounts for less memory than Docker receives.
func ParseBytes(raw string) (int64, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	index := 0
	for index < len(value) && ((value[index] >= '0' && value[index] <= '9') || value[index] == '.') {
		index++
	}
	if index == 0 {
		return 0, fmt.Errorf("must begin with a positive number")
	}
	number, err := strconv.ParseFloat(value[:index], 64)
	if err != nil || number <= 0 || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, fmt.Errorf("must begin with a positive number")
	}
	multipliers := map[string]float64{
		"": 1, "b": 1, "k": 1_000, "kb": 1_000, "ki": 1 << 10, "kib": 1 << 10,
		"m": 1_000_000, "mb": 1_000_000, "mi": 1 << 20, "mib": 1 << 20,
		"g": 1_000_000_000, "gb": 1_000_000_000, "gi": 1 << 30, "gib": 1 << 30,
	}
	multiplier, exists := multipliers[value[index:]]
	if !exists {
		return 0, fmt.Errorf("uses an unsupported size suffix")
	}
	bytes := number * multiplier
	if bytes >= float64(math.MaxInt64) {
		return 0, fmt.Errorf("is too large")
	}
	return int64(math.Ceil(bytes)), nil
}
