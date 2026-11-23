package codexresponsesws

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	"github.com/madou1217/ai_home/application/codexwebsocket"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/upstreamretry"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	"github.com/madou1217/ai_home/internal/adapters/codex/responseswebsocket"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
)

const (
	codexWSSurface             = "codex_responses_ws"
	maxWSHandshakePoolAttempts = 64
	overflowErrorWriteTimeout  = 250 * time.Millisecond
)

// HandshakeRetrySelector 是 Selector 的可选扩展端口，用于分离钉选 Phase 0 与回落池 Phase 1、
// 在握手阶段零等待遍历健康候选池，并在 429 等待后通过完整 Recruiter（含原子
// RateLimitCooldownWaiver）重新征召与验证账号。
type HandshakeRetrySelector interface {
	SelectPinnedOnly(
		ctx context.Context,
		request codexwebsocket.Request,
	) (codexwebsocket.Selection, bool, error)
	OpenPool(
		ctx context.Context,
		request codexwebsocket.Request,
		excluded ...accountcore.AccountRef,
	) (codexwebsocket.SelectionCursor, error)
	ReacquireFor429Retry(
		ctx context.Context,
		request codexwebsocket.Request,
		pinned bool,
		target accountcore.AccountRef,
		receipt runtimecore.CooldownReceipt,
		originObservation accountcredentials.CredentialObservation,
	) (selection codexwebsocket.Selection, usedWaiver bool, found bool, err error)
}

var _ HandshakeRetrySelector = (*codexwebsocket.Selector)(nil)

func sameWSCredentialObservation(
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

type wsTerminalError struct {
	valid   bool
	status  int
	code    string
	message string
}

type wsDialOutcome struct {
	upstream        responseswebsocket.Connection
	fatalConfigErr  bool
	failure         inferencegateway.AttemptFailure
	cooldownReceipt runtimecore.CooldownReceipt
	evidence        upstreamretry.Evidence
	wsErr           wsTerminalError
}

func (outcome wsDialOutcome) blocksRouting() bool {
	if !outcome.failure.IsValid() {
		return false
	}
	policy, err := runtimecore.PolicyFor(outcome.failure.RuntimeKind())
	if err != nil {
		return true
	}
	return policy.BlocksRouting()
}

// allowsPinnedFallback 仅在已经进入合法 raw HTTP 429 恢复流程后，用于判定钉选重试期间
// 遇到的后续非 429 失败是否属于可继续回落到健康池的非硬阻塞软失败；凭据失效、额度耗尽、
// 策略/权限阻塞、安全/WAF 拒绝或 400 客户端错误绝不静默换号。
func (outcome wsDialOutcome) allowsPinnedFallback() bool {
	if outcome.fatalConfigErr || !outcome.failure.IsValid() {
		return false
	}
	if outcome.failure.RuntimeKind() == runtimecore.FailureSafetyRejected ||
		outcome.failure.RuntimeKind() == runtimecore.FailureUpstreamEdgeRejected {
		return false
	}
	return outcome.failure.ResponseFailure().Retryable() && !outcome.blocksRouting()
}

// allowsPoolFailover 仅在本 turn 已经观察到合法 raw HTTP 429 后才允许继续扫描池内其它健康账号；
// 在从未遇到合法 raw HTTP 429 的纯非 429 / 传输失败场景下，保持基线单次握手返回映射错误的行为。
func (outcome wsDialOutcome) allowsPoolFailover() bool {
	if outcome.fatalConfigErr || !outcome.failure.IsValid() {
		return false
	}
	if outcome.failure.RuntimeKind() == runtimecore.FailureSafetyRejected ||
		outcome.failure.RuntimeKind() == runtimecore.FailureUpstreamEdgeRejected {
		return false
	}
	return outcome.failure.ResponseFailure().Retryable()
}

// rejectsCredential reports an account-level authentication rejection. Other
// accounts in the same pool may still be healthy, so handshake must skip this
// account instead of ending the whole turn with the first 401/403.
func (outcome wsDialOutcome) rejectsCredential() bool {
	if outcome.failure.IsValid() {
		switch outcome.failure.RuntimeKind() {
		case runtimecore.FailureCredentialRejected, runtimecore.FailureStaticCredentialRejected:
			return true
		}
	}
	return outcome.wsErr.status == http.StatusUnauthorized || outcome.wsErr.status == http.StatusForbidden
}

type ws429Candidate struct {
	route             runtimecore.ModelRoute
	evidence          upstreamretry.Evidence
	cooldownReceipt   runtimecore.CooldownReceipt
	originObservation accountcredentials.CredentialObservation
}

type ws429Tracker struct {
	candidates []ws429Candidate
}

func (tracker *ws429Tracker) Record(candidate ws429Candidate) {
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

func (tracker *ws429Tracker) HasCandidates() bool {
	return tracker != nil && len(tracker.candidates) > 0
}

func buildWS429Evidence(
	accountRef accountcore.AccountRef,
	pinned bool,
	failure inferencegateway.AttemptFailure,
) upstreamretry.Evidence {
	status, _ := failure.ObservedHTTPStatus()
	_, explicitAt, hasExplicit := failure.ExplicitRetryAfter()
	explicitRaw, explicitOverflow := failure.ExplicitRetryAfterOverflow()
	return upstreamretry.Evidence{
		Surface:                    codexWSSurface,
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

func watchSessionWaitContext(session *managedSession) (context.Context, func()) {
	waitCtx, cancel := context.WithCancel(session.Context())
	clientClosed := session.ClientClosed()
	if clientClosed == nil {
		return waitCtx, cancel
	}
	select {
	case <-clientClosed:
		cancel()
		return waitCtx, cancel
	default:
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-clientClosed:
			cancel()
		case <-waitCtx.Done():
		case <-done:
		}
	}()
	return waitCtx, func() {
		close(done)
		cancel()
	}
}

// connectUpstreamForTurn 在向任何上游连接发送业务帧（response.create）之前建立上游 WS 连接。
//
// 安全边界说明：客户端 HTTP 101 Upgrade 已在读取首帧前完成，这里绝不宣称 HTTP 下游未提交；
// 唯一可证明安全重试的窗口是「上游 WS 握手阶段失败，尚未挂载上游连接且尚未向任何上游写出业务帧、
// 也未收到任何上游业务帧」。一旦 Connect 成功并交由调用方写帧，后续连接内错误帧（含 429 error/
// response.failed）绝不由此控制器重放，保持既有 observer/failover 语义。
func (handler *Handler) connectUpstreamForTurn(
	session *managedSession,
	model string,
	pinnedAccountRef string,
	clientHeader http.Header,
	localAuthority string,
) (responseswebsocket.Connection, codexwebsocket.Selection, runtimecore.ModelRoute, bool) {
	pinnedAccountRef = strings.TrimSpace(pinnedAccountRef)
	selectReq := codexwebsocket.Request{
		ClientProtocol:   inference.ClientProtocolOpenAIResponses,
		Model:            model,
		PinnedAccountRef: pinnedAccountRef,
	}
	retrySelector, supportsRetry := handler.selector.(HandshakeRetrySelector)
	if handler.upstream429Retries == nil || !supportsRetry {
		return handler.connectUpstreamLegacy(
			session,
			selectReq,
			clientHeader,
			localAuthority,
		)
	}

	turnCtx, stopTurn := watchSessionWaitContext(session)
	defer stopTurn()

	reqState := upstreamretry.NewRequestState()
	contacted := false
	var lastErr wsTerminalError

	if pinnedAccountRef != "" {
		selection, found, err := retrySelector.SelectPinnedOnly(turnCtx, selectReq)
		if err != nil {
			if turnCtx.Err() == nil {
				handler.writeSelectionError(session.Client(), err)
			}
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
		}
		var excludePinned []accountcore.AccountRef
		enteredRaw429Recovery := false
		if found {
			route, routeErr := runtimecore.NewModelRoute(
				selection.AccountRef(),
				selection.Route().EffectiveModel(),
			)
			if routeErr != nil {
				if turnCtx.Err() == nil {
					writeWebSocketError(
						session.Client(),
						http.StatusInternalServerError,
						"invalid_runtime_route",
						"账号运行态路由无效",
					)
				}
				return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
			}
			contacted = true
			outcome := handler.dialAndRecordHandshake(
				turnCtx,
				runtimecore.ContextWithPriorCooldownReceipt(
					context.WithoutCancel(turnCtx),
					runtimecore.CooldownReceipt{},
				),
				route,
				selection,
				true,
				clientHeader,
				localAuthority,
			)
			if outcome.upstream != nil {
				return outcome.upstream, selection, route, true
			}
			if turnCtx.Err() != nil {
				handler.writeOverflowProtocolErrorIfNeeded(session)
				return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
			}
			if outcome.fatalConfigErr {
				handler.writeTerminalWSError(session, outcome.wsErr)
				return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
			}
			lastErr = outcome.wsErr
			if upstreamretry.Eligible(outcome.evidence) {
				enteredRaw429Recovery = true
				handler.upstream429Retries.FreezePolicyAtObservation(turnCtx, reqState, outcome.evidence)
				phaseTracker := &ws429Tracker{}
				phaseTracker.Record(ws429Candidate{
					route:             route,
					evidence:          outcome.evidence,
					cooldownReceipt:   outcome.cooldownReceipt,
					originObservation: selection.CredentialObservation(),
				})
				upstream, winSel, winRoute, connected, cancelled, stopFallback := handler.runHandshake429RetryLoop(
					session,
					retrySelector,
					model,
					true,
					reqState,
					phaseTracker,
					clientHeader,
					localAuthority,
					&lastErr,
				)
				if connected {
					return upstream, winSel, winRoute, true
				}
				if cancelled {
					handler.writeOverflowProtocolErrorIfNeeded(session)
					return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
				}
				if stopFallback {
					handler.writeTerminalWSError(session, lastErr)
					return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
				}
				excludePinned = []accountcore.AccountRef{selection.AccountRef()}
			} else if outcome.rejectsCredential() {
				// 账号级 401/403：钉选账号可能已失效，但池里其它账号仍然健康，
				// 把它加入排除集后继续 Phase 1，而不是把第一次鉴权失败直接交给客户端。
				excludePinned = []accountcore.AccountRef{selection.AccountRef()}
			} else {
				// 尚未进入合法 raw HTTP 429 恢复前，任何非 429 或不合格 429（如 503/网络超时/
				// 硬配额等）都严格保持基线单次握手返回映射错误并终止，不跨账号回落。
				handler.writeTerminalWSError(session, lastErr)
				return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
			}
		}

		// Phase 1 回落池：仅当钉选账号初始已处于软冷却（基线语义），或 Phase 0 已进入合法
		// raw HTTP 429 恢复并在耗尽/禁用后允许寻找健康替代账号时执行；若池中无其它可用账号且
		// Phase 0 已拿到真实上游错误（如 429），忠实透传该真实错误。
		poolReq := codexwebsocket.Request{
			ClientProtocol: inference.ClientProtocolOpenAIResponses,
			Model:          model,
		}
		cursor, poolErr := retrySelector.OpenPool(turnCtx, poolReq, excludePinned...)
		if poolErr != nil {
			if turnCtx.Err() == nil {
				if contacted && lastErr.valid {
					handler.writeTerminalWSError(session, lastErr)
				} else {
					handler.writeSelectionError(session.Client(), poolErr)
				}
			}
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
		}
		return handler.runHandshakePoolPhase(
			turnCtx,
			session,
			retrySelector,
			cursor,
			model,
			reqState,
			clientHeader,
			localAuthority,
			enteredRaw429Recovery,
			contacted,
			lastErr,
		)
	}

	// 非钉选路径：首次握手前保持基线单次失败语义；一旦观察到合法 raw HTTP 429，再零等待
	// 遍历池内其它健康 Codex 账号，全池耗尽后按有效策略有界等待重试。
	cursor, err := retrySelector.OpenPool(turnCtx, selectReq)
	if err != nil {
		if turnCtx.Err() == nil {
			handler.writeSelectionError(session.Client(), err)
		}
		return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
	}
	return handler.runHandshakePoolPhase(
		turnCtx,
		session,
		retrySelector,
		cursor,
		model,
		reqState,
		clientHeader,
		localAuthority,
		false,
		false,
		wsTerminalError{},
	)
}

func (handler *Handler) connectUpstreamLegacy(
	session *managedSession,
	selectReq codexwebsocket.Request,
	clientHeader http.Header,
	localAuthority string,
) (responseswebsocket.Connection, codexwebsocket.Selection, runtimecore.ModelRoute, bool) {
	selection, err := handler.selector.Select(session.Context(), selectReq)
	if err != nil {
		handler.writeSelectionError(session.Client(), err)
		return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
	}
	route, err := runtimecore.NewModelRoute(
		selection.AccountRef(),
		selection.Route().EffectiveModel(),
	)
	if err != nil {
		writeWebSocketError(
			session.Client(),
			http.StatusInternalServerError,
			"invalid_runtime_route",
			"账号运行态路由无效",
		)
		return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
	}
	dialCtx, cancelDial := context.WithTimeout(session.Context(), upstreamDialTimeout)
	upstream, upstreamResponse, dialErr := handler.upstream.Connect(
		dialCtx,
		selection.Credential(),
		clientHeader,
		localAuthority,
	)
	cancelDial()
	if dialErr != nil {
		handler.handleDialFailure(
			session.Client(),
			route,
			selection.CredentialObservation(),
			upstreamResponse,
			dialErr,
		)
		return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
	}
	return upstream, selection, route, true
}

func (handler *Handler) runHandshakePoolPhase(
	turnCtx context.Context,
	session *managedSession,
	retrySelector HandshakeRetrySelector,
	cursor codexwebsocket.SelectionCursor,
	model string,
	reqState *upstreamretry.RequestState,
	clientHeader http.Header,
	localAuthority string,
	enteredRaw429Recovery bool,
	contacted bool,
	lastErr wsTerminalError,
) (responseswebsocket.Connection, codexwebsocket.Selection, runtimecore.ModelRoute, bool) {
	phaseTracker := &ws429Tracker{}
	var cursorErr error
	for attempt := 0; attempt < maxWSHandshakePoolAttempts; attempt++ {
		selection, found, err := cursor.Next(turnCtx)
		if err != nil {
			cursorErr = err
			break
		}
		if !found || turnCtx.Err() != nil {
			break
		}
		route, routeErr := runtimecore.NewModelRoute(
			selection.AccountRef(),
			selection.Route().EffectiveModel(),
		)
		if routeErr != nil {
			continue
		}
		contacted = true
		outcome := handler.dialAndRecordHandshake(
			turnCtx,
			runtimecore.ContextWithPriorCooldownReceipt(
				context.WithoutCancel(turnCtx),
				runtimecore.CooldownReceipt{},
			),
			route,
			selection,
			false,
			clientHeader,
			localAuthority,
		)
		if outcome.upstream != nil {
			return outcome.upstream, selection, route, true
		}
		if turnCtx.Err() != nil {
			handler.writeOverflowProtocolErrorIfNeeded(session)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
		}
		if outcome.fatalConfigErr {
			handler.writeTerminalWSError(session, outcome.wsErr)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
		}
		lastErr = outcome.wsErr
		if upstreamretry.Eligible(outcome.evidence) {
			enteredRaw429Recovery = true
			handler.upstream429Retries.FreezePolicyAtObservation(turnCtx, reqState, outcome.evidence)
			phaseTracker.Record(ws429Candidate{
				route:             route,
				evidence:          outcome.evidence,
				cooldownReceipt:   outcome.cooldownReceipt,
				originObservation: selection.CredentialObservation(),
			})
		}
		// 账号级 401/403 可以换一个账号重试；其它非 429 失败（503/超时/断连）仍保持
		// 基线单次握手语义，不把普通故障升级为全池重试。
		if !outcome.rejectsCredential() && (!enteredRaw429Recovery || !outcome.allowsPoolFailover()) {
			handler.writeTerminalWSError(session, lastErr)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
		}
	}

	if turnCtx.Err() != nil {
		handler.writeOverflowProtocolErrorIfNeeded(session)
		return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
	}

	if phaseTracker.HasCandidates() {
		upstream, winSel, winRoute, connected, cancelled, _ := handler.runHandshake429RetryLoop(
			session,
			retrySelector,
			model,
			false,
			reqState,
			phaseTracker,
			clientHeader,
			localAuthority,
			&lastErr,
		)
		if connected {
			return upstream, winSel, winRoute, true
		}
		if cancelled {
			handler.writeOverflowProtocolErrorIfNeeded(session)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
		}
	}

	if contacted && lastErr.valid {
		handler.writeTerminalWSError(session, lastErr)
		return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
	}
	if cursorErr != nil {
		handler.writeSelectionError(session.Client(), cursorErr)
		return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
	}
	handler.writeSelectionError(session.Client(), accountrouting.ErrNoRoutableAccount)
	return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false
}

func (handler *Handler) selectNextWS429Candidate(
	ctx context.Context,
	reqState *upstreamretry.RequestState,
	tracker *ws429Tracker,
) (ws429Candidate, upstreamretry.Decision, bool) {
	if handler == nil || handler.upstream429Retries == nil || tracker == nil || len(tracker.candidates) == 0 {
		return ws429Candidate{}, upstreamretry.Decision{}, false
	}
	var best ws429Candidate
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

func (handler *Handler) runHandshake429RetryLoop(
	session *managedSession,
	retrySelector HandshakeRetrySelector,
	model string,
	pinned bool,
	reqState *upstreamretry.RequestState,
	tracker *ws429Tracker,
	clientHeader http.Header,
	localAuthority string,
	lastErr *wsTerminalError,
) (
	upstream responseswebsocket.Connection,
	winSelection codexwebsocket.Selection,
	winRoute runtimecore.ModelRoute,
	connected bool,
	cancelled bool,
	stopFallback bool,
) {
	if handler == nil || handler.upstream429Retries == nil || tracker == nil || !tracker.HasCandidates() {
		return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, false, false
	}

	preCheckCtx, stopPreCheck := watchSessionWaitContext(session)
	candidate, decision, shouldRetry := handler.selectNextWS429Candidate(preCheckCtx, reqState, tracker)
	preCheckCancelled := preCheckCtx.Err() != nil
	stopPreCheck()
	if !shouldRetry {
		reqState.NoteAbort(decision.AbortReason)
		return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, preCheckCancelled, false
	}

	// 确认需要进入 429 睡眠等待后再惰性启动客户端读协程，保证客户端 Close/TCP 断开可在
	// 毫秒级取消等待，同时保持禁用/快速失败分支零额外 goroutine 开销，且绝不对
	// coder/websocket.Read 传入短生命周期 ctx。
	session.startClientReader()
	waitCtx, stopWait := watchSessionWaitContext(session)
	defer stopWait()

	reacquireReq := codexwebsocket.Request{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          model,
	}

	for {
		if err := handler.upstream429Retries.Wait(waitCtx, reqState, candidate.evidence, decision); err != nil {
			handler.upstream429Retries.ReportOutcome(
				reqState,
				codexWSSurface,
				"codex",
				candidate.route.AccountRef().String(),
				"cancelled",
				upstreamretry.AbortCancelled,
			)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, true, true
		}

		if canDispatch, abortReason := handler.upstream429Retries.CanDispatchAfterWait(waitCtx, candidate.evidence); !canDispatch {
			reqState.NoteAbort(abortReason)
			handler.upstream429Retries.ReportOutcome(
				reqState,
				codexWSSurface,
				"codex",
				candidate.route.AccountRef().String(),
				"aborted",
				abortReason,
			)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, abortReason == upstreamretry.AbortCancelled && waitCtx.Err() != nil, false
		}

		selection, usedWaiver, found, err := retrySelector.ReacquireFor429Retry(
			waitCtx,
			reacquireReq,
			pinned,
			candidate.route.AccountRef(),
			candidate.cooldownReceipt,
			candidate.originObservation,
		)
		if err != nil || !found || waitCtx.Err() != nil {
			if waitCtx.Err() != nil {
				handler.upstream429Retries.ReportOutcome(
					reqState,
					codexWSSurface,
					"codex",
					candidate.route.AccountRef().String(),
					"cancelled",
					upstreamretry.AbortCancelled,
				)
				return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, true, true
			}
			reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
			handler.upstream429Retries.ReportOutcome(
				reqState,
				codexWSSurface,
				"codex",
				candidate.route.AccountRef().String(),
				"aborted",
				upstreamretry.AbortReacquireUnavailable,
			)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, false, false
		}

		route, routeErr := runtimecore.NewModelRoute(
			selection.AccountRef(),
			selection.Route().EffectiveModel(),
		)
		if routeErr != nil || !selection.IsValid() {
			reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
			handler.upstream429Retries.ReportOutcome(
				reqState,
				codexWSSurface,
				"codex",
				candidate.route.AccountRef().String(),
				"aborted",
				upstreamretry.AbortReacquireUnavailable,
			)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, false, false
		}

		// R3：仅在本次重征召实际使用自冷却豁免时，强制复核原始失败凭据代次仍为当前持久化快照。
		if usedWaiver {
			current, checkErr := handler.attempts.IsCurrentCredentialObservation(waitCtx, candidate.originObservation)
			if checkErr != nil || !current || !sameWSCredentialObservation(selection.CredentialObservation(), candidate.originObservation) {
				reqState.NoteAbort(upstreamretry.AbortReacquireUnavailable)
				handler.upstream429Retries.ReportOutcome(
					reqState,
					codexWSSurface,
					"codex",
					selection.AccountRef().String(),
					"aborted",
					upstreamretry.AbortReacquireUnavailable,
				)
				return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, false, false
			}
		}

		// F2：在所有可能阻塞的重征召、凭据刷新和代次核验完成之后、真正发起上游 Connect 前
		// 执行最终策略/取消/ExplicitRetryAt 门禁，拦截等待后被关闭或超时的派发。
		if canDispatch, abortReason := handler.upstream429Retries.CanDispatchAfterWait(waitCtx, candidate.evidence); !canDispatch {
			reqState.NoteAbort(abortReason)
			handler.upstream429Retries.ReportOutcome(
				reqState,
				codexWSSurface,
				"codex",
				selection.AccountRef().String(),
				"aborted",
				abortReason,
			)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, abortReason == upstreamretry.AbortCancelled && waitCtx.Err() != nil, false
		}

		// R1：延续单请求顺序重试的冷却所有权链；若未动用自冷却豁免则清空先序凭证。
		recordCtx := context.WithoutCancel(waitCtx)
		if usedWaiver {
			recordCtx = runtimecore.ContextWithPriorCooldownReceipt(recordCtx, candidate.cooldownReceipt)
		} else {
			recordCtx = runtimecore.ContextWithPriorCooldownReceipt(recordCtx, runtimecore.CooldownReceipt{})
		}

		outcome := handler.dialAndRecordHandshake(
			waitCtx,
			recordCtx,
			route,
			selection,
			pinned,
			clientHeader,
			localAuthority,
		)
		if outcome.upstream != nil {
			handler.upstream429Retries.ReportOutcome(
				reqState,
				codexWSSurface,
				"codex",
				selection.AccountRef().String(),
				"recovered",
				upstreamretry.AbortNone,
			)
			return outcome.upstream, selection, route, true, false, false
		}
		if waitCtx.Err() != nil {
			handler.upstream429Retries.ReportOutcome(
				reqState,
				codexWSSurface,
				"codex",
				selection.AccountRef().String(),
				"cancelled",
				upstreamretry.AbortCancelled,
			)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, true, true
		}
		if outcome.wsErr.valid {
			*lastErr = outcome.wsErr
		}
		if outcome.fatalConfigErr {
			handler.upstream429Retries.ReportOutcome(
				reqState,
				codexWSSurface,
				"codex",
				selection.AccountRef().String(),
				"failed_non_429",
				upstreamretry.AbortNone,
			)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, false, true
		}
		if !upstreamretry.Eligible(outcome.evidence) {
			handler.upstream429Retries.ReportOutcome(
				reqState,
				codexWSSurface,
				"codex",
				selection.AccountRef().String(),
				"failed_non_429",
				upstreamretry.AbortNone,
			)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, false, pinned && !outcome.allowsPinnedFallback()
		}

		handler.upstream429Retries.FreezePolicyAtObservation(waitCtx, reqState, outcome.evidence)
		candidate = ws429Candidate{
			route:             route,
			evidence:          outcome.evidence,
			cooldownReceipt:   outcome.cooldownReceipt,
			originObservation: selection.CredentialObservation(),
		}
		decision = handler.upstream429Retries.PlanNextWait(waitCtx, reqState, candidate.evidence)
		if !decision.ShouldRetry {
			reqState.NoteAbort(decision.AbortReason)
			outcomeName := "aborted"
			if decision.AbortReason == upstreamretry.AbortRetriesExhausted {
				outcomeName = "exhausted"
			}
			handler.upstream429Retries.ReportOutcome(
				reqState,
				codexWSSurface,
				"codex",
				selection.AccountRef().String(),
				outcomeName,
				decision.AbortReason,
			)
			return nil, codexwebsocket.Selection{}, runtimecore.ModelRoute{}, false, decision.AbortReason == upstreamretry.AbortCancelled && waitCtx.Err() != nil, false
		}
	}
}

func (handler *Handler) dialAndRecordHandshake(
	parentCtx context.Context,
	recordCtx context.Context,
	route runtimecore.ModelRoute,
	selection codexwebsocket.Selection,
	pinned bool,
	clientHeader http.Header,
	localAuthority string,
) wsDialOutcome {
	dialCtx, cancelDial := context.WithTimeout(parentCtx, upstreamDialTimeout)
	upstream, upstreamResponse, dialErr := handler.upstream.Connect(
		dialCtx,
		selection.Credential(),
		clientHeader,
		localAuthority,
	)
	cancelDial()
	if dialErr == nil && upstream != nil {
		return wsDialOutcome{upstream: upstream}
	}
	if dialErr == nil && upstream == nil {
		dialErr = errors.New("upstream websocket connection is nil")
	}

	// 无论失败分类结果如何，在离开单次握手尝试（更在任何睡眠前）立即有界读取并关闭上游响应体。
	var prefix []byte
	var readErr error
	if upstreamResponse != nil && upstreamResponse.Body != nil {
		prefix, readErr = io.ReadAll(io.LimitReader(upstreamResponse.Body, sharedfailure.MaxErrorPayloadBytes+1))
		_ = upstreamResponse.Body.Close()
	}

	if parentCtx.Err() != nil {
		return wsDialOutcome{}
	}

	if errors.Is(dialErr, responseswebsocket.ErrSelfLoop) ||
		errors.Is(dialErr, responseswebsocket.ErrInvalidEndpoint) ||
		errors.Is(dialErr, responseswebsocket.ErrUnsupportedCredential) {
		return wsDialOutcome{
			fatalConfigErr: true,
			wsErr: wsTerminalError{
				valid:   true,
				status:  http.StatusBadGateway,
				code:    "upstream_websocket_invalid",
				message: "Codex WebSocket 上游配置无效",
			},
		}
	}

	failure, err := handler.classifyDialFailure(route, upstreamResponse, prefix, readErr, dialErr)
	if err != nil || !failure.IsValid() {
		return wsDialOutcome{
			wsErr: wsTerminalError{
				valid:   true,
				status:  http.StatusBadGateway,
				code:    "upstream_websocket_unavailable",
				message: "Codex WebSocket 上游连接失败",
			},
		}
	}

	_, receipt, _ := recordCodexFailureWithReceipt(
		recordCtx,
		handler.attempts,
		handler.modelRefreshes,
		route,
		selection.CredentialObservation(),
		failure,
	)

	responseFailure := failure.ResponseFailure()
	status := http.StatusBadGateway
	if upstreamResponse != nil &&
		upstreamResponse.StatusCode >= http.StatusBadRequest &&
		upstreamResponse.StatusCode <= 599 {
		status = upstreamResponse.StatusCode
	}
	if failure.RuntimeKind() == runtimecore.FailureUpstreamEdgeRejected {
		status = http.StatusBadGateway
	}

	return wsDialOutcome{
		failure:         failure,
		cooldownReceipt: receipt,
		evidence:        buildWS429Evidence(route.AccountRef(), pinned, failure),
		wsErr: wsTerminalError{
			valid:   true,
			status:  status,
			code:    responseFailure.Code(),
			message: responseFailure.SafeMessage(),
		},
	}
}

func (handler *Handler) classifyDialFailure(
	route runtimecore.ModelRoute,
	response *http.Response,
	prefix []byte,
	readErr error,
	dialErr error,
) (inferencegateway.AttemptFailure, error) {
	if response != nil && readErr == nil {
		observed := *response
		observed.Body = io.NopCloser(bytes.NewReader(prefix))
		observedAt := handler.clock()
		classification, observeErr := configured.ClassifyHTTPWithRules(
			handler.rules,
			string(route.AccountRef()),
			response.StatusCode,
			response.Header,
			prefix,
			observedAt,
			func() (sharedfailure.Classification, error) {
				return codexfailure.ObserveHTTP(&observed, observedAt)
			},
		)
		if observeErr == nil {
			if failure, err := attemptfailure.New(classification); err == nil && failure.IsValid() {
				return failure, nil
			}
		}
	}
	return attemptfailure.NewTransport(dialErr)
}

func (handler *Handler) writeTerminalWSError(session *managedSession, wsErr wsTerminalError) {
	if session == nil || session.Closing() {
		return
	}
	if clientClosed := session.ClientClosed(); clientClosed != nil {
		select {
		case <-clientClosed:
			return
		default:
		}
	}
	if !wsErr.valid {
		writeWebSocketError(
			session.Client(),
			http.StatusBadGateway,
			"upstream_websocket_unavailable",
			"Codex WebSocket 上游连接失败",
		)
		return
	}
	writeWebSocketError(session.Client(), wsErr.status, wsErr.code, wsErr.message)
}

// writeOverflowProtocolErrorIfNeeded 在等待期间因客户端连续发送多帧撑满单槽待消费队列而
// 中止时，尽力以极短有界超时回写稳定的并发协议错误帧（不阻塞关闭清理）。
func (handler *Handler) writeOverflowProtocolErrorIfNeeded(session *managedSession) {
	if session == nil || session.Closing() || !errors.Is(session.ClientReadErr(), ErrConcurrentTurn) {
		return
	}
	client := session.Client()
	if client == nil {
		return
	}
	payload, err := json.Marshal(webSocketErrorEnvelope{
		Type:   "error",
		Status: http.StatusBadRequest,
		Error: webSocketErrorView{
			Code:    "concurrent_response_create",
			Message: "同一 WebSocket 连接只允许串行请求",
		},
	})
	if err != nil {
		return
	}
	writeCtx, cancel := context.WithTimeout(context.Background(), overflowErrorWriteTimeout)
	defer cancel()
	_ = client.Write(writeCtx, websocket.MessageText, payload)
}
