//go:build !linux

package personalcache

import (
	"errors"
	"fmt"
	"os"
)

func publishDependencyGeneration(canonical, staged, retired string) error {
	if err := os.Rename(canonical, retired); err != nil {
		return fmt.Errorf("retire previous dependency generation: %w", err)
	}
	if err := os.Rename(staged, canonical); err != nil {
		rollbackErr := os.Rename(retired, canonical)
		return errors.Join(fmt.Errorf("publish staged dependency generation: %w", err), rollbackErr)
	}
	return nil
}
