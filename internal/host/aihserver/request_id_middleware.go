package aihserver

import (
	"net/http"

	"github.com/madou1217/ai_home/core/requestid"
)

// withRequestID 为每个入站请求确定稳定的 Request ID。
//
// 客户端自带的合法 X-Request-Id 原样沿用（便于和调用方日志对齐），否则生成
// 新的 ID；无论成功、失败还是流式响应，ID 都会在响应头里交还给客户端。
// 同一个 ID 写入请求 Context，失败事件、429 等待事件与访问日志都从 Context 取。
func withRequestID(next http.Handler) http.Handler {
	if next == nil {
		return nil
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		id := requestid.Sanitize(request.Header.Get(requestid.HeaderName))
		if id == "" {
			id = requestid.New()
		}
		response.Header().Set(requestid.HeaderName, id)
		next.ServeHTTP(response, request.WithContext(requestid.WithContext(request.Context(), id)))
	})
}