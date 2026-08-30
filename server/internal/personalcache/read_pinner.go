package personalcache

import "context"

// ReadPinner retains one exact published dependency generation for the
// lifetime of a read lease. The sealed interface prevents server packages from
// supplying an implementation that weakens generation stability.
type ReadPinner interface {
	pin(root, source string) (string, func(), error)
	cleanup(context.Context, string) error
}

type platformReadPinner struct{}

func (platformReadPinner) pin(root, source string) (string, func(), error) {
	return pinPublishedDependency(root, source)
}

func (platformReadPinner) cleanup(ctx context.Context, root string) error {
	return cleanupPublishedDependencyPinsContext(ctx, root)
}
