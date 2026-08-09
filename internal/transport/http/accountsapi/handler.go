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
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

const (
	// CollectionPath 是账号管理 v1 集合资源的规范路径。
	CollectionPath = accountcontract.AccountsPath
	// AliasesPath 是 Provider 数字别名只读解析资源的规范集合前缀。
	AliasesPath = accountcontract.AccountAliasesPath
	// NativeImportPath 是 Codex、Claude 官方 artifact 导入资源的规范路径。
	NativeImportPath = "/v1/management/account-imports"
	// Sub2APIImportPath 是单账号 sub2api 迁移文档导入资源的规范路径。
	Sub2APIImportPath = "/v1/management/account-imports/sub2api"
	// DefaultsPath 是 Provider 默认启动账号资源的规范集合前缀。
	DefaultsPath = "/v1/management/account-defaults"
	// SelectionPath 是启动账号解析命令的规范路径。
	SelectionPath  = "/v1/management/account-selections/resolve"
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
	GetAccountOverviewByCLIAccountID(
		ctx context.Context,
		providerID string,
		cliAccountID accountcore.CLIAccountID,
	) (accountapp.AccountOverview, error)
	SetAccountEnabled(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		enabled bool,
	) (accountcore.Account, error)
}

// ModelManagement 是账号模型子资源依赖的最小查询和命令端口。
type ModelManagement interface {
	ListAccountModels(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) ([]accountapp.AccountModel, error)
	SetManualModelPolicy(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		modelID string,
		policy accountapp.ModelManualPolicy,
	) ([]accountapp.AccountModel, error)
	RefreshAccountModels(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) ([]accountapp.AccountModel, error)
}

// UsageManagement 是账号额度子资源依赖的离线读取和显式刷新端口。
type UsageManagement interface {
	GetUsage(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (usageapp.ReadResult, error)
	RefreshUsage(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (usageapp.ReadResult, error)
}

// AccountDeletion 是账号成员资源依赖的独立删除用例端口。
type AccountDeletion interface {
	DeleteAccount(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) error
}

// ProviderDefaultManagement 是默认启动账号资源依赖的独立应用端口。
type ProviderDefaultManagement interface {
	Get(
		ctx context.Context,
		providerID string,
	) (accountcore.ProviderDefault, error)
	Set(
		ctx context.Context,
		providerID string,
		accountRef accountcore.AccountRef,
	) (accountcore.ProviderDefault, error)
	Clear(ctx context.Context, providerID string) error
}

// LaunchAccountSelection 是 Provider CLI 启动账号解析依赖的应用端口。
type LaunchAccountSelection interface {
	Resolve(
		ctx context.Context,
		request accountapp.LaunchSelectionRequest,
	) (accountapp.LaunchSelection, error)
}

// StaticCredentialRotation 是静态凭据子资源依赖的原地轮换用例端口。
type StaticCredentialRotation interface {
	Rotate(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		replacement accountapp.Credential,
	) (accountcore.Account, error)
}

// AccountExporter 是账号成员导出资源依赖的单账号 JSON 输出端口。
type AccountExporter interface {
	// ExportAccount 返回一个账号在目标外部合同中的完整文档。
	ExportAccount(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) ([]byte, error)
}

// Registrar 是 HTTP API Key 创建入口依赖的最小注册端口。
type Registrar interface {
	Register(
		ctx context.Context,
		credential accountapp.Credential,
		profile accountapp.PublicProfile,
	) (accountcore.Account, error)
}

// NativeAccountDecoder 是 HTTP 导入入口依赖的 Provider 官方 artifact 反腐端口。
type NativeAccountDecoder interface {
	Supports(providerID string) bool
	Decode(
		providerID string,
		artifactsJSON []byte,
	) (accountapp.Credential, accountapp.PublicProfile, error)
}

// Sub2APIAccountDecoder 是标准迁移 JSON 导入依赖的最小反腐端口。
type Sub2APIAccountDecoder interface {
	DecodeAccount(
		documentJSON []byte,
	) (accountapp.Credential, accountapp.PublicProfile, error)
}

// Dependencies 集中声明账号 HTTP 入站适配器的依赖。
type Dependencies struct {
	Management          Management
	Models              ModelManagement
	Usage               UsageManagement
	Deletion            AccountDeletion
	Defaults            ProviderDefaultManagement
	Selections          LaunchAccountSelection
	CredentialRotation  StaticCredentialRotation
	Sub2APIExporter     AccountExporter
	CLIProxyAPIExporter AccountExporter
	Registrar           Registrar
	APIKeys             APIKeyCredentialFactory
	StaticCredentials   StaticCredentialFactory
	NativeAccounts      NativeAccountDecoder
	Sub2APIAccounts     Sub2APIAccountDecoder
	Authorizer          Authorizer
}

// Handler 是可挂载到未来 Go Server Composition Root 的账号管理路由。
type Handler struct {
	management          Management
	models              ModelManagement
	usage               UsageManagement
	deletion            AccountDeletion
	defaults            ProviderDefaultManagement
	selections          LaunchAccountSelection
	credentialRotation  StaticCredentialRotation
	sub2apiExporter     AccountExporter
	cliProxyAPIExporter AccountExporter
	registrar           Registrar
	apiKeys             APIKeyCredentialFactory
	staticCredentials   StaticCredentialFactory
	native              NativeAccountDecoder
	sub2api             Sub2APIAccountDecoder
	authorizer          Authorizer
}

// NewHandler 创建依赖完整且默认失败关闭的账号 HTTP Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Management == nil ||
		dependencies.Models == nil ||
		dependencies.Usage == nil ||
		dependencies.Deletion == nil ||
		dependencies.Defaults == nil ||
		dependencies.Selections == nil ||
		dependencies.CredentialRotation == nil ||
		dependencies.Sub2APIExporter == nil ||
		dependencies.CLIProxyAPIExporter == nil ||
		dependencies.Registrar == nil ||
		dependencies.APIKeys == nil ||
		dependencies.StaticCredentials == nil ||
		dependencies.NativeAccounts == nil ||
		dependencies.Sub2APIAccounts == nil ||
		dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		management:          dependencies.Management,
		models:              dependencies.Models,
		usage:               dependencies.Usage,
		deletion:            dependencies.Deletion,
		defaults:            dependencies.Defaults,
		selections:          dependencies.Selections,
		credentialRotation:  dependencies.CredentialRotation,
		sub2apiExporter:     dependencies.Sub2APIExporter,
		cliProxyAPIExporter: dependencies.CLIProxyAPIExporter,
		registrar:           dependencies.Registrar,
		apiKeys:             dependencies.APIKeys,
		staticCredentials:   dependencies.StaticCredentials,
		native:              dependencies.NativeAccounts,
		sub2api:             dependencies.Sub2APIAccounts,
		authorizer:          dependencies.Authorizer,
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
	case request.URL.Path == Sub2APIImportPath:
		handler.handleSub2APIImport(response, request)
	case request.URL.Path == NativeImportPath:
		handler.handleNativeImport(response, request)
	case request.URL.Path == CollectionPath:
		handler.handleCollection(response, request)
	case strings.HasPrefix(request.URL.Path, AliasesPath+"/"):
		handler.handleAccountAlias(response, request)
	case request.URL.Path == SelectionPath:
		handler.handleLaunchSelection(response, request)
	case strings.HasPrefix(request.URL.Path, DefaultsPath+"/"):
		handler.handleProviderDefault(response, request)
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
	resource, err := parseMemberResource(request.URL.Path)
	if err != nil {
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_account_ref",
			"账号引用格式无效",
		)
		return
	}
	accountRef := resource.accountRef
	switch resource.kind {
	case memberResourceAccount:
		handler.handleAccountMember(response, request, accountRef)
	case memberResourceCredential:
		handler.handleAccountCredential(response, request, accountRef)
	case memberResourceModels:
		handler.handleAccountModels(response, request, accountRef)
	case memberResourceModelRefresh:
		handler.handleAccountModelRefresh(response, request, accountRef)
	case memberResourceUsage:
		handler.handleAccountUsage(response, request, accountRef)
	case memberResourceUsageRefresh:
		handler.handleAccountUsageRefresh(response, request, accountRef)
	case memberResourceExport:
		handler.handleAccountExport(
			response,
			request,
			accountRef,
			handler.sub2apiExporter,
			"sub2api-data.json",
		)
	case memberResourceCLIProxyAPIExport:
		handler.handleAccountExport(
			response,
			request,
			accountRef,
			handler.cliProxyAPIExporter,
			"cliproxyapi-auth.json",
		)
	default:
		writeAPIError(
			response,
			http.StatusNotFound,
			"route_not_found",
			"请求的账号资源不存在",
		)
	}
}

// handleAccountCredential 使用完整 PUT 语义轮换静态凭据并返回同一账号投影。
func (handler *Handler) handleAccountCredential(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if request.Method != http.MethodPut {
		response.Header().Set("Allow", http.MethodPut)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) {
		return
	}
	var input updateCredentialRequest
	if err := decodeJSONRequest(response, request, &input); err != nil {
		writeRequestDecodeError(response, err)
		return
	}
	current, err := handler.management.GetAccountOverview(
		request.Context(),
		accountRef,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	credential, err := handler.staticCredentials.BuildStatic(
		current.Account().ProviderID(),
		input.Auth.Kind,
		input.Auth.APIKey,
		input.Auth.AuthToken,
		input.Auth.BaseURL,
	)
	if err != nil {
		writeStaticCredentialInputError(response, err)
		return
	}
	if _, err := handler.credentialRotation.Rotate(
		request.Context(),
		accountRef,
		credential,
	); err != nil {
		writeApplicationError(response, err)
		return
	}
	updated, err := handler.management.GetAccountOverview(
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
		accountResponse{Data: newAccountView(updated)},
	)
}

// handleAccountExport 返回一个不缓存、不包含本地身份的标准附件。
func (handler *Handler) handleAccountExport(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
	exporter AccountExporter,
	fileName string,
) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) ||
		rejectUnexpectedBody(response, request) {
		return
	}
	document, err := exporter.ExportAccount(
		request.Context(),
		accountRef,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeExportJSON(response, document, fileName)
}

// handleAccountUsage 只允许离线读取最近一次成功快照。
func (handler *Handler) handleAccountUsage(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) {
		return
	}
	result, err := handler.usage.GetUsage(request.Context(), accountRef)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, newAccountUsageResponse(result))
}

// handleAccountUsageRefresh 显式请求一次上游刷新并返回已持久化快照。
func (handler *Handler) handleAccountUsageRefresh(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) ||
		rejectUnexpectedBody(response, request) {
		return
	}
	result, err := handler.usage.RefreshUsage(request.Context(), accountRef)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, newAccountUsageResponse(result))
}

// handleAccountMember 分发账号基础详情、启停和删除操作。
func (handler *Handler) handleAccountMember(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	switch request.Method {
	case http.MethodGet:
		handler.getAccount(response, request, accountRef)
	case http.MethodPatch:
		handler.updateAccount(response, request, accountRef)
	case http.MethodDelete:
		handler.deleteAccount(response, request, accountRef)
	default:
		response.Header().Set(
			"Allow",
			http.MethodGet+", "+http.MethodPatch+", "+http.MethodDelete,
		)
		writeMethodNotAllowed(response)
	}
}

// handleAccountModels 分发账号模型列表和人工策略维护。
func (handler *Handler) handleAccountModels(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	switch request.Method {
	case http.MethodGet:
		handler.listAccountModels(response, request, accountRef)
	case http.MethodPatch:
		handler.updateAccountModel(response, request, accountRef)
	default:
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPatch)
		writeMethodNotAllowed(response)
	}
}

// handleAccountModelRefresh 执行显式 Provider 目录刷新。
func (handler *Handler) handleAccountModelRefresh(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(response)
		return
	}
	handler.refreshAccountModels(response, request, accountRef)
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

// deleteAccount 拒绝额外输入并返回无响应体的标准删除结果。
func (handler *Handler) deleteAccount(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if rejectUnexpectedQuery(response, request) ||
		rejectUnexpectedBody(response, request) {
		return
	}
	if err := handler.deletion.DeleteAccount(
		request.Context(),
		accountRef,
	); err != nil {
		writeApplicationError(response, err)
		return
	}
	writeNoContent(response)
}

// listAccountModels 返回自动发现、人工策略和最终有效性快照。
func (handler *Handler) listAccountModels(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if rejectUnexpectedQuery(response, request) {
		return
	}
	models, err := handler.models.ListAccountModels(request.Context(), accountRef)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, accountModelListResponse{
		Data: newAccountModelViews(models),
	})
}

// updateAccountModel 设置一个真实模型的人工覆盖策略并返回完整快照。
func (handler *Handler) updateAccountModel(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if rejectUnexpectedQuery(response, request) {
		return
	}
	var input updateAccountModelRequest
	if err := decodeJSONRequest(response, request, &input); err != nil {
		writeRequestDecodeError(response, err)
		return
	}
	policy, err := accountapp.ParseModelManualPolicy(input.ManualPolicy)
	if err != nil {
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"invalid_model_policy",
			"model_id 或 manual_policy 无效",
		)
		return
	}
	models, err := handler.models.SetManualModelPolicy(
		request.Context(),
		accountRef,
		input.ModelID,
		policy,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, accountModelListResponse{
		Data: newAccountModelViews(models),
	})
}

// refreshAccountModels 同步刷新一次完整上游目录，失败时保留旧快照。
func (handler *Handler) refreshAccountModels(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if rejectUnexpectedQuery(response, request) ||
		rejectUnexpectedBody(response, request) {
		return
	}
	models, err := handler.models.RefreshAccountModels(
		request.Context(),
		accountRef,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, accountModelListResponse{
		Data: newAccountModelViews(models),
	})
}
