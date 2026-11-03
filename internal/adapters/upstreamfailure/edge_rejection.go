package upstreamfailure

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// 站点边缘（WAF/CDN/网关）对**请求本身**的拒绝：与账号凭据无关，不能当成凭据失效。
//
// 该文件镜像 Node 的 lib/server/upstream-edge-block.js（2026-10-15 家族事故的修复）：
//
//	① WAF/CDN 拦截页：cf-mitigated 头，或 HTML 正文，或 text/html 且正文不是 JSON；
//	② APISIX 类边缘网关的**请求格式拒绝**：server: APISIX/* + 正文是只有 message
//	   一个键的 JSON 对象 + message 不含凭据语义。
//
// 事故（2026-10-15）：www.workbuddy.ai/v2/chat/completions（腾讯 EdgeOne + APISIX 栈）
// 对某次请求回 401 + `{"message":"invalid_format"}`，被通用 401 分支判成「凭据失效」，
// 给一个完全健康的账号挂了 31 536 000 000 ms 冷却；事后同一 token 换请求形态直连 200。
//
// 判定必须同时满足形状条件（避免把厂商真正的 401 吞掉）：网关签名头、credentials-blind
// 的信封形状、message 无凭据语义——任何像凭据问题的回答仍按凭据处理。两类命中都不
// 记账号失败、不换号：换号只会拿到同一张拦截页 / 同一个格式门。

const (
	// edgeHTMLScanBytes 限制 HTML 拦截页判定只检查正文开头（与 Node slice(0, 512) 同口径）。
	edgeHTMLScanBytes = 512
)

// edgeCredentialMessageMarkers 是「像凭据问题」的消息片段。
//
// 与 Node 正则 /auth|token|credential|login|sign.?in|unauthoriz|forbidden|permission|expired|apikey|api.?key/i
// 同集合：比较前去掉空格、连字符与下划线，因此 sign in / sign-in / signin 与
// api key / api-key / api_key / apikey 都被覆盖。
var edgeCredentialMessageMarkers = []string{
	"auth", "token", "credential", "login", "signin", "unauthoriz",
	"forbidden", "permission", "expired", "apikey",
}

// ObserveEdgeRejection 判定一次 401/403 响应是否属于「与账号无关的站点边缘拒绝」。
//
// 命中时返回可直接提交的运行态分类（NoStateChange），调用方应不记账、不换号，并以
// 网关 502 交付客户端（与 Node policy 的 clientStatusCode 一致）。仅在 401/403 上
// 判定，与 Node 的策略判定同门。
func ObserveEdgeRejection(
	statusCode int,
	header http.Header,
	body []byte,
) (Classification, bool) {
	if statusCode != http.StatusUnauthorized && statusCode != http.StatusForbidden {
		return Classification{}, false
	}
	if !isEdgeBlockedResponse(header, body) && !isEdgeGatewayFormatRejection(header, body) {
		return Classification{}, false
	}
	classification, err := NewClassification(runtimecore.FailureUpstreamEdgeRejected, 0)
	if err != nil {
		return Classification{}, false
	}
	return classification, true
}

// ObserveEdgeRejectionResponse 是 *http.Response 级入口，供 Provider Observer 共用。
//
// 只在 401/403 上有界预读正文，并把同一份字节回放给后续解析（保留原始 Closer），
// 因此观察器的后续解析与「没有预读」逐字节等价。
func ObserveEdgeRejectionResponse(response *http.Response) (Classification, bool) {
	if response == nil || response.Body == nil {
		return Classification{}, false
	}
	if response.StatusCode != http.StatusUnauthorized && response.StatusCode != http.StatusForbidden {
		return Classification{}, false
	}
	original := response.Body
	payload, readErr := io.ReadAll(io.LimitReader(original, MaxErrorPayloadBytes+1))
	response.Body = &replayBody{
		Reader: io.MultiReader(bytes.NewReader(payload), original),
		Closer: original,
	}
	if readErr != nil {
		return Classification{}, false
	}
	return ObserveEdgeRejection(response.StatusCode, response.Header, payload)
}

// replayBody 让「预读后回放」不丢原始 Closer：先交付已读字节，再继续原始流。
type replayBody struct {
	io.Reader
	io.Closer
}

// isEdgeBlockedResponse 镜像 Node isEdgeBlockedResponse：WAF/CDN 拦截页。
func isEdgeBlockedResponse(header http.Header, body []byte) bool {
	if strings.TrimSpace(headerValue(header, "cf-mitigated")) != "" {
		return true
	}
	trimmed := strings.TrimSpace(string(body))
	lowered := strings.ToLower(firstBytes(trimmed, edgeHTMLScanBytes))
	htmlBody := strings.HasPrefix(lowered, "<!doctype html") ||
		strings.HasPrefix(lowered, "<html")
	contentType := strings.ToLower(strings.TrimSpace(headerValue(header, "content-type")))
	return htmlBody ||
		(strings.HasPrefix(contentType, "text/html") && !strings.HasPrefix(trimmed, "{"))
}

// isEdgeGatewayFormatRejection 镜像 Node isEdgeGatewayFormatRejection：APISIX 请求格式拒绝。
func isEdgeGatewayFormatRejection(header http.Header, body []byte) bool {
	if !strings.Contains(strings.ToLower(headerValue(header, "server")), "apisix") {
		return false
	}
	trimmed := strings.TrimSpace(string(body))
	if !strings.HasPrefix(trimmed, "{") {
		return false
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &envelope); err != nil {
		return false
	}
	if len(envelope) != 1 {
		return false
	}
	rawMessage, found := envelope["message"]
	if !found {
		return false
	}
	var message string
	if err := json.Unmarshal(rawMessage, &message); err != nil {
		return false
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return false
	}
	return !mentionsCredentialSemantics(message)
}

// mentionsCredentialSemantics 判断边缘文案是否在谈凭据（命中即仍按凭据问题处理）。
func mentionsCredentialSemantics(message string) bool {
	normalized := strings.ToLower(message)
	normalized = strings.NewReplacer(" ", "", "-", "", "_", "", "\t", "").Replace(normalized)
	for _, marker := range edgeCredentialMessageMarkers {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

// headerValue 读取同名 Header；http.Header.Get 本身对大小写不敏感。
func headerValue(header http.Header, name string) string {
	if header == nil {
		return ""
	}
	return header.Get(name)
}

// firstBytes 截取前 n 个字节；只用于 ASCII 前缀判定，允许切断多字节字符。
func firstBytes(value string, n int) string {
	if len(value) <= n {
		return value
	}
	return value[:n]
}
