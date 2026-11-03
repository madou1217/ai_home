package codebuddyfamilyrelay

import (
	familyfailure "github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/upstreamfailure"
)

// UpstreamError 是家族上游错误响应的解析结论。
//
// 三种形态必须分清，否则会把「上游说得很清楚的话」洗成网关自有错误：
//   - Envelope：腾讯统一信封 `{code,msg,requestId,displayMsg,actions}`，
//     Message 取 displayMsg 的 zh/zh-hant/en（比 code 数字对用户有用）；
//   - 非信封但有正文（例如 openresty 的 401 HTML）：Message 是截断后的正文，
//     Retryable 按状态码判断（>=500）；
//   - 非信封且无正文（标准 OpenAI 错误体之类）：Message 为空，调用方原样透传。
type UpstreamError struct {
	// Envelope 表示这是腾讯统一信封。
	Envelope bool
	// Code 是信封业务码；非信封时为 nil。
	Code *int64
	// Message 是给客户端的人可读文案；为空表示调用方应原样透传上游正文。
	Message string
	// Retryable 表示换账号重试可能改变结果。
	Retryable bool
}

// ParseUpstreamError 解析家族上游的错误响应（与 Node 侧 parseCodebuddyFamilyError 同语义）。
//
// 实现下沉在内层领域包 internal/adapters/codebuddyfamily/upstreamfailure：同一份解析
// 还要供运行态失败分类使用（见那里的 ObserveHTTP），两处各写一份必然让「文案」与
// 「可重试性」分叉。
func ParseUpstreamError(statusCode int, body []byte) UpstreamError {
	envelope := familyfailure.ParseEnvelope(statusCode, body)
	return UpstreamError{
		Envelope:  envelope.Present,
		Code:      envelope.Code,
		Message:   envelope.Message,
		Retryable: envelope.Retryable,
	}
}
