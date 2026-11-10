// Package webuisetdefaultapi 提供账号「设为默认 / 取消默认」的管理写入口。
//
// 路由（由共享 wiring 注册，本包只导出模式常量）：
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/set-default
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/clear-default
//
// 本包只编排已经迁到 Go 的原语：
//
//   - Provider 默认关系（account_defaults 表）由 application/accounts.ProviderDefaults
//     持有，它是启动链路的真值源；
//   - AIH Server 落点指针（app_kv provider:default:<provider>）由 internal/host/aihdefault
//     持有，显式指定账号时必须撤掉残留档位；
//   - 宿主全局配置的钉选 / 网关落点 / 直连授权回收仍是 Node 的投影。端口未注入时
//     路由显式返回 501，宿主配置被外部改动时返回 409，绝不先写一半状态再报成功。
package webuisetdefaultapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/host/aihdefault"
)

const (
	// Path 是账号管理契约前缀。
	Path = "/v1/management/webui/accounts"
	// SetDefaultRouteSuffix 由共享 wiring 拼在 Path 之后。
	SetDefaultRouteSuffix = "/{provider}/{accountRef}/set-default"
	// ClearDefaultRouteSuffix 由共享 wiring 拼在 Path 之后。
	ClearDefaultRouteSuffix = "/{provider}/{accountRef}/clear-default"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("默认账号写入接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// DefaultRelations 是 Provider 默认关系的应用层端口。
//
// 只暴露「替换 / 清除」两个动作：账号归属、启停和凭据完整性由实现方在事务内
// 校验，HTTP 层不再复制一套资格判定。
type DefaultRelations interface {
	Set(
		ctx context.Context,
		providerID string,
		accountRef accountcore.AccountRef,
	) (accountcore.ProviderDefault, error)
	Clear(ctx context.Context, providerID string) error
}

// HostAccountSelector 把宿主全局配置钉到指定账号（Node syncGlobalConfigToHost）。
// nil 表示投影未接入，set-default 必须返回 501。
type HostAccountSelector interface {
	SelectAccount(
		ctx context.Context,
		providerID string,
		accountRef accountcore.AccountRef,
	) error
}

// HostGatewayLander 把宿主全局配置切到无钉选网关档
// （Node syncGlobalConfigToHost(provider, ”, { gateway: true })）。
// nil 表示投影未接入，支持网关档的 Provider 在 clear-default 时返回 501。
type HostGatewayLander interface {
	LandGateway(ctx context.Context, providerID string) error
}

// HostGrantRevoker 回收该账号在宿主上遗留的直连授权。没有该钩子的 Provider
// 保持 nil；有钩子但回收失败时路由返回 502，而不是把失败吞成成功。
type HostGrantRevoker interface {
	RevokeGrant(
		ctx context.Context,
		providerID string,
		accountRef accountcore.AccountRef,
	) (bool, error)
}

// Dependencies 汇总写入依赖。Host 端口可以为 nil，由路由按能力显式返回 501。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	Catalog    *providers.Catalog
	Defaults   DefaultRelations

	HostSelector HostAccountSelector
	HostGate     HostGatewayLander
	HostGrant    HostGrantRevoker
}

// Handler 处理 set-default / clear-default。两条路由共用一个 Handler，
// 由路径后缀分派（wiring 分别注册两个模式）。
type Handler struct {
	authorizer   Authorizer
	databasePath string
	catalog      *providers.Catalog
	defaults     DefaultRelations
	store        aihdefault.Store

	hostSelector HostAccountSelector
	hostGate     HostGatewayLander
	hostGrant    HostGrantRevoker
}

var _ DefaultRelations = (*accountapp.ProviderDefaults)(nil)

// NewHandler 创建默认失败关闭的 Handler。宿主投影端口允许缺席：真实请求会得到
// 501，而不是静默跳过投影。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		strings.TrimSpace(dependencies.AIHomeDir) == "" ||
		dependencies.Catalog == nil ||
		dependencies.Defaults == nil {
		return nil, ErrInvalidDependencies
	}
	databasePath, err := appstate.DatabasePath(dependencies.AIHomeDir)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:   dependencies.Authorizer,
		databasePath: databasePath,
		catalog:      dependencies.Catalog,
		defaults:     dependencies.Defaults,
		store: aihdefault.Store{
			DatabasePath: databasePath,
			Catalog:      dependencies.Catalog,
		},
		hostSelector: dependencies.HostSelector,
		hostGate:     dependencies.HostGate,
		hostGrant:    dependencies.HostGrant,
	}, nil
}

type setDefaultView struct {
	OK             bool                `json:"ok"`
	Provider       string              `json:"provider"`
	AccountRef     string              `json:"accountRef"`
	Default        defaultRelationView `json:"default"`
	LandingCleared bool                `json:"landingCleared"`
}

type defaultRelationView struct {
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
	UpdatedAt  string `json:"updatedAt"`
}

type clearDefaultView struct {
	OK               bool        `json:"ok"`
	Provider         string      `json:"provider"`
	AccountRef       string      `json:"accountRef"`
	AIServerDefault  landingView `json:"aiServerDefault"`
	HostGrantRevoked *bool       `json:"hostGrantRevoked,omitempty"`
}

type landingView struct {
	OK            bool   `json:"ok"`
	Landed        bool   `json:"landed"`
	AlreadyLanded bool   `json:"alreadyLanded"`
	Profile       string `json:"profile,omitempty"`
	Reason        string `json:"reason,omitempty"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

type accountScope struct {
	provider   string
	accountRef accountcore.AccountRef
}

// ServeHTTP 按路由后缀分派；未知路径返回 404。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil ||
		handler.authorizer == nil ||
		handler.catalog == nil ||
		handler.defaults == nil {
		writeError(response, http.StatusServiceUnavailable,
			"default_account_unavailable", "默认账号服务不可用")
		return
	}
	switch {
	case strings.HasSuffix(request.URL.Path, "/set-default"):
		handler.serveSetDefault(response, request)
	case strings.HasSuffix(request.URL.Path, "/clear-default"):
		handler.serveClearDefault(response, request)
	default:
		writeError(response, http.StatusNotFound, "route_not_found", "")
	}
}

func (handler *Handler) serveSetDefault(response http.ResponseWriter, request *http.Request) {
	scope, ok := handler.resolveScope(response, request)
	if !ok {
		return
	}
	if handler.hostSelector == nil {
		writeError(response, http.StatusNotImplemented,
			"host_projection_unavailable", "宿主配置投影未接入，默认账号未被修改")
		return
	}

	relation, err := handler.defaults.Set(request.Context(), scope.provider, scope.accountRef)
	if err != nil {
		handler.writeRelationError(response, err, "set_default_failed")
		return
	}
	if err := handler.hostSelector.SelectAccount(
		request.Context(), scope.provider, scope.accountRef,
	); err != nil {
		writeError(response, http.StatusBadGateway,
			"set_default_host_sync_failed", err.Error())
		return
	}
	// 显式指定账号后，残留的 AIH Server 档位会让启动链路静默忽略该账号。
	landingCleared, err := handler.store.ClearProviderProfile(request.Context(), scope.provider)
	if err != nil {
		writeError(response, http.StatusBadGateway,
			"set_default_pointer_clear_failed", err.Error())
		return
	}
	writeJSON(response, http.StatusOK, setDefaultView{
		OK:             true,
		Provider:       scope.provider,
		AccountRef:     scope.accountRef.String(),
		Default:        newDefaultRelationView(relation),
		LandingCleared: landingCleared,
	})
}

func (handler *Handler) serveClearDefault(response http.ResponseWriter, request *http.Request) {
	scope, ok := handler.resolveScope(response, request)
	if !ok {
		return
	}
	gatewayCapable := handler.catalog.Supports(scope.provider, providers.CapabilityGatewayProfile)
	if gatewayCapable && handler.hostGate == nil {
		writeError(response, http.StatusNotImplemented,
			"host_projection_unavailable", "宿主配置投影未接入，默认账号未被清除")
		return
	}

	if err := handler.defaults.Clear(request.Context(), scope.provider); err != nil {
		handler.writeRelationError(response, err, "clear_default_failed")
		return
	}
	var revoked *bool
	if handler.hostGrant != nil {
		result, err := handler.hostGrant.RevokeGrant(
			request.Context(), scope.provider, scope.accountRef,
		)
		if err != nil {
			writeError(response, http.StatusBadGateway,
				"host_grant_revoke_failed", err.Error())
			return
		}
		revoked = &result
	}
	landed := aihdefault.LandOnServerDefault(
		request.Context(), handler.store, scope.provider, handler.gatewaySync(),
	)
	if !landed.OK {
		status, code := landingFailure(landed.Reason)
		writeErrorReason(response, status, code, "", landed.Reason)
		return
	}
	writeJSON(response, http.StatusOK, clearDefaultView{
		OK:         true,
		Provider:   scope.provider,
		AccountRef: scope.accountRef.String(),
		AIServerDefault: landingView{
			OK:            landed.OK,
			Landed:        landed.Landed,
			AlreadyLanded: landed.AlreadyLanded,
			Profile:       landed.Profile,
			Reason:        landed.Reason,
		},
		HostGrantRevoked: revoked,
	})
}

// resolveScope 负责鉴权、方法、路径与「账号确实属于该 Provider」的校验。
func (handler *Handler) resolveScope(
	response http.ResponseWriter,
	request *http.Request,
) (accountScope, bool) {
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return accountScope{}, false
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return accountScope{}, false
	}
	rawProvider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	rawAccountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if rawProvider == "" || rawAccountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "")
		return accountScope{}, false
	}
	provider, found := handler.catalog.CanonicalID(rawProvider)
	if !found {
		writeError(response, http.StatusBadRequest, "unsupported_provider", "")
		return accountScope{}, false
	}
	accountRef, err := accountcore.ParseAccountRef(rawAccountRef)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_account_ref", "")
		return accountScope{}, false
	}
	owner, found, err := appstate.LookupAccountProvider(
		request.Context(), handler.databasePath, accountRef.String(),
	)
	if err != nil {
		writeError(response, http.StatusInternalServerError,
			"default_account_lookup_failed", err.Error())
		return accountScope{}, false
	}
	if !found {
		writeError(response, http.StatusNotFound, "account_not_found", "")
		return accountScope{}, false
	}
	if strings.ToLower(strings.TrimSpace(owner)) != provider {
		writeError(response, http.StatusConflict, "account_provider_mismatch", "")
		return accountScope{}, false
	}
	return accountScope{provider: provider, accountRef: accountRef}, true
}

func (handler *Handler) gatewaySync() aihdefault.GatewaySync {
	if handler.hostGate == nil {
		return nil
	}
	return handler.hostGate.LandGateway
}

// writeRelationError 把应用层默认关系错误映射成稳定状态码。
func (handler *Handler) writeRelationError(
	response http.ResponseWriter,
	err error,
	fallback string,
) {
	switch {
	case errors.Is(err, accountapp.ErrProviderDefaultConflict):
		writeError(response, http.StatusConflict, "default_provider_conflict", err.Error())
	case errors.Is(err, accountapp.ErrProviderDefaultMismatch):
		writeError(response, http.StatusConflict, "default_provider_mismatch", err.Error())
	case errors.Is(err, accountapp.ErrProviderDefaultDisabled):
		writeError(response, http.StatusConflict, "default_provider_disabled", err.Error())
	case errors.Is(err, accountapp.ErrProviderDefaultUnconfigured):
		writeError(response, http.StatusConflict, "default_provider_unconfigured", err.Error())
	case errors.Is(err, accountapp.ErrAccountNotFound):
		writeError(response, http.StatusNotFound, "account_not_found", "")
	case errors.Is(err, accountapp.ErrInvalidProviderDefault):
		writeError(response, http.StatusBadRequest, "invalid_default_provider", err.Error())
	case errors.Is(err, accountapp.ErrInvalidProviderDefaultDependencies):
		writeError(response, http.StatusServiceUnavailable,
			"default_provider_unavailable", err.Error())
	default:
		writeError(response, http.StatusInternalServerError, fallback, err.Error())
	}
}

// landingFailure 区分「投影未接入」(501)、「宿主状态冲突」(409) 与真实同步失败 (502)。
func landingFailure(reason string) (int, string) {
	switch reason {
	case aihdefault.CodeHostSyncUnavailable:
		return http.StatusNotImplemented, "host_projection_unavailable"
	case aihdefault.CodeScopeUnavailable:
		return http.StatusConflict, "host_scope_unavailable"
	case aihdefault.CodeHostConfigChanged:
		return http.StatusConflict, "gateway_default_host_config_changed"
	case aihdefault.CodeHostConfigNotRegularFile:
		return http.StatusConflict, "host_config_not_regular_file"
	case aihdefault.CodeOwnershipUnsupported:
		return http.StatusConflict, "gateway_profile_ownership_unsupported"
	case aihdefault.CodeGatewayRestoreFailed:
		return http.StatusBadGateway, "gateway_default_restore_failed"
	case aihdefault.CodeProfileWriteFailed:
		return http.StatusBadGateway, "default_provider_profile_write_failed"
	default:
		return http.StatusBadGateway, "gateway_config_sync_failed"
	}
}

func newDefaultRelationView(relation accountcore.ProviderDefault) defaultRelationView {
	return defaultRelationView{
		Provider:   relation.ProviderID(),
		AccountRef: relation.AccountRef().String(),
		UpdatedAt:  relation.UpdatedAt().UTC().Format(time.RFC3339Nano),
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeErrorReason(response, status, code, message, "")
}

func writeErrorReason(
	response http.ResponseWriter,
	status int,
	code string,
	message string,
	reason string,
) {
	writeJSON(response, status, errorView{
		OK:      false,
		Error:   code,
		Message: message,
		Reason:  reason,
	})
}
