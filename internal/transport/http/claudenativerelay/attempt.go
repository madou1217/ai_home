package claudenativerelay

import (
	"bytes"
	"io"
	"net/http"

	"github.com/madou1217/ai_home/application/accountcredentials"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/transportpolicy"
)

// attemptOutcome 描述一次上游尝试对编排的影响。
//
// 无论是否可重试，只要拿到了真实上游响应就一并保留：轮转耗尽时必须把上游说过的
// 话原样还给客户端，而不是合成一个网关自己的错误。把真实 429/529 洗成 502 会让
// 客户端按「网关故障」立即重试，与限流要求的退避语义相反。
type attemptOutcome struct {
	// response 是尚未写给客户端的上游响应，可能为空（未触网或凭据不可用）。
	response *http.Response
	// route 是本次尝试的账号模型元组，用于记录运行态。
	route runtimecore.ModelRoute
	// observation 是本次尝试读取凭据时看到的低敏持久化观察。
	observation accountcredentials.CredentialObservation
	// credentialUnfit 表示账号凭据无法由透传承载（非官方 OAuth）。
	//
	// 无租约调用方遇到这种账号应交回 Canonical——它能承载 API Key 等凭据；
	// 在此拒绝等于让本可服务的请求失败。
	credentialUnfit bool
	// retryAccount 表示该失败已被分类为可换号重试。
	//
	// 必须由失败分类给出，不能从状态码反推：上游可能伪造换号 Header，而部分
	// 4xx 换号也不会改变结果。
	retryAccount bool
	// failure 描述没有上游响应时该如何回复客户端。
	failure relayFailure
}

// relayFailure 是没有上游响应可交付时的网关自有错误。
type relayFailure struct {
	status  int
	code    string
	message string
}

// hasFailure 判断是否记录了网关自有错误。
func (failure relayFailure) hasFailure() bool {
	return failure.status != 0
}

// closeResponse 释放该结果持有的上游连接。
func (outcome attemptOutcome) closeResponse() {
	closeUpstreamResponse(outcome.response)
}

// attemptRelay 用指定账号执行一次上游透传尝试。
//
// 关键约束：本函数**不向客户端写任何字节**。轮转只有在客户端尚未收到任何输出时
// 才安全，一旦写出就无法收回；因此写出决策统一留给调用方，在确认不再重试之后进行。
//
// 第二个返回值为真表示可以换号重试；此时 outcome 仍可能带着上游响应，供耗尽时交付。
func (handler *Handler) attemptRelay(
	request *http.Request,
	accountRef accountcore.AccountRef,
	modelID runtimecore.ModelID,
	body []byte,
) (attemptOutcome, bool) {
	route, err := runtimecore.NewModelRoute(accountRef, modelID.String())
	if err != nil {
		return attemptOutcome{failure: relayFailure{
			status:  http.StatusBadGateway,
			code:    "relay_state_unavailable",
			message: "Claude Relay 运行态不可用",
		}}, false
	}
	binding, observation, err := handler.credentials.ResolveObservedCredentialBinding(
		request.Context(),
		accountRef,
	)
	if err != nil ||
		!binding.IsValid() ||
		binding.AccountRef() != accountRef ||
		binding.ProviderID() != claudeauth.ProviderID ||
		!observation.IsValid() ||
		observation.AccountRef() != accountRef ||
		observation.ProviderID() != claudeauth.ProviderID {
		// 凭据读取失败属该账号自身问题，换号可能成功；耗尽时按账号不可用回复。
		return attemptOutcome{
			route:        route,
			retryAccount: true,
			failure: relayFailure{
				status:  http.StatusServiceUnavailable,
				code:    "relay_account_unavailable",
				message: "Claude Relay 账号当前不可用",
			},
		}, true
	}
	credential := binding.Credential()
	// 透传只允许打官方 Messages 端点（officialMessagesEndpoint 是安全属性），
	// 因此只有「官方端点上的订阅 OAuth」才适用。指向第三方中转的凭据即使也是
	// OAuth 形态，也必须交回 Canonical——那里才尊重账号自带的 Base URL。
	accessToken, err := nativeOAuthAccessToken(credential)
	if err != nil || !transportpolicy.RequiresNativeOAuth(credential) {
		// 凭据不适配是账号的确定性属性，换号可能成功；但绝不能触网。
		// 不换号：透传是传输优化，不该改变调度选中的账号。若因凭据不适配就
		// 跳到下一个，透传会系统性偏向 OAuth 账号，让 API Key 账号在 Messages
		// 流量上被饿死，公平轮转失效。正确做法是把这一次交给能服务它的
		// Canonical，账号选择保持不变。
		return attemptOutcome{
			route:           route,
			credentialUnfit: true,
			failure: relayFailure{
				status:  http.StatusUnprocessableEntity,
				code:    "unsupported_relay_credential",
				message: "Claude Relay 账号必须使用官方 OAuth",
			},
		}, false
	}

	request.Body = io.NopCloser(bytes.NewReader(body))
	request.ContentLength = int64(len(body))
	upstream, err := buildUpstreamRequest(request, accessToken)
	if err == nil && !hasNativeClaudeHeaders(request.Header) {
		// 非原生客户端：正文身份已在入口补齐，外层标识在此补齐，两者缺一
		// 都会被上游按非订阅调用拒绝。
		applyOfficialClientHeaders(upstream.Header)
	}
	if err != nil {
		// 请求本身无法构造，换号不会改变结果。
		return attemptOutcome{
			route: route,
			failure: relayFailure{
				status:  http.StatusBadRequest,
				code:    "invalid_relay_request",
				message: "Claude Relay 请求无效",
			},
		}, false
	}

	upstreamResponse, err := handler.client.Do(upstream)
	if err != nil || upstreamResponse == nil || upstreamResponse.Body == nil {
		closeUpstreamResponse(upstreamResponse)
		retry := err != nil && handler.recordTransportFailure(
			request.Context(),
			route,
			observation,
			err,
		)
		return attemptOutcome{
			route:        route,
			retryAccount: retry,
			failure: relayFailure{
				status:  http.StatusBadGateway,
				code:    "relay_upstream_unavailable",
				message: "Claude 上游暂时不可用",
			},
		}, retry
	}
	if upstreamResponse.StatusCode >= http.StatusOK &&
		upstreamResponse.StatusCode < http.StatusMultipleChoices {
		return attemptOutcome{
			response:    upstreamResponse,
			route:       route,
			observation: observation,
		}, false
	}

	retry := handler.recordHTTPFailure(
		request.Context(),
		route,
		observation,
		upstreamResponse,
	)
	// 失败响应一律保留：无论是否继续换号，耗尽时都要把它原样交付。
	return attemptOutcome{
		response:     upstreamResponse,
		route:        route,
		observation:  observation,
		retryAccount: retry,
	}, retry
}
