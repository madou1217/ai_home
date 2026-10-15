package codebuddyfamilyrelay

import (
	"encoding/json"
	"strconv"
	"strings"
)

// retryableUpstreamCodes 是「换账号重试可能改变结果」的业务码。
//
// 三个都属**本端应当已规避**或环境相关：WAF 判请求不合法（换出口可能就过了）、
// 上游不再支持非流式、首条非 system。其余业务码换号无意义（请求本身的问题）。
var retryableUpstreamCodes = map[int64]bool{
	10085: true,
	11101: true,
	11128: true,
}

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
func ParseUpstreamError(statusCode int, body []byte) UpstreamError {
	text := strings.TrimSpace(string(body))
	fields, ok := decodeRawObject(json.RawMessage(text))
	if !ok {
		// 非信封（例如 openresty 的 401 HTML）：状态码本身就是全部信息。
		message := truncateRunes(text, 300)
		if message == "" {
			message = "upstream_status_" + strconv.Itoa(statusCode)
		}
		return UpstreamError{Message: message, Retryable: statusCode >= 500}
	}
	// 没有 code 字段说明它不是腾讯信封（可能是标准 OpenAI 错误体），
	// 交给调用方原样处理。
	rawCode, hasCode := fields["code"]
	if !hasCode {
		return UpstreamError{}
	}
	code, ok := rawInt64(rawCode)
	result := UpstreamError{Envelope: true}
	if ok {
		result.Code = &code
		result.Retryable = retryableUpstreamCodes[code]
	}
	result.Message = upstreamErrorMessage(fields, rawCode)
	return result
}

// upstreamErrorMessage 按 displayMsg(zh → zh-hant → en) → msg → code 的优先级取文案。
func upstreamErrorMessage(fields map[string]json.RawMessage, rawCode json.RawMessage) string {
	if display, ok := decodeRawObject(fields["displayMsg"]); ok {
		for _, key := range []string{"zh", "zh-hant", "en"} {
			if value, ok := rawString(display[key]); ok && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
	}
	if message, ok := rawString(fields["msg"]); ok && strings.TrimSpace(message) != "" {
		return strings.TrimSpace(message)
	}
	return "upstream_code_" + strings.TrimSpace(string(rawCode))
}

// truncateRunes 按字符截断，避免把多字节字符切成半个。
func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}
