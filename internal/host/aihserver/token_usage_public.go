package aihserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
)

// publicTokenUsageHandler 暴露浏览器调试入口：
//
//	GET /v0/webui/accounts/{provider}/{accountRef}/token-usage?source=go
//
// 与 Node 旧实现同语义：必须显式带 source=go（这是对拍调试入口，不是产品路径），
// 授权沿用管理面 Bearer；成功后把 Go 的原始文档包成 {ok:true, go:<doc>}。
func publicTokenUsageHandler(accounts http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if accounts == nil {
			writeSystemJSON(response, http.StatusServiceUnavailable, systemErrorResponse{
				Error: systemErrorView{Code: "token_usage_unavailable", Message: "账号用量服务不可用"},
			})
			return
		}
		if strings.TrimSpace(request.URL.Query().Get("source")) != "go" {
			writeSystemJSON(response, http.StatusBadRequest, map[string]any{
				"ok":      false,
				"error":   "source_required",
				"message": "这是对拍调试入口，必须显式带 ?source=go 才会返回 Go 的原始结果",
			})
			return
		}
		accountRef := strings.TrimSpace(request.PathValue("accountRef"))
		if accountRef == "" {
			writeSystemJSON(response, http.StatusBadRequest, map[string]any{
				"ok":    false,
				"error": "invalid_account_path",
			})
			return
		}
		cloned := request.Clone(request.Context())
		cloned.URL.Path = "/v1/management/accounts/" + accountRef + "/token-usage"
		cloned.URL.RawQuery = strings.ReplaceAll(request.URL.RawQuery, "source=go", "")
		cloned.URL.RawQuery = strings.Trim(cloned.URL.RawQuery, "&")
		recorder := httptest.NewRecorder()
		accounts.ServeHTTP(recorder, cloned)
		result := recorder.Result()
		defer func() { _ = result.Body.Close() }()
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("Content-Type", "application/json; charset=utf-8")
		if result.StatusCode < 200 || result.StatusCode >= 300 {
			response.WriteHeader(result.StatusCode)
			_, _ = response.Write(recorder.Body.Bytes())
			return
		}
		var document any
		if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
			response.WriteHeader(http.StatusBadGateway)
			_, _ = response.Write([]byte(`{"ok":false,"error":"go_token_usage_failed"}`))
			return
		}
		response.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(response).Encode(map[string]any{"ok": true, "go": document})
	})
}
