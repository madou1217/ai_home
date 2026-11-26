// Package upstreamretry provides centralized, bounded, cancellable decision and
// wait orchestration for transient upstream HTTP 429 failures across canonical
// inference routes and native HTTP relays.
package upstreamretry

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/requestid"
	corepolicy "github.com/madou1217/ai_home/core/upstreamretry"
)

// ErrStaleRetryDecision indicates Wait was invoked with a decision that does
// not match the current single-flight request retry epoch.
var ErrStaleRetryDecision = errors.New("stale or overlapping upstream 429 retry wait decision")

// PolicyResolver resolves the live effective upstream 429 retry policy for an account.
type PolicyResolver interface {
	Resolve(ctx context.Context, accountRef string) corepolicy.EffectivePolicy
}

// Sleeper sleeps for delay or returns early when ctx is cancelled.
type Sleeper interface {
	Sleep(ctx context.Context, delay time.Duration) error
}

// WaitSource indicates whether the configured schedule or upstream Retry-After determined delay.
type WaitSource string

const (
	WaitSourceSchedule   WaitSource = "schedule"
	WaitSourceRetryAfter WaitSource = "retry_after"
)

// AbortReason describes why a retry wait did not proceed.
type AbortReason string

const (
	AbortNone                        AbortReason = ""
	AbortPolicyDisabled              AbortReason = "policy_disabled"
	AbortRetriesExhausted            AbortReason = "retries_exhausted"
	AbortRetryAfterExceedsLimit      AbortReason = "retry_after_exceeds_limit"
	AbortTotalWaitBudgetExceeded     AbortReason = "total_wait_budget_exceeded"
	AbortRequestDeadlineInsufficient AbortReason = "request_deadline_insufficient"
	AbortCancelled                   AbortReason = "cancelled"
	AbortReacquireUnavailable        AbortReason = "reacquire_unavailable"
)

// WaitEvent is a low-sensitivity diagnostic event emitted right before sleeping.
type WaitEvent struct {
	Surface      string
	RequestID    string
	ProviderID   string
	AccountRef   string
	RetryNumber  int
	MaxRetries   int
	Delay        time.Duration
	WaitSource   WaitSource
	Pinned       bool
	PolicySource corepolicy.PolicySource
}

// OutcomeEvent is a low-sensitivity terminal diagnostic event for requests that
// entered or evaluated upstream 429 waiting.
type OutcomeEvent struct {
	Surface     string
	RequestID   string
	ProviderID  string
	AccountRef  string
	Outcome     string
	Retries     int
	TotalWait   time.Duration
	AbortReason AbortReason
}

// Observer receives low-sensitivity retry telemetry without secrets or payloads.
type Observer interface {
	ObserveWait(event WaitEvent)
	ObserveOutcome(event OutcomeEvent)
}

// Evidence captures only the low-sensitivity provenance needed to gate a 429 retry.
// ExplicitRetryAt must be an anchored UTC timestamp whenever HasExplicitRetryAfter is true.
type Evidence struct {
	Surface                    string
	ProviderID                 string
	AccountRef                 string
	Pinned                     bool
	Committed                  bool
	ObservedHTTPStatus         int
	RuntimeKind                runtimecore.FailureKind
	Retryable                  bool
	HasExplicitRetryAfter      bool
	ExplicitRetryAt            time.Time
	ExplicitRetryAfterOverflow bool
	ExplicitRetryAfterRaw      string
}

// RetryAfterHeaderAction tells final response renderers how to update Retry-After.
type RetryAfterHeaderAction uint8

const (
	// RetryAfterHeaderNone means the final response has no authoritative Retry-After recorded.
	RetryAfterHeaderNone RetryAfterHeaderAction = iota
	// RetryAfterHeaderSet sets Retry-After to the computed remaining seconds or validated overflow decimal.
	RetryAfterHeaderSet
	// RetryAfterHeaderClear deletes any copied upstream Retry-After whose not-before window has already elapsed.
	RetryAfterHeaderClear
)

// Eligible reports whether evidence strictly qualifies for upstream HTTP 429 retry.
//
// Only uncommitted raw HTTP 429 responses classified as transient, retryable
// FailureRateLimited (non-blocking model cooldown) qualify.
func Eligible(evidence Evidence) bool {
	if evidence.Committed ||
		evidence.ObservedHTTPStatus != http.StatusTooManyRequests ||
		evidence.RuntimeKind != runtimecore.FailureRateLimited ||
		!evidence.Retryable ||
		strings.TrimSpace(evidence.AccountRef) == "" {
		return false
	}
	policy, err := runtimecore.PolicyFor(evidence.RuntimeKind)
	if err != nil {
		return false
	}
	return !policy.BlocksRouting() && policy.Action() == runtimecore.ActionModelCooldown
}

// Decision is the deterministic outcome of planning the next wait step.
type Decision struct {
	ShouldRetry  bool
	Delay        time.Duration
	RetryNumber  int
	MaxRetries   int
	PlanEpoch    uint64
	WaitSource   WaitSource
	PolicySource corepolicy.PolicySource
	AbortReason  AbortReason
}

// Controller evaluates effective 429 retry policies and executes cancellable sleeps.
type Controller struct {
	policies PolicyResolver
	clock    func() time.Time
	sleeper  Sleeper
	observer Observer
}

// NewController builds a retry controller with safe default clock and cancellable timer sleeper.
func NewController(
	policies PolicyResolver,
	clock func() time.Time,
	sleeper Sleeper,
	observer Observer,
) *Controller {
	if policies == nil {
		return nil
	}
	if clock == nil {
		clock = time.Now
	}
	if sleeper == nil {
		sleeper = timerSleeper{}
	}
	return &Controller{
		policies: policies,
		clock:    clock,
		sleeper:  sleeper,
		observer: observer,
	}
}

// ResolveCurrent returns the live effective policy for an account.
func (controller *Controller) ResolveCurrent(
	ctx context.Context,
	accountRef string,
) corepolicy.EffectivePolicy {
	if controller == nil || controller.policies == nil {
		return corepolicy.EffectivePolicy{Enabled: false, Source: corepolicy.SourceGlobal}
	}
	return controller.policies.Resolve(ctx, accountRef)
}

// Now returns the controller's current UTC timestamp.
func (controller *Controller) Now() time.Time {
	if controller == nil || controller.clock == nil {
		return time.Now().UTC()
	}
	return controller.clock().UTC()
}

// RequestState holds the shared finite retry permit and frozen per-target schedule
// for a single client HTTP request, shared across phases, routes, and fallback handlers.
type RequestState struct {
	mu                   sync.Mutex
	requestID            string
	frozen               map[string]corepolicy.EffectivePolicy
	retriesUsed          int
	totalWait            time.Duration
	planEpoch            uint64
	inFlightWait         bool
	hasAuthoritativeHint bool
	lastExplicitRetryAt  time.Time
	lastExplicitOverflow bool
	lastExplicitRaw      string
	lastAbortReason      AbortReason
	outcomeReported      bool
}

// NewRequestState creates a fresh request-scoped 429 retry permit.
func NewRequestState() *RequestState {
	return &RequestState{
		frozen: make(map[string]corepolicy.EffectivePolicy, 2),
	}
}

type requestStateContextKey struct{}

// EnsureRequestState returns an existing request-scoped 429 retry state from ctx
// or creates and attaches one so relay->canonical fallback never resets retry counts.
func EnsureRequestState(ctx context.Context) (context.Context, *RequestState) {
	id := requestid.FromContext(ctx)
	if existing, ok := RequestStateFromContext(ctx); ok {
		if id != "" {
			existing.mu.Lock()
			if existing.requestID == "" {
				existing.requestID = id
			}
			existing.mu.Unlock()
		}
		return ctx, existing
	}
	state := NewRequestState()
	state.requestID = id
	return context.WithValue(ctx, requestStateContextKey{}, state), state
}

// RequestID 返回本请求的网关 Request ID；未设置时返回空串。
func (state *RequestState) RequestID() string {
	if state == nil {
		return ""
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.requestID
}

// RequestStateFromContext retrieves the shared request-scoped retry state if attached.
func RequestStateFromContext(ctx context.Context) (*RequestState, bool) {
	if ctx == nil {
		return nil, false
	}
	state, ok := ctx.Value(requestStateContextKey{}).(*RequestState)
	return state, ok && state != nil
}

// Summary returns the monotonic retry count and total waited duration for this request.
func (state *RequestState) Summary() (retries int, totalWait time.Duration) {
	if state == nil {
		return 0, 0
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.retriesUsed, state.totalWait
}

// RecordExplicitRetryAfter saves the latest authoritative anchored upstream
// Retry-After timestamp for final HTTP 429 header propagation. Unanchored
// hints (zero retryAt) clear any previous value so clocks never restart or leak.
func (state *RequestState) RecordExplicitRetryAfter(
	hasHeader bool,
	retryAt time.Time,
) {
	state.RecordFailureHint(hasHeader, retryAt, false, "")
}

// RecordFailureHint binds the exact current response's Retry-After fact (anchored
// timestamp, validated decimal overflow, or absent) so prior accounts' hints can
// never leak onto a later response.
func (state *RequestState) RecordFailureHint(
	hasHeader bool,
	retryAt time.Time,
	overflow bool,
	rawDecimal string,
) {
	if state == nil {
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if !hasHeader {
		state.hasAuthoritativeHint = false
		state.lastExplicitRetryAt = time.Time{}
		state.lastExplicitOverflow = false
		state.lastExplicitRaw = ""
		return
	}
	if overflow && rawDecimal != "" {
		state.hasAuthoritativeHint = true
		state.lastExplicitRetryAt = time.Time{}
		state.lastExplicitOverflow = true
		state.lastExplicitRaw = rawDecimal
		return
	}
	if retryAt.IsZero() {
		state.hasAuthoritativeHint = false
		state.lastExplicitRetryAt = time.Time{}
		state.lastExplicitOverflow = false
		state.lastExplicitRaw = ""
		return
	}
	state.hasAuthoritativeHint = true
	state.lastExplicitRetryAt = retryAt.UTC()
	state.lastExplicitOverflow = false
	state.lastExplicitRaw = ""
}

// ClearExplicitRetryAfter drops any previously recorded Retry-After hint.
func (state *RequestState) ClearExplicitRetryAfter() {
	state.RecordFailureHint(false, time.Time{}, false, "")
}

// RetryAfterHeader computes the exact final Retry-After action for the current response:
//   - RetryAfterHeaderSet: active positive remaining seconds or unrepresentable decimal overflow.
//   - RetryAfterHeaderClear: an authoritative hint existed and has already elapsed (delete stale copied header).
//   - RetryAfterHeaderNone: current response supplied no authoritative hint (leave headers untouched).
func (state *RequestState) RetryAfterHeader(now time.Time) (string, RetryAfterHeaderAction) {
	if state == nil {
		return "", RetryAfterHeaderNone
	}
	state.mu.Lock()
	hasHint := state.hasAuthoritativeHint
	retryAt := state.lastExplicitRetryAt
	overflow := state.lastExplicitOverflow
	rawDecimal := state.lastExplicitRaw
	state.mu.Unlock()

	if !hasHint {
		return "", RetryAfterHeaderNone
	}
	if overflow && rawDecimal != "" {
		return rawDecimal, RetryAfterHeaderSet
	}
	if retryAt.IsZero() {
		return "", RetryAfterHeaderNone
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	remaining := retryAt.Sub(now.UTC())
	if remaining <= 0 {
		return "", RetryAfterHeaderClear
	}
	seconds := int64(math.Ceil(remaining.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	return strconv.FormatInt(seconds, 10), RetryAfterHeaderSet
}

// RetryAfterHeaderValue computes the accurate remaining positive integer seconds
// from the anchored upstream Retry-After timestamp without trimming or restarting.
func (state *RequestState) RetryAfterHeaderValue(now time.Time) string {
	value, action := state.RetryAfterHeader(now)
	if action == RetryAfterHeaderSet {
		return value
	}
	return ""
}

// NoteAbort records the terminal abort reason when waiting cannot continue.
func (state *RequestState) NoteAbort(reason AbortReason) {
	if state == nil || reason == AbortNone {
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	state.lastAbortReason = reason
}

// FreezePolicyAtObservation freezes the effective policy for evidence.AccountRef
// at that target's first eligible HTTP 429 observation without consuming any
// retry permit or sleeping. Subsequent calls for the same target are no-ops.
func (controller *Controller) FreezePolicyAtObservation(
	ctx context.Context,
	state *RequestState,
	evidence Evidence,
) {
	if controller == nil || state == nil || !Eligible(evidence) {
		return
	}
	targetKey := strings.TrimSpace(evidence.AccountRef)
	if targetKey == "" {
		return
	}
	state.mu.Lock()
	_, exists := state.frozen[targetKey]
	state.mu.Unlock()
	if exists {
		return
	}
	livePolicy := controller.ResolveCurrent(ctx, targetKey)
	state.mu.Lock()
	if _, exists := state.frozen[targetKey]; !exists {
		state.frozen[targetKey] = livePolicy.Clone()
	}
	state.mu.Unlock()
}

// PlanNextWait evaluates whether the target account may wait and retry once more.
//
// The target's policy schedule is frozen on first eligible 429 within this request.
// Subsequent hot-disables abort pending retries immediately, while retry counts and
// total wait durations NEVER reset even if global/account settings change mid-request.
func (controller *Controller) PlanNextWait(
	ctx context.Context,
	state *RequestState,
	evidence Evidence,
) Decision {
	if controller == nil || state == nil || !Eligible(evidence) {
		return Decision{ShouldRetry: false, AbortReason: AbortPolicyDisabled}
	}
	if ctx.Err() != nil {
		return Decision{ShouldRetry: false, AbortReason: AbortCancelled}
	}

	targetKey := strings.TrimSpace(evidence.AccountRef)
	livePolicy := controller.ResolveCurrent(ctx, targetKey)

	state.mu.Lock()
	frozen, exists := state.frozen[targetKey]
	if !exists {
		frozen = livePolicy.Clone()
		state.frozen[targetKey] = frozen
	}
	retriesUsed := state.retriesUsed
	totalWait := state.totalWait
	planEpoch := state.planEpoch
	state.mu.Unlock()

	if !livePolicy.Enabled || !frozen.Enabled || len(frozen.BackoffSeconds) == 0 {
		return Decision{
			ShouldRetry:  false,
			PolicySource: livePolicy.Source,
			AbortReason:  AbortPolicyDisabled,
		}
	}
	if retriesUsed >= len(frozen.BackoffSeconds) {
		return Decision{
			ShouldRetry:  false,
			MaxRetries:   len(frozen.BackoffSeconds),
			PolicySource: frozen.Source,
			AbortReason:  AbortRetriesExhausted,
		}
	}

	now := controller.Now()
	scheduled := time.Duration(frozen.BackoffSeconds[retriesUsed]) * time.Second
	delay := scheduled
	waitSource := WaitSourceSchedule

	if evidence.HasExplicitRetryAfter {
		if evidence.ExplicitRetryAfterOverflow {
			return Decision{
				ShouldRetry:  false,
				MaxRetries:   len(frozen.BackoffSeconds),
				WaitSource:   WaitSourceRetryAfter,
				PolicySource: frozen.Source,
				AbortReason:  AbortRetryAfterExceedsLimit,
			}
		}
		remaining, anchored := explicitNotBeforeRemaining(evidence, now)
		if !anchored || remaining > corepolicy.MaxSingleWait {
			return Decision{
				ShouldRetry:  false,
				MaxRetries:   len(frozen.BackoffSeconds),
				WaitSource:   WaitSourceRetryAfter,
				PolicySource: frozen.Source,
				AbortReason:  AbortRetryAfterExceedsLimit,
			}
		}
		if remaining > delay {
			delay = remaining
			waitSource = WaitSourceRetryAfter
		}
	}

	if totalWait+delay > corepolicy.MaxTotalWait {
		return Decision{
			ShouldRetry:  false,
			MaxRetries:   len(frozen.BackoffSeconds),
			WaitSource:   waitSource,
			PolicySource: frozen.Source,
			AbortReason:  AbortTotalWaitBudgetExceeded,
		}
	}

	if deadline, hasDeadline := ctx.Deadline(); hasDeadline && now.Add(delay).After(deadline) {
		return Decision{
			ShouldRetry:  false,
			MaxRetries:   len(frozen.BackoffSeconds),
			WaitSource:   waitSource,
			PolicySource: frozen.Source,
			AbortReason:  AbortRequestDeadlineInsufficient,
		}
	}

	return Decision{
		ShouldRetry:  true,
		Delay:        delay,
		RetryNumber:  retriesUsed + 1,
		MaxRetries:   len(frozen.BackoffSeconds),
		PlanEpoch:    planEpoch,
		WaitSource:   waitSource,
		PolicySource: frozen.Source,
	}
}

// Wait executes one cancellable wait step and atomically claims & advances the
// single-flight request retry epoch.
func (controller *Controller) Wait(
	ctx context.Context,
	state *RequestState,
	evidence Evidence,
	decision Decision,
) error {
	if controller == nil || state == nil || !decision.ShouldRetry {
		return nil
	}
	state.mu.Lock()
	if state.inFlightWait ||
		decision.PlanEpoch != state.planEpoch ||
		decision.RetryNumber != state.retriesUsed+1 {
		state.mu.Unlock()
		return ErrStaleRetryDecision
	}
	state.inFlightWait = true
	state.mu.Unlock()

	if controller.observer != nil {
		controller.observer.ObserveWait(WaitEvent{
			Surface:      evidence.Surface,
			RequestID:    state.RequestID(),
			ProviderID:   evidence.ProviderID,
			AccountRef:   evidence.AccountRef,
			RetryNumber:  decision.RetryNumber,
			MaxRetries:   decision.MaxRetries,
			Delay:        decision.Delay,
			WaitSource:   decision.WaitSource,
			Pinned:       evidence.Pinned,
			PolicySource: decision.PolicySource,
		})
	}
	startedAt := controller.Now()
	err := controller.sleeper.Sleep(ctx, decision.Delay)
	elapsed := controller.Now().Sub(startedAt)
	if elapsed < 0 {
		elapsed = 0
	}
	state.mu.Lock()
	state.inFlightWait = false
	state.planEpoch++
	if err != nil {
		state.totalWait += elapsed
		state.lastAbortReason = AbortCancelled
		state.mu.Unlock()
		return err
	}
	state.retriesUsed++
	// Track the greater of planned delay and measured elapsed time so fake/fast
	// clocks still charge the bounded wait budget deterministically.
	if elapsed < decision.Delay {
		state.totalWait += decision.Delay
	} else {
		state.totalWait += elapsed
	}
	state.mu.Unlock()
	return nil
}

// CanDispatchAfterWait re-checks live policy enablement and anchored upstream
// Retry-After not-before immediately before dispatching the post-wait retry.
func (controller *Controller) CanDispatchAfterWait(
	ctx context.Context,
	evidence Evidence,
) (bool, AbortReason) {
	if controller == nil {
		return false, AbortPolicyDisabled
	}
	if ctx != nil && ctx.Err() != nil {
		return false, AbortCancelled
	}
	livePolicy := controller.ResolveCurrent(ctx, strings.TrimSpace(evidence.AccountRef))
	if !livePolicy.Enabled {
		return false, AbortPolicyDisabled
	}
	if evidence.HasExplicitRetryAfter {
		if evidence.ExplicitRetryAfterOverflow || evidence.ExplicitRetryAt.IsZero() {
			return false, AbortRetryAfterExceedsLimit
		}
		if controller.Now().Before(evidence.ExplicitRetryAt.UTC()) {
			return false, AbortRetryAfterExceedsLimit
		}
	}
	return true, AbortNone
}

// ReportOutcome emits a single terminal diagnostic observation if any retry wait
// occurred or a non-policy-disabled abort reason was recorded.
func (controller *Controller) ReportOutcome(
	state *RequestState,
	surface string,
	providerID string,
	accountRef string,
	outcome string,
	abortReason AbortReason,
) {
	if controller == nil || controller.observer == nil || state == nil {
		return
	}
	state.mu.Lock()
	if state.outcomeReported {
		state.mu.Unlock()
		return
	}
	retries := state.retriesUsed
	totalWait := state.totalWait
	if abortReason == AbortNone {
		abortReason = state.lastAbortReason
	}
	if retries == 0 && (abortReason == AbortNone || abortReason == AbortPolicyDisabled) {
		state.mu.Unlock()
		return
	}
	state.outcomeReported = true
	state.mu.Unlock()

	controller.observer.ObserveOutcome(OutcomeEvent{
		Surface:     surface,
		RequestID:   state.RequestID(),
		ProviderID:  providerID,
		AccountRef:  accountRef,
		Outcome:     outcome,
		Retries:     retries,
		TotalWait:   totalWait,
		AbortReason: abortReason,
	})
}

func explicitNotBeforeRemaining(evidence Evidence, now time.Time) (time.Duration, bool) {
	if evidence.ExplicitRetryAt.IsZero() {
		return 0, false
	}
	remaining := evidence.ExplicitRetryAt.UTC().Sub(now.UTC())
	if remaining > 0 {
		return remaining, true
	}
	return 0, true
}

type timerSleeper struct{}

func (timerSleeper) Sleep(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
