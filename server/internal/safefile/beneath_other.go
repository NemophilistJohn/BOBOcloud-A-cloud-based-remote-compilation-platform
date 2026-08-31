//go:build !linux

package safefile

import (
	"context"
	"io"
	"io/fs"
	"os"
)

func validateDirectoryBeneath(root, relative string) error {
	return validateDirectoryBeneathFallback(root, relative)
}

func ensureDirectoryBeneath(root, relative string, mode fs.FileMode) error {
	return ensureDirectoryBeneathFallback(root, relative, mode)
}

func openRegularBeneath(root, relative string) (*os.File, error) {
	return openRegularBeneathFallback(root, relative)
}

func replaceRegularBeneath(ctx context.Context, root, relative string, source io.Reader, mode fs.FileMode, maxBytes int64) error {
	return replaceRegularBeneathFallback(ctx, root, relative, source, mode, maxBytes)
}

func removeEntryBeneath(root, relative string) error {
	return removeEntryBeneathFallback(root, relative)
}

func removeAllBeneath(root, relative string) error {
	return removeAllBeneathFallback(root, relative)
}
