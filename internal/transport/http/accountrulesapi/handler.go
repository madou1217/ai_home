// Package accountrulesapi 是账号级上游错误规则的管理 HTTP 边界。
//
// 账号级配置 = 账号自身规则 + 挂载的映射组 id 顺序；有效规则由 Go 在读取时拼装，
// Node 不再推送「已拼装好」的整份规则。本包只做鉴权、路径分派、JSON DTO 与错误映射。
//
//	GET    /v1/management/accounts/{ref}/upstream-error-rules  读取配置与拼装结果
//	PUT    /v1/management/accounts/{ref}/upstream-error-rules  整体替换配置
//	DELETE /v1/management/accounts/{ref}/upstream-error-rules  清空配置（幂等）
//	GET    /v1/management/account-upstream-error-rules         列出全部账号配置（诊断/对账）
package accountrulesapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

const (
	// CollectionPath 是全部账号配置的只读诊断路径。
	CollectionPath = "/v1/management/account-upstream-error-rules"
	// MemberPattern 是账号级配置路径的方法无关模式，供路由注册使用。
	MemberPattern = "/v1/management/accounts/{ref}/upstream-error-rules"
	// maxBodyBytes 限制一次配置写入的正文大小。
	maxBodyBytes = 1 << 20
)

// ErrInvalidDependencies 表示 Handler 缺少服务或鉴权。
var ErrInvalidDependencies = errors.New("账号级上游错误规则 Handler 依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Service 是账号规则用例端口（由 application/upstreamrules.Service 实现）。
type Service interface {
	Effective(ctx context.Context, accountRef string) (rulesapp.AccountView, error)
	ReplaceAccount(ctx context.Context, accountRef string, input rulesapp.AccountInput) (rulesapp.AccountView, error)
	DeleteAccount(ctx context.Context, accountRef string) (bool, error)
	ListAccounts(ctx context.Context) ([]rulesapp.AccountView, error)
	SupportedProviders() []string
	Generation() int64
}

// Dependencies 汇总账号规则接口依赖。
type Dependencies struct {
	Authorizer Authorizer
	Service    Service
}

// Handler 提供账号级上游错误规则的读写。
type Handler struct {
	authorizer Authorizer
	service    Service
}

// NewHandler 创建账号级规则管理接口。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Service == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, service: dependencies.Service}, nil
}

// accountRulesPayload 是整体替换的请求体；缺席字段按空集合处理。
type accountRulesPayload struct {
	GroupIDs []string         `json:"group_ids"`
	Rules    []rulescore.Rule `json:"rules"`
}

// accountRulesView 是单个账号的配置与拼装结果。
type accountRulesView struct {
	AccountRef     string           `json:"account_ref"`
	Provider       string           `json:"provider"`
	Source         string           `json:"source"`
	GroupIDs       []string         `json:"group_ids"`
	Rules          []rulescore.Rule `json:"rules"`
	EffectiveRules []rulescore.Rule `json:"effective_rules"`
	Supported      bool             `json:"supported"`
}

// ServeHTTP 只接受 Management Key 鉴权过的请求。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.service == nil {
		writeError(response, http.StatusServiceUnavailable, "account_rules_unavailable", "账号规则服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.URL.Path == CollectionPath {
		if request.Method != http.MethodGet {
			response.Header().Set("Allow", "GET")
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET")
			return
		}
		handler.list(response, request)
		return
	}
	accountRef := request.PathValue("ref")
	if accountRef == "" {
		writeError(response, http.StatusNotFound, "route_not_found", "请求的账号规则资源不存在")
		return
	}
	switch request.Method {
	case http.MethodGet:
		handler.get(response, request, accountRef)
	case http.MethodPut:
		handler.put(response, request, accountRef)
	case http.MethodDelete:
		handler.remove(response, request, accountRef)
	default:
		response.Header().Set("Allow", "GET, PUT, DELETE")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的账号规则操作")
	}
}

func (handler *Handler) list(response http.ResponseWriter, request *http.Request) {
	accounts, err := handler.service.ListAccounts(request.Context())
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "account_rules_unavailable", "账号规则服务不可用")
		return
	}
	views := make([]accountRulesView, 0, len(accounts))
	for _, account := range accounts {
		views = append(views, toView(account))
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"data": map[string]any{
			"accounts":            views,
			"supported_providers": nonNilStrings(handler.service.SupportedProviders()),
			"generation":          handler.service.Generation(),
		},
	})
}

func (handler *Handler) get(response http.ResponseWriter, request *http.Request, accountRef string) {
	view, err := handler.service.Effective(request.Context(), accountRef)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"data": toView(view)})
}

func (handler *Handler) put(response http.ResponseWriter, request *http.Request, accountRef string) {
	payload, ok := decodePayload(response, request)
	if !ok {
		return
	}
	view, err := handler.service.ReplaceAccount(request.Context(), accountRef, rulesapp.AccountInput{
		GroupIDs: payload.GroupIDs,
		Rules:    payload.Rules,
	})
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"data": toView(view)})
}

func (handler *Handler) remove(response http.ResponseWriter, request *http.Request, accountRef string) {
	deleted, err := handler.service.DeleteAccount(request.Context(), accountRef)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"data": map[string]any{"account_ref": accountRef, "deleted": deleted},
	})
}

// toView 把应用层视图转成稳定的 JSON 形状。
func toView(view rulesapp.AccountView) accountRulesView {
	return accountRulesView{
		AccountRef:     view.AccountRef,
		Provider:       view.Provider,
		Source:         string(view.Source),
		GroupIDs:       nonNilStrings(view.GroupIDs),
		Rules:          nonNilRules(view.Rules),
		EffectiveRules: nonNilRules(view.EffectiveRules),
		Supported:      view.Supported,
	}
}

func decodePayload(response http.ResponseWriter, request *http.Request) (accountRulesPayload, bool) {
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil || int64(len(body)) > maxBodyBytes {
		writeError(response, http.StatusBadRequest, "invalid_account_rules", "请求体无效")
		return accountRulesPayload{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var payload accountRulesPayload
	if err := decoder.Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_account_rules", "请求体不是合法 JSON")
		return accountRulesPayload{}, false
	}
	return payload, true
}

func writeServiceError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, rulesapp.ErrAccountNotFound):
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
	case errors.Is(err, rulesapp.ErrInvalidAccountRef):
		writeError(response, http.StatusBadRequest, "invalid_account_ref", "账号引用无效")
	case errors.Is(err, rulesapp.ErrInvalidGroupIDs):
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_group", err.Error())
	case errors.Is(err, rulescore.ErrInvalidRules):
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_rules", err.Error())
	default:
		writeError(response, http.StatusInternalServerError, "account_rules_failed", "账号规则操作失败")
	}
}

func nonNilRules(rules []rulescore.Rule) []rulescore.Rule {
	if rules == nil {
		return []rulescore.Rule{}
	}
	return rules
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    "invalid_request_error",
			"param":   nil,
			"code":    code,
		},
	})
}
