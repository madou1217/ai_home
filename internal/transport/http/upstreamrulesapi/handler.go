// Package upstreamrulesapi 是旧版「有效规则投影」的兼容管理接口。
//
// 新写入口是账号级接口（/v1/management/accounts/{ref}/upstream-error-rules），本接口
// 只服务于尚未升级的 Node：它推送的已经是拼装好的有效规则，Go 不再展开映射组，
// 而是把这份快照作为兼容投影保存。账号级配置存在时优先于兼容投影，因此双写期不会
// 互相覆盖。
//
//	PUT /v1/management/upstream-error-rules  整体替换兼容投影，返回接受结果与对拍差异
//	GET /v1/management/upstream-error-rules  只读诊断
package upstreamrulesapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// Path 是旧版规则投影的管理路径。
const Path = "/v1/management/upstream-error-rules"

// maxProjectionBytes 限制一次投影推送的正文大小。
const maxProjectionBytes = 1 << 20

// ErrInvalidDependencies 表示 Handler 缺少服务或鉴权。
var ErrInvalidDependencies = errors.New("上游错误规则投影 Handler 依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Service 是兼容投影用例端口（由 application/upstreamrules.Service 实现）。
type Service interface {
	ReplaceProjection(ctx context.Context, accounts []rulesapp.ProjectionAccount) (rulesapp.ProjectionResult, error)
	Snapshot(ctx context.Context) ([]rulesapp.Record, error)
	Generation() int64
	SupportedProviders() []string
}

// Dependencies 集中声明规则投影管理接口的依赖。
type Dependencies struct {
	Authorizer Authorizer
	Service    Service
}

// Handler 接收旧版 Node 的账号规则投影推送。
type Handler struct {
	authorizer Authorizer
	service    Service
}

// NewHandler 创建账号规则投影管理接口。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Service == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		service:    dependencies.Service,
	}, nil
}

// accountPush 是单个账号的推送记录。
type accountPush struct {
	AccountRef string           `json:"account_ref"`
	Provider   string           `json:"provider"`
	Rules      []rulescore.Rule `json:"rules"`
}

// pushRequest 是整体替换请求体。
type pushRequest struct {
	Accounts []accountPush `json:"accounts"`
}

// accountView 是只读诊断里的单账号投影。
type accountView struct {
	AccountRef string           `json:"account_ref"`
	Provider   string           `json:"provider"`
	Rules      []rulescore.Rule `json:"rules"`
}

// dropView 是一条被丢弃的账号投影。
type dropView struct {
	AccountRef string `json:"account_ref"`
	Reason     string `json:"reason"`
}

// rulesView 是返回给 Node 的投影状态。
type rulesView struct {
	Generation          int64         `json:"generation"`
	AcceptedAccountRefs []string      `json:"accepted_account_refs"`
	Dropped             []dropView    `json:"dropped"`
	SupportedProviders  []string      `json:"supported_providers"`
	MismatchedRefs      []string      `json:"mismatched_account_refs"`
	Accounts            []accountView `json:"accounts,omitempty"`
}

// ServeHTTP 只接受 Management Key 鉴权过的 GET 与 PUT。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.service == nil {
		writeError(response, http.StatusServiceUnavailable, "upstream_rules_unavailable", "账号规则投影不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	switch request.Method {
	case http.MethodGet:
		handler.view(response, request, nil, true)
	case http.MethodPut:
		handler.put(response, request)
	default:
		response.Header().Set("Allow", "GET, PUT")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET 与 PUT")
	}
}

// put 校验并整体替换兼容投影，然后回传接受结果。
func (handler *Handler) put(response http.ResponseWriter, request *http.Request) {
	var push pushRequest
	decoder := json.NewDecoder(io.LimitReader(request.Body, maxProjectionBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&push); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_projection", "账号规则投影格式无效")
		return
	}
	accounts := make([]rulesapp.ProjectionAccount, 0, len(push.Accounts))
	for _, account := range push.Accounts {
		accounts = append(accounts, rulesapp.ProjectionAccount{
			AccountRef: account.AccountRef,
			Provider:   account.Provider,
			Rules:      account.Rules,
		})
	}
	result, err := handler.service.ReplaceProjection(request.Context(), accounts)
	if err != nil {
		// 整体拒绝：保留原投影，避免部分应用让某些账号失去异常语义。
		writeError(response, http.StatusBadRequest, "invalid_projection", err.Error())
		return
	}
	writeView(response, http.StatusOK, rulesView{
		Generation:          result.Generation,
		AcceptedAccountRefs: nonNilStrings(result.Accepted),
		Dropped:             dropViews(result.Dropped),
		SupportedProviders:  nonNilStrings(handler.service.SupportedProviders()),
		MismatchedRefs:      nonNilStrings(result.Mismatched),
	})
}

// view 汇总当前兼容投影与接受结果。
func (handler *Handler) view(
	response http.ResponseWriter,
	request *http.Request,
	drops []rulesapp.Drop,
	includeAccounts bool,
) {
	records, err := handler.service.Snapshot(request.Context())
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "upstream_rules_unavailable", "账号规则投影不可用")
		return
	}
	view := rulesView{
		Generation:          handler.service.Generation(),
		AcceptedAccountRefs: make([]string, 0, len(records)),
		Dropped:             dropViews(drops),
		SupportedProviders:  nonNilStrings(handler.service.SupportedProviders()),
		MismatchedRefs:      []string{},
	}
	for _, record := range records {
		view.AcceptedAccountRefs = append(view.AcceptedAccountRefs, record.AccountRef)
		if !includeAccounts {
			continue
		}
		rules := record.Rules
		if rules == nil {
			rules = []rulescore.Rule{}
		}
		view.Accounts = append(view.Accounts, accountView{
			AccountRef: record.AccountRef,
			Provider:   record.Provider,
			Rules:      rules,
		})
	}
	writeView(response, http.StatusOK, view)
}

// dropViews 把被丢弃的账号投影转换为响应结构；始终返回非 nil 切片。
func dropViews(drops []rulesapp.Drop) []dropView {
	views := make([]dropView, 0, len(drops))
	for _, drop := range drops {
		views = append(views, dropView{AccountRef: drop.AccountRef, Reason: drop.Reason})
	}
	return views
}

// nonNilStrings 保证 JSON 里是 [] 而不是 null。
func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func writeView(response http.ResponseWriter, status int, view rulesView) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]any{"data": view})
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	errorType := "invalid_request_error"
	if status >= 500 {
		errorType = "server_error"
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]any{
		"error": map[string]any{"message": message, "type": errorType, "param": nil, "code": code},
	})
}
