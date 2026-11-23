package codexresponseshttp

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/upstreamretry"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// RateLimitReacquirer is an optional AccountSource extension that separates
// pinned Phase 0 from Phase 1 pool fallback and supports atomic CooldownReceipt
// post-429 account reacquisition with fresh credentials.
type RateLimitReacquirer interface {
	OpenPinnedOnly(ctx context.Context, model string, accountRef accountcore.AccountRef) (Cursor, error)
	OpenFallbackPool(ctx context.Context, model string, excluded accountcore.AccountRef) (Cursor, error)
	ReacquireFor429Retry(
		ctx context.Context,
		model string,
		pinned bool,
		accountRef accountcore.AccountRef,
		cooldownReceipt runtimecore.CooldownReceipt,
		originObservation accountcredentials.CredentialObservation,
	) (selection Selection, usedWaiver bool, found bool, err error)
}

func sameCodexCredentialObservation(
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

type codex429Candidate struct {
	accountRef        accountcore.AccountRef
	evidence          upstreamretry.Evidence
	cooldownReceipt   runtimecore.CooldownReceipt
	originObservation accountcredentials.CredentialObservation
}

type codex429Tracker struct {
	candidates []codex429Candidate
}

func (tracker *codex429Tracker) Record(candidate codex429Candidate) {
	if tracker == nil || !upstreamretry.Eligible(candidate.evidence) {
		return
	}
	for index := range tracker.candidates {
		if tracker.candidates[index].accountRef == candidate.accountRef {
			tracker.candidates[index] = candidate
			return
		}
	}
	tracker.candidates = append(tracker.candidates, candidate)
}

func (tracker *codex429Tracker) HasCandidates() bool {
	return tracker != nil && len(tracker.candidates) > 0
}

func buildCodex429Evidence(
	accountRef accountcore.AccountRef,
	pinned bool,
	failure inferencegateway.AttemptFailure,
) upstreamretry.Evidence {
	status, _ := failure.ObservedHTTPStatus()
	_, explicitAt, hasExplicit := failure.ExplicitRetryAfter()
	explicitRaw, explicitOverflow := failure.ExplicitRetryAfterOverflow()
	return upstreamretry.Evidence{
		Surface:                    "codex_responses_http",
		ProviderID:                 "codex",
		AccountRef:                 accountRef.String(),
		Pinned:                     pinned,
		Committed:                  false,
		ObservedHTTPStatus:         status,
		RuntimeKind:                failure.RuntimeKind(),
		Retryable:                  failure.ResponseFailure().Retryable(),
		HasExplicitRetryAfter:      hasExplicit,
		ExplicitRetryAt:            explicitAt,
		ExplicitRetryAfterOverflow: explicitOverflow,
		ExplicitRetryAfterRaw:      explicitRaw,
	}
}

func recordCodexFailureHint(reqState *upstreamretry.RequestState, failure inferencegateway.AttemptFailure) {
	if reqState == nil {
		return
	}
	status, known := failure.ObservedHTTPStatus()
	if !known || status != http.StatusTooManyRequests {
		reqState.ClearExplicitRetryAfter()
		return
	}
	_, explicitAt, hasExplicit := failure.ExplicitRetryAfter()
	explicitRaw, explicitOverflow := failure.ExplicitRetryAfterOverflow()
	reqState.RecordFailureHint(hasExplicit, explicitAt, explicitOverflow, explicitRaw)
}

func (handler *Handler) selectNextCodex429Candidate(
	ctx context.Context,
	reqState *upstreamretry.RequestState,
	tracker *codex429Tracker,
) (codex429Candidate, upstreamretry.Decision, bool) {
	if handler == nil || handler.Upstream429Retries == nil || tracker == nil || len(tracker.candidates) == 0 {
		return codex429Candidate{}, upstreamretry.Decision{}, false
	}
	var best codex429Candidate
	var bestDecision upstreamretry.Decision
	found := false
	var fallbackAbort upstreamretry.AbortReason
	for _, candidate := range tracker.candidates {
		decision := handler.Upstream429Retries.PlanNextWait(ctx, reqState, candidate.evidence)
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

// runCodex429RetryLoop performs bounded, cancellable 429 waits and fresh
// credential reacquisition for native Codex HTTP Responses requests.
// Returns handled=true if a final response was already written or client cancelled.
func (handler *Handler) runCodex429RetryLoop(
	ctx context.Context,
	response http.ResponseWriter,
	request *http.Request,
	payload []byte,
	metadata nativeRequest,
	pinned bool,
	tracker *codex429Tracker,
	reqState *upstreamretry.RequestState,
	trail *failureTrail,
	transportBudget *int,
	last **http.Response,
	lastRef *accountcore.AccountRef,
) (handled bool) {
	if handler == nil || handler.Upstream429Retries == nil || tracker == nil || !tracker.HasCandidates() {
		return false
	}
	reacquirer, ok := handler.Accounts.(RateLimitReacquirer)
	if !ok {
		return false
	}
	candidate, decision, shouldRetry := handler.selectNextCodex429Candidate(ctx, reqState, tracker)
	if !shouldRetry {
		reqState.NoteAbort(decision.AbortReason)
		return false
	}

	for {
		if err := handler.Upstream429Retries.Wait(ctx, reqState, candidate.evidence, decision); err != nil {
			handler.Upstream429Retries.ReportOutcome(
				reqState,
				"codex_responses_http",
				"codex",
				candidate.accountRef.String(),
				"cancelled",
				upstreamretry.AbortCancelled,
			)
			return true
		}

		if canDispatch, abortReason := handler.Upstream429Retries.CanDispatchAfterWait(ctx, candidate.evidence); !canDispatch {
			reqState.NoteAbort(abortReason)
			handler.Upstream429Retries.ReportOutcome(
				reqState,
				"codex_responses_http",
				"codex",
				candidate.accountRef.String(),
				"aborted",
				abortReason,
			)
			return abortReason == upstreamretry.AbortCancelled && ctx.Err() != nil
		}

		selection, usedWaiver, found, err := reacquirer.ReacquireFor429Retry(
			ctx,
			metadata.Model,
			pinned,
			candidate.accountRef,
			candidate.cooldownReceipt,
			candidate.originObservation,
		)
		if err != nil || !found || ctx.Err() != nil {
			if ctx.Err() != nil {
				return true
			}
			reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
			handler.Upstream429Retries.ReportOutcome(
				reqState,
				"codex_responses_http",
				"codex",
				candidate.accountRef.String(),
				"aborted",
				upstreamretry.AbortReacquireUnavailable,
			)
			return false
		}
		route, routeErr := runtimecore.NewModelRoute(selection.AccountRef, metadata.Model)
		if routeErr != nil ||
			selection.Credential == nil ||
			selection.Credential.ProviderID() != "codex" ||
			!selection.Observation.IsValid() ||
			selection.Observation.AccountRef() != selection.AccountRef ||
			selection.Observation.ProviderID() != "codex" {
			reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
			return false
		}
		if isStatelessCredential(selection.Credential) && !metadata.passthroughSafe() {
			return false
		}

		if usedWaiver {
			current, checkErr := handler.observed.IsCurrentCredentialObservation(ctx, candidate.originObservation)
			if checkErr != nil || !current || !sameCodexCredentialObservation(selection.Observation, candidate.originObservation) {
				reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
				handler.Upstream429Retries.ReportOutcome(
					reqState,
					"codex_responses_http",
					"codex",
					selection.AccountRef.String(),
					"aborted",
					upstreamretry.AbortReacquireUnavailable,
				)
				return false
			}
		}
		// Final pre-dispatch check immediately after all blocking recruitment,
		// credential refresh, and observation verification, right before nativeRoundTrip.
		if canDispatch, abortReason := handler.Upstream429Retries.CanDispatchAfterWait(ctx, candidate.evidence); !canDispatch {
			reqState.NoteAbort(abortReason)
			handler.Upstream429Retries.ReportOutcome(
				reqState,
				"codex_responses_http",
				"codex",
				selection.AccountRef.String(),
				"aborted",
				abortReason,
			)
			return abortReason == upstreamretry.AbortCancelled && ctx.Err() != nil
		}

		attemptCtx := ctx
		if usedWaiver {
			attemptCtx = runtimecore.ContextWithPriorCooldownReceipt(ctx, candidate.cooldownReceipt)
		} else {
			attemptCtx = runtimecore.ContextWithPriorCooldownReceipt(ctx, runtimecore.CooldownReceipt{})
		}

		upstream, transportFailure, attemptStarted, admitErr := handler.nativeRoundTrip(
			attemptCtx,
			selection,
			payload,
			request,
			trail,
			transportBudget,
			metadata.Model,
		)
		if admitErr != nil {
			reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
			return false
		}
		if upstream == nil {
			if request.Context().Err() != nil {
				return true
			}
			if transportFailure.IsValid() {
				handler.recordFailure(attemptCtx, route, selection, transportFailure)
			}
			return false
		}

		if upstream.StatusCode >= 200 && upstream.StatusCode < 300 {
			probeWindow := handler.ProbeWindow
			if probeWindow <= 0 {
				probeWindow = nativeProbeWindow
			}
			probed := handler.probeResponse(upstream, metadata.Stream, string(selection.AccountRef), probeWindow)
			failure := probed.failure
			if request.Context().Err() != nil {
				_ = upstream.Body.Close()
				return true
			}
			if failure.IsValid() && failure.RuntimeKind() == runtimecore.FailureSafetyRejected {
				handler.recordFailure(ctx, route, selection, failure)
				_ = upstream.Body.Close()
				trail.attempt(selection.AccountRef, "safety_rejected", failure, "", attemptStarted)
				reqState.ClearExplicitRetryAfter()
				applyCodex429ResponseHeaders(response.Header(), reqState, false, handler.Clock())
				handler.fail(response, trail, "upstream_safety_rejected")
				return true
			}
			if failure.IsValid() && failure.ResponseFailure().Retryable() {
				handler.recordFailure(ctx, route, selection, failure)
				trail.attempt(selection.AccountRef, "precommit_failure", failure, "", attemptStarted)
				_ = upstream.Body.Close()
				upstream.Body = io.NopCloser(bytes.NewReader(probed.buffered))
				if *last != nil {
					_ = (*last).Body.Close()
				}
				*last, *lastRef = upstream, selection.AccountRef
				reqState.ClearExplicitRetryAfter()
				return false
			}
			applyCodex429ResponseHeaders(response.Header(), reqState, false, handler.Clock())
			if probed.committed {
				writeResponseHeaders(response, upstream, selection.AccountRef, metadata.Stream)
				flushResponse(response)
			}
			handler.deliver(response, request.WithContext(ctx), upstream, route, selection, metadata.Stream, probed.committed, trail)
			_ = upstream.Body.Close()
			handler.Upstream429Retries.ReportOutcome(
				reqState,
				"codex_responses_http",
				"codex",
				selection.AccountRef.String(),
				"recovered",
				upstreamretry.AbortNone,
			)
			return true
		}

		prefix, readErr := io.ReadAll(io.LimitReader(upstream.Body, 1024*1024+1))
		observedResponse := *upstream
		observedResponse.Body = io.NopCloser(bytes.NewReader(prefix))
		observedAt := handler.Clock()
		classification, classifyErr := configured.ClassifyHTTPWithRules(
			handler.Rules,
			string(selection.AccountRef),
			upstream.StatusCode,
			upstream.Header,
			prefix,
			observedAt,
			func() (sharedfailure.Classification, error) {
				return codexfailure.ObserveHTTP(&observedResponse, observedAt)
			},
		)
		failure, failureErr := attemptfailure.New(classification)
		retry := false
		var cooldownReceipt runtimecore.CooldownReceipt
		trail.attempt(selection.AccountRef, fmt.Sprintf("http_%d", upstream.StatusCode), failure, "", attemptStarted)
		if classifyErr == nil && failureErr == nil {
			cooldownReceipt = handler.recordFailure(attemptCtx, route, selection, failure)
			recordCodexFailureHint(reqState, failure)
			if failure.RuntimeKind() == runtimecore.FailureSafetyRejected {
				_ = upstream.Body.Close()
				applyCodex429ResponseHeaders(response.Header(), reqState, false, handler.Clock())
				handler.fail(response, trail, "upstream_safety_rejected")
				return true
			}
			if failure.RuntimeKind() == runtimecore.FailureUpstreamEdgeRejected {
				_ = upstream.Body.Close()
				applyCodex429ResponseHeaders(response.Header(), reqState, false, handler.Clock())
				handler.fail(response, trail, "upstream_edge_rejected")
				return true
			}
			retry = failure.ResponseFailure().Retryable()
		} else {
			reqState.ClearExplicitRetryAfter()
		}
		if readErr != nil || len(prefix) > 1024*1024 || !retry {
			copyHeaders(response.Header(), upstream.Header)
			setAccountHeaders(response, selection.AccountRef)
			applyCodex429ResponseHeaders(response.Header(), reqState, upstream.StatusCode == http.StatusTooManyRequests, handler.Clock())
			response.WriteHeader(upstream.StatusCode)
			copyBody(response, io.MultiReader(bytes.NewReader(prefix), upstream.Body), 0)
			_ = upstream.Body.Close()
			trail.finish(upstream.StatusCode, "upstream_status")
			handler.Upstream429Retries.ReportOutcome(
				reqState,
				"codex_responses_http",
				"codex",
				selection.AccountRef.String(),
				"failed_non_429",
				upstreamretry.AbortNone,
			)
			return true
		}

		// Close live upstream socket and preserve bounded snapshot BEFORE deciding next sleep.
		_ = upstream.Body.Close()
		upstream.Body = io.NopCloser(bytes.NewReader(prefix))
		if *last != nil {
			_ = (*last).Body.Close()
		}
		*last, *lastRef = upstream, selection.AccountRef

		nextEvidence := buildCodex429Evidence(selection.AccountRef, pinned, failure)
		if !upstreamretry.Eligible(nextEvidence) {
			handler.Upstream429Retries.ReportOutcome(
				reqState,
				"codex_responses_http",
				"codex",
				selection.AccountRef.String(),
				"failed_non_429",
				upstreamretry.AbortNone,
			)
			return false
		}
		handler.Upstream429Retries.FreezePolicyAtObservation(ctx, reqState, nextEvidence)
		candidate = codex429Candidate{
			accountRef:        selection.AccountRef,
			evidence:          nextEvidence,
			cooldownReceipt:   cooldownReceipt,
			originObservation: selection.Observation,
		}
		decision = handler.Upstream429Retries.PlanNextWait(ctx, reqState, candidate.evidence)
		if !decision.ShouldRetry {
			reqState.NoteAbort(decision.AbortReason)
			return false
		}
	}
}

func applyCodex429ResponseHeaders(
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
