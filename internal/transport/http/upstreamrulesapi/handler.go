// Package upstreamrulesapi 是 Go 接收 Node 账号自定义上游错误规则投影的管理接口。
//
// Node 控制面是规则与错误映射分组的唯一 owner：它在账号或分组变更后把每个账号的
// 有效规则整体推给 Go，Go 只读这份投影并在分类上游失败时使用。本包只做 HTTP
// 边界与接受结果回传，不解释规则语义（识别在 core/upstreamrules）。
//
//	PUT /v1/management/upstream-error-rules  整体替换，返回已接受的账号引用与丢弃原因
//	GET /v1/management/upstream-error-rules  只读诊断
package upstreamrulesapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// Path 是 Node 推送账号规则投影的管理路径。
const Path = "/v1/management/upstream-error-rules"

// maxProjectionBytes 限制一次投影推送的正文大小。
const maxProjectionBytes = 1 << 20

// ErrInvalidDependencies 表示 Handler 缺少投影存储或鉴权。
var ErrInvalidDependencies = errors.New("上游错误规则投影 Handler 依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 集中声明规则投影管理接口的依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      *rulesapp.Store
}

// Handler 接收 Node 的账号规则投影推送。
type Handler struct {
	authorizer Authorizer
	store      *rulesapp.Store
}

// NewHandler 创建账号规则投影管理接口。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		store:      dependencies.Store,
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
	Accounts            []accountView `json:"accounts,omitempty"`
}

// ServeHTTP 只接受 Management Key 鉴权过的 GET 与 PUT。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
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
		writeView(response, http.StatusOK, handler.view(nil, true))
	case http.MethodPut:
		handler.put(response, request)
	default:
		response.Header().Set("Allow", "GET, PUT")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET 与 PUT")
	}
}

// put 校验并整体替换投影，然后回传接受结果。
func (handler *Handler) put(response http.ResponseWriter, request *http.Request) {
	var push pushRequest
	decoder := json.NewDecoder(io.LimitReader(request.Body, maxProjectionBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&push); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_projection", "账号规则投影格式无效")
		return
	}
	accounts := make([]rulesapp.AccountRules, 0, len(push.Accounts))
	for _, account := range push.Accounts {
		accounts = append(accounts, rulesapp.NewAccountRules(
			account.AccountRef,
			account.Provider,
			account.Rules,
		))
	}
	result, err := handler.store.Replace(accounts)
	if err != nil {
		// 整体拒绝：保留原投影，避免部分应用让某些账号失去异常语义。
		writeError(response, http.StatusBadRequest, "invalid_projection", err.Error())
		return
	}
	writeView(response, http.StatusOK, handler.view(result.Dropped, false))
}

// view 汇总当前投影与接受结果。
//
// dropped 只在推送响应里出现：它是本次推送的判定结果，不是投影的持久状态。
func (handler *Handler) view(drops []rulesapp.Drop, includeAccounts bool) rulesView {
	snapshot := handler.store.Snapshot()
	view := rulesView{
		Generation:          handler.store.Generation(),
		AcceptedAccountRefs: make([]string, 0, len(snapshot)),
		Dropped:             dropViews(drops),
		SupportedProviders:  handler.store.SupportedProviders(),
	}
	if view.SupportedProviders == nil {
		view.SupportedProviders = []string{}
	}
	for _, account := range snapshot {
		view.AcceptedAccountRefs = append(view.AcceptedAccountRefs, account.AccountRef())
		if !includeAccounts {
			continue
		}
		rules := account.Rules()
		if rules == nil {
			rules = []rulescore.Rule{}
		}
		view.Accounts = append(view.Accounts, accountView{
			AccountRef: account.AccountRef(),
			Provider:   account.Provider(),
			Rules:      rules,
		})
	}
	return view
}

// dropViews 把被丢弃的账号投影转换为响应结构；始终返回非 nil 切片。
func dropViews(drops []rulesapp.Drop) []dropView {
	views := make([]dropView, 0, len(drops))
	for _, drop := range drops {
		views = append(views, dropView{AccountRef: drop.AccountRef, Reason: drop.Reason})
	}
	return views
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
