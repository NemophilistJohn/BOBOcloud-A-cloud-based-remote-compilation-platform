//go:build linux

package packageops

import (
	"fmt"
	"os"
)

func syncPersistentDirectory(directory string) error {
	file, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("open package completion directory for sync: %w", err)
	}
	defer file.Close()
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync package completion directory: %w", err)
	}
	return nil
}
