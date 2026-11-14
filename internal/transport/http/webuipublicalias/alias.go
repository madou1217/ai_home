// Package webuipublicalias 把浏览器数据面前缀（/v0/webui/*）映射到 Go 的管理前缀。
//
// WebUI 的浏览器路由与 Go 管理路由是同一份能力的两套前缀：迁移时 Go 直接接住
// /v0/webui/*，用一次路径重写复用既有处理器，避免 Node 再做一层前缀改写与转发。
package webuipublicalias

import (
	"net/http"
	"strings"
)

// Rewrite 返回把 from 前缀替换成 to 前缀的处理器；from 必须是非空且以 "/" 开头。
//
// 只改路径与 RawPath，查询串、方法与请求体原样保留；to/from 不匹配时保持原路径，
// 由目标处理器按自己的路由表返回 404。
func Rewrite(from, to string, handler http.Handler) http.Handler {
	trimmedFrom := strings.TrimSuffix(from, "/")
	trimmedTo := strings.TrimSuffix(to, "/")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if handler == nil {
			http.NotFound(w, r)
			return
		}
		request := r.Clone(r.Context())
		if strings.HasPrefix(r.URL.Path, trimmedFrom) {
			request.URL.Path = trimmedTo + strings.TrimPrefix(r.URL.Path, trimmedFrom)
		}
		if r.URL.RawPath != "" && strings.HasPrefix(r.URL.RawPath, trimmedFrom) {
			request.URL.RawPath = trimmedTo + strings.TrimPrefix(r.URL.RawPath, trimmedFrom)
		}
		handler.ServeHTTP(w, request)
	})
}
