package imageexecution

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/upstreamretry"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
	"github.com/madou1217/ai_home/internal/adapters/images"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
)

type submissionAbortError struct {
	reason upstreamretry.AbortReason
}

func (abortErr *submissionAbortError) Error() string {
	if abortErr == nil {
		return "image submission aborted"
	}
	return "image submission aborted: " + string(abortErr.reason)
}

type image429Candidate struct {
	route             runtimecore.ModelRoute
	evidence          upstreamretry.Evidence
	cooldownReceipt   runtimecore.CooldownReceipt
	originObservation accountcredentials.CredentialObservation
	lastErr           error
}

type image429Tracker struct {
	candidates []image429Candidate
}

func (tracker *image429Tracker) Record(candidate image429Candidate) {
	if tracker == nil || !upstreamretry.Eligible(candidate.evidence) {
		return
	}
	for index := range tracker.candidates {
		if tracker.candidates[index].route.AccountRef() == candidate.route.AccountRef() {
			tracker.candidates[index] = candidate
			return
		}
	}
	tracker.candidates = append(tracker.candidates, candidate)
}

func (tracker *image429Tracker) HasCandidates() bool {
	return tracker != nil && len(tracker.candidates) > 0
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

func isRaw429Error(err error) bool {
	imgErr, ok := images.AsError(err)
	return ok && imgErr != nil && imgErr.ObservedHTTPStatus == http.StatusTooManyRequests
}

func allowsPoolExtensionAfterFailure(failure inferencegateway.AttemptFailure) bool {
	if !failure.IsValid() {
		return false
	}
	switch failure.RuntimeKind() {
	case runtimecore.FailureSafetyRejected,
		runtimecore.FailureUpstreamEdgeRejected,
		runtimecore.FailureInvalidRequest:
		return false
	}
	return failure.ResponseFailure().Retryable()
}

func buildImagesInput(
	request imagegeneration.Request,
	account images.Account,
	httpDoer images.HTTPDoer,
) images.Input {
	return images.Input{
		Mode:              request.Mode,
		Model:             request.Model,
		Prompt:            request.Prompt,
		N:                 request.N,
		Size:              request.Size,
		Quality:           request.Quality,
		ResponseFormat:    images.ResponseFormat(request.ResponseFormat),
		Images:            request.Images,
		Mask:              request.Mask,
		Background:        request.Background,
		OutputFormat:      request.OutputFormat,
		OutputCompression: request.OutputCompression,
		Moderation:        request.Moderation,
		Raw:               request.Raw,
		JSONOnly:          request.JSONOnly,
		Account:           account,
		HTTP:              httpDoer,
	}
}

func buildImage429Evidence(
	surface string,
	provider string,
	accountRef string,
	pinned bool,
	cause error,
	evidenceComplete bool,
	failure inferencegateway.AttemptFailure,
) upstreamretry.Evidence {
	// I2：只有基于完整原始上游错误正文（未截断、可完整分类）的真实 sendUpstream HTTP 429
	// 才允许进入 429 退避重试；任何不完整证据一律置 rawStatus=0 严格 fail-closed。
	rawStatus := 0
	if evidenceComplete {
		if imgErr, ok := images.AsError(cause); ok && imgErr != nil && imgErr.ObservedHTTPStatus > 0 {
			if status, known := failure.ObservedHTTPStatus(); known && status == imgErr.ObservedHTTPStatus {
				rawStatus = status
			}
		}
	}
	_, explicitAt, hasExplicit := failure.ExplicitRetryAfter()
	explicitRaw, explicitOverflow := failure.ExplicitRetryAfterOverflow()
	return upstreamretry.Evidence{
		Surface:                    surface,
		ProviderID:                 provider,
		AccountRef:                 accountRef,
		Pinned:                     pinned,
		Committed:                  false,
		ObservedHTTPStatus:         rawStatus,
		RuntimeKind:                failure.RuntimeKind(),
		Retryable:                  failure.ResponseFailure().Retryable(),
		HasExplicitRetryAfter:      hasExplicit,
		ExplicitRetryAt:            explicitAt,
		ExplicitRetryAfterOverflow: explicitOverflow,
		ExplicitRetryAfterRaw:      explicitRaw,
	}
}

func recordImageFailureHint(
	reqState *upstreamretry.RequestState,
	cause error,
	failure inferencegateway.AttemptFailure,
) {
	if reqState == nil {
		return
	}
	if !isRaw429Error(cause) {
		reqState.ClearExplicitRetryAfter()
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

func applyEvidenceHintToState(
	reqState *upstreamretry.RequestState,
	evidence upstreamretry.Evidence,
) {
	if reqState == nil {
		return
	}
	reqState.RecordFailureHint(
		evidence.HasExplicitRetryAfter,
		evidence.ExplicitRetryAt,
		evidence.ExplicitRetryAfterOverflow,
		evidence.ExplicitRetryAfterRaw,
	)
}

func buildRetryMetadata(
	reqState *upstreamretry.RequestState,
	isFinal429 bool,
	now time.Time,
) RetryMetadata {
	if reqState == nil {
		return RetryMetadata{}
	}
	retries, totalWait := reqState.Summary()
	if !isFinal429 {
		return RetryMetadata{
			Retries:          retries,
			TotalWait:        totalWait,
			RetryAfterAction: upstreamretry.RetryAfterHeaderClear,
		}
	}
	retryAfter, action := reqState.RetryAfterHeader(now)
	return RetryMetadata{
		Retries:          retries,
		TotalWait:        totalWait,
		RetryAfterHeader: retryAfter,
		RetryAfterAction: action,
	}
}

func candidateEligible(
	registry images.Registry,
	provider string,
	request imagegeneration.Request,
	candidate images.Account,
) bool {
	strategy := registry.Resolve(provider, candidate)
	if request.PassthroughOnly {
		return strategy.Kind() == "passthrough"
	}
	if !strategy.SupportsModel(request.Model) {
		return false
	}
	return images.CheckCapabilities(strategy, provider, request) == nil
}

// observeInitialAttemptFailure 在初始 images.Execute 每次尝试失败时精确记录一次运行态失败与
// 原子 CooldownReceipt；无真实观察能力时退回旧有 LegacyFailure 并保持 fail-closed（不加入重试池）。
func (executor *Executor) observeInitialAttemptFailure(
	ctx context.Context,
	reqState *upstreamretry.RequestState,
	session ObservedAccountSession,
	tracker *image429Tracker,
	provider string,
	pinned bool,
	account images.Account,
	model string,
	attemptErr error,
) (inferencegateway.AttemptFailure, bool) {
	failure, failureComplete, failureErr := executor.classifyAttemptFailure(provider, account, attemptErr)
	if failureErr == nil && failure.IsValid() {
		recordImageFailureHint(reqState, attemptErr, failure)
	} else {
		reqState.ClearExplicitRetryAfter()
	}

	var (
		obs    accountcredentials.CredentialObservation
		hasObs bool
	)
	if session != nil {
		obs, hasObs = session.ObservationFor(account.AccountRef)
	}

	if executor.observedAttempts == nil || !hasObs || !obs.IsValid() {
		if executor.legacyFailure != nil {
			recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), executor.recordTimeout)
			defer cancel()
			executor.legacyFailure(recordCtx, account.AccountRef, model, attemptErr)
		}
		return failure, failureErr == nil && failure.IsValid()
	}

	if failureErr != nil || !failure.IsValid() {
		return inferencegateway.AttemptFailure{}, false
	}
	ref, err := accountcore.ParseAccountRef(strings.TrimSpace(account.AccountRef))
	if err != nil {
		return failure, true
	}
	route, routeErr := runtimecore.NewModelRoute(ref, strings.TrimSpace(model))
	if routeErr != nil {
		return failure, true
	}

	recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), executor.recordTimeout)
	defer cancel()
	recordCtx = runtimecore.ContextWithPriorCooldownReceipt(recordCtx, runtimecore.CooldownReceipt{})
	_, receipt, _ := executor.observedAttempts.RecordFailureWithReceipt(recordCtx, route, obs, failure)

	evidence := buildImage429Evidence(
		executor.surface,
		provider,
		account.AccountRef,
		pinned,
		attemptErr,
		failureComplete,
		failure,
	)
	if upstreamretry.Eligible(evidence) {
		if executor.upstream429Retries != nil {
			executor.upstream429Retries.FreezePolicyAtObservation(ctx, reqState, evidence)
		}
		tracker.Record(image429Candidate{
			route:             route,
			evidence:          evidence,
			cooldownReceipt:   receipt,
			originObservation: obs,
			lastErr:           attemptErr,
		})
	}
	return failure, true
}

// classifyAttemptFailure 对真实 sendUpstream 非 2xx 响应使用完整（未截断）错误正文、到达时刻
// 锚定的 Retry-After 与 configured.ClassifyHTTPWithRules；返回 evidenceComplete 标记是否具备
// 完整可信的结构化分类证据（超过 64KB 时不走内置 64KB 截断解码，畸形/截断大 JSON 严格 fail-closed）。
func (executor *Executor) classifyAttemptFailure(
	provider string,
	account images.Account,
	cause error,
) (inferencegateway.AttemptFailure, bool, error) {
	if imageErr, ok := images.AsError(cause); ok && imageErr != nil {
		if imageErr.ObservedHTTPStatus > 0 {
			observedAt := imageErr.ObservedAt
			if observedAt.IsZero() {
				observedAt = executor.now()
			}
			body, complete := imageErr.FailureEvidence()
			if !complete {
				body = imageErr.FailureBody()
			}
			evidenceComplete := complete
			if evidenceComplete && len(body) > sharedfailure.MaxErrorPayloadBytes && looksLikeJSONObject(body) && !json.Valid(body) {
				evidenceComplete = false
			}
			isCodexOAuth := strings.EqualFold(strings.TrimSpace(provider), "codex") && !account.APIKeyMode
			classification, observeErr := configured.ClassifyHTTPWithRules(
				executor.rules,
				account.AccountRef,
				imageErr.ObservedHTTPStatus,
				imageErr.UpstreamHeader,
				body,
				observedAt,
				func() (sharedfailure.Classification, error) {
					if isCodexOAuth {
						if len(body) <= sharedfailure.MaxErrorPayloadBytes {
							observed := &http.Response{
								StatusCode: imageErr.ObservedHTTPStatus,
								Header:     imageErr.UpstreamHeader,
								Body:       io.NopCloser(bytes.NewReader(body)),
							}
							classification, err := codexfailure.ObserveHTTP(observed, observedAt)
							if err != nil {
								return classification, err
							}
							return reclassifyCodexOAuthImageForbidden(
								imageErr.ObservedHTTPStatus,
								classification,
							)
						}
						// 内置 codexfailure.ObserveHTTP 内部按 64KB 截断解码；超过 64KB 时直接解析
						// 完整已有界正文，防止尾部硬配额/账单字段被丢弃并误判为瞬态 429。
						classified, decodedOK, err := observeLargeCodexHTTP(
							imageErr.ObservedHTTPStatus,
							imageErr.UpstreamHeader,
							body,
							observedAt,
						)
						if !decodedOK {
							evidenceComplete = false
						}
						if err != nil {
							return classified, err
						}
						return reclassifyCodexOAuthImageForbidden(
							imageErr.ObservedHTTPStatus,
							classified,
						)
					}
					return sharedfailure.ObserveHTTP(
						imageErr.ObservedHTTPStatus,
						imageErr.UpstreamHeader,
						body,
						observedAt,
					)
				},
			)
			if observeErr == nil {
				failure, err := attemptfailure.New(classification)
				return failure, evidenceComplete, err
			}
			if errors.Is(observeErr, sharedfailure.ErrNoFailureEvidence) {
				return inferencegateway.AttemptFailure{}, false, observeErr
			}
		} else if imageErr.StatusCode >= http.StatusBadRequest {
			// 非真实上游 HTTP 状态（本地构造、解析、转码、超时等）：保留与既有 RecordImageFailure
			// 一致的运行态记录语义，但绝不附加 ObservedHTTPStatus，因此不可能触发 429 重试。
			classification, observeErr := sharedfailure.ObserveHTTP(
				imageErr.StatusCode,
				nil,
				[]byte(imageErr.UpstreamBody),
				executor.now(),
			)
			if observeErr == nil {
				failure, err := attemptfailure.New(classification)
				return failure, false, err
			}
			if errors.Is(observeErr, sharedfailure.ErrNoFailureEvidence) {
				return inferencegateway.AttemptFailure{}, false, observeErr
			}
		}
	}
	if failure, err := attemptfailure.NewTransport(cause); err == nil {
		return failure, false, nil
	}
	failure, err := attemptfailure.NewClassified(runtimecore.FailureUpstreamUnavailable)
	return failure, false, err
}

// reclassifyCodexOAuthImageForbidden 把 Codex OAuth 在图片端点的通用 403 收敛为
// 账号-模型级权限阻塞，而不是共享分类器的账号级凭据拒绝。
//
// 2026-11-20 真实账号验证：token_revoked 的账号文本和图片都返回 401，必须账号级阻塞；
// 另一些账号文本仍可用，只有 /codex/images/* 返回 403 {"detail":"Forbidden"}。共享的
// codexfailure 把这类通用 403 归为 credential_rejected，若直接落库会让账号连文本一起
// 被移出池。401 与其他更具体的 403 分类（边缘拦截、账单、额度等）不在这里改写。
func reclassifyCodexOAuthImageForbidden(
	statusCode int,
	classification sharedfailure.Classification,
) (sharedfailure.Classification, error) {
	if statusCode != http.StatusForbidden ||
		classification.Kind() != runtimecore.FailureCredentialRejected {
		return classification, nil
	}
	return sharedfailure.NewBlockingClassification(
		runtimecore.FailurePermissionDenied,
		runtimecore.BlockScopeAccountModel,
	)
}

func looksLikeJSONObject(body []byte) bool {
	trimmed := bytes.TrimSpace(body)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

type largeCodexErrorFields struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type largeCodexErrorEnvelope struct {
	Type     string                 `json:"type"`
	Code     string                 `json:"code"`
	Error    *largeCodexErrorFields `json:"error"`
	Detail   *largeCodexErrorFields `json:"detail"`
	Response *struct {
		Error *largeCodexErrorFields `json:"error"`
	} `json:"response"`
}

// observeLargeCodexHTTP 在响应体已完整读取但大于 64KB 时，对完整 JSON 信封提取 Codex 稳定错误标识并
// 委托 codexfailure.Classify；若形似 JSON 却无法完整解析，返回 decodedOK=false 让上层 429 重试 fail-closed。
func observeLargeCodexHTTP(
	statusCode int,
	header http.Header,
	body []byte,
	observedAt time.Time,
) (sharedfailure.Classification, bool, error) {
	if classification, rejected := sharedfailure.ObserveEdgeRejection(statusCode, header, body); rejected {
		return classification, true, nil
	}
	var envelope largeCodexErrorEnvelope
	decodedOK := true
	if looksLikeJSONObject(body) {
		if err := json.Unmarshal(body, &envelope); err != nil {
			decodedOK = false
		}
	}
	var fields largeCodexErrorFields
	switch {
	case envelope.Response != nil && envelope.Response.Error != nil:
		fields = *envelope.Response.Error
	case envelope.Error != nil:
		fields = *envelope.Error
	case envelope.Detail != nil:
		fields = *envelope.Detail
	default:
		fields = largeCodexErrorFields{Type: envelope.Type, Code: envelope.Code}
	}
	errorType, _ := sharedfailure.NormalizeErrorToken(fields.Type)
	errorCode, _ := sharedfailure.NormalizeErrorToken(fields.Code)
	retryAfter, _ := sharedfailure.ParseRetryAfter(
		strings.TrimSpace(header.Get("Retry-After")),
		observedAt,
	)
	classification, err := codexfailure.Classify(codexfailure.Input{
		StatusCode: statusCode,
		ErrorType:  errorType,
		ErrorCode:  errorCode,
		RetryAfter: retryAfter,
	})
	if err != nil {
		return classification, false, err
	}
	return sharedfailure.AttachExplicitRetryAfter(classification, header, observedAt), decodedOK, nil
}

func (executor *Executor) selectNextImage429Candidate(
	ctx context.Context,
	reqState *upstreamretry.RequestState,
	tracker *image429Tracker,
) (image429Candidate, upstreamretry.Decision, bool) {
	if executor == nil || executor.upstream429Retries == nil || tracker == nil || len(tracker.candidates) == 0 {
		return image429Candidate{}, upstreamretry.Decision{}, false
	}
	var best image429Candidate
	var bestDecision upstreamretry.Decision
	found := false
	var fallbackAbort upstreamretry.AbortReason
	for _, candidate := range tracker.candidates {
		decision := executor.upstream429Retries.PlanNextWait(ctx, reqState, candidate.evidence)
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

func (executor *Executor) runImage429RetryLoop(
	ctx context.Context,
	execCtx context.Context,
	reqState *upstreamretry.RequestState,
	reacquirer RateLimitReacquirer,
	provider string,
	request imagegeneration.Request,
	pinned bool,
	tracker *image429Tracker,
	submissionAccepted *atomic.Bool,
	initialErr error,
) (Result, error) {
	lastErr := initialErr
	if submissionAccepted.Load() {
		reqState.ClearExplicitRetryAfter()
		return Result{
			Retry: buildRetryMetadata(reqState, false, executor.now()),
		}, lastErr
	}
	candidate, decision, shouldRetry := executor.selectNextImage429Candidate(ctx, reqState, tracker)
	if !shouldRetry {
		reqState.NoteAbort(decision.AbortReason)
		return Result{
			Retry: buildRetryMetadata(reqState, isRaw429Error(lastErr), executor.now()),
		}, lastErr
	}

	eligibleFn := func(account images.Account) bool {
		return candidateEligible(executor.registry, provider, request, account)
	}

	for {
		if submissionAccepted.Load() {
			reqState.ClearExplicitRetryAfter()
			return Result{
				Retry: buildRetryMetadata(reqState, false, executor.now()),
			}, lastErr
		}
		applyEvidenceHintToState(reqState, candidate.evidence)
		if err := executor.upstream429Retries.Wait(ctx, reqState, candidate.evidence, decision); err != nil {
			executor.upstream429Retries.ReportOutcome(
				reqState,
				executor.surface,
				provider,
				candidate.route.AccountRef().String(),
				"cancelled",
				upstreamretry.AbortCancelled,
			)
			return Result{
				Retry: buildRetryMetadata(reqState, isRaw429Error(candidate.lastErr), executor.now()),
			}, candidate.lastErr
		}

		if canDispatch, abortReason := executor.upstream429Retries.CanDispatchAfterWait(ctx, candidate.evidence); !canDispatch {
			reqState.NoteAbort(abortReason)
			executor.upstream429Retries.ReportOutcome(
				reqState,
				executor.surface,
				provider,
				candidate.route.AccountRef().String(),
				"aborted",
				abortReason,
			)
			return Result{
				Retry: buildRetryMetadata(reqState, isRaw429Error(candidate.lastErr), executor.now()),
			}, candidate.lastErr
		}

		reacquired, usedWaiver, found, err := reacquirer.ReacquireFor429Retry(
			ctx,
			provider,
			request.Model,
			pinned,
			candidate.route.AccountRef(),
			candidate.cooldownReceipt,
			candidate.originObservation,
			eligibleFn,
		)
		if err != nil || !found || ctx.Err() != nil {
			if ctx.Err() != nil {
				executor.upstream429Retries.ReportOutcome(
					reqState,
					executor.surface,
					provider,
					candidate.route.AccountRef().String(),
					"cancelled",
					upstreamretry.AbortCancelled,
				)
				return Result{
					Retry: buildRetryMetadata(reqState, isRaw429Error(candidate.lastErr), executor.now()),
				}, candidate.lastErr
			}
			reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
			executor.upstream429Retries.ReportOutcome(
				reqState,
				executor.surface,
				provider,
				candidate.route.AccountRef().String(),
				"aborted",
				upstreamretry.AbortReacquireUnavailable,
			)
			return Result{
				Retry: buildRetryMetadata(reqState, isRaw429Error(candidate.lastErr), executor.now()),
			}, candidate.lastErr
		}

		ref, refErr := accountcore.ParseAccountRef(strings.TrimSpace(reacquired.Account.AccountRef))
		route, routeErr := runtimecore.NewModelRoute(ref, strings.TrimSpace(request.Model))
		if refErr != nil ||
			routeErr != nil ||
			!reacquired.Observation.IsValid() ||
			reacquired.Observation.AccountRef() != ref ||
			!eligibleFn(reacquired.Account) {
			reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
			executor.upstream429Retries.ReportOutcome(
				reqState,
				executor.surface,
				provider,
				candidate.route.AccountRef().String(),
				"aborted",
				upstreamretry.AbortReacquireUnavailable,
			)
			return Result{
				Retry: buildRetryMetadata(reqState, isRaw429Error(candidate.lastErr), executor.now()),
			}, candidate.lastErr
		}

		// R3：仅在本次重征召实际动用自冷却豁免时，核验原始失败凭据代次仍与重征召一致且为当前快照。
		if usedWaiver {
			current, checkErr := executor.observedAttempts.IsCurrentCredentialObservation(ctx, candidate.originObservation)
			if checkErr != nil || !current || !sameCredentialObservation(reacquired.Observation, candidate.originObservation) {
				reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
				executor.upstream429Retries.ReportOutcome(
					reqState,
					executor.surface,
					provider,
					reacquired.Account.AccountRef,
					"aborted",
					upstreamretry.AbortReacquireUnavailable,
				)
				return Result{
					Retry: buildRetryMetadata(reqState, isRaw429Error(candidate.lastErr), executor.now()),
				}, candidate.lastErr
			}
		}

		// 入口快检：避免策略已被热关闭时还浪费一次阻塞的策略前置 prepare（如 AGY project lookup）。
		if canDispatch, abortReason := executor.upstream429Retries.CanDispatchAfterWait(ctx, candidate.evidence); !canDispatch {
			reqState.NoteAbort(abortReason)
			executor.upstream429Retries.ReportOutcome(
				reqState,
				executor.surface,
				provider,
				reacquired.Account.AccountRef,
				"aborted",
				abortReason,
			)
			return Result{
				Retry: buildRetryMetadata(reqState, isRaw429Error(candidate.lastErr), executor.now()),
			}, candidate.lastErr
		}

		// I1 最终提交门禁：绑定到 sendUpstream 真正发起 generation/edit POST（doer.Do）之前，
		// 在 AGY PrepareImageGenerateContent 等所有阻塞准备完成后再次核验策略、取消、accepted 锁与 waiver 代次。
		currentCandidate := candidate
		currentUsedWaiver := usedWaiver
		submitCtx := images.ContextWithSubmissionGate(execCtx, func(gateCtx context.Context) error {
			if submissionAccepted.Load() {
				return &submissionAbortError{reason: upstreamretry.AbortReacquireUnavailable}
			}
			if ctx.Err() != nil || gateCtx.Err() != nil {
				return &submissionAbortError{reason: upstreamretry.AbortCancelled}
			}
			if canDispatch, abortReason := executor.upstream429Retries.CanDispatchAfterWait(gateCtx, currentCandidate.evidence); !canDispatch {
				return &submissionAbortError{reason: abortReason}
			}
			if currentUsedWaiver {
				current, checkErr := executor.observedAttempts.IsCurrentCredentialObservation(gateCtx, currentCandidate.originObservation)
				if checkErr != nil || !current {
					return &submissionAbortError{reason: upstreamretry.AbortReacquireUnavailable}
				}
			}
			return nil
		})

		strategy := executor.registry.Resolve(provider, reacquired.Account)
		generated, generateErr := strategy.Generate(submitCtx, buildImagesInput(request, reacquired.Account, executor.http))
		if generateErr == nil {
			reqState.ClearExplicitRetryAfter()
			executor.upstream429Retries.ReportOutcome(
				reqState,
				executor.surface,
				provider,
				reacquired.Account.AccountRef,
				"recovered",
				upstreamretry.AbortNone,
			)
			return Result{
				Execution: images.Execution{
					Provider: provider,
					Account:  reacquired.Account,
					Result:   generated,
					Strategy: strategy,
				},
				Observation: reacquired.Observation,
				HasObserved: true,
				Retry:       buildRetryMetadata(reqState, false, executor.now()),
			}, nil
		}

		// I1：若提交门禁在真正 POST 前拦截，绝不记未发起尝试的失败、绝不回落其它账号，忠实返回原始 429。
		var abortErr *submissionAbortError
		if errors.As(generateErr, &abortErr) {
			reqState.NoteAbort(abortErr.reason)
			outcomeName := "aborted"
			if abortErr.reason == upstreamretry.AbortCancelled {
				outcomeName = "cancelled"
			}
			executor.upstream429Retries.ReportOutcome(
				reqState,
				executor.surface,
				provider,
				reacquired.Account.AccountRef,
				outcomeName,
				abortErr.reason,
			)
			return Result{
				Retry: buildRetryMetadata(reqState, isRaw429Error(candidate.lastErr), executor.now()),
			}, candidate.lastErr
		}

		lastErr = generateErr
		if ctx.Err() != nil {
			executor.upstream429Retries.ReportOutcome(
				reqState,
				executor.surface,
				provider,
				reacquired.Account.AccountRef,
				"cancelled",
				upstreamretry.AbortCancelled,
			)
			return Result{
				Retry: buildRetryMetadata(reqState, isRaw429Error(candidate.lastErr), executor.now()),
			}, candidate.lastErr
		}

		// R1：仅当本次重征召动用自冷却豁免时延续先序 CooldownReceipt，维护单请求顺序重试所有权链。
		failure, failureComplete, failureErr := executor.classifyAttemptFailure(provider, reacquired.Account, generateErr)
		var nextReceipt runtimecore.CooldownReceipt
		if failureErr == nil && failure.IsValid() {
			recordImageFailureHint(reqState, generateErr, failure)
			recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), executor.recordTimeout)
			if usedWaiver {
				recordCtx = runtimecore.ContextWithPriorCooldownReceipt(recordCtx, candidate.cooldownReceipt)
			} else {
				recordCtx = runtimecore.ContextWithPriorCooldownReceipt(recordCtx, runtimecore.CooldownReceipt{})
			}
			_, nextReceipt, _ = executor.observedAttempts.RecordFailureWithReceipt(
				recordCtx,
				route,
				reacquired.Observation,
				failure,
			)
			cancel()
		} else {
			reqState.ClearExplicitRetryAfter()
		}

		// I4：上游已返回 2xx 但后续解析/本地转码失败时立即终止，绝不回退旧候选再次生成。
		if submissionAccepted.Load() {
			reqState.ClearExplicitRetryAfter()
			executor.upstream429Retries.ReportOutcome(
				reqState,
				executor.surface,
				provider,
				reacquired.Account.AccountRef,
				"failed_non_429",
				upstreamretry.AbortNone,
			)
			return Result{
				Retry: buildRetryMetadata(reqState, false, executor.now()),
			}, lastErr
		}

		nextEvidence := buildImage429Evidence(
			executor.surface,
			provider,
			reacquired.Account.AccountRef,
			pinned,
			generateErr,
			failureComplete,
			failure,
		)
		if !upstreamretry.Eligible(nextEvidence) {
			executor.upstream429Retries.ReportOutcome(
				reqState,
				executor.surface,
				provider,
				reacquired.Account.AccountRef,
				"failed_non_429",
				upstreamretry.AbortNone,
			)
			return Result{
				Retry: buildRetryMetadata(reqState, isRaw429Error(lastErr), executor.now()),
			}, lastErr
		}

		executor.upstream429Retries.FreezePolicyAtObservation(ctx, reqState, nextEvidence)
		candidate = image429Candidate{
			route:             route,
			evidence:          nextEvidence,
			cooldownReceipt:   nextReceipt,
			originObservation: reacquired.Observation,
			lastErr:           generateErr,
		}
		decision = executor.upstream429Retries.PlanNextWait(ctx, reqState, candidate.evidence)
		if !decision.ShouldRetry {
			reqState.NoteAbort(decision.AbortReason)
			outcomeName := "aborted"
			if decision.AbortReason == upstreamretry.AbortRetriesExhausted {
				outcomeName = "exhausted"
			}
			executor.upstream429Retries.ReportOutcome(
				reqState,
				executor.surface,
				provider,
				reacquired.Account.AccountRef,
				outcomeName,
				decision.AbortReason,
			)
			return Result{
				Retry: buildRetryMetadata(reqState, isRaw429Error(lastErr), executor.now()),
			}, lastErr
		}
	}
}
