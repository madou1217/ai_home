//go:build !windows && !linux

package netguard

import "fmt"

// New returns a platform guard. Only Windows has a strict adapter in this
// phase; macOS/Linux adapters are added when their enforcement mechanism is
// implemented. Cooperative/direct launches remain usable everywhere.
func New(options Options) (Guard, error) {
	if options.Policy.Mode == ModeStrict {
		return nil, fmt.Errorf("%w: 需要 macOS sandbox / Linux cgroup 适配器", ErrUnsupportedStrict)
	}
	return NewNoop(options), nil
}
