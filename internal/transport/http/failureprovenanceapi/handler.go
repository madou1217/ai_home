// Package failureprovenanceapi 暴露最近失败命中记录与生效语义的只读管理接口。
//
// 数据来自进程内环形缓冲与失败语义契约；两者都是低敏标识，不含响应正文、
// 请求内容或凭据。
package failureprovenanceapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	failurecontract "github.com/madou1217/ai_home/contracts/upstream-failure"
	runtimeprovenance "github.com/madou1217/ai_home/internal/runtime/failureprovenance"
)

const (
	// HitsPath 是最近失败命中记录的只读路径。
	HitsPath = "/v1/management/failure-provenance"
	// SemanticsPath 是生效语义表的只读路径。
	SemanticsPath = "/v1/management/upstream-failure-semantics"
	// WebUIHitsPath / WebUISemanticsPath 是浏览器别名（挂载层生成 /v0/webui）。
	WebUIHitsPath      = "/v1/management/webui/failure-provenance"
	WebUISemanticsPath = "/v1/management/webui/upstream-failure-semantics"

	defaultLimit = 100
	maxLimit     = 500
)

// ErrInvalidDependencies 表示 Handler 缺少管理鉴权。
var ErrInvalidDependencies = errors.New("失败命中 Handler 依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Handler 提供命中记录与语义表查询。
type Handler struct {
	authorizer Authorizer
}

// NewHandler 创建只读 Handler。
func NewHandler(authorizer Authorizer) (*Handler, error) {
	if authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: authorizer}, nil
}

type errorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ServeHits 返回最近命中记录。
func (handler *Handler) ServeHits(response http.ResponseWriter, request *http.Request) {
	if !handler.authorize(response, request, http.MethodGet) {
		return
	}
	query := request.URL.Query()
	limit := defaultLimit
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	entries, dropped := runtimeprovenance.Snapshot(limit, runtimeprovenance.Filter{
		Provider:   strings.TrimSpace(query.Get("provider")),
		AccountRef: strings.TrimSpace(query.Get("account_ref")),
		Semantic:   strings.TrimSpace(query.Get("semantic")),
	})
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":      true,
		"entries": entries,
		"dropped": dropped,
	})
}

// ServeSemantics 返回生效语义表。
func (handler *Handler) ServeSemantics(response http.ResponseWriter, request *http.Request) {
	if !handler.authorize(response, request, http.MethodGet) {
		return
	}
	document := failurecontract.Effective()
	if document == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]errorView{"error": {Code: "contract_unavailable", Message: "失败语义契约不可用"}})
		return
	}
	provider := strings.TrimSpace(request.URL.Query().Get("provider"))
	signals := make([]failurecontract.Signal, 0, len(document.Signals))
	for _, signal := range document.Signals {
		if provider != "" && !strings.EqualFold(signal.Provider, provider) &&
			!strings.EqualFold(signal.Provider, "all") {
			continue
		}
		signals = append(signals, signal)
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":            true,
		"schemaVersion": document.SchemaVersion,
		"policies":      document.Policies,
		"signals":       signals,
		"ruleKinds":     document.RuleKinds,
		"version":       failurecontract.Version(),
	})
}

func (handler *Handler) authorize(response http.ResponseWriter, request *http.Request, method string) bool {
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]errorView{"error": {Code: "unauthorized", Message: "管理密钥无效"}})
		return false
	}
	if request.Method != method {
		response.Header().Set("Allow", method)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]errorView{"error": {Code: "method_not_allowed", Message: "只支持 " + method}})
		return false
	}
	return true
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}