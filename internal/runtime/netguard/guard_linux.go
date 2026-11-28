//go:build linux

package netguard

import "fmt"

// New returns the Linux guard. Strict mode uses cgroup v2 + nftables.
func New(options Options) (Guard, error) {
	if options.Policy.Mode == ModeStrict {
		return NewLinuxGuard(options)
	}
	return NewNoop(options), nil
}

var _ = fmt.Sprintf
