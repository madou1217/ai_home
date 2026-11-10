// Package webuiaccountimportapi 提供账号页的 aih-accounts 导入契约。
//
// 与 accountsapi 的分工：accountsapi 的 POST /v1/management/account-imports/aih-accounts
// 是 CLI 与 Node 同步用的管理面入口；本包是 WebUI 路径
// (POST /v1/management/webui/accounts/import) 的薄适配层。
//
// 导入是有状态的写操作，文档结构、单条失败不影响其余条目、summary 计数都由
// accountsapi 的实现负责；本包只补 WebUI 的鉴权、方法与错误 envelope，然后把请求
// 交给同一个导入端点，因此两侧的 DTO 与逐账号结果形状天然一致。
package webuiaccountimportapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// Path 是账号导入的 WebUI 契约路径。
//
//	POST /v1/management/webui/accounts/import
const Path = "/v1/management/webui/accounts/import"

// upstreamPath 是复用的 accountsapi 导入端点。
//
// 由 accountsapi 的公开路径常量派生，而不是抄一份字面量：两个包对写死的路径
// 同时变更时本包会跟着对齐，不会静默转发到不存在的路由。
const upstreamPath = accountsapi.NativeImportPath + "/aih-accounts"

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或导入端点。
var ErrInvalidDependencies = errors.New("账号导入接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 管理接口共用）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// ImportEndpoint 是 aih-accounts 导入服务。
//
// accountsapi 的账号 Handler 即实现：它按 URL 路径分发到 aih-accounts 导入逻辑，
// 并输出 {ok, summary, accounts:[{provider, accountRef, status, reason}]}。
// 这里只声明 ServeHTTP，装配面不会因为复用而把管理面写能力暴露给本包。
type ImportEndpoint interface {
	ServeHTTP(response http.ResponseWriter, request *http.Request)
}

// Dependencies 汇总账号导入的最小依赖。
type Dependencies struct {
	Authorizer Authorizer
	Import     ImportEndpoint
}

// Handler 是账号导入的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	imports    ImportEndpoint
}

// NewHandler 校验依赖并创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Import == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		imports:    dependencies.Import,
	}, nil
}

// ServeHTTP 把 WebUI 导入请求交给 accountsapi 的 aih-accounts 导入端点。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.imports == nil {
		writeError(response, http.StatusServiceUnavailable, "webui_accounts_import_unavailable", "账号导入不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持导入账号")
		return
	}
	handler.imports.ServeHTTP(response, importRequest(request))
}

// importRequest 复制请求并改写到 accountsapi 的导入路径。
//
// 复制而不是原地改：入站请求在返回后仍可能被中间件或访问日志读取，改写它的
// URL 会把 WebUI 路径伪装成管理面路径。RequestURI 是服务端字段，转发时清空，
// 避免下游把它当成需要重新解析的原始行。
func importRequest(request *http.Request) *http.Request {
	forwarded := request.Clone(request.Context())
	forwarded.URL.Path = upstreamPath
	forwarded.RequestURI = ""
	return forwarded
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorResponse struct {
	OK    bool      `json:"ok"`
	Error errorBody `json:"error"`
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(errorResponse{
		OK:    false,
		Error: errorBody{Code: code, Message: message},
	})
}
