package inferenceapi

import (
	"net/http"
	"strings"
)

// ProviderHeader 是客户端显式选择 Provider 的请求头（历史 Node 语义）。
const ProviderHeader = "X-Provider"

// ProviderHint 读取并归一化显式 Provider 选择；空串/auto 表示不限制。
func ProviderHint(request *http.Request) string {
	if request == nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(request.Header.Get(ProviderHeader)))
}
