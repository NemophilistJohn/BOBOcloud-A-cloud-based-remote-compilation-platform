//go:build linux

package personalcache

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// publishDependencyGeneration atomically exchanges the published and staged
// directories. A crash can leave the old generation at staged, but never
// exposes a missing or half-written canonical path.
func publishDependencyGeneration(canonical, staged, retired string) error {
	if err := unix.Renameat2(unix.AT_FDCWD, canonical, unix.AT_FDCWD, staged, unix.RENAME_EXCHANGE); err != nil {
		return fmt.Errorf("exchange dependency generation: %w", err)
	}
	if err := os.Rename(staged, retired); err != nil {
		rollbackErr := unix.Renameat2(unix.AT_FDCWD, canonical, unix.AT_FDCWD, staged, unix.RENAME_EXCHANGE)
		return errors.Join(fmt.Errorf("retire previous dependency generation: %w", err), rollbackErr)
	}
	return nil
}
