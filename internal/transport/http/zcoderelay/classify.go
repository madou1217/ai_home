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

// zcode 的错误语义按 **端点** 区分：
//
//   - plan（start-plan / 套餐未知）：长期 JWT + 官方 harness；
//     1005 = 额度用尽，3012 = 客户端/协议不被接受（通常是本机缺 harness 或版本过旧）；
//   - ultra（zai / bigmodel coding plan）：双鉴权头；
//     1113 = 余额不足/无可用资源包，1005 = 额度用尽。
//
// 同一个 Provider 下两套端点对同名 code 可能有不同含义，所以分类必须带 surface。
// 具体「code → 语义」在 contracts/upstream-failure 的 zcode 信号行里，本文件只负责
// 把 zcode 的信封投影成低敏证据。
const (
	// SurfacePlan 是 start-plan/未知套餐端点。
	SurfacePlan = "zcode/plan"
	// SurfaceUltra 是 zai/bigmodel coding plan 端点。
	SurfaceUltra = "zcode/ultra"
)

// FailureSurface 返回当前 Provider 变体实际使用的端点键。
func (provider *Provider) FailureSurface() string {
	if provider == nil {
		return ""
	}
	if IsUltraEndpoint(provider.baseURL) {
		return SurfaceUltra
	}
	return SurfacePlan
}

// ClassifyFailure 处理非 2xx 响应：先按 zcode 信封取 code，再查端点策略。
func (provider *Provider) ClassifyFailure(
	statusCode int,
	header http.Header,
	body []byte,
	observedAt time.Time,
) (sharedfailure.Classification, error) {
	surface := provider.FailureSurface()
	if failure, ok := detectBusinessFailure(body); ok {
		if classification, matched := classifyByContract(surface, statusCode, failure.Code); matched {
			return classification, nil
		}
	}
	// 没有结构化 code（例如空正文的 401/5xx）：回落到通用状态码规则，
	// 但仍带上 surface，便于 Provider 专属信号命中。
	return sharedfailure.ObserveHTTPForProviderSurface(
		ProviderID, surface, statusCode, header, body, observedAt,
	)
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
	surface := provider.FailureSurface()
	if classification, matched := classifyByContract(surface, statusCode, failure.Code); matched {
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
func (*Provider) PresentBusinessFailure(
	classification sharedfailure.Classification,
) relaycore.BusinessFailurePresentation {
	switch classification.Kind() {
	case runtimecore.FailureBillingBlocked:
		return relaycore.BusinessFailurePresentation{
			StatusCode: http.StatusTooManyRequests,
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
	}
	return relaycore.BusinessFailurePresentation{}
}

// classifyByContract 用 (provider, surface, status, code) 查失败契约。
func classifyByContract(surface string, statusCode int, code string) (sharedfailure.Classification, bool) {
	input := sharedfailure.SignalInputFromSurface(
		ProviderID, surface, statusCode, "", code, 0, nil,
	)
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
