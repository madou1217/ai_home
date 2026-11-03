package claudenativerelay

import (
	"encoding/json"
	"net/http"
)

// relayErrorDocument 是 Native Relay 自身错误的稳定低敏结构。
type relayErrorDocument struct {
	Error relayErrorView `json:"error"`
}

// relayErrorView 只暴露固定错误码和安全消息。
type relayErrorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeRelayError 写入不会与上游 Anthropic 错误混淆的本地响应。
func writeRelayError(
	response http.ResponseWriter,
	status int,
	code string,
	message string,
) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(relayErrorDocument{
		Error: relayErrorView{
			Code:    code,
			Message: message,
		},
	})
}
