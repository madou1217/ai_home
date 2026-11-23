package inferencegateway

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	"github.com/madou1217/ai_home/application/admission"
	"github.com/madou1217/ai_home/application/upstreamretry"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

// Upstream429HeaderObserver receives low-cardinality diagnostic headers and
// optional final Retry-After header before downstream response headers commit.
type Upstream429HeaderObserver func(retries int, totalWait time.Duration, retryAfter string)

type upstream429HeaderObserverKey struct{}

// WithUpstream429HeaderObserver attaches a per-request header callback for 429 telemetry.
func WithUpstream429HeaderObserver(
	ctx context.Context,
	observer Upstream429HeaderObserver,
) context.Context {
	if ctx == nil || observer == nil {
		return ctx
	}
	return context.WithValue(ctx, upstream429HeaderObserverKey{}, observer)
}

func observeUpstream429Headers(
	ctx context.Context,
	retries int,
	totalWait time.Duration,
	retryAfter string,
) {
	if ctx == nil {
		return
	}
	observer, ok := ctx.Value(upstream429HeaderObserverKey{}).(Upstream429HeaderObserver)
	if !ok || observer == nil {
		return
	}
	observer(retries, totalWait, retryAfter)
}

type upstream429DispatchAbortError struct {
	reason upstreamretry.AbortReason
}

func (err upstream429DispatchAbortError) Error() string {
	return "upstream 429 retry dispatch aborted: " + string(err.reason)
}

type rateLimitReacquireToken struct {
	waiver        accountrouting.RateLimitCooldownWaiver
	usedWaiver    bool
	evidence      upstreamretry.Evidence
	hasRetryCheck bool
}

type rateLimitReacquireKey struct{}

func withRateLimitReacquire(
	ctx context.Context,
	waiver accountrouting.RateLimitCooldownWaiver,
	usedWaiver bool,
	evidence upstreamretry.Evidence,
) context.Context {
	if ctx == nil {
		return ctx
	}
	return context.WithValue(ctx, rateLimitReacquireKey{}, rateLimitReacquireToken{
		waiver:        waiver,
		usedWaiver:    usedWaiver,
		evidence:      evidence,
		hasRetryCheck: true,
	})
}

func rateLimitReacquireFromContext(ctx context.Context) (rateLimitReacquireToken, bool) {
	if ctx == nil {
		return rateLimitReacquireToken{}, false
	}
	token, ok := ctx.Value(rateLimitReacquireKey{}).(rateLimitReacquireToken)
	return token, ok && token.hasRetryCheck
}

func sameCredentialObservation(
	left accountcredentials.CredentialObservation,
	right accountcredentials.CredentialObservation,
) bool {
	return left.IsValid() &&
		right.IsValid() &&
		left.AccountRef() == right.AccountRef() &&
		left.ProviderID() == right.ProviderID() &&
		left.UpdatedAt().Equal(right.UpdatedAt()) &&
		left.IsStaticSecret() == right.IsStaticSecret()
}

// upstream429Candidate captures the exact route, target account, failure stream,
// atomic runtime CooldownReceipt, and failed attempt's originating CredentialObservation.
type upstream429Candidate struct {
	route             Route
	accountRef        accountcore.AccountRef
	evidence          upstreamretry.Evidence
	cooldownReceipt   runtimecore.CooldownReceipt
	originObservation accountcredentials.CredentialObservation
	stream            *attemptStream
}

type upstream429Tracker struct {
	candidates []upstream429Candidate
}

func (tracker *upstream429Tracker) Record(candidate upstream429Candidate) {
	if tracker == nil || !upstreamretry.Eligible(candidate.evidence) {
		return
	}
	for index := range tracker.candidates {
		existing := tracker.candidates[index]
		if existing.accountRef == candidate.accountRef &&
			existing.route.ProviderID() == candidate.route.ProviderID() &&
			existing.route.EffectiveModel() == candidate.route.EffectiveModel() {
			tracker.candidates[index] = candidate
			return
		}
	}
	tracker.candidates = append(tracker.candidates, candidate)
}

func (tracker *upstream429Tracker) HasCandidates() bool {
	return tracker != nil && len(tracker.candidates) > 0
}

func buildUpstream429Evidence(
	surface string,
	route Route,
	accountRef accountcore.AccountRef,
	pinned bool,
	stream *attemptStream,
	failure AttemptFailure,
) upstreamretry.Evidence {
	status, _ := failure.ObservedHTTPStatus()
	_, explicitAt, hasExplicit := failure.ExplicitRetryAfter()
	explicitRaw, explicitOverflow := failure.ExplicitRetryAfterOverflow()
	committed := stream != nil && stream.Visible()
	return upstreamretry.Evidence{
		Surface:                    surface,
		ProviderID:                 string(route.ProviderID()),
		AccountRef:                 accountRef.String(),
		Pinned:                     pinned,
		Committed:                  committed,
		ObservedHTTPStatus:         status,
		RuntimeKind:                failure.RuntimeKind(),
		Retryable:                  failure.ResponseFailure().Retryable(),
		HasExplicitRetryAfter:      hasExplicit,
		ExplicitRetryAt:            explicitAt,
		ExplicitRetryAfterOverflow: explicitOverflow,
		ExplicitRetryAfterRaw:      explicitRaw,
	}
}

func recordFailureRetryAfterHint(reqState *upstreamretry.RequestState, failure AttemptFailure) {
	if reqState == nil {
		return
	}
	if !isRawHTTP429Failure(failure) {
		reqState.ClearExplicitRetryAfter()
		return
	}
	_, explicitAt, hasExplicit := failure.ExplicitRetryAfter()
	explicitRaw, explicitOverflow := failure.ExplicitRetryAfterOverflow()
	reqState.RecordFailureHint(hasExplicit, explicitAt, explicitOverflow, explicitRaw)
}

func isRawHTTP429Failure(failure AttemptFailure) bool {
	status, known := failure.ObservedHTTPStatus()
	return known && status == http.StatusTooManyRequests
}

// refreshAdmittedInvocationForAttempt repeats post-gate admission (and
// pre-dispatch 429 live policy/not-before checks) while honoring an active
// post-429 cooldown waiver bound to the failed attempt's original CredentialObservation.
func (coordinator *Coordinator) refreshAdmittedInvocationForAttempt(
	ctx context.Context,
	invocation Invocation,
	upstream UpstreamAdapter,
) (Invocation, error) {
	token, hasToken := rateLimitReacquireFromContext(ctx)
	if hasToken && coordinator.upstream429Retries != nil {
		if canDispatch, abortReason := coordinator.upstream429Retries.CanDispatchAfterWait(ctx, token.evidence); !canDispatch {
			return Invocation{}, upstream429DispatchAbortError{reason: abortReason}
		}
	}
	var (
		refreshed      Invocation
		err            error
		enforcedWaiver bool
	)
	if hasToken &&
		token.waiver.IsValid() &&
		invocation.Route().ProviderID() == inference.ProviderClaude &&
		invocation.Account().Ref() == token.waiver.Receipt.Route().AccountRef() {
		request, reqErr := accountrouting.NewPinnedRequest(
			coordinator.catalog,
			string(invocation.Route().ProviderID()),
			invocation.Route().EffectiveModel(),
			invocation.Account().Ref(),
		)
		if reqErr != nil {
			return Invocation{}, reqErr
		}
		request = request.WithSessionAffinity(
			RequestSessionKey(ctx),
			invocation.Request().IncludeEncryptedReasoning(),
		).WithRateLimitCooldownWaiver(token.waiver)
		session, beginErr := coordinator.recruiter.Begin(ctx, request, upstream)
		if beginErr != nil {
			return Invocation{}, beginErr
		}
		recruited, nextErr := session.Next(ctx)
		if errors.Is(nextErr, accountrouting.ErrNoRoutableAccount) {
			return Invocation{}, errAdmittedAccountUnavailable
		}
		if nextErr != nil {
			return Invocation{}, nextErr
		}
		if invocation.Request().IncludeEncryptedReasoning() &&
			recruited.CredentialObservation() != invocation.CredentialObservation() {
			return Invocation{}, accountcredentials.ErrCredentialIdentityChanged
		}
		refreshed, err = newInvocation(
			invocation.Request(),
			invocation.Route(),
			recruited.Account(),
			recruited.Binding(),
			recruited.CredentialObservation(),
			recruited.QuotaBucket(),
		)
		if err != nil {
			return Invocation{}, err
		}
		enforcedWaiver = recruited.UsedRateLimitCooldownWaiver()
	} else {
		refreshed, err = coordinator.refreshAdmittedInvocation(ctx, invocation, upstream)
		if err != nil {
			return Invocation{}, err
		}
		enforcedWaiver = hasToken && token.usedWaiver
	}
	if hasToken && enforcedWaiver {
		if !token.waiver.IsValid() ||
			!sameCredentialObservation(refreshed.CredentialObservation(), token.waiver.Observation) {
			return Invocation{}, errAdmittedAccountUnavailable
		}
		current, checkErr := coordinator.attempts.IsCurrentCredentialObservation(ctx, token.waiver.Observation)
		if checkErr != nil || !current {
			return Invocation{}, errAdmittedAccountUnavailable
		}
	}
	// Final pre-dispatch check immediately after all blocking admission,
	// recruitment/refresh, and credential-observation checks, right before upstream.Execute.
	if hasToken && coordinator.upstream429Retries != nil {
		if canDispatch, abortReason := coordinator.upstream429Retries.CanDispatchAfterWait(ctx, token.evidence); !canDispatch {
			return Invocation{}, upstream429DispatchAbortError{reason: abortReason}
		}
	}
	return refreshed, nil
}

func (coordinator *Coordinator) selectNextUpstream429Candidate(
	ctx context.Context,
	reqState *upstreamretry.RequestState,
	tracker *upstream429Tracker,
) (upstream429Candidate, upstreamretry.Decision, bool) {
	if coordinator == nil || coordinator.upstream429Retries == nil || tracker == nil || len(tracker.candidates) == 0 {
		return upstream429Candidate{}, upstreamretry.Decision{}, false
	}
	var bestCandidate upstream429Candidate
	var bestDecision upstreamretry.Decision
	found := false
	var fallbackAbort upstreamretry.AbortReason
	for _, candidate := range tracker.candidates {
		decision := coordinator.upstream429Retries.PlanNextWait(ctx, reqState, candidate.evidence)
		if !decision.ShouldRetry {
			if fallbackAbort == upstreamretry.AbortNone ||
				(fallbackAbort == upstreamretry.AbortPolicyDisabled && decision.AbortReason != upstreamretry.AbortPolicyDisabled) {
				fallbackAbort = decision.AbortReason
			}
			continue
		}
		if !found || decision.Delay < bestDecision.Delay {
			bestCandidate = candidate
			bestDecision = decision
			found = true
		}
	}
	if !found {
		return tracker.candidates[len(tracker.candidates)-1], upstreamretry.Decision{
			ShouldRetry: false,
			AbortReason: fallbackAbort,
		}, false
	}
	return bestCandidate, bestDecision, true
}

// runUpstream429RetryLoop executes bounded, cancellable post-exhaustion or
// pinned-account wait-and-retry strictly outside route/provider/account gates.
func (coordinator *Coordinator) runUpstream429RetryLoop(
	ctx context.Context,
	request inference.Request,
	pinned bool,
	tracker *upstream429Tracker,
	reqState *upstreamretry.RequestState,
	emit EventSink,
	accountFailures *requestAccountFailureRecorder,
	pendingFailure **attemptStream,
) (terminal bool, err error) {
	if coordinator == nil || coordinator.upstream429Retries == nil || tracker == nil || !tracker.HasCandidates() {
		return false, nil
	}
	if pendingFailure != nil && *pendingFailure != nil && (*pendingFailure).Visible() {
		return false, nil
	}
	surface := "canonical:" + string(request.ClientProtocol())

	candidate, decision, ok := coordinator.selectNextUpstream429Candidate(ctx, reqState, tracker)
	if !ok {
		reqState.NoteAbort(decision.AbortReason)
		return false, nil
	}

	for {
		if err := coordinator.upstream429Retries.Wait(ctx, reqState, candidate.evidence, decision); err != nil {
			coordinator.upstream429Retries.ReportOutcome(
				reqState,
				surface,
				string(candidate.route.ProviderID()),
				candidate.accountRef.String(),
				"cancelled",
				upstreamretry.AbortCancelled,
			)
			return false, err
		}

		if canDispatch, abortReason := coordinator.upstream429Retries.CanDispatchAfterWait(ctx, candidate.evidence); !canDispatch {
			reqState.NoteAbort(abortReason)
			coordinator.upstream429Retries.ReportOutcome(
				reqState,
				surface,
				string(candidate.route.ProviderID()),
				candidate.accountRef.String(),
				"aborted",
				abortReason,
			)
			if abortReason == upstreamretry.AbortCancelled && ctx.Err() != nil {
				return false, ctx.Err()
			}
			return false, nil
		}

		// Publish retry diagnostic headers BEFORE the next attempt can commit its
		// first streaming or non-streaming response byte.
		retries, totalWait := reqState.Summary()
		observeUpstream429Headers(ctx, retries, totalWait, "")

		attemptResult, reacquired, abortReason, attemptErr := coordinator.executeSingleUpstream429Retry(
			ctx,
			request,
			pinned,
			candidate,
			emit,
			accountFailures,
		)
		if attemptErr != nil {
			if attemptResult.stream != nil && attemptResult.stream.Visible() {
				return false, attemptErr
			}
			return false, attemptErr
		}
		if !reacquired {
			if attemptResult.retryableCooldown {
				// 冷却由本次或并发的 429 留下：继续等待下一档，不重新观察上游。
				decision = coordinator.upstream429Retries.PlanNextWait(ctx, reqState, candidate.evidence)
				if !decision.ShouldRetry {
					reqState.NoteAbort(decision.AbortReason)
					coordinator.upstream429Retries.ReportOutcome(
						reqState,
						surface,
						string(candidate.route.ProviderID()),
						candidate.accountRef.String(),
						"aborted",
						decision.AbortReason,
					)
					return false, nil
				}
				continue
			}
			if abortReason == upstreamretry.AbortNone {
				abortReason = upstreamretry.AbortReacquireUnavailable
			}
			reqState.NoteAbort(abortReason)
			coordinator.upstream429Retries.ReportOutcome(
				reqState,
				surface,
				string(candidate.route.ProviderID()),
				candidate.accountRef.String(),
				"aborted",
				abortReason,
			)
			if abortReason == upstreamretry.AbortCancelled && ctx.Err() != nil {
				return false, ctx.Err()
			}
			return false, nil
		}
		if attemptResult.terminal {
			coordinator.upstream429Retries.ReportOutcome(
				reqState,
				surface,
				string(attemptResult.route.ProviderID()),
				attemptResult.accountRef.String(),
				"recovered",
				upstreamretry.AbortNone,
			)
			return true, nil
		}
		if attemptResult.stream != nil && pendingFailure != nil {
			*pendingFailure = attemptResult.stream
		}
		if attemptResult.stream != nil && attemptResult.stream.Visible() {
			return false, nil
		}

		recordFailureRetryAfterHint(reqState, attemptResult.failure)

		nextEvidence := buildUpstream429Evidence(
			surface,
			attemptResult.route,
			attemptResult.accountRef,
			pinned,
			attemptResult.stream,
			attemptResult.failure,
		)
		if !upstreamretry.Eligible(nextEvidence) {
			coordinator.upstream429Retries.ReportOutcome(
				reqState,
				surface,
				string(attemptResult.route.ProviderID()),
				attemptResult.accountRef.String(),
				"failed_non_429",
				upstreamretry.AbortNone,
			)
			return false, nil
		}
		coordinator.upstream429Retries.FreezePolicyAtObservation(ctx, reqState, nextEvidence)

		candidate = upstream429Candidate{
			route:             attemptResult.route,
			accountRef:        attemptResult.accountRef,
			evidence:          nextEvidence,
			cooldownReceipt:   attemptResult.cooldownReceipt,
			originObservation: attemptResult.originObservation,
			stream:            attemptResult.stream,
		}
		decision = coordinator.upstream429Retries.PlanNextWait(ctx, reqState, candidate.evidence)
		if !decision.ShouldRetry {
			reqState.NoteAbort(decision.AbortReason)
			return false, nil
		}
	}
}

type upstream429RetryAttemptResult struct {
	terminal bool
	// retryableCooldown 表示本次没有重新派发，只因 (账号,模型) 软冷却而无法重征召；
	// 调用方应继续按策略等待下一档，而不是把 429 交还客户端。
	retryableCooldown bool
	route             Route
	accountRef        accountcore.AccountRef
	failure           AttemptFailure
	cooldownReceipt   runtimecore.CooldownReceipt
	originObservation accountcredentials.CredentialObservation
	stream            *attemptStream
}

// executeSingleUpstream429Retry reacquires route/provider gates FIRST, then
// re-checks live policy/not-before, live eligibility & fresh credentials before attempting.
func (coordinator *Coordinator) executeSingleUpstream429Retry(
	ctx context.Context,
	request inference.Request,
	pinned bool,
	candidate upstream429Candidate,
	emit EventSink,
	accountFailures *requestAccountFailureRecorder,
) (upstream429RetryAttemptResult, bool, upstreamretry.AbortReason, error) {
	route := candidate.route
	upstream, err := coordinator.upstreams.Resolve(route.ProtocolID())
	if err != nil {
		return upstream429RetryAttemptResult{}, false, upstreamretry.AbortNone, err
	}

	if canDispatch, abortReason := coordinator.upstream429Retries.CanDispatchAfterWait(ctx, candidate.evidence); !canDispatch {
		return upstream429RetryAttemptResult{}, false, abortReason, nil
	}

	rewritten := coordinator.rewriteForRoute(request, route)
	recruited, usedWaiver, recruitErr := coordinator.reacquireAccountFor429Retry(
		ctx,
		rewritten,
		route,
		upstream,
		pinned,
		candidate,
	)
	if recruitErr != nil {
		if errors.Is(recruitErr, accountrouting.ErrModelCooldown) {
			return upstream429RetryAttemptResult{retryableCooldown: true}, false, upstreamretry.AbortNone, nil
		}
		if errors.Is(recruitErr, accountrouting.ErrNoRoutableAccount) ||
			errors.Is(recruitErr, accountcredentials.ErrCredentialIdentityChanged) {
			return upstream429RetryAttemptResult{}, false, upstreamretry.AbortReacquireUnavailable, nil
		}
		return upstream429RetryAttemptResult{}, false, upstreamretry.AbortNone, recruitErr
	}

	invocation, err := newInvocation(
		rewritten,
		route,
		recruited.Account(),
		recruited.Binding(),
		recruited.CredentialObservation(),
		recruited.QuotaBucket(),
	)
	if err != nil {
		return upstream429RetryAttemptResult{}, false, upstreamretry.AbortNone, err
	}

	var waiverForAttempt accountrouting.RateLimitCooldownWaiver
	if usedWaiver {
		waiverForAttempt = accountrouting.RateLimitCooldownWaiver{
			Receipt:     candidate.cooldownReceipt,
			Observation: candidate.originObservation,
		}
	}
	attemptCtx := withRateLimitReacquire(ctx, waiverForAttempt, usedWaiver, candidate.evidence)
	if usedWaiver {
		attemptCtx = runtimecore.ContextWithPriorCooldownReceipt(attemptCtx, candidate.cooldownReceipt)
	} else {
		attemptCtx = runtimecore.ContextWithPriorCooldownReceipt(attemptCtx, runtimecore.CooldownReceipt{})
	}
	outcome, err := coordinator.executeAttempt(
		attemptCtx,
		invocation,
		upstream,
		emit,
		accountFailures,
	)
	var dispatchAbort upstream429DispatchAbortError
	if errors.As(err, &dispatchAbort) {
		return upstream429RetryAttemptResult{}, false, dispatchAbort.reason, nil
	}
	if errors.Is(err, errAdmittedAccountUnavailable) ||
		errors.Is(err, accountcredentials.ErrCredentialIdentityChanged) ||
		admission.IsRejection(err) {
		return upstream429RetryAttemptResult{}, false, upstreamretry.AbortReacquireUnavailable, nil
	}
	if err != nil {
		return upstream429RetryAttemptResult{stream: outcome.stream}, true, upstreamretry.AbortNone, err
	}
	if !outcome.retry {
		return upstream429RetryAttemptResult{
			terminal:   true,
			route:      route,
			accountRef: recruited.Account().Ref(),
			stream:     outcome.stream,
		}, true, upstreamretry.AbortNone, nil
	}

	return upstream429RetryAttemptResult{
		terminal:          false,
		route:             route,
		accountRef:        recruited.Account().Ref(),
		failure:           outcome.failure,
		cooldownReceipt:   outcome.cooldownReceipt,
		originObservation: outcome.observation,
		stream:            outcome.stream,
	}, true, upstreamretry.AbortNone, nil
}

func (coordinator *Coordinator) reacquireAccountFor429Retry(
	ctx context.Context,
	request inference.Request,
	route Route,
	upstream UpstreamAdapter,
	pinned bool,
	candidate upstream429Candidate,
) (accountrouting.Result, bool, error) {
	// For unpinned requests, prefer any newly recovered healthy alternate account
	// before reusing the rate-limited target account's atomic cooldown waiver.
	if !pinned {
		poolReq, err := accountrouting.NewRequest(
			coordinator.catalog,
			string(route.ProviderID()),
			route.EffectiveModel(),
		)
		if err == nil {
			poolReq = poolReq.WithSessionAffinity(
				RequestSessionKey(ctx),
				request.IncludeEncryptedReasoning(),
			)
			if session, beginErr := coordinator.recruiter.Begin(ctx, poolReq, upstream); beginErr == nil {
				if recruited, nextErr := session.Next(ctx); nextErr == nil {
					return recruited, false, nil
				} else if !errors.Is(nextErr, accountrouting.ErrNoRoutableAccount) {
					return accountrouting.Result{}, false, nextErr
				}
			}
		}
	}

	pinnedReq, err := accountrouting.NewPinnedRequest(
		coordinator.catalog,
		string(route.ProviderID()),
		route.EffectiveModel(),
		candidate.accountRef,
	)
	if err != nil {
		return accountrouting.Result{}, false, err
	}
	pinnedReq = pinnedReq.WithSessionAffinity(
		RequestSessionKey(ctx),
		request.IncludeEncryptedReasoning(),
	)
	waiver := accountrouting.RateLimitCooldownWaiver{
		Receipt:     candidate.cooldownReceipt,
		Observation: candidate.originObservation,
	}
	if waiver.IsValid() {
		pinnedReq = pinnedReq.WithRateLimitCooldownWaiver(waiver)
	}
	session, err := coordinator.recruiter.Begin(ctx, pinnedReq, upstream)
	if err != nil {
		return accountrouting.Result{}, false, err
	}
	recruited, err := session.Next(ctx)
	if err != nil {
		return accountrouting.Result{}, false, err
	}
	return recruited, recruited.UsedRateLimitCooldownWaiver(), nil
}

func (coordinator *Coordinator) finalizeExhausted429Headers(
	ctx context.Context,
	request inference.Request,
	reqState *upstreamretry.RequestState,
	pendingFailure *attemptStream,
) {
	if pendingFailure == nil || pendingFailure.Visible() || reqState == nil {
		return
	}
	retries, totalWait := reqState.Summary()
	retryAfter := ""
	if failed, ok := pendingFailure.terminal.(inference.ResponseFailedEvent); ok &&
		failed.Failure().Code() == string(runtimecore.FailureRateLimited) {
		now := time.Now().UTC()
		if coordinator != nil && coordinator.clock != nil {
			now = coordinator.clock().UTC()
		}
		retryAfter = reqState.RetryAfterHeaderValue(now)
	}
	if retries > 0 || retryAfter != "" {
		observeUpstream429Headers(ctx, retries, totalWait, retryAfter)
	}
	if coordinator != nil && coordinator.upstream429Retries != nil {
		outcome := "exhausted"
		if retries == 0 {
			outcome = "aborted"
		}
		coordinator.upstream429Retries.ReportOutcome(
			reqState,
			"canonical:"+string(request.ClientProtocol()),
			"",
			"",
			outcome,
			upstreamretry.AbortNone,
		)
	}
}
