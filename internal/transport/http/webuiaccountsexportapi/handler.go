// Package webuiaccountsexportapi 提供账号页的集合导出契约。
//
// 与 accountsapi 的分工：accountsapi 的 /v1/management/accounts/export/aih-accounts 是
// CLI 与 Node 同步用的管理面入口；本包是 WebUI 路径
// (GET /v1/management/webui/accounts/export) 的薄适配层，复用同一份导出文档服务
// (accountsapi.ExportAccountCollection)，只在协议层补上 WebUI 的鉴权与错误 envelope。
package webuiaccountsexportapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// Path 是账号集合导出的 WebUI 契约路径。
//
//	GET /v1/management/webui/accounts/export?provider=&accountRef=
const Path = "/v1/management/webui/accounts/export"

// FileName 是下载附件名；与 CLI 入口同名，导入端不需要按入口分支。
const FileName = "aih-accounts.json"

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或导出数据源。
var ErrInvalidDependencies = errors.New("账号导出接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与 accountsapi / webuiaccountsapi 共用）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总账号导出的最小依赖。
//
// Overviews 只要求「列账号」一个能力，而不是整个 accountsapi.Management：
// 导出只需要账号事实与凭据快照，装配面越小越不容易把管理面写能力带进来。
type Dependencies struct {
	Authorizer  Authorizer
	Overviews   accountsapi.OverviewLister
	Credentials accountsapi.CredentialSnapshotReader
	// Resolver 是 Node→Go 账号引用的翻译器；零值等价于「未启用同步」的恒等翻译。
	Resolver accountrefmap.Resolver
}

// Handler 是账号集合导出的 HTTP 入站适配器。
type Handler struct {
	authorizer  Authorizer
	overviews   accountsapi.OverviewLister
	credentials accountsapi.CredentialSnapshotReader
	resolver    accountrefmap.Resolver
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		dependencies.Overviews == nil ||
		dependencies.Credentials == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		overviews:   dependencies.Overviews,
		credentials: dependencies.Credentials,
		resolver:    dependencies.Resolver,
	}, nil
}

// ServeHTTP 输出满足 provider / accountRef 过滤的 aih-accounts 附件。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil ||
		handler.overviews == nil || handler.credentials == nil {
		writeError(response, http.StatusServiceUnavailable, "webui_accounts_export_unavailable", "账号导出不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持读取出账号导出")
		return
	}
	query, err := handler.translateExportQuery(request.URL.Query())
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_export_query", "导出过滤参数无效")
		return
	}
	filters, err := accountsapi.ParseExportFilters(query.values)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_export_query", "导出过滤参数无效")
		return
	}
	result, err := accountsapi.ExportAccountCollection(
		request.Context(),
		handler.overviews,
		handler.credentials,
		filters,
	)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "webui_accounts_export_failed", "账号导出失败")
		return
	}
	// 指定了 accountRef 却一个都没导出：与 Node 入口一致回 404，而不是空集合 200。
	if query.hasRefs && result.Exported == 0 {
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Content-Disposition", `attachment; filename="`+FileName+`"`)
	response.Header().Set("X-AIH-Exported-Accounts", strconv.Itoa(result.Exported))
	response.Header().Set("X-AIH-Skipped-Accounts", strconv.Itoa(result.Skipped))
	// node-only 只在数据可解释时给出：过滤会移出集合成员、跳过的账号也不在文档里，
	// 两种情况都会把已存在的 Go 账号误算成 Node-only，宁可不发也不发错数。
	if links := handler.resolverLinks(); links != nil &&
		!query.hasProviders && !query.hasRefs && result.Skipped == 0 {
		if count, ok := nodeOnlyAccounts(links, result.Document); ok {
			response.Header().Set(NodeOnlyAccountsHeader, strconv.Itoa(count))
		}
	}
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(result.Document)
	_, _ = response.Write([]byte{'\n'})
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
