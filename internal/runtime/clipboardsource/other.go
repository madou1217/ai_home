//go:build !darwin && !windows && !linux

package clipboardsource

import "context"

type unsupportedResolver struct{}

// New returns a resolver that never attributes a source on unsupported hosts.
func New() Resolver { return &unsupportedResolver{} }

func (r *unsupportedResolver) Frontmost(ctx context.Context) (App, bool) {
	return App{}, false
}
