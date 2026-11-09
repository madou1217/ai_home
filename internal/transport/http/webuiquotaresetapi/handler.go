// Package webuiquotaresetapi 提供账号额度重置历史的只读模型。
//
// 数据源是 Node 的 app-state.db（account_quota_reset_events 表）：检测与写入仍由
// Node 的额度协调器负责，本包只读。读模型迁到 Go 的目的不是换数据源，而是让
// /v0/webui/accounts/:provider/:ref/quota-reset-events 不再由 Node 自己组装。
package webuiquotaresetapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

const (
	// Path 是账号额度重置历史的管理契约前缀。
	//
	//	GET /v1/management/webui/accounts/{provider}/{accountRef}/quota-reset-events
	Path = "/v1/management/webui/accounts"
	// DefaultLimit / MaxLimit 与 Node 路由一致：缺省 50，最多 200。
	DefaultLimit = 50
	MaxLimit     = 200
)

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// AccountLookup 提供账号是否存在及其 Provider 归属。
//
// 只暴露一个窄方法：路由需要的全部账号事实就是「这个 ref 是否存在、属于哪个
// Provider」，不需要把账号应用层整个端口拖进来。
type AccountLookup interface {
	LookupProvider(ctx context.Context, accountRef string) (string, bool, error)
}

// EventSource 读取某个账号的重置历史。
type EventSource interface {
	Read(ctx context.Context, accountRef string, limit int, beforeID int64) ([]Event, error)
}

// Dependencies 汇总只读模型依赖。
type Dependencies struct {
	Authorizer Authorizer
	Accounts   AccountLookup
	Events     EventSource
}

// Handler 处理额度重置历史读取。
type Handler struct {
	authorizer Authorizer
	accounts   AccountLookup
	events     EventSource
}

// NewHandler 创建默认失败关闭的只读 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Accounts == nil || dependencies.Events == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		accounts:   dependencies.Accounts,
		events:     dependencies.Events,
	}, nil
}

// Event 是 account_quota_reset_events 的一行，字段名与 Node mapEventRow 逐字一致。
type Event struct {
	ID                        int64    `json:"id"`
	EventKey                  string   `json:"eventKey"`
	AccountRef                string   `json:"accountRef"`
	Provider                  string   `json:"provider"`
	QuotaKey                  string   `json:"quotaKey"`
	WindowLabel               string   `json:"windowLabel"`
	WindowMinutes             *int64   `json:"windowMinutes"`
	EventKind                 string   `json:"eventKind"`
	Classification            string   `json:"classification"`
	Cause                     string   `json:"cause"`
	PreviousRemainingPct      *float64 `json:"previousRemainingPct"`
	CurrentRemainingPct       *float64 `json:"currentRemainingPct"`
	PreviousExpectedResetAtMS *int64   `json:"previousExpectedResetAtMs"`
	ExhaustedAtMS             *int64   `json:"exhaustedAtMs"`
	OccurredAtMS              int64    `json:"occurredAtMs"`
	DetectedAtMS              int64    `json:"detectedAtMs"`
	EarlyDurationMS           int64    `json:"earlyDurationMs"`
	PreviousPlanType          *string  `json:"previousPlanType"`
	CurrentPlanType           *string  `json:"currentPlanType"`
}

type eventsResponse struct {
	OK         bool    `json:"ok"`
	Provider   string  `json:"provider"`
	AccountRef string  `json:"accountRef"`
	Events     []Event `json:"events"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.accounts == nil || handler.events == nil {
		writeError(response, http.StatusServiceUnavailable,
			"quota_reset_events_unavailable", "额度重置历史服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	writeNoStoreHeaders(response)

	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	rawRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider == "" || rawRef == "" {
		writeError(response, http.StatusBadRequest,
			"invalid_quota_reset_events_path", "无效的账号重置历史路径")
		return
	}
	owner, found, err := handler.accounts.LookupProvider(request.Context(), rawRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError,
			"list_quota_reset_events_failed", err.Error())
		return
	}
	if !found || strings.ToLower(strings.TrimSpace(owner)) != provider {
		writeError(response, http.StatusNotFound, "account_not_found",
			"未找到 "+provider+" 账号 "+rawRef)
		return
	}

	limit := parseLimit(request.URL.Query().Get("limit"))
	beforeID := parseBeforeID(request.URL.Query().Get("beforeId"))
	events, err := handler.events.Read(request.Context(), rawRef, limit, beforeID)
	if err != nil {
		writeError(response, http.StatusInternalServerError,
			"list_quota_reset_events_failed", err.Error())
		return
	}
	if events == nil {
		events = []Event{}
	}
	writeJSON(response, http.StatusOK, eventsResponse{
		OK:         true,
		Provider:   provider,
		AccountRef: rawRef,
		Events:     events,
	})
}

// parseLimit 与 Node 同口径：非法值按缺省处理，再夹到 [1,200]。
func parseLimit(raw string) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value <= 0 {
		return DefaultLimit
	}
	if value > MaxLimit {
		return MaxLimit
	}
	return value
}

// parseBeforeID 与 Node 同口径：非法/非正数视为「不翻页」。
func parseBeforeID(raw string) int64 {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value <= 0 {
		return 0
	}
	return value
}

func writeNoStoreHeaders(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: code, Message: message})
}
