// Package accountsapi 提供 Go 账号应用层的版本化 HTTP 入站适配器。
//
// 该包只负责鉴权、路由、DTO、HTTP 错误和应用用例调用，不打开数据库、不处理 OAuth、
// 不读取凭据内容，也不依赖 Node Server 或 WebUI。
package accountsapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// CollectionPath 是账号管理 v1 集合资源的规范路径。
	CollectionPath = "/v1/management/accounts"
	apiMaxPageSize = accountapp.MaxOverviewLimit - 1
)

// ErrInvalidDependencies 表示 Handler 缺少应用服务、凭据工厂或鉴权策略。
var ErrInvalidDependencies = errors.New("账号 HTTP Handler 依赖无效")

// Management 是 HTTP 查询和启停命令依赖的最小应用端口。
type Management interface {
	ListAccountOverviews(
		ctx context.Context,
		query accountapp.OverviewQuery,
	) ([]accountapp.AccountOverview, error)
	GetAccountOverview(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.AccountOverview, error)
	SetAccountEnabled(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		enabled bool,
	) (accountcore.Account, error)
}

// Registrar 是 HTTP API Key 创建入口依赖的最小注册端口。
type Registrar interface {
	Register(
		ctx context.Context,
		credential accountapp.Credential,
		profile accountapp.PublicProfile,
	) (accountcore.Account, error)
}

// Dependencies 集中声明账号 HTTP 入站适配器的依赖。
type Dependencies struct {
	Management Management
	Registrar  Registrar
	APIKeys    APIKeyCredentialFactory
	Authorizer Authorizer
}

// Handler 是可挂载到未来 Go Server Composition Root 的账号管理路由。
type Handler struct {
	management Management
	registrar  Registrar
	apiKeys    APIKeyCredentialFactory
	authorizer Authorizer
}

// NewHandler 创建依赖完整且默认失败关闭的账号 HTTP Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Management == nil ||
		dependencies.Registrar == nil ||
		dependencies.APIKeys == nil ||
		dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		management: dependencies.Management,
		registrar:  dependencies.Registrar,
		apiKeys:    dependencies.APIKeys,
		authorizer: dependencies.Authorizer,
	}, nil
}

// ServeHTTP 先完成管理鉴权，再按集合或成员资源分发请求。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil ||
		handler.authorizer == nil ||
		!handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeAPIError(
			response,
			http.StatusUnauthorized,
			"unauthorized",
			"需要有效的 Management Key",
		)
		return
	}
	switch {
	case request.URL.Path == CollectionPath:
		handler.handleCollection(response, request)
	case strings.HasPrefix(request.URL.Path, CollectionPath+"/"):
		handler.handleMember(response, request)
	default:
		writeAPIError(
			response,
			http.StatusNotFound,
			"route_not_found",
			"请求的账号资源不存在",
		)
	}
}

// handleCollection 分发账号列表和创建操作。
func (handler *Handler) handleCollection(
	response http.ResponseWriter,
	request *http.Request,
) {
	switch request.Method {
	case http.MethodGet:
		handler.listAccounts(response, request)
	case http.MethodPost:
		handler.createAccount(response, request)
	default:
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeMethodNotAllowed(response)
	}
}

// handleMember 校验 AccountRef 后分发详情和局部更新操作。
func (handler *Handler) handleMember(
	response http.ResponseWriter,
	request *http.Request,
) {
	accountRef, err := parseMemberAccountRef(request.URL.Path)
	if err != nil {
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_account_ref",
			"账号引用格式无效",
		)
		return
	}
	switch request.Method {
	case http.MethodGet:
		handler.getAccount(response, request, accountRef)
	case http.MethodPatch:
		handler.updateAccount(response, request, accountRef)
	default:
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPatch)
		writeMethodNotAllowed(response)
	}
}

// listAccounts 执行有界 keyset 查询并准确计算下一页。
func (handler *Handler) listAccounts(
	response http.ResponseWriter,
	request *http.Request,
) {
	query, visibleLimit, err := parseOverviewQuery(request)
	if err != nil {
		writeInvalidQuery(response)
		return
	}
	overviews, err := handler.management.ListAccountOverviews(
		request.Context(),
		query,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	hasMore := len(overviews) > visibleLimit
	if hasMore {
		overviews = overviews[:visibleLimit]
	}
	nextAfterRef := ""
	if hasMore && len(overviews) > 0 {
		nextAfterRef = overviews[len(overviews)-1].Account().Ref().String()
	}
	writeJSON(response, http.StatusOK, accountListResponse{
		Data: newAccountViews(overviews),
		Page: pageView{
			Limit:        visibleLimit,
			HasMore:      hasMore,
			NextAfterRef: nextAfterRef,
		},
	})
}

// getAccount 按稳定 AccountRef 返回单个公开管理投影。
func (handler *Handler) getAccount(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if rejectUnexpectedQuery(response, request) {
		return
	}
	overview, err := handler.management.GetAccountOverview(
		request.Context(),
		accountRef,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(
		response,
		http.StatusOK,
		accountResponse{Data: newAccountView(overview)},
	)
}

// createAccount 只接受 Codex、Claude API Key，并返回不含密钥的账号投影。
func (handler *Handler) createAccount(
	response http.ResponseWriter,
	request *http.Request,
) {
	if rejectUnexpectedQuery(response, request) {
		return
	}
	var input createAccountRequest
	if err := decodeJSONRequest(response, request, &input); err != nil {
		writeRequestDecodeError(response, err)
		return
	}
	if input.Auth.Kind != "api_key" {
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"unsupported_auth_kind",
			"当前接口只支持 API Key 注册",
		)
		return
	}
	credential, err := handler.apiKeys.Build(
		input.ProviderID,
		input.Auth.APIKey,
		input.Auth.BaseURL,
	)
	if err != nil {
		writeCredentialInputError(response, err)
		return
	}
	account, err := handler.registrar.Register(
		request.Context(),
		credential,
		nil,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:       account,
		HasCredential: true,
		AuthKind:      "api_key",
	})
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(
		response,
		http.StatusCreated,
		accountResponse{Data: newAccountView(overview)},
	)
}

// updateAccount 当前只允许幂等设置 enabled 字段。
func (handler *Handler) updateAccount(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if rejectUnexpectedQuery(response, request) {
		return
	}
	var input updateAccountRequest
	if err := decodeJSONRequest(response, request, &input); err != nil {
		writeRequestDecodeError(response, err)
		return
	}
	if input.Enabled == nil {
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_request",
			"enabled 字段必填",
		)
		return
	}
	if _, err := handler.management.SetAccountEnabled(
		request.Context(),
		accountRef,
		*input.Enabled,
	); err != nil {
		writeApplicationError(response, err)
		return
	}
	overview, err := handler.management.GetAccountOverview(
		request.Context(),
		accountRef,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(
		response,
		http.StatusOK,
		accountResponse{Data: newAccountView(overview)},
	)
}
