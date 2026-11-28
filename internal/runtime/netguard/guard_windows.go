//go:build windows

package netguard

import "fmt"

// New returns the Windows guard. Strict mode uses the WinDivert P0 adapter
// until the WFP callout driver is available.
func New(options Options) (Guard, error) {
	if options.Policy.Mode == ModeStrict {
		return NewWinDivertGuard(options)
	}
	return NewNoop(options), nil
}

var _ = fmt.Sprintf
