package claudenativerelay

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
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

type claudeRelay429Candidate struct {
	route             runtimecore.ModelRoute
	evidence          upstreamretry.Evidence
	cooldownReceipt   runtimecore.CooldownReceipt
	originObservation accountcredentials.CredentialObservation
}

type claudeRelay429DispatchGuard struct {
	evidence          upstreamretry.Evidence
	enforcedWaiver    bool
	originObservation accountcredentials.CredentialObservation
}

type claudeRelay429DispatchGuardKey struct{}

func withClaudeRelay429DispatchGuard(
	ctx context.Context,
	guard claudeRelay429DispatchGuard,
) context.Context {
	if ctx == nil {
		return ctx
	}
	return context.WithValue(ctx, claudeRelay429DispatchGuardKey{}, guard)
}

func claudeRelay429DispatchGuardFromContext(ctx context.Context) (claudeRelay429DispatchGuard, bool) {
	if ctx == nil {
		return claudeRelay429DispatchGuard{}, false
	}
	guard, ok := ctx.Value(claudeRelay429DispatchGuardKey{}).(claudeRelay429DispatchGuard)
	return guard, ok && guard.evidence.AccountRef != ""
}

func sameClaudeCredentialObservation(
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

type claudeRelay429Tracker struct {
	pinned     bool
	candidates []claudeRelay429Candidate
	reqState   *upstreamretry.RequestState
	controller *upstreamretry.Controller
}

type claudeRelay429TrackerKey struct{}

func withClaudeRelay429Tracker(
	ctx context.Context,
	tracker *claudeRelay429Tracker,
) context.Context {
	if ctx == nil || tracker == nil {
		return ctx
	}
	return context.WithValue(ctx, claudeRelay429TrackerKey{}, tracker)
}

func claudeRelay429TrackerFromContext(ctx context.Context) *claudeRelay429Tracker {
	if ctx == nil {
		return nil
	}
	tracker, _ := ctx.Value(claudeRelay429TrackerKey{}).(*claudeRelay429Tracker)
	return tracker
}

func (tracker *claudeRelay429Tracker) Record(
	ctx context.Context,
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
	providerID := strings.TrimSpace(originObservation.ProviderID())
	if providerID == "" {
		providerID = claudeauth.ProviderID
	}
	evidence := upstreamretry.Evidence{
		Surface:                    "claude_native_relay",
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
	candidate := claudeRelay429Candidate{
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

func (tracker *claudeRelay429Tracker) HasCandidates() bool {
	return tracker != nil && len(tracker.candidates) > 0
}

func (handler *Handler) reacquireCooledTargetAfterWait(
	ctx context.Context,
	source AccountSource,
	modelID runtimecore.ModelID,
	route runtimecore.ModelRoute,
	receipt runtimecore.CooldownReceipt,
	originObservation accountcredentials.CredentialObservation,
) (accountcore.AccountRef, bool, bool) {
	if reacquirer, ok := source.(RateLimitReacquirer); ok {
		ref, usedWaiver, found, err := reacquirer.ReacquireFor429Retry(ctx, modelID, route.AccountRef(), receipt, originObservation)
		return ref, usedWaiver, err == nil && found && ref.IsValid()
	}
	if handler != nil && handler.accounts != nil {
		if reacquirer, ok := handler.accounts.(RateLimitReacquirer); ok {
			ref, usedWaiver, found, err := reacquirer.ReacquireFor429Retry(ctx, modelID, route.AccountRef(), receipt, originObservation)
			return ref, usedWaiver, err == nil && found && ref.IsValid()
		}
	}
	// Fail-closed: if a full recruitment/UsageGate/transport reacquirer is not wired,
	// do not bypass admission via bare CheckEligibility.
	return "", false, false
}

func snapshotAndCloseResponse(upstream *http.Response) *http.Response {
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

func (handler *Handler) selectNextClaude429Candidate(
	ctx context.Context,
	reqState *upstreamretry.RequestState,
	tracker *claudeRelay429Tracker,
) (claudeRelay429Candidate, upstreamretry.Decision, bool) {
	if handler == nil || handler.upstream429Retries == nil || tracker == nil || len(tracker.candidates) == 0 {
		return claudeRelay429Candidate{}, upstreamretry.Decision{}, false
	}
	var best claudeRelay429Candidate
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

// runClaude429RetryLoop runs bounded, cancellable 429 waits after closing the
// prior upstream response body, preserving the real 429 snapshot if reacquisition fails.
func (handler *Handler) runClaude429RetryLoop(
	request *http.Request,
	source AccountSource,
	modelID runtimecore.ModelID,
	body []byte,
	pinned bool,
	tracker *claudeRelay429Tracker,
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
	candidate, decision, shouldRetry := handler.selectNextClaude429Candidate(ctx, reqState, tracker)
	if !shouldRetry {
		reqState.NoteAbort(decision.AbortReason)
		return current, false
	}

	// Snapshot bounded error body & close live upstream connection BEFORE sleeping.
	if current.response != nil {
		current.response = snapshotAndCloseResponse(current.response)
	}

	for {
		providerID := strings.TrimSpace(candidate.evidence.ProviderID)
		if providerID == "" {
			providerID = claudeauth.ProviderID
		}
		if err := handler.upstream429Retries.Wait(ctx, reqState, candidate.evidence, decision); err != nil {
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"claude_native_relay",
				providerID,
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
				"claude_native_relay",
				providerID,
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
				modelID,
				candidate.route,
				candidate.cooldownReceipt,
				candidate.originObservation,
			)
			if !ok {
				reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
				handler.upstream429Retries.ReportOutcome(
					reqState,
					"claude_native_relay",
					providerID,
					candidate.route.AccountRef().String(),
					"aborted",
					upstreamretry.AbortReacquireUnavailable,
				)
				return current, false
			}
			targetRef = reacquiredRef
			usedWaiver = reacquiredWithWaiver
		}

		// Pre-dispatch check immediately after full recruitment/admission (final check also runs inside attemptRelay after credential resolution).
		if canDispatch, abortReason := handler.upstream429Retries.CanDispatchAfterWait(ctx, candidate.evidence); !canDispatch {
			reqState.NoteAbort(abortReason)
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"claude_native_relay",
				providerID,
				targetRef.String(),
				"aborted",
				abortReason,
			)
			return current, abortReason == upstreamretry.AbortCancelled && ctx.Err() != nil
		}

		roundTracker := &claudeRelay429Tracker{
			pinned:     pinned,
			reqState:   reqState,
			controller: handler.upstream429Retries,
		}
		retryCtx := withClaudeRelay429Tracker(ctx, roundTracker)
		retryCtx = withClaudeRelay429DispatchGuard(retryCtx, claudeRelay429DispatchGuard{
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
		next, retry := handler.attemptRelay(retryReq, targetRef, modelID, body)
		if next.abortedReason != upstreamretry.AbortNone && next.response == nil {
			reqState.NoteAbort(next.abortedReason)
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"claude_native_relay",
				providerID,
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
		// Never swallow a real 429 into an account-unavailable 503 if reacquisition
		// failed (e.g., credential deleted/disabled/unfit mid-wait).
		if next.response == nil {
			reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"claude_native_relay",
				providerID,
				targetRef.String(),
				"aborted",
				upstreamretry.AbortReacquireUnavailable,
			)
			return current, false
		}

		current.closeResponse()
		current = next
		outcomeProviderID := strings.TrimSpace(current.observation.ProviderID())
		if outcomeProviderID == "" {
			outcomeProviderID = providerID
		}

		if current.response.StatusCode >= 200 && current.response.StatusCode < 300 {
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"claude_native_relay",
				outcomeProviderID,
				targetRef.String(),
				"recovered",
				upstreamretry.AbortNone,
			)
			return current, false
		}
		if !retry || !roundTracker.HasCandidates() {
			handler.upstream429Retries.ReportOutcome(
				reqState,
				"claude_native_relay",
				outcomeProviderID,
				targetRef.String(),
				"failed_non_429",
				upstreamretry.AbortNone,
			)
			return current, false
		}

		current.response = snapshotAndCloseResponse(current.response)
		candidate = roundTracker.candidates[len(roundTracker.candidates)-1]
		decision = handler.upstream429Retries.PlanNextWait(ctx, reqState, candidate.evidence)
		if !decision.ShouldRetry {
			reqState.NoteAbort(decision.AbortReason)
			return current, false
		}
	}
}

func isClaudeRequestPinned(request *http.Request, leased bool) bool {
	if leased {
		return true
	}
	if request == nil {
		return false
	}
	return strings.TrimSpace(request.Header.Get(inferenceapi.AccountRefHeader)) != ""
}

func applyClaude429ResponseHeaders(
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
