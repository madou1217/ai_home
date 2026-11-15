package webuiauth

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

type viaContextKey struct{}

func withAuthVia(ctx context.Context, via string) context.Context {
	return context.WithValue(ctx, viaContextKey{}, via)
}

// ViaFromContext 读取外层鉴权门记录在请求上下文中的放行来源（如 loopback_bootstrap / loopback）。
func ViaFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	via, _ := ctx.Value(viaContextKey{}).(string)
	return via
}

// IsLoopbackBootstrap 判断请求是否已通过外层 WebUI 鉴权门的本机引导窄口放行。
func IsLoopbackBootstrap(request *http.Request) bool {
	return request != nil && ViaFromContext(request.Context()) == ViaLoopbackBootstrap
}

// IsLoopbackManagement 判断请求是否已通过 /v0/management 的「未配密钥时本机回环」规则放行。
func IsLoopbackManagement(request *http.Request) bool {
	return request != nil && ViaFromContext(request.Context()) == ViaLoopback
}

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
		ctx := withAuthVia(request.Context(), result.Via)
		if result.Via == ViaManagementKey {
			next.ServeHTTP(response, request.WithContext(ctx))
			return
		}
		// 回环例外通过：下游仍需 Bearer，若当前配置了有效密钥则注入，未配置时保留上下文标记交由下游按语义处理。
		cloned := request.Clone(ctx)
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			cloned.Header.Set("Authorization", "Bearer "+trimmed)
		}
		next.ServeHTTP(response, cloned)
	})
}

// RequireManagementKeyOrLoopback 包装 /v0/management/* 公开管理路由：
// 对齐 Node management-router.js 的鉴权语义（配置了密钥时严格要求 Bearer，返回 401 unauthorized_management；
// 未配置密钥时仅允许本机直连回环访问，远端返回 503 management_key_not_configured）。
func RequireManagementKeyOrLoopback(requiredKey func() string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		key := ""
		if requiredKey != nil {
			key = requiredKey()
		}
		result := AuthorizeManagementKeyOrLoopback(request, key)
		if !result.OK {
			response.Header().Set("Cache-Control", "no-store")
			response.Header().Set("Content-Type", "application/json; charset=utf-8")
			if result.StatusCode == http.StatusUnauthorized {
				response.Header().Set("WWW-Authenticate", "Bearer")
			}
			response.WriteHeader(result.StatusCode)
			_ = json.NewEncoder(response).Encode(map[string]any{
				"ok":    false,
				"error": result.Reason,
			})
			return
		}
		if next == nil {
			http.NotFound(response, request)
			return
		}
		ctx := withAuthVia(request.Context(), result.Via)
		if result.Via == ViaManagementKey {
			next.ServeHTTP(response, request.WithContext(ctx))
			return
		}
		cloned := request.Clone(ctx)
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			cloned.Header.Set("Authorization", "Bearer "+trimmed)
		}
		next.ServeHTTP(response, cloned)
	})
}
