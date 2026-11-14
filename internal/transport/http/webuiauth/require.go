package webuiauth

import (
	"encoding/json"
	"net/http"
)

// RequireManagementKey 包装公开 WebUI 处理器：先按 Node 同款门鉴权，
// 通过后把 Management Key 注入 Bearer 再交给下游（下游按管理面鉴权）。
func RequireManagementKey(requiredKey func() string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		key := ""
		if requiredKey != nil {
			key = requiredKey()
		}
		result := Authorize(request, key)
		if !result.OK {
			response.Header().Set("Cache-Control", "no-store")
			response.Header().Set("Content-Type", "application/json; charset=utf-8")
			response.WriteHeader(result.StatusCode)
			_ = json.NewEncoder(response).Encode(map[string]any{
				"ok":     false,
				"error":  "webui_unauthorized",
				"reason": result.Reason,
			})
			return
		}
		if next == nil {
			http.NotFound(response, request)
			return
		}
		if result.Via == "management_key" {
			next.ServeHTTP(response, request)
			return
		}
		// 回环例外通过：下游仍需 Bearer，注入本次生效的 Key。
		cloned := request.Clone(request.Context())
		cloned.Header.Set("Authorization", "Bearer "+key)
		next.ServeHTTP(response, cloned)
	})
}
