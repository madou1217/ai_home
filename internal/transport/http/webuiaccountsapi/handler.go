// Package webuiaccountsapi 提供账号页行数据的只读 WebUI 契约。
//
// 与 accountsapi 的分工：accountsapi 是账号管理 API（snake_case，供 CLI 与 Node 同步用），
// 本包产出的是账号页行（camelCase，键名与 Node 的 /v0/webui/accounts 行一致），
// 下一轮 Node 可以直接把整页代理过来。
//
// 本切片只填「静态可派生」字段，全部来自 aih.db 的 accounts / account_credentials /
// account_ui_state / account_profiles / account_usage_snapshots / account_defaults /
// account_models。运行池、探针、token 用量、Provider 能力这些 Node 独有事实留空，
// 由响应里的 derived_by=go_partial 与三份字段清单标注，让调用方知道哪些键必须覆盖。
package webuiaccountsapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// Path 是账号页行的 WebUI 契约路径。
//
//	GET /v1/management/webui/accounts?provider=&ref=&after_ref=&limit=
const Path = "/v1/management/webui/accounts"

const (
	// defaultLimit 与 accountsapi 的默认分页大小保持一致（50 行）。
	defaultLimit = 50
	// maxLimit 是 accountsapi 的单页上限减一：本包同样多取一行判断 has_more。
	maxLimit = 255
	// derivedByGoPartial 标注这一版行只由 Go 的部分字段组成，调用方必须叠加覆盖层。
	derivedByGoPartial = "go_partial"
)

// ErrInvalidDependencies 表示 Handler 缺少数据源或鉴权策略。
var ErrInvalidDependencies = errors.New("账号页读模型接口依赖无效")

// ErrInvalidQuery 表示查询参数不符合当前路由合同。
var ErrInvalidQuery = errors.New("账号页读模型查询参数无效")

// Authorizer 是管理面请求的鉴权策略（与 accountsapi 共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总账号页读模型的依赖。
type Dependencies struct {
	Authorizer Authorizer
	Source     Source
}

// Handler 是账号页读模型的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	source     Source
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Source == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, source: dependencies.Source}, nil
}

// pageView 与 accountsapi 的分页形状一致，Node 侧的翻页逻辑可以直接复用。
type pageView struct {
	Limit        int    `json:"limit"`
	HasMore      bool   `json:"has_more"`
	NextAfterRef string `json:"next_after_ref"`
}

// listResponse 是账号页读模型的成功响应。
//
// 三份字段清单是**契约的一部分**而不是文档：Node 代理时按 filled（Go 真值）/
// approx（Go 有值，但口径或时机由 Node 决定）/ unfilled（空占位）决定覆盖策略，
// 服务端与调用方不需要各记一份名单。
type listResponse struct {
	OK             bool     `json:"ok"`
	Accounts       []Row    `json:"accounts"`
	Page           pageView `json:"page"`
	DerivedBy      string   `json:"derived_by"`
	FilledFields   []string `json:"filled_fields"`
	ApproxFields   []string `json:"approx_fields"`
	UnfilledFields []string `json:"unfilled_fields"`
	// Warnings 记录 fail-soft 的降级原因（缺表等），正常为空。
	Warnings []string `json:"warnings,omitempty"`
}

// errorBody 是与其它 WebUI 契约一致的错误 envelope。
type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorResponse struct {
	OK    bool      `json:"ok"`
	Error errorBody `json:"error"`
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.source == nil {
		writeError(response, http.StatusServiceUnavailable, "webui_accounts_unavailable", "账号页读模型不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持读取账号页行")
		return
	}
	query, err := parseQuery(request)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_query", "账号页读模型查询参数无效")
		return
	}
	result, err := handler.source.ListAccountRows(request.Context(), query)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "webui_accounts_failed", "账号页读模型读取失败")
		return
	}
	// source 按「可见条数 + 1」查询，多出来的一行只用于判断 has_more。
	rows := result.Rows
	visibleLimit := query.Limit - 1
	hasMore := len(rows) > visibleLimit
	if hasMore {
		rows = rows[:visibleLimit]
	}
	nextAfterRef := ""
	if hasMore && len(rows) > 0 {
		nextAfterRef = rows[len(rows)-1].AccountRef
	}
	accounts := rows
	if accounts == nil {
		accounts = []Row{}
	}
	writeJSON(response, http.StatusOK, listResponse{
		OK:             true,
		Accounts:       accounts,
		Page:           pageView{Limit: visibleLimit, HasMore: hasMore, NextAfterRef: nextAfterRef},
		DerivedBy:      derivedByGoPartial,
		FilledFields:   filledRowFields,
		ApproxFields:   approxRowFields,
		UnfilledFields: unfilledRowFields(),
		Warnings:       result.Warnings(),
	})
}

// parseQuery 只接受显式声明的四个参数，未知参数一律拒绝。
//
// 为什么不允许额外参数：账号页会被 Node 整体代理，拼错的过滤参数如果被静默忽略，
// 表现是「过滤没生效、返回了全部账号」，比 400 难查得多。
func parseQuery(request *http.Request) (Query, error) {
	values, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil || request.URL.RawQuery != "" && len(values) == 0 {
		return Query{}, ErrInvalidQuery
	}
	for key, entries := range values {
		switch key {
		case "provider", "ref", "after_ref", "limit":
		default:
			return Query{}, ErrInvalidQuery
		}
		if len(entries) != 1 {
			return Query{}, ErrInvalidQuery
		}
	}
	query := Query{Provider: normalizeProvider(values.Get("provider"))}
	if values.Has("ref") {
		ref, err := accountcore.ParseAccountRef(values.Get("ref"))
		if err != nil {
			return Query{}, ErrInvalidQuery
		}
		query.AccountRef = ref.String()
	}
	if values.Has("after_ref") {
		afterRef, err := accountcore.ParseAccountRef(values.Get("after_ref"))
		if err != nil {
			return Query{}, ErrInvalidQuery
		}
		query.AfterRef = afterRef.String()
	}
	visibleLimit := defaultLimit
	if values.Has("limit") {
		limit, err := strconv.Atoi(values.Get("limit"))
		if err != nil || limit < 1 || limit > maxLimit {
			return Query{}, ErrInvalidQuery
		}
		visibleLimit = limit
	}
	query.Limit = visibleLimit + 1
	return query, nil
}

// normalizeProvider 与 Node 侧口径一致：Provider 一律小写去空白。
func normalizeProvider(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: errorBody{Code: code, Message: message}})
}
