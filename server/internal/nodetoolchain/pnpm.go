package nodetoolchain

import (
	"fmt"
	"strconv"
	"strings"
)

// DefaultPNPMVersion is deliberately an exact pnpm 10 release. pnpm 10
// supports both managed Node 20 and Node 22 runtimes, while an unversioned
// Corepack invocation can move to a pnpm major that no longer supports Node 20.
const DefaultPNPMVersion = "10.32.1"

// NormalizePNPMVersion accepts only a stable, exact pnpm version compatible
// with every Node runtime currently advertised by BOBOCLOUD. Tags, ranges and
// prereleases would make dependency materialization depend on mutable registry
// state and are therefore rejected.
func NormalizePNPMVersion(value string) (string, error) {
	value = strings.TrimSpace(value)
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return "", fmt.Errorf("pnpm version must be an exact major.minor.patch release")
	}
	numbers := make([]int, len(parts))
	for index, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return "", fmt.Errorf("pnpm version must be an exact major.minor.patch release")
		}
		for _, character := range part {
			if character < '0' || character > '9' {
				return "", fmt.Errorf("pnpm version must be an exact major.minor.patch release")
			}
		}
		number, err := strconv.Atoi(part)
		if err != nil {
			return "", fmt.Errorf("pnpm version is invalid: %w", err)
		}
		numbers[index] = number
	}
	if numbers[0] < 9 || numbers[0] > 10 {
		return "", fmt.Errorf("pnpm version must use major 9 or 10 for managed Node 20/22 compatibility")
	}
	return fmt.Sprintf("%d.%d.%d", numbers[0], numbers[1], numbers[2]), nil
}

// PNPMExecutable returns a shell-safe, Corepack-mediated executable pinned to
// the reviewed server policy. NormalizePNPMVersion's numeric-only grammar is
// what makes direct composition safe here.
func PNPMExecutable(version string) (string, error) {
	normalized, err := NormalizePNPMVersion(version)
	if err != nil {
		return "", err
	}
	return "corepack pnpm@" + normalized, nil
}
