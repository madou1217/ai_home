package relaycore

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/upstreamretry"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// RateLimitReacquirer is an optional AccountSource extension that reruns full
// fresh recruitment (enabled candidates, UsageGate, runtime hard blocks +
// atomic CooldownWaiver, credentials, and transport policy) after waiting.
type RateLimitReacquirer interface {
	ReacquireFor429Retry(
		ctx context.Context,
		providerID string,
		modelID runtimecore.ModelID,
		target accountcore.AccountRef,
		receipt runtimecore.CooldownReceipt,
		originObservation accountcredentials.CredentialObservation,
	) (accountRef accountcore.AccountRef, usedWaiver bool, found bool, err error)
}

type relay429Candidate struct {
	providerID        string
	route             runtimecore.ModelRoute
	evidence          upstreamretry.Evidence
	cooldownReceipt   runtimecore.CooldownReceipt
	originObservation accountcredentials.CredentialObservation
}

type relay429DispatchGuard struct {
	evidence          upstreamretry.Evidence
	enforcedWaiver    bool
	originObservation accountcredentials.CredentialObservation
}

type relay429DispatchGuardKey struct{}

func withRelay429DispatchGuard(
	ctx context.Context,
	guard relay429DispatchGuard,
) context.Context {
	if ctx == nil {
		return ctx
	}
	return context.WithValue(ctx, relay429DispatchGuardKey{}, guard)
}

func relay429DispatchGuardFromContext(ctx context.Context) (relay429DispatchGuard, bool) {
	if ctx == nil {
		return relay429DispatchGuard{}, false
	}
	guard, ok := ctx.Value(relay429DispatchGuardKey{}).(relay429DispatchGuard)
	return guard, ok && guard.evidence.AccountRef != ""
}

func sameRelayCredentialObservation(
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

type relay429Tracker struct {
	pinned     bool
	candidates []relay429Candidate
	reqState   *upstreamretry.RequestState
	controller *upstreamretry.Controller
}

type relay429TrackerKey struct{}

func withRelay429Tracker(ctx context.Context, tracker *relay429Tracker) context.Context {
	if ctx == nil || tracker == nil {
		return ctx
	}
	return context.WithValue(ctx, relay429TrackerKey{}, tracker)
}

func relay429TrackerFromContext(ctx context.Context) *relay429Tracker {
	if ctx == nil {
		return nil
	}
	tracker, _ := ctx.Value(relay429TrackerKey{}).(*relay429Tracker)
	return tracker
}

func (tracker *relay429Tracker) Record(
	ctx context.Context,
	providerID string,
	route runtimecore.ModelRoute,
	originObservation accountcredentials.CredentialObservation,
	failure inferencegateway.AttemptFailure,
	cooldownReceipt runtimecore.CooldownReceipt,
) {
	if tracker == nil {
		return
	}
	status, known := failure.ObservedHTTPStatus()
	_, explicitAt, hasExplicit := failure.ExplicitRetryAfter()
	explicitRaw, explicitOverflow := failure.ExplicitRetryAfterOverflow()
	if known && status == http.StatusTooManyRequests {
		tracker.reqState.RecordFailureHint(hasExplicit, explicitAt, explicitOverflow, explicitRaw)
	} else {
		tracker.reqState.ClearExplicitRetryAfter()
		return
	}
	evidence := upstreamretry.Evidence{
		Surface:                    "family_relay:" + providerID,
		ProviderID:                 providerID,
		AccountRef:                 route.AccountRef().String(),
		Pinned:                     tracker.pinned,
		Committed:                  false,
		ObservedHTTPStatus:         status,
		RuntimeKind:                failure.RuntimeKind(),
		Retryable:                  failure.ResponseFailure().Retryable(),
		HasExplicitRetryAfter:      hasExplicit,
		ExplicitRetryAt:            explicitAt,
		ExplicitRetryAfterOverflow: explicitOverflow,
		ExplicitRetryAfterRaw:      explicitRaw,
	}
	if !upstreamretry.Eligible(evidence) {
		return
	}
	tracker.controller.FreezePolicyAtObservation(ctx, tracker.reqState, evidence)
	candidate := relay429Candidate{
		providerID:        providerID,
		route:             route,
		evidence:          evidence,
		cooldownReceipt:   cooldownReceipt,
		originObservation: originObservation,
	}
	for index := range tracker.candidates {
		if tracker.candidates[index].route == route {
			tracker.candidates[index] = candidate
			return
		}
	}
	tracker.candidates = append(tracker.candidates, candidate)
}

func (tracker *relay429Tracker) HasCandidates() bool {
	return tracker != nil && len(tracker.candidates) > 0
}

func (handler *Handler) reacquireCooledTargetAfterWait(
	ctx context.Context,
	source AccountSource,
	providerID string,
	modelID runtimecore.ModelID,
	route runtimecore.ModelRoute,
	receipt runtimecore.CooldownReceipt,
	originObservation accountcredentials.CredentialObservation,
) (accountcore.AccountRef, bool, bool) {
	if reacquirer, ok := source.(RateLimitReacquirer); ok {
		ref, usedWaiver, found, err := reacquirer.ReacquireFor429Retry(
			ctx,
			providerID,
			modelID,
			route.AccountRef(),
			receipt,
			originObservation,
		)
		return ref, usedWaiver, err == nil && found && ref.IsValid()
	}
	if handler != nil && handler.accounts != nil {
		if reacquirer, ok := handler.accounts.(RateLimitReacquirer); ok {
			ref, usedWaiver, found, err := reacquirer.ReacquireFor429Retry(
				ctx,
				providerID,
				modelID,
				route.AccountRef(),
				receipt,
				originObservation,
			)
			return ref, usedWaiver, err == nil && found && ref.IsValid()
		}
	}
	// Fail-closed: if a full recruitment/UsageGate/transport reacquirer is not wired,
	// do not bypass admission via bare CheckEligibility.
	return "", false, false
}

func snapshotAndCloseRelayResponse(upstream *http.Response) *http.Response {
	if upstream == nil || upstream.Body == nil {
		return upstream
	}
	payload, _ := io.ReadAll(io.LimitReader(upstream.Body, sharedfailure.MaxErrorPayloadBytes))
	_ = upstream.Body.Close()
	cloned := *upstream
	cloned.Header = upstream.Header.Clone()
	cloned.Body = io.NopCloser(bytes.NewReader(payload))
	return &cloned
}

func (handler *Handler) selectNextRelay429Candidate(
	ctx context.Context,
	reqState *upstreamretry.RequestState,
	tracker *relay429Tracker,
) (relay429Candidate, upstreamretry.Decision, bool) {
	if handler == nil || handler.upstream429Retries == nil || tracker == nil || len(tracker.candidates) == 0 {
		return relay429Candidate{}, upstreamretry.Decision{}, false
	}
	var best relay429Candidate
	var bestDecision upstreamretry.Decision
	found := false
	var fallbackAbort upstreamretry.AbortReason
	for _, candidate := range tracker.candidates {
		decision := handler.upstream429Retries.PlanNextWait(ctx, reqState, candidate.evidence)
		if !decision.ShouldRetry {
			if fallbackAbort == upstreamretry.AbortNone ||
				(fallbackAbort == upstreamretry.AbortPolicyDisabled && decision.AbortReason != upstreamretry.AbortPolicyDisabled) {
				fallbackAbort = decision.AbortReason
			}
			continue
		}
		if !found || decision.Delay < bestDecision.Delay {
			best = candidate
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
	return best, bestDecision, true
}

// runRelay429RetryLoop runs bounded, cancellable 429 waits after closing the
// prior upstream response body, preserving the real 429 response if reacquisition fails.
func (handler *Handler) runRelay429RetryLoop(
	request *http.Request,
	source AccountSource,
	modelID runtimecore.ModelID,
	body []byte,
	stream bool,
	pinned bool,
	tracker *relay429Tracker,
	reqState *upstreamretry.RequestState,
	current attemptOutcome,
) (attemptOutcome, bool) {
	if handler == nil || handler.upstream429Retries == nil || tracker == nil || !tracker.HasCandidates() {
		return current, false
	}
	if current.response != nil && current.response.StatusCode >= 200 && current.response.StatusCode < 300 {
		return current, false
	}
	ctx := request.Context()
	candidate, decision, shouldRetry := handler.selectNextRelay429Candidate(ctx, reqState, tracker)
	if !shouldRetry {
		reqState.NoteAbort(decision.AbortReason)
		return current, false
	}

	if current.response != nil {
		current.response = snapshotAndCloseRelayResponse(current.response)
	}

	for {
		if err := handler.upstream429Retries.Wait(ctx, reqState, candidate.evidence, decision); err != nil {
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"family_relay:"+candidate.providerID,
				candidate.providerID,
				candidate.route.AccountRef().String(),
				"cancelled",
				upstreamretry.AbortCancelled,
			)
			return current, true
		}

		if canDispatch, abortReason := handler.upstream429Retries.CanDispatchAfterWait(ctx, candidate.evidence); !canDispatch {
			reqState.NoteAbort(abortReason)
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"family_relay:"+candidate.providerID,
				candidate.providerID,
				candidate.route.AccountRef().String(),
				"aborted",
				abortReason,
			)
			return current, abortReason == upstreamretry.AbortCancelled && ctx.Err() != nil
		}

		// For unpinned pool requests, prefer any newly healthy alternate account first.
		targetRef := accountcore.AccountRef("")
		usedWaiver := false
		if !pinned && source != nil {
			if freshCursor, err := source.Accounts(ctx, modelID); err == nil && freshCursor != nil {
				if altRef, found, nextErr := freshCursor.Next(ctx); nextErr == nil && found && altRef.IsValid() {
					targetRef = altRef
				}
			}
		}
		if !targetRef.IsValid() {
			reacquiredRef, reacquiredWithWaiver, ok := handler.reacquireCooledTargetAfterWait(
				ctx,
				source,
				candidate.providerID,
				modelID,
				candidate.route,
				candidate.cooldownReceipt,
				candidate.originObservation,
			)
			if !ok {
				reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
				handler.upstream429Retries.ReportOutcome(
					reqState,
					"family_relay:"+candidate.providerID,
					candidate.providerID,
					candidate.route.AccountRef().String(),
					"aborted",
					upstreamretry.AbortReacquireUnavailable,
				)
				return current, false
			}
			targetRef = reacquiredRef
			usedWaiver = reacquiredWithWaiver
		}

		// Final pre-dispatch check immediately after full recruitment/admission and before network send.
		if canDispatch, abortReason := handler.upstream429Retries.CanDispatchAfterWait(ctx, candidate.evidence); !canDispatch {
			reqState.NoteAbort(abortReason)
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"family_relay:"+candidate.providerID,
				candidate.providerID,
				targetRef.String(),
				"aborted",
				abortReason,
			)
			return current, abortReason == upstreamretry.AbortCancelled && ctx.Err() != nil
		}

		roundTracker := &relay429Tracker{
			pinned:     pinned,
			reqState:   reqState,
			controller: handler.upstream429Retries,
		}
		retryCtx := withRelay429Tracker(ctx, roundTracker)
		retryCtx = withRelay429DispatchGuard(retryCtx, relay429DispatchGuard{
			evidence:          candidate.evidence,
			enforcedWaiver:    usedWaiver,
			originObservation: candidate.originObservation,
		})
		if usedWaiver {
			retryCtx = runtimecore.ContextWithPriorCooldownReceipt(retryCtx, candidate.cooldownReceipt)
		} else {
			retryCtx = runtimecore.ContextWithPriorCooldownReceipt(retryCtx, runtimecore.CooldownReceipt{})
		}
		retryReq := request.WithContext(retryCtx)
		next, retry := handler.attemptRelay(retryReq, targetRef, modelID, body, stream)
		if next.abortedReason != upstreamretry.AbortNone && next.response == nil {
			reqState.NoteAbort(next.abortedReason)
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"family_relay:"+candidate.providerID,
				candidate.providerID,
				targetRef.String(),
				"aborted",
				next.abortedReason,
			)
			return current, next.abortedReason == upstreamretry.AbortCancelled && ctx.Err() != nil
		}
		if ctx.Err() != nil {
			next.closeResponse()
			return current, true
		}
		// Never swallow a real 429 into relay_account_unavailable 503 if reacquisition fails.
		if next.response == nil && next.failure.status != http.StatusTooManyRequests {
			reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"family_relay:"+candidate.providerID,
				candidate.providerID,
				targetRef.String(),
				"aborted",
				upstreamretry.AbortReacquireUnavailable,
			)
			return current, false
		}

		current.closeResponse()
		current = next

		if current.response != nil && current.response.StatusCode >= 200 && current.response.StatusCode < 300 {
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"family_relay:"+current.provider,
				current.provider,
				targetRef.String(),
				"recovered",
				upstreamretry.AbortNone,
			)
			return current, false
		}
		if !retry || !roundTracker.HasCandidates() {
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"family_relay:"+candidate.providerID,
				candidate.providerID,
				targetRef.String(),
				"failed_non_429",
				upstreamretry.AbortNone,
			)
			return current, false
		}

		if current.response != nil {
			current.response = snapshotAndCloseRelayResponse(current.response)
		}
		candidate = roundTracker.candidates[len(roundTracker.candidates)-1]
		decision = handler.upstream429Retries.PlanNextWait(ctx, reqState, candidate.evidence)
		if !decision.ShouldRetry {
			reqState.NoteAbort(decision.AbortReason)
			return current, false
		}
	}
}

func isRelayRequestPinned(request *http.Request) bool {
	if request == nil {
		return false
	}
	return strings.TrimSpace(request.Header.Get(inferenceapi.AccountRefHeader)) != ""
}

func applyRelay429ResponseHeaders(
	header http.Header,
	reqState *upstreamretry.RequestState,
	isFinal429 bool,
	now time.Time,
) {
	if header == nil || reqState == nil {
		return
	}
	retries, totalWait := reqState.Summary()
	retryAfter := ""
	clearRetryAfter := false
	if isFinal429 {
		value, action := reqState.RetryAfterHeader(now)
		switch action {
		case upstreamretry.RetryAfterHeaderSet:
			retryAfter = value
		case upstreamretry.RetryAfterHeaderClear:
			clearRetryAfter = true
		}
	}
	inferenceapi.ApplyUpstream429HeadersWithAction(header, retries, totalWait, retryAfter, clearRetryAfter)
}
