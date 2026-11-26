package clientauth

// 本文件提供推理入口统一的"鉴权 + 身份/统计注入"入口。
//
// 各 handler 原本只调用 authorizer.Authorized(request) 拿布尔值；现在需要同时
// 拿到调用方身份和请求统计作用域，且要兼容旧测试桩（只实现 Authorized）。

import (
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/clientkeystats"
	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
)

// Authenticator 是带身份返回的鉴权端口。
type Authenticator interface {
	Authenticate(request *http.Request) (coreclientkeys.Identity, bool)
}

// Authorize 校验请求并把身份与统计作用域写入返回的请求上下文。
//
// 返回的 *http.Request 必须替代原 request 继续向下传递，否则下游拿不到身份。
// 旧桩只实现 Authorized 时按总 key 处理，scope 为空。
func Authorize(
	authorizer interface{ Authorized(*http.Request) bool },
	request *http.Request,
	surface string,
) (coreclientkeys.Identity, *http.Request, *clientkeystats.RequestScope, bool) {
	if authorizer == nil || request == nil {
		return coreclientkeys.Identity{}, request, nil, false
	}
	authenticator, ok := authorizer.(Authenticator)
	if !ok {
		if !authorizer.Authorized(request) {
			return coreclientkeys.Identity{}, request, nil, false
		}
		identity := coreclientkeys.MasterIdentity()
		ctx := coreclientkeys.WithIdentity(request.Context(), identity)
		return identity, request.Clone(ctx), nil, true
	}
	identity, authorized := authenticator.Authenticate(request)
	if !authorized {
		return coreclientkeys.Identity{}, request, nil, false
	}
	var scope *clientkeystats.RequestScope
	if scoper, ok := authenticator.(interface {
		BeginRequest(coreclientkeys.Identity, string) *clientkeystats.RequestScope
	}); ok {
		scope = scoper.BeginRequest(identity, surface)
	}
	ctx := coreclientkeys.WithIdentity(request.Context(), identity)
	if !identity.Master {
		if limitsSource, ok := authenticator.(interface {
			Limits(string) (coreclientkeys.Limits, bool)
		}); ok {
			if limits, found := limitsSource.Limits(identity.KeyID); found {
				ctx = coreclientkeys.WithLimits(ctx, limits)
			}
		}
	}
	if scope != nil {
		ctx = clientkeystats.WithScope(ctx, scope)
	}
	return identity, request.Clone(ctx), scope, true
}

// FinishScope 供入口在请求结束时统一收尾：上下文已取消视为中断。
func FinishScope(scope *clientkeystats.RequestScope, request *http.Request) {
	if scope == nil {
		return
	}
	aborted := false
	if request != nil && request.Context() != nil {
		aborted = request.Context().Err() != nil
	}
	scope.Finish(aborted)
}

// Middleware 对带客户端 Key 的请求注入身份与统计作用域。
//
// 不做拒绝：各 handler 仍按自己的错误形状返回 401；这里只在鉴权成功时把
// 身份/作用域放进上下文，失败则原样放行。这样不用改 12 个 handler，
// 也不会把管理面请求误计为客户端请求。
func (authorizer *Authorizer) Middleware(next http.Handler) http.Handler {
	if authorizer == nil || next == nil {
		return next
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		surface := SurfaceForPath(request.URL.Path)
		if _, decorated, scope, ok := Authorize(authorizer, request, surface); ok {
			defer FinishScope(scope, decorated)
			next.ServeHTTP(response, decorated)
			return
		}
		next.ServeHTTP(response, request)
	})
}

// SurfaceForPath 把推理入口路径归一到稳定的 surface 标签。
func SurfaceForPath(path string) string {
	trimmed := path
	switch {
	case strings.HasPrefix(trimmed, "/v1/responses"):
		return "responses"
	case strings.HasPrefix(trimmed, "/v1/chat/completions"):
		return "chat"
	case strings.HasPrefix(trimmed, "/api/paas/v4/chat/completions"):
		return "chat"
	case strings.HasPrefix(trimmed, "/api/v3/chat/completions"):
		return "chat"
	case strings.HasPrefix(trimmed, "/v1/messages"):
		return "messages"
	case strings.HasPrefix(trimmed, "/v1beta/"):
		return "gemini"
	case strings.HasPrefix(trimmed, "/v1/images/"):
		return "images"
	case strings.HasPrefix(trimmed, "/v1/models"):
		return "models"
	case strings.HasPrefix(trimmed, "/v1/blobs"):
		return "blobs"
	case strings.HasPrefix(trimmed, "/v0/codex/app-server"):
		return "codex-app-server"
	default:
		return "http"
	}
}
