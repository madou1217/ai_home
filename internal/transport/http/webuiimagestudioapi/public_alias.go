package webuiimagestudioapi

import (
	"net/http"
	"strings"
)

// PublicPath 是浏览器使用的 WebUI 数据面前缀。
//
// 同一能力在管理面挂在 Path 下（Node 旧的薄代理走的就是它）；迁移后浏览器
// 直接打 /v0/webui/*，Go 用同一个 Handler 应答，不再需要 Node 做前缀改写与转发。
const PublicPath = "/v0/webui/studio/image"

// NewPublicAlias 把 PublicPath 前缀重写到管理前缀后交给同一个 Handler。
//
// 只改路径与 RawPath，查询串原样保留；鉴权仍由 Handler 自己的 Management Key
// 校验器执行（与 Node 的 /v0 门行为一致：Bearer + 常量时间比较）。
func NewPublicAlias(handler http.Handler) http.Handler {
	if handler == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeStudioError(w, http.StatusServiceUnavailable, "image_studio_unavailable", "image Studio service is unavailable")
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := r.Clone(r.Context())
		request.URL.Path = Path + strings.TrimPrefix(r.URL.Path, PublicPath)
		if r.URL.RawPath != "" {
			request.URL.RawPath = Path + strings.TrimPrefix(r.URL.RawPath, PublicPath)
		}
		handler.ServeHTTP(w, request)
	})
}
