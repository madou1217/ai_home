package zcoderelay

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	failurecontract "github.com/madou1217/ai_home/contracts/upstream-failure"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// zcode 的错误语义由稳定 code 决定，与请求走 plan 还是 ultra 端点无关：
//
//	1005 → 额度用尽；1113 → 余额不足；3012 → 客户端/协议不匹配（本地 harness/版本）；
//	3006 → 当前套餐不允许该模型；401 → 凭据失效。
//
// 端点差异只影响上游地址与鉴权头（见 endpoints.go），不影响「这个错误是什么意思」，
// 因此错误表按 Provider 维护，不引入端点维度。具体映射在
// contracts/upstream-failure 的 zcode 信号行里，本文件只负责把 zcode 的信封
// 投影成低敏证据。

// ClassifyFailure 处理非 2xx 响应：先按 zcode 信封取 code，再查 Provider 级语义表。
func (provider *Provider) ClassifyFailure(
	statusCode int,
	header http.Header,
	body []byte,
	observedAt time.Time,
) (sharedfailure.Classification, error) {
	if failure, ok := detectBusinessFailure(body); ok {
		if classification, matched := classifyByContract(statusCode, failure.Code); matched {
			return classification, nil
		}
	}
	// 没有结构化 code（例如空正文的 401/5xx）：回落到通用状态码规则。
	return sharedfailure.ObserveHTTPForProvider(ProviderID, statusCode, header, body, observedAt)
}

// ClassifyBusinessFailure 处理 HTTP 2xx 但正文是业务错误的响应（例如
// {"code":1005,"msg":"exceed quota limit"}）。
//
// 命中契约信号时用信号语义；未登记的 code 归为 invalid_request（请求级、不阻塞账号），
// 避免把未知的「200 + 业务错误」误判成上游不可用而冷却账号。
func (provider *Provider) ClassifyBusinessFailure(
	statusCode int,
	_ http.Header,
	body []byte,
) (sharedfailure.Classification, bool) {
	if statusCode < 200 || statusCode >= 300 {
		// 非 2xx 由 ClassifyFailure 处理；接口契约只要求这里判定 2xx 业务失败。
		return sharedfailure.Classification{}, false
	}
	failure, ok := detectBusinessFailure(body)
	if !ok {
		return sharedfailure.Classification{}, false
	}
	if classification, matched := classifyByContract(statusCode, failure.Code); matched {
		return classification, true
	}
	classification, err := sharedfailure.NewClassification(runtimecore.FailureInvalidRequest, 0)
	if err != nil {
		return sharedfailure.Classification{}, false
	}
	withStatus, err := classification.WithObservedHTTPStatus(statusCode)
	if err != nil {
		return sharedfailure.Classification{}, false
	}
	return withStatus, true
}

// PresentBusinessFailure 让 zcode 的业务失败带上可操作的文案与状态。
//
// 状态按语义选，而不是按上游原始状态：这样 Anthropic 入口用同一状态映射
// （429→rate_limit_error、403→permission_error、400→invalid_request_error）也能得到
// 正确的错误类别；不需要额外的 surface 映射表或自定义 code 字段。
func (*Provider) PresentBusinessFailure(
	classification sharedfailure.Classification,
) relaycore.BusinessFailurePresentation {
	switch classification.Kind() {
	case runtimecore.FailureBillingBlocked:
		return relaycore.BusinessFailurePresentation{
			StatusCode: http.StatusForbidden,
			Code:       "zcode_billing_blocked",
			Message:    "ZCode 余额不足或无可用资源包，请充值后重试",
		}
	case runtimecore.FailureQuotaExhausted:
		return relaycore.BusinessFailurePresentation{
			StatusCode: http.StatusTooManyRequests,
			Code:       "zcode_quota_exhausted",
			Message:    "ZCode 额度已用尽，请等待额度恢复或更换账号",
		}
	case runtimecore.FailureInvalidRequest:
		return relaycore.BusinessFailurePresentation{
			StatusCode: http.StatusBadRequest,
			Code:       "zcode_client_contract_mismatch",
			Message:    "ZCode 拒绝当前客户端/协议（3012）：请确认官方 harness 与客户端版本",
		}
	case runtimecore.FailureModelUnsupported:
		return relaycore.BusinessFailurePresentation{
			StatusCode: http.StatusBadRequest,
			Code:       "zcode_model_not_allowed",
			Message:    "该账号套餐不允许使用此模型（3006）",
		}
	}
	return relaycore.BusinessFailurePresentation{}
}

// PresentHTTPStatusFailure 让非 2xx 的 zcode 业务码也能带上可操作文案。
func (*Provider) PresentHTTPStatusFailure(
	statusCode int,
	classification sharedfailure.Classification,
) (relaycore.BusinessFailurePresentation, bool) {
	if classification.Kind() == runtimecore.FailureModelUnsupported {
		return relaycore.BusinessFailurePresentation{
			StatusCode: http.StatusBadRequest,
			Code:       "zcode_model_not_allowed",
			Message:    "该账号套餐不允许使用此模型（3006）",
		}, true
	}
	return relaycore.BusinessFailurePresentation{}, false
}

// classifyByContract 用 (provider, status, code) 查失败契约。
func classifyByContract(statusCode int, code string) (sharedfailure.Classification, bool) {
	input := sharedfailure.SignalInputFrom(ProviderID, statusCode, "", code, 0, nil)
	match, matched := failurecontract.Resolve(input)
	if !matched {
		return sharedfailure.Classification{}, false
	}
	kind := runtimecore.FailureKind(match.Semantic)
	classification, err := sharedfailure.ClassifySignal(
		match, statusCode, sharedfailure.SignalRetryAfter(kind, statusCode, 0),
	)
	if err != nil {
		return sharedfailure.Classification{}, false
	}
	withStatus, err := classification.WithObservedHTTPStatus(statusCode)
	if err != nil {
		return sharedfailure.Classification{}, false
	}
	return withStatus, true
}

type businessFailure struct {
	Code    string
	Message string
}

// detectBusinessFailure 只认「JSON 对象 + 数字 code + 字符串 msg，且没有 chat 结果字段」。
func detectBusinessFailure(body []byte) (businessFailure, bool) {
	trimmed := strings.TrimSpace(string(body))
	if !strings.HasPrefix(trimmed, "{") {
		return businessFailure{}, false
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(trimmed), &document); err != nil {
		return businessFailure{}, false
	}
	if _, ok := document["choices"]; ok {
		return businessFailure{}, false
	}
	if _, ok := document["content"]; ok {
		return businessFailure{}, false
	}
	code, ok := document["code"]
	if !ok {
		return businessFailure{}, false
	}
	message := ""
	if text, ok := document["msg"].(string); ok {
		message = strings.TrimSpace(text)
	} else if text, ok := document["message"].(string); ok {
		message = strings.TrimSpace(text)
	}
	if message == "" {
		return businessFailure{}, false
	}
	return businessFailure{Code: fmt.Sprint(code), Message: message}, true
}
