package accountruntime

import (
	"context"
	"time"
)

// CooldownReceipt is an immutable, monotonic generation token returned
// atomically by the runtime from an accepted cooldown failure write.
//
// It binds the exact (accountRef, modelID) route, FailureKind, RetryAt, and
// monotonic cooldown revision so post-429 retry reacquisition can allow only
// the exact failure recorded by this request and never bypass a concurrent
// failure, recovery, or hard block.
type CooldownReceipt struct {
	route    ModelRoute
	kind     FailureKind
	retryAt  time.Time
	revision uint64
}

// NewCooldownReceipt constructs a valid CooldownReceipt for an accepted
// cooldown write; invalid inputs return the zero receipt (fail-closed).
func NewCooldownReceipt(
	route ModelRoute,
	kind FailureKind,
	retryAt time.Time,
	revision uint64,
) CooldownReceipt {
	policy, err := PolicyFor(kind)
	if !route.IsValid() ||
		err != nil ||
		!policy.EntersCooldown() ||
		!isRuntimeTime(retryAt) ||
		revision == 0 {
		return CooldownReceipt{}
	}
	return CooldownReceipt{
		route:    route,
		kind:     kind,
		retryAt:  normalizeRuntimeTime(retryAt),
		revision: revision,
	}
}

// IsValid reports whether the receipt carries complete atomic cooldown provenance.
func (receipt CooldownReceipt) IsValid() bool {
	policy, err := PolicyFor(receipt.kind)
	return receipt.route.IsValid() &&
		err == nil &&
		policy.EntersCooldown() &&
		isRuntimeTime(receipt.retryAt) &&
		receipt.revision > 0
}

// Route returns the exact (accountRef, modelID) route bound by this receipt.
func (receipt CooldownReceipt) Route() ModelRoute {
	return receipt.route
}

// Kind returns the FailureKind that produced the cooldown.
func (receipt CooldownReceipt) Kind() FailureKind {
	return receipt.kind
}

// RetryAt returns the exact cooldown expiry timestamp bound by this receipt.
func (receipt CooldownReceipt) RetryAt() time.Time {
	return receipt.retryAt
}

// Revision returns the monotonic runtime revision of the accepted write.
func (receipt CooldownReceipt) Revision() uint64 {
	return receipt.revision
}

// Matches reports whether eligibility reflects the exact unchanged cooldown
// generation captured in this receipt. Any concurrent write, recovery, or
// hard block invalidates the match.
func (receipt CooldownReceipt) Matches(route ModelRoute, eligibility Eligibility) bool {
	return receipt.IsValid() &&
		route == receipt.route &&
		eligibility.Status() == EligibilityModelCooldown &&
		eligibility.FailureKind() == receipt.kind &&
		eligibility.CooldownRevision() > 0 &&
		eligibility.CooldownRevision() == receipt.revision &&
		eligibility.RetryAt().Equal(receipt.retryAt)
}

type priorCooldownReceiptKey struct{}

// ContextWithPriorCooldownReceipt attaches the immediately preceding owned
// CooldownReceipt onto a sequential retry attempt's context so the runtime can
// verify unbroken single-request cooldown ownership if the retry also receives
// HTTP 429 while the prior cooldown is still active. Passing an invalid receipt
// explicitly clears any outer context value.
func ContextWithPriorCooldownReceipt(
	ctx context.Context,
	receipt CooldownReceipt,
) context.Context {
	if ctx == nil {
		return nil
	}
	if !receipt.IsValid() {
		return context.WithValue(ctx, priorCooldownReceiptKey{}, CooldownReceipt{})
	}
	return context.WithValue(ctx, priorCooldownReceiptKey{}, receipt)
}

// PriorCooldownReceiptFromContext returns the valid prior CooldownReceipt from
// ctx when present.
func PriorCooldownReceiptFromContext(ctx context.Context) (CooldownReceipt, bool) {
	if ctx == nil {
		return CooldownReceipt{}, false
	}
	receipt, ok := ctx.Value(priorCooldownReceiptKey{}).(CooldownReceipt)
	return receipt, ok && receipt.IsValid()
}
