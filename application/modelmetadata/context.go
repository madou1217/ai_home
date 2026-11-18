package modelmetadata

import "context"

// ContextWindow is an exact-model catalog declaration, not an account entitlement.
// Zero optional fields mean unknown; a default window must always be positive.
type ContextWindow struct {
	Tokens            int64
	MaximumTokens     int64
	AutoCompactTokens int64
}

func (window ContextWindow) IsValid() bool {
	return window.Tokens > 0 &&
		(window.MaximumTokens == 0 || window.MaximumTokens >= window.Tokens) &&
		window.AutoCompactTokens >= 0
}

// ContextWindowReader returns a detached snapshot keyed by exact model IDs.
// Unknown models must not inherit a family's or another model's window.
type ContextWindowReader interface {
	ReadContextWindows(context.Context) (map[string]ContextWindow, error)
}
