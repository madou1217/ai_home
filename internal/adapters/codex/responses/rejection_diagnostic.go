package responses

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

// 上游拒绝请求（4xx 参数类错误）时的低敏诊断。
//
// 客户端只看到"上游拒绝当前请求参数"，没有这条诊断就无法知道 Go 的编码与上游合同在哪个
// 字段不一致。只记录状态码、错误 type/code/param 与截断的 message，不记录请求体、凭据或
// 账号标识。

// maxRejectionBodyBytes 限制为诊断缓冲的上游错误体。
const maxRejectionBodyBytes = 64 * 1024

// maxRejectionMessageRunes 限制写入日志的上游 message 长度。
const maxRejectionMessageRunes = 300

// UpstreamRejection 是一次上游拒绝请求的低敏事实。
type UpstreamRejection struct {
	Model      string
	StatusCode int
	Type       string
	Code       string
	Param      string
	Message    string
}

// ObserveRejections 注册上游拒绝观察器；只在组合根装配期调用。
func (adapter *Adapter) ObserveRejections(observer func(UpstreamRejection)) {
	if adapter != nil {
		adapter.rejections = observer
	}
}

// bufferRejectionBody 读出有界错误体并返回可重放的 Body，供分类器与诊断共用。
func bufferRejectionBody(response *http.Response) []byte {
	payload, _ := io.ReadAll(io.LimitReader(response.Body, maxRejectionBodyBytes))
	response.Body = io.NopCloser(bytes.NewReader(payload))
	return payload
}

// reportRejection 对 4xx（认证与限流除外）解析错误体并通知观察器。
func (adapter *Adapter) reportRejection(model string, statusCode int, payload []byte) {
	if adapter.rejections == nil ||
		statusCode < http.StatusBadRequest ||
		statusCode >= http.StatusInternalServerError ||
		statusCode == http.StatusUnauthorized ||
		statusCode == http.StatusTooManyRequests {
		return
	}
	var envelope struct {
		Error struct {
			Type    string `json:"type"`
			Code    any    `json:"code"`
			Param   any    `json:"param"`
			Message string `json:"message"`
		} `json:"error"`
		Detail string `json:"detail"`
	}
	_ = json.Unmarshal(payload, &envelope)
	message := envelope.Error.Message
	if message == "" {
		message = envelope.Detail
	}
	adapter.rejections(UpstreamRejection{
		Model:      model,
		StatusCode: statusCode,
		Type:       envelope.Error.Type,
		Code:       scalarText(envelope.Error.Code),
		Param:      scalarText(envelope.Error.Param),
		Message:    truncateRunes(strings.TrimSpace(message), maxRejectionMessageRunes),
	})
}

// scalarText 把 JSON 标量转为文本，非标量返回空串。
func scalarText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64, bool:
		encoded, _ := json.Marshal(typed)
		return string(encoded)
	default:
		return ""
	}
}

// truncateRunes 按字符截断并保证 UTF-8 合法。
func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit]) + "…"
}
