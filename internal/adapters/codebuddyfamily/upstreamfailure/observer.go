// Package upstreamfailure 把 CodeBuddy / WorkBuddy 家族的结构化上游错误映射为统一运行态分类。
//
// 与 Node 侧同一套口径（lib/account/codebuddy-family-inference.js 的
// parseCodebuddyFamilyError + RETRYABLE_CODES）：
//   - 腾讯统一信封 `{code,msg,requestId,displayMsg,actions}` 的文案优先
//     displayMsg 的 zh → zh-hant → en（比透 code 数字对用户有用），其次 msg，最后 code；
//   - 只有三个业务码算「换账号/换出口可能改变结果」：10085（WAF 判请求不合法）、
//     11101（上游不再支持非流式）、11128（首条非 system）——后两个本端应当已规避，
//     真出现说明上游行为变了，因此也按可重试处理并留在指标里可见。
//
// 分类只按「状态码 + 信封可重试性」定，不猜业务码语义：家族业务码是腾讯私有的，
// 没有可依赖的公开语义表，硬编码猜测会把「请求问题」误判成「账号问题」。
package upstreamfailure

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// ErrInvalidObservation 表示观察输入不完整（无响应可看）。
var ErrInvalidObservation = errors.New("家族上游失败观察输入无效")

// retryableEnvelopeCodes 是「换账号/换出口可能改变结果」的业务码（与 Node 同集合）。
var retryableEnvelopeCodes = map[int64]bool{
	10085: true,
	11101: true,
	11128: true,
}

// Envelope 是家族上游错误响应的解析结论。
type Envelope struct {
	// Present 表示这是腾讯统一信封（带 code 字段）。
	Present bool
	// Code 是信封业务码；非信封时为 nil。
	Code *int64
	// Message 是给客户端的人可读文案；为空表示调用方应原样透传上游正文。
	Message string
	// Retryable 表示换账号/换出口可能改变结果。
	Retryable bool
}

// ParseEnvelope 解析家族上游的错误响应（与 Node 的 parseCodebuddyFamilyError 同语义）。
func ParseEnvelope(statusCode int, body []byte) Envelope {
	text := strings.TrimSpace(string(body))
	fields, ok := decodeObject([]byte(text))
	if !ok {
		// 非信封（例如 openresty 的 401 HTML）：状态码本身就是全部信息。
		message := truncateRunes(text, 300)
		if message == "" {
			message = "upstream_status_" + strconv.Itoa(statusCode)
		}
		return Envelope{Message: message, Retryable: statusCode >= 500}
	}
	rawCode, hasCode := fields["code"]
	if !hasCode {
		// 不是腾讯信封（可能是标准 OpenAI 错误体）：交给调用方原样处理。
		return Envelope{}
	}
	result := Envelope{Present: true}
	if code, ok := int64Value(rawCode); ok {
		result.Code = &code
		result.Retryable = retryableEnvelopeCodes[code]
	}
	result.Message = envelopeMessage(fields, rawCode)
	return result
}

// Classify 按状态码 + 信封可重试性返回单一失败分类。
//
// 判断顺序（先具体后兜底）：可重试信封码 → 明确状态码 → 其余按状态段归类。
func Classify(statusCode int, envelope Envelope) (sharedfailure.Classification, error) {
	kind := runtimecore.FailureUnclassified
	switch {
	case envelope.Retryable:
		// WAF 判请求不合法（10085）等：换出口/换账号可能就过了。用「上游暂不可用」
		// 而不是「限流」——限流语义是额度窗口，会给账号挂 5 分钟冷却；这里只是一次
		// 环境相关的拒绝（30 秒冷却 + 换号），与 Node 的「换个出口 IP 可能就过了」一致。
		kind = runtimecore.FailureUpstreamUnavailable
	case statusCode == http.StatusTooManyRequests:
		kind = runtimecore.FailureRateLimited
	case statusCode == http.StatusUnauthorized:
		kind = runtimecore.FailureCredentialRejected
	case statusCode == http.StatusForbidden:
		kind = runtimecore.FailurePermissionDenied
	case statusCode == http.StatusBadRequest || statusCode == http.StatusUnprocessableEntity:
		kind = runtimecore.FailureInvalidRequest
	case statusCode == http.StatusRequestTimeout:
		kind = runtimecore.FailureRequestTimeout
	case statusCode == http.StatusNotFound:
		kind = runtimecore.FailureNotFound
	case statusCode >= http.StatusInternalServerError:
		kind = runtimecore.FailureUpstreamUnavailable
	}
	if kind == runtimecore.FailurePermissionDenied {
		return sharedfailure.NewBlockingClassification(kind, runtimecore.BlockScopeAccountModel)
	}
	return sharedfailure.NewClassification(kind, time.Duration(0))
}

// ObserveHTTP 观察一次家族上游 HTTP 响应并给出分类。
//
// 只有存在失败证据时才分类：2xx 响应里的 `code` 字段（正常响应也可能带业务码）不构成
// 失败，因此 2xx 且信封不可重试时返回 ErrNoFailureEvidence，让调用方按成功处理——
// 普通 200 正文绝不能被规则或观察器改写成失败。
func ObserveHTTP(
	statusCode int,
	header http.Header,
	body []byte,
	observedAt time.Time,
) (sharedfailure.Classification, error) {
	if statusCode <= 0 {
		return sharedfailure.Classification{}, ErrInvalidObservation
	}
	if classification, rejected := sharedfailure.ObserveEdgeRejection(statusCode, header, body); rejected {
		// 站点边缘拒绝（WAF 拦截页 / 网关请求格式拒绝）与账号凭据无关：
		// 不按凭据失效处理，调用方也不换号（与 Node 的 edge policy 同语义）。
		return classification, nil
	}
	envelope := ParseEnvelope(statusCode, body)
	if statusCode < http.StatusMultipleChoices && !envelope.Retryable {
		return sharedfailure.Classification{}, sharedfailure.ErrNoFailureEvidence
	}
	classification, err := Classify(statusCode, envelope)
	if err != nil {
		return sharedfailure.Classification{}, err
	}
	// Retry-After 只在有限提示内采纳（与 Claude observer 同口径，避免上游用超长值绕过上限）。
	if retryAfter := parseRetryAfter(header); retryAfter > 0 && retryAfter <= runtimecore.MaxCooldownHint {
		if classification.Kind() != runtimecore.FailurePermissionDenied {
			return sharedfailure.NewClassification(classification.Kind(), retryAfter)
		}
	}
	return classification, nil
}

// parseRetryAfter 读取 Retry-After（秒数或 HTTP 日期），无法解析时返回 0。
func parseRetryAfter(header http.Header) time.Duration {
	if header == nil {
		return 0
	}
	value := strings.TrimSpace(header.Get("Retry-After"))
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil {
		if seconds <= 0 {
			return 0
		}
		return time.Duration(seconds) * time.Second
	}
	if moment, err := http.ParseTime(value); err == nil {
		if wait := time.Until(moment); wait > 0 {
			return wait
		}
	}
	return 0
}

// envelopeMessage 按 displayMsg(zh → zh-hant → en) → msg → code 的优先级取文案。
func envelopeMessage(fields map[string]json.RawMessage, rawCode json.RawMessage) string {
	if display, ok := decodeObject(fields["displayMsg"]); ok {
		for _, key := range []string{"zh", "zh-hant", "en"} {
			if value, ok := stringValue(display[key]); ok && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
	}
	if message, ok := stringValue(fields["msg"]); ok && strings.TrimSpace(message) != "" {
		return strings.TrimSpace(message)
	}
	return "upstream_code_" + strings.TrimSpace(string(rawCode))
}

// decodeObject 解析 JSON 对象；不是对象时返回 false（逐字段宽容）。
func decodeObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, false
	}
	return fields, true
}

// stringValue 只接受 JSON 字符串。
func stringValue(raw json.RawMessage) (string, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// int64Value 接受数字或数字字符串（与 Node 的 Number() 同口径）。
func int64Value(raw json.RawMessage) (int64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) == 0 {
		return 0, false
	}
	if trimmed[0] == '"' {
		value, ok := stringValue(raw)
		if !ok {
			return 0, false
		}
		trimmed = strings.TrimSpace(value)
	}
	parsed, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// truncateRunes 按字符截断，避免把多字节字符切成半个。
func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}
