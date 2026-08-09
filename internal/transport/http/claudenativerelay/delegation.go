package claudenativerelay

import (
	"bytes"
	"io"
	"net/http"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// relayContractSatisfied 静默判断请求能否走透传。
//
// 与 validRelayRequest 的区别是不写响应：无租约调用方不满足合同时应交回
// Canonical，而不是收到一个透传通道的错误——它可能压根没打算用透传。
func relayContractSatisfied(request *http.Request) bool {
	if request == nil || request.URL == nil || request.URL.Path != Path {
		return false
	}
	if request.Method != http.MethodPost {
		return false
	}
	if request.URL.ForceQuery ||
		request.URL.RawQuery != "" && request.URL.RawQuery != nativeBetaQuery {
		return false
	}
	if request.Body == nil ||
		request.ContentLength <= 0 ||
		request.ContentLength > MaxRequestBodyBytes {
		return false
	}
	mediaType := strings.TrimSpace(request.Header.Get("Content-Type"))
	return mediaType == "" || strings.HasPrefix(mediaType, "application/json")
}

// delegate 把请求交给 Canonical 入口，并恢复可能已被读走的正文。
//
// body 为空表示正文尚未被消费，此时保持原样；否则用已读内容重放，避免下游
// 读到空请求体。
func (handler *Handler) delegate(
	response http.ResponseWriter,
	request *http.Request,
	body []byte,
) {
	handler.delegatePinned(response, request, body, "")
}

// delegatePinned 交回 Canonical，并可指定必须使用的账号。
//
// 调度已经选中账号却因凭据不适配无法透传时，必须把这个选择一并交过去：
// 让 Canonical 重新征召会额外消耗一次公平计数，多账号轮转随之偏斜。
func (handler *Handler) delegatePinned(
	response http.ResponseWriter,
	request *http.Request,
	body []byte,
	accountRef accountcore.AccountRef,
) {
	if handler.fallback == nil {
		writeRelayError(
			response,
			http.StatusServiceUnavailable,
			"relay_unavailable",
			"Claude Native Relay 当前不可用",
		)
		return
	}
	if body != nil {
		request.Body = io.NopCloser(bytes.NewReader(body))
		request.ContentLength = int64(len(body))
	}
	if accountRef != "" {
		request.Header.Set(inferenceapi.AccountRefHeader, string(accountRef))
	}
	handler.fallback.ServeHTTP(response, request)
}
