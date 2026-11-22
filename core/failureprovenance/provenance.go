// Package failureprovenance 记录一次失败分类"命中了哪一层规则"。
//
// 该包只保存低敏标识：来源层、信号 ID、Provider、结构化错误类型/代码与真实
// HTTP 状态；不保存响应正文、请求内容或凭据。运行态、失败日志与诊断 API 共用
// 这一份值对象，避免各自解释"为什么这次失败被这样归类"。
package failureprovenance

import "strings"

// Source 是失败分类的判定来源层。
type Source string

const (
	// SourceAccountRule 表示命中了账号级自定义规则。
	SourceAccountRule Source = "account_rule"
	// SourceGlobalOverride 表示命中了运行时全局覆盖信号。
	SourceGlobalOverride Source = "global_override"
	// SourceBuiltinContract 表示命中了内置契约信号。
	SourceBuiltinContract Source = "builtin_contract"
	// SourceObserverStructural 表示命中了适配器的结构性判定（边缘拒绝等）。
	SourceObserverStructural Source = "observer_structural"
	// SourceTransport 表示这次失败来自传输层，而不是 HTTP 响应。
	SourceTransport Source = "transport"
	// SourceLocal 表示本机合成失败（例如本机账号池为空）。
	SourceLocal Source = "local"
)

// Provenance 是一次失败分类的来源证据。
type Provenance struct {
	source     Source
	signalID   string
	provider   string
	errorType  string
	errorCode  string
	httpStatus int
}

// New 创建来源证据；空来源视为无效。
func New(
	source Source,
	signalID string,
	provider string,
	errorType string,
	errorCode string,
	httpStatus int,
) Provenance {
	return Provenance{
		source:     source,
		signalID:   strings.TrimSpace(signalID),
		provider:   strings.TrimSpace(provider),
		errorType:  strings.TrimSpace(errorType),
		errorCode:  strings.TrimSpace(errorCode),
		httpStatus: httpStatus,
	}
}

// Source 返回判定来源层。
func (provenance Provenance) Source() Source { return provenance.source }

// SignalID 返回命中的契约/规则标识。
func (provenance Provenance) SignalID() string { return provenance.signalID }

// Provider 返回产生证据的 Provider。
func (provenance Provenance) Provider() string { return provenance.provider }

// ErrorType 返回结构化错误类型。
func (provenance Provenance) ErrorType() string { return provenance.errorType }

// ErrorCode 返回结构化错误代码。
func (provenance Provenance) ErrorCode() string { return provenance.errorCode }

// HTTPStatus 返回真实 HTTP 状态；0 表示未知。
func (provenance Provenance) HTTPStatus() int { return provenance.httpStatus }

// IsZero 判断当前值没有携带来源证据。
func (provenance Provenance) IsZero() bool {
	return provenance.source == "" &&
		provenance.signalID == "" &&
		provenance.provider == "" &&
		provenance.httpStatus == 0
}

// IsValid 判断来源层是否是已登记取值。
func (provenance Provenance) IsValid() bool {
	switch provenance.source {
	case SourceAccountRule, SourceGlobalOverride, SourceBuiltinContract,
		SourceObserverStructural, SourceTransport, SourceLocal:
		return true
	default:
		return false
	}
}
