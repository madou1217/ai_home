package codexresponseshttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/madou1217/ai_home/internal/transport/http/codexwire"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/admission"
	"github.com/madou1217/ai_home/application/clientkeystats"
	"github.com/madou1217/ai_home/application/effortalign"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/upstreamretry"
	"github.com/madou1217/ai_home/contracts/codex-relay"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	"github.com/madou1217/ai_home/internal/adapters/codex/responses"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

var ErrNotNativeRoute = errors.New("native Responses route requires canonical conversion")

const (
	// nativeTransportAttemptsPerAccount 是同一账号在「上游一个响应字节都没返回」时的
	// 最大联系次数（含首次）。传输失败（连接重置、HTTP/2 PROTOCOL_ERROR、unexpected EOF）
	// 描述的是出口可达性，不是账号可用性；单账号或同出口池里换号只是把同一故障再演一遍。
	nativeTransportAttemptsPerAccount = 3
	// nativeTransportRetryBudget 限制整个请求的同账号重试次数：多账号池在出口整体
	// 抖动时，不能让 4 个候选账号各自把重试打满，把一次请求拖成十几分钟。
	nativeTransportRetryBudget = 3
	// nativeTransportRetryBaseDelay 是首次重试前的等待，之后每次翻倍。
	nativeTransportRetryBaseDelay = 250 * time.Millisecond
	nativeTransportRetryMaxDelay  = time.Second
)

type Selection struct {
	AccountRef  accountcore.AccountRef
	Credential  accountapp.Credential
	Observation accountcredentials.CredentialObservation
}

type Cursor interface {
	Next(context.Context) (Selection, bool, error)
}

// CursorDiagnostics 由候选游标可选实现：整轮扫空时给出低敏原因，
// 让 503 no_available_account 能区分“没有候选”与“候选被额度、模型目录、
// 冷却或并发全部挡下”。
type CursorDiagnostics interface {
	ExhaustedReason() string
}
type AccountSource interface {
	Open(context.Context, string) (Cursor, error)
}
type Authorizer interface{ Authorized(*http.Request) bool }
type Upstream interface {
	RoundTripNative(context.Context, accountapp.Credential, []byte, http.Header, string) (*http.Response, error)
}

type Dependencies struct {
	Authorizer         Authorizer
	Accounts           AccountSource
	Upstream           Upstream
	Fallback           http.Handler
	Attempts           inferencegateway.AttemptRecorder
	Credentials        inferencegateway.CredentialObservationVerifier
	ModelRefreshes     inferencegateway.ModelRefreshScheduler
	Upstream429Retries *upstreamretry.Controller
	Clock              func() time.Time
	// Rules 可选：账号自定义上游错误规则求值端口。为 nil 表示 Go 未承接该能力，
	// 分类完全由内置观察器决定（与不接入规则时逐字节一致）。
	Rules configured.Rules
	// FailureLog 可选：请求以失败结束时收到一份低敏摘要（见 FailureReport）。
	FailureLog func(FailureReport)
	// Ladders 可选：原生快路径的推理强度档位来源。nil 表示不做强度对齐。
	// ChatGPT 登录账号的请求是字节透传，不会经过 Canonical Adapter 的 aligner，
	// 必须在这里对齐，否则客户端 model_reasoning_effort=none 会打到只支持
	// low..max 的模型上（上游 400 unsupported_value）。
	Ladders effortalign.LadderReader
	// ProbeWindow 可选：流式响应写头前等待首个正文事件的时长。<=0 用 nativeProbeWindow。
	// 超过窗口即提交当前账号并开始交付（含心跳），避免长推理的 TTFB 静默被中间层判死。
	ProbeWindow time.Duration
}

type Handler struct {
	Dependencies
	observed *inferencegateway.ObservedAttemptRecorder
}

func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil || deps.Accounts == nil || deps.Upstream == nil || deps.Fallback == nil || deps.Clock == nil || deps.ModelRefreshes == nil {
		return nil, errors.New("native Responses dependencies are invalid")
	}
	observed, err := inferencegateway.NewObservedAttemptRecorder(deps.Attempts, deps.Credentials)
	if err != nil {
		return nil, err
	}
	return &Handler{Dependencies: deps, observed: observed}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	// Carry the remote execution session id through the whole attempt so usage
	// recorded on success/failure can be attributed to that session.
	request = request.WithContext(clientkeystats.WithRemoteSession(
		request.Context(), request.Header.Get(clientkeystats.RemoteSessionHeader),
	))
	if !handler.Authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, "unauthorized")
		return
	}
	// 跳数上限（不是「有头即拒」）：跨机中转（本机网关 → 远程 server 网关）是正常拓扑，
	// 只有超过上限才说明出现了 A→B→A 的环。见 responses.MaxNativeRelayHops。
	if responses.NativeRelayHop(request.Header) > responses.MaxNativeRelayHops {
		writeError(response, "infinite_loop_detected")
		return
	}
	mediaType, _, _ := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if request.Method != http.MethodPost || request.URL.RawQuery != "" || mediaType != "application/json" {
		handler.Fallback.ServeHTTP(response, request)
		return
	}
	ctx, err := inferenceapi.ContextWithPinnedAccount(request)
	if err != nil {
		writeError(response, "invalid_account_ref")
		return
	}
	var timing *nativeTiming
	if request.Header.Get("X-Aih-Timing") == "1" {
		timing = newNativeTiming()
		response = &nativeTimingWriter{ResponseWriter: response, timing: timing}
		defer timing.log()
	}
	payload, metadata, err := readRequest(response, request)
	if errors.Is(err, inferenceapi.ErrRequestBodyTimeout) {
		// An interrupted upload is not a decoder gap. Replaying an incomplete
		// body through Node cannot repair it and would hide the timeout again.
		writeError(response, "request_timeout")
		return
	}
	if errors.Is(err, inferenceapi.ErrRequestTooLarge) {
		// Retrying or handing the same oversized history to another decoder cannot
		// repair it. Preserve the size error instead of reporting malformed JSON.
		writeError(response, "request_too_large")
		return
	}
	if err != nil {
		// 读取/解压/解析都发生在选账号和联系上游之前，属于解码阶段失败；
		// 标记为解码拒收，供前置宿主识别失败类别。
		inferenceapi.MarkDecodeRejected(response)
		writeError(response, "invalid_request_body")
		return
	}
	// 标准 OpenAI Responses SDK 会携带 temperature / max_output_tokens / metadata
	// 等 Codex 原生线协议表达不了的可选字段。原生快路径是字节透传，直接送给
	// 上游会被 400 拒绝；这类请求交回 Canonical，由适配层做宽容投影。
	if codexwire.RequiresCanonicalProjection(payload) {
		request.Body = io.NopCloser(bytes.NewReader(payload))
		request.ContentLength = int64(len(payload))
		handler.Fallback.ServeHTTP(response, request.WithContext(ctx))
		return
	}
	// 原样透传前先剥掉上游解析不了的引用（item id 前缀、store:false 的断点、
	// 换号后无法解密的 reasoning）。见 sanitizeNativePayload 的说明。
	timing.markModel(metadata.Model, metadata.Stream)
	payload = codexwire.SanitizeRequestPayload(payload)
	payload = effortalign.AlignResponsesPayload(payload, inference.ProviderCodex, metadata.Model, handler.Ladders)
	// gateway.attempt 由 Canonical Coordinator 执行；native 快路径没有该中间件时，
	// 把请求交给 Canonical 执行同一代插件，而不是让插件静默不执行。
	// 此时还没有打开账号游标、没有联系上游，交给 Canonical 不产生重复副作用。
	if inferenceapi.RequiresAttemptMiddleware(request.Context()) {
		request.Body = io.NopCloser(bytes.NewReader(payload))
		request.ContentLength = int64(len(payload))
		handler.Fallback.ServeHTTP(response, request.WithContext(ctx))
		return
	}
	trail := handler.newFailureTrail(metadata.Model)
	ctx, reqState := upstreamretry.EnsureRequestState(ctx)
	pinnedRef, requestPinned := inferencegateway.PinnedAccount(ctx)
	reacquirer, supportsSplitPin := handler.Accounts.(RateLimitReacquirer)

	var phaseCursors []Cursor
	var phasePinnedFlags []bool
	if requestPinned && supportsSplitPin {
		pinCursor, err := reacquirer.OpenPinnedOnly(ctx, metadata.Model, pinnedRef)
		if errors.Is(err, ErrNotNativeRoute) {
			request.Body = io.NopCloser(bytes.NewReader(payload))
			handler.Fallback.ServeHTTP(response, request.WithContext(ctx))
			return
		}
		if err != nil || pinCursor == nil {
			trail.selection(err)
			handler.fail(response, trail, "no_available_account")
			return
		}
		phaseCursors = append(phaseCursors, pinCursor)
		phasePinnedFlags = append(phasePinnedFlags, true)
		if poolCursor, poolErr := reacquirer.OpenFallbackPool(ctx, metadata.Model, pinnedRef); poolErr == nil && poolCursor != nil {
			phaseCursors = append(phaseCursors, poolCursor)
			phasePinnedFlags = append(phasePinnedFlags, false)
		}
	} else {
		cursor, err := handler.Accounts.Open(ctx, metadata.Model)
		if errors.Is(err, ErrNotNativeRoute) {
			request.Body = io.NopCloser(bytes.NewReader(payload))
			handler.Fallback.ServeHTTP(response, request.WithContext(ctx))
			return
		}
		if err != nil || cursor == nil {
			trail.selection(err)
			handler.fail(response, trail, "no_available_account")
			return
		}
		phaseCursors = append(phaseCursors, cursor)
		phasePinnedFlags = append(phasePinnedFlags, requestPinned)
	}
	// 整个请求（含流式交付）的总预算。10 分钟的旧上限会切断长推理流，
	// 现在与流空闲策略共享同一个放宽后的总时长（见 G3）。
	ctx, cancel := context.WithTimeout(ctx, inferenceapi.StreamTotalTimeout)
	defer cancel()
	var last *http.Response
	var lastRef accountcore.AccountRef
	contacted := false
	var selectionErr error
	transportBudget := nativeTransportRetryBudget
	defer func() {
		if last != nil {
			_ = last.Body.Close()
		}
	}()
	for phaseIdx, cursor := range phaseCursors {
		phasePinned := phasePinnedFlags[phaseIdx]
		phaseTracker := &codex429Tracker{}
		for attempt := 0; attempt < 4; attempt++ {
			selection, found, err := cursor.Next(ctx)
			if err != nil {
				selectionErr = err
			}
			if err != nil || !found || ctx.Err() != nil {
				break
			}
			timing.markAccount(string(selection.AccountRef))
			route, err := runtimecore.NewModelRoute(selection.AccountRef, metadata.Model)
			if err != nil || selection.Credential == nil || selection.Credential.ProviderID() != "codex" || !selection.Observation.IsValid() || selection.Observation.AccountRef() != selection.AccountRef || selection.Observation.ProviderID() != "codex" {
				break
			}
			// ChatGPT 登录账号的上游只接受 codex CLI 形状的请求（见 nativeRequest.passthroughSafe）。
			// 其它形状交给 Canonical：OAuth 的 store/续接由 Canonical 按上游能力归一化或明确拒绝，
			// 不能把已经选好的账号丢给 Node 重放。已有账号试过就跳过这个账号，不把注定 400 的请求发出去。
			if isStatelessCredential(selection.Credential) && !metadata.passthroughSafe() {
				if !contacted {
					request.Body = io.NopCloser(bytes.NewReader(payload))
					request.ContentLength = int64(len(payload))
					handler.Fallback.ServeHTTP(response, request.WithContext(ctx))
					return
				}
				continue
			}
			// 钉选账号不可用时请求会回落到普通池并成功；不记录就只剩响应头可查。
			if requestPinned && selection.AccountRef != pinnedRef {
				trail.pinFallback(pinnedRef, selection.AccountRef)
			}
			contacted = true
			// 传输失败且上游一个字节都没返回时，先在同一账号上有界重试，再考虑换号。
			timing.markUpstreamStart()
			upstream, transportFailure, attemptStarted, admitErr := handler.nativeRoundTrip(ctx, selection, payload, request, trail, &transportBudget, metadata.Model)
			if admitErr != nil {
				if request.Context().Err() != nil {
					return
				}
				handler.failAdmission(response, trail, admitErr)
				return
			}
			if upstream == nil {
				if request.Context().Err() != nil {
					return
				}
				if transportFailure.IsValid() {
					handler.recordFailure(ctx, route, selection, transportFailure)
				}
				continue
			}
			timing.markUpstreamHeader()
			if last != nil {
				_ = last.Body.Close()
				last = nil
			}
			if upstream.StatusCode >= 200 && upstream.StatusCode < 300 {
				probeWindow := handler.ProbeWindow
				if probeWindow <= 0 {
					probeWindow = nativeProbeWindow
				}
				probed := handler.probeResponse(upstream, metadata.Stream, string(selection.AccountRef), probeWindow)
				timing.markProbeDone()
				failure := probed.failure
				if request.Context().Err() != nil {
					_ = upstream.Body.Close()
					return
				}
				if failure.IsValid() && failure.RuntimeKind() == runtimecore.FailureSafetyRejected {
					handler.recordFailure(ctx, route, selection, failure)
					_ = upstream.Body.Close()
					trail.attempt(selection.AccountRef, "safety_rejected", failure, "", attemptStarted)
					applyCodex429ResponseHeaders(response.Header(), reqState, false, handler.Clock())
					handler.fail(response, trail, "upstream_safety_rejected")
					return
				}
				// HTTP 200 也可能在尚未输出内容时返回容量/额度错误。
				// probeResponse 已限定可重放边界，立即关闭底层流与泵并只保留有界错误快照，
				// 避免后续若进入同阶段其他 429 候选的退避等待时仍持有活连接或后台泵。
				if failure.IsValid() && failure.ResponseFailure().Retryable() {
					handler.recordFailure(ctx, route, selection, failure)
					trail.attempt(selection.AccountRef, "precommit_failure", failure, "", attemptStarted)
					_ = upstream.Body.Close()
					upstream.Body = io.NopCloser(bytes.NewReader(probed.buffered))
					last, lastRef = upstream, selection.AccountRef
					reqState.ClearExplicitRetryAfter()
					continue
				}
				applyCodex429ResponseHeaders(response.Header(), reqState, false, handler.Clock())
				if probed.committed {
					// 窗口到期时正文尚未开始：先写 200 头并立即 flush 到线上，
					// 后续读到的字节（含回放）与心跳都走同一个响应。
					// 只 WriteHeader 不 Flush 时，net/http 会把头留在缓冲区等首块正文，
					// 提前交付就失去意义。
					writeResponseHeaders(response, upstream, selection.AccountRef, metadata.Stream)
					flushResponse(response)
				}
				timing.markCommitted()
				handler.deliver(response, request.WithContext(ctx), upstream, route, selection, metadata.Stream, probed.committed, attemptStarted, trail)
				_ = upstream.Body.Close()
				return
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
				cooldownReceipt = handler.recordFailure(ctx, route, selection, failure)
				recordCodexFailureHint(reqState, failure)
				if failure.RuntimeKind() == runtimecore.FailureSafetyRejected {
					_ = upstream.Body.Close()
					applyCodex429ResponseHeaders(response.Header(), reqState, false, handler.Clock())
					handler.fail(response, trail, "upstream_safety_rejected")
					return
				}
				if failure.RuntimeKind() == runtimecore.FailureUpstreamEdgeRejected {
					// 站点边缘拒绝（WAF 拦截页 / 网关请求格式拒绝）与账号无关：交付网关 502，
					// 不透传上游拦截页，也不换号（与 Node 的 edge policy 同语义）。
					_ = upstream.Body.Close()
					applyCodex429ResponseHeaders(response.Header(), reqState, false, handler.Clock())
					handler.fail(response, trail, "upstream_edge_rejected")
					return
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
				return
			}
			_ = upstream.Body.Close()
			upstream.Body = io.NopCloser(bytes.NewReader(prefix))
			last, lastRef = upstream, selection.AccountRef
			if classifyErr == nil && failureErr == nil {
				if status, known := failure.ObservedHTTPStatus(); known && status == http.StatusTooManyRequests {
					evidence := buildCodex429Evidence(selection.AccountRef, phasePinned, failure)
					if upstreamretry.Eligible(evidence) {
						handler.Upstream429Retries.FreezePolicyAtObservation(ctx, reqState, evidence)
						phaseTracker.Record(codex429Candidate{
							accountRef:        selection.AccountRef,
							evidence:          evidence,
							cooldownReceipt:   cooldownReceipt,
							originObservation: selection.Observation,
						})
					}
				}
			}
		}
		if request.Context().Err() != nil {
			return
		}
		if phaseTracker.HasCandidates() {
			if handler.runCodex429RetryLoop(
				ctx,
				response,
				request,
				payload,
				metadata,
				phasePinned,
				phaseTracker,
				reqState,
				trail,
				&transportBudget,
				&last,
				&lastRef,
			) {
				return
			}
		}
	}
	if request.Context().Err() != nil {
		return
	}
	if last != nil {
		copyHeaders(response.Header(), last.Header)
		setAccountHeaders(response, lastRef)
		applyCodex429ResponseHeaders(response.Header(), reqState, last.StatusCode == http.StatusTooManyRequests, handler.Clock())
		if handler.Upstream429Retries != nil {
			retries, _ := reqState.Summary()
			outcome := "exhausted"
			if retries == 0 {
				outcome = "aborted"
			}
			handler.Upstream429Retries.ReportOutcome(reqState, "codex_responses_http", "codex", lastRef.String(), outcome, upstreamretry.AbortNone)
		}
		response.WriteHeader(last.StatusCode)
		copyBody(response, last.Body, 0)
		trail.finish(last.StatusCode, "upstream_status")
		return
	}
	if !contacted {
		// 选号阶段整轮候选仅因并发天花板被跳过时，账号是存在的、只是此刻满了：
		// 与 Canonical 汇合点和 WS 入口一致，交回可重试的 429，而不是 503。
		if selectionErr != nil {
			trail.selection(selectionErr)
		}
		if reason := cursorReasons(phaseCursors); reason != "" {
			trail.explain(reason)
		}
		if errors.Is(selectionErr, accountrouting.ErrConcurrencyExhausted) {
			handler.failAdmission(response, trail, admission.NewSaturationError(admission.ReasonAccountSaturated))
			return
		}
		handler.fail(response, trail, "no_available_account")
		return
	}
	handler.fail(response, trail, "upstream_temporarily_unavailable")
}

// nativeRoundTrip 联系上游；只有「一个响应字节都没拿到」的传输失败才在同一账号
// 上重试。一旦拿到响应对象（哪怕状态码是 4xx/5xx），后续判断与交付都由调用方处理，
// 这里绝不重试：重复请求会对同一轮生成计费两次，流式场景还会重复帧。
//
// retryBudget 是请求级预算指针，每真正发起一次重试就减一；由调用方在所有账号间共享。
func (handler *Handler) nativeRoundTrip(
	ctx context.Context,
	selection Selection,
	payload []byte,
	request *http.Request,
	trail *failureTrail,
	retryBudget *int,
	model string,
) (*http.Response, inferencegateway.AttemptFailure, time.Time, error) {
	var lastFailure inferencegateway.AttemptFailure
	for attempt := 0; ; attempt++ {
		lease, admitErr := admission.Acquire(ctx, admission.Request{
			Provider:   string(inference.ProviderCodex),
			AccountRef: selection.AccountRef.String(),
			Model:      model,
		})
		if admitErr != nil {
			return nil, lastFailure, time.Time{}, admitErr
		}
		started := trail.now()
		upstream, err := handler.Upstream.RoundTripNative(ctx, selection.Credential, payload, request.Header, request.Host)
		if err == nil && upstream != nil && upstream.Body != nil {
			upstream.Body = &admissionBody{ReadCloser: upstream.Body, release: lease.Release}
			return upstream, inferencegateway.AttemptFailure{}, started, nil
		}
		lease.Release()
		if upstream != nil && upstream.Body != nil {
			_ = upstream.Body.Close()
		}
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		failure, classifyErr := attemptfailure.NewTransport(err)
		if classifyErr == nil {
			lastFailure = failure
		}
		trail.attempt(selection.AccountRef, "transport", failure, err.Error(), started)
		// 客户端断开或总预算耗尽时不再等待，也不再有意义地重试。
		if ctx.Err() != nil {
			return nil, lastFailure, time.Time{}, nil
		}
		if attempt+1 >= nativeTransportAttemptsPerAccount || (retryBudget != nil && *retryBudget <= 0) {
			return nil, lastFailure, time.Time{}, nil
		}
		if retryBudget != nil {
			*retryBudget--
		}
		if !waitTransportRetry(ctx, nativeTransportRetryDelay(attempt)) {
			return nil, lastFailure, time.Time{}, nil
		}
	}
}

// admissionBody 在上游响应体关闭时归还并发名额。
type admissionBody struct {
	io.ReadCloser
	release func()
}

func (body *admissionBody) Close() error {
	err := body.ReadCloser.Close()
	if body.release != nil {
		body.release()
		body.release = nil
	}
	return err
}

// nativeTransportRetryDelay 返回第 retry 次重试（从 0 起）前的等待时长：250ms、500ms…上限 1s。
func nativeTransportRetryDelay(retry int) time.Duration {
	delay := nativeTransportRetryBaseDelay
	for i := 0; i < retry; i++ {
		delay *= 2
		if delay >= nativeTransportRetryMaxDelay {
			return nativeTransportRetryMaxDelay
		}
	}
	return delay
}

// waitTransportRetry 在 ctx 存活的前提下等待；返回 false 表示等待被取消。
func waitTransportRetry(ctx context.Context, delay time.Duration) bool {
	if delay <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// fail 写出网关错误并汇报失败摘要。
func (handler *Handler) fail(response http.ResponseWriter, trail *failureTrail, code string) {
	writeError(response, code)
	trail.finish(codexrelay.Error(code).Status, code)
}

// failAdmission 把并发准入拒绝写成 429 + Retry-After（稳定错误码）。
func (handler *Handler) failAdmission(response http.ResponseWriter, trail *failureTrail, err error) {
	rejection, ok := admission.AsRejection(err)
	if !ok {
		handler.fail(response, trail, "upstream_temporarily_unavailable")
		return
	}
	response.Header().Set("Retry-After", strconv.Itoa(rejection.RetryAfterSeconds()))
	writeAdmissionError(response)
	trail.finish(http.StatusTooManyRequests, admission.CodeAccountTemporarilyUnavailable)
}

// writeAdmissionError 写出与其它 Codex 错误同形的 429 错误体。
func writeAdmissionError(response http.ResponseWriter) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(http.StatusTooManyRequests)
	_ = json.NewEncoder(response).Encode(map[string]any{"error": map[string]any{
		"code":    admission.CodeAccountTemporarilyUnavailable,
		"message": "Inference capacity is temporarily unavailable, retry later",
		"type":    "rate_limit_error",
		"param":   nil,
	}})
}

func (handler *Handler) recordFailure(ctx context.Context, route runtimecore.ModelRoute, selection Selection, failure inferencegateway.AttemptFailure) runtimecore.CooldownReceipt {
	recorded, receipt, _ := handler.observed.RecordFailureWithReceipt(ctx, route, selection.Observation, failure)
	if recorded && failure.RuntimeKind() == runtimecore.FailureModelUnsupported {
		_ = handler.ModelRefreshes.ScheduleModelRefresh(ctx, selection.AccountRef, "codex")
	}
	return receipt
}

func writeError(response http.ResponseWriter, code string) {
	definition := codexrelay.Error(code)
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(definition.Status)
	_ = json.NewEncoder(response).Encode(map[string]any{"error": map[string]any{"code": code, "message": definition.Message, "type": definition.Type, "param": nil}})
}

// isStatelessCredential 报告凭据是否指向不存储 response 的 ChatGPT Codex 上游。
func isStatelessCredential(credential accountapp.Credential) bool {
	_, oauth := credential.(*codexauth.OAuthAuth)
	return oauth
}

// cursorReasons 汇总本轮所有候选游标的扫空诊断；无游标或无诊断时返回空。
//
// 只用于失败摘要：503 no_available_account 过去只有 attempts=[]，无法区分
// “没有候选”与“候选被额度门禁/模型目录/冷却全部挡下”。
func cursorReasons(cursors []Cursor) string {
	reasons := make([]string, 0, len(cursors))
	for _, cursor := range cursors {
		diagnostics, ok := cursor.(CursorDiagnostics)
		if !ok {
			continue
		}
		if reason := diagnostics.ExhaustedReason(); reason != "" {
			reasons = append(reasons, reason)
		}
	}
	return strings.Join(reasons, "; ")
}
