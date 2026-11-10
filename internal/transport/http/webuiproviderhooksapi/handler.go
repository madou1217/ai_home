// Package webuiproviderhooksapi 提供「各 Provider 的 Hook 档案」只读投影。
//
// 数据边界：唯一数据源是 core/providers 的能力合同。Support 与 Adapter 来自
// SessionSync；Target / TimeoutUnit / EventMatchers / FeatureFlag 在内置合同里
// 没有真值来源，DeriveHookProfile 也不会替它们编默认值。
//
// 因此本投影的规则是「缺数据就说缺数据」：
//   - supported=false 的 Provider 如实给出 reason；
//   - supported=true 但档案字段为空时，把空值原样返回（target=[]、
//     event_matchers={}、timeout_unit=""、feature_flag=null），并把该行标为
//     degraded，在 unfilled_fields 里点名缺了哪几项。
//
// 不把空值翻译成「默认秒」「不需要 matcher」之类的猜测：gemini 的 timeout 以毫秒计、
// codex 之外的 Provider 本来就不需要 matcher，猜错会写出读不回来的原生配置。
package webuiproviderhooksapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// Path 是 Provider Hook 档案的 WebUI 契约路径。
//
//	GET /v1/management/webui/provider-hooks
const Path = "/v1/management/webui/provider-hooks"

const (
	// derivedByGoPartial 标注响应只包含 Go 合同能证明的字段。
	derivedByGoPartial = "go_partial"
	// dataSource 固定指向 Provider 能力合同。
	dataSource = "core/providers"

	// statusComplete 表示档案字段齐全，可直接交给适配器写文件。
	statusComplete = "complete"
	// statusDegraded 表示 Provider 声明了 Hook，但写文件所需的字段有缺失。
	statusDegraded = "degraded"
	// statusUnsupported 表示合同本身没有 Hook，缺失是设计而非故障。
	statusUnsupported = "unsupported"
)

// ErrInvalidDependencies 表示 Handler 缺少合同目录或鉴权策略。
var ErrInvalidDependencies = errors.New("Provider Hook 档案接口依赖无效")

// Authorizer 校验管理面请求的 Bearer 密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总只读投影的依赖。
type Dependencies struct {
	Authorizer Authorizer
	Catalog    *providers.Catalog
}

// Handler 是 Provider Hook 档案的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	catalog    *providers.Catalog
}

// NewHandler 校验依赖并创建 Handler；缺依赖时失败关闭。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Catalog == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, catalog: dependencies.Catalog}, nil
}

// response 是成功响应。
//
// providers 覆盖合同里的**全部** Provider，而不是只列有 Hook 的那些：
// 调用方需要「这个 Provider 没有 Hook」的明确回答，沉默缺席只能靠猜。
type response struct {
	OK         bool           `json:"ok"`
	DerivedBy  string         `json:"derived_by"`
	DataSource string         `json:"data_source"`
	Providers  []providerView `json:"providers"`
}

// providerView 是一个 Provider 的 Hook 档案与完整性标记。
//
// 空值字段不带 omitempty：空本身就是结论，必须出现在响应里。
type providerView struct {
	ProviderID string `json:"provider_id"`
	// Supported 与合同 SessionSync.Mode 一致。
	Supported bool `json:"supported"`
	// Status 取 complete / degraded / unsupported，是 supported 与字段完整性的合成结论。
	Status string `json:"status"`
	// Reason 在 supported=false 时说明为什么没有 Hook。
	Reason string `json:"reason"`
	// Adapter 是写文件格式适配器；supported=true 时由合同声明。
	Adapter string `json:"adapter"`
	// Target 是相对原生根的路径段；合同没有真值源时为空数组。
	Target []string `json:"target"`
	// TimeoutUnit 是 timeout 的计量单位；空字符串表示合同未声明，不是「秒」。
	TimeoutUnit string `json:"timeout_unit"`
	// EventMatchers 是「事件名 → matcher」；空对象表示合同未声明，不是「不需要」。
	EventMatchers map[string]string `json:"event_matchers"`
	// FeatureFlag 为 nil 表示合同未声明，不能读成 false。
	FeatureFlag *bool `json:"feature_flag"`
	// FilledFields 列出本行真实有值的键。
	FilledFields []string `json:"filled_fields"`
	// UnfilledFields 列出写文件需要、但合同没有声明的键。
	UnfilledFields []string `json:"unfilled_fields"`
}

// errorResponse 与相邻 WebUI 契约保持同一扁平形状。
type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.catalog == nil {
		writeError(responseWriter, http.StatusServiceUnavailable, "provider_hooks_unavailable", "Hook 档案服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		responseWriter.Header().Set("Allow", http.MethodGet)
		writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	writeJSON(responseWriter, http.StatusOK, newResponse(handler.catalog))
}

// newResponse 按合同顺序投影每个 Provider 的 Hook 档案。
func newResponse(catalog *providers.Catalog) response {
	definitions := catalog.List()
	views := make([]providerView, 0, len(definitions))
	for _, definition := range definitions {
		views = append(views, projectProvider(definition, providers.DeriveHookProfile(definition)))
	}
	return response{OK: true, DerivedBy: derivedByGoPartial, DataSource: dataSource, Providers: views}
}

// projectProvider 把一份 Hook 档案投影成 HTTP 视图。
//
// 这里只复制、不推导：任何字段的空值都保持空值，由 hookStatus 与 fieldLedger
// 负责把它读成「未声明」。
func projectProvider(definition providers.Definition, profile providers.HookProfile) providerView {
	view := providerView{
		ProviderID:    strings.TrimSpace(definition.ID),
		Supported:     profile.Supported,
		Reason:        strings.TrimSpace(profile.Reason),
		Adapter:       strings.TrimSpace(string(profile.Adapter)),
		Target:        append([]string{}, profile.Target...),
		TimeoutUnit:   strings.TrimSpace(string(profile.TimeoutUnit)),
		EventMatchers: make(map[string]string, len(profile.EventMatchers)),
	}
	for event, matcher := range profile.EventMatchers {
		view.EventMatchers[event] = matcher
	}
	if profile.FeatureFlag != nil {
		flag := *profile.FeatureFlag
		view.FeatureFlag = &flag
	}
	view.Status = hookStatus(view)
	view.FilledFields, view.UnfilledFields = fieldLedger(view)
	return view
}

// hookStatus 合成一行结论。
//
// supported=false 是设计结论，不是降级；supported=true 却缺写文件字段时才叫 degraded，
// 因为此时调用方拿不到足够的参数，贸然写文件只会写坏原生配置。
func hookStatus(view providerView) string {
	if !view.Supported {
		return statusUnsupported
	}
	if view.Adapter == "" || len(view.Target) == 0 || view.TimeoutUnit == "" || len(view.EventMatchers) == 0 {
		return statusDegraded
	}
	return statusComplete
}

// supportedProfileFields 是 supported=true 时写文件所需的档案字段。
var supportedProfileFields = []string{"adapter", "target", "timeout_unit", "event_matchers", "feature_flag"}

// fieldLedger 生成「本行有哪些值、缺了哪些」两份清单。
//
// 缺失清单只列**本该有值**的键：unsupported 的 Provider 按合同不能声明写文件参数
// （见 providers.ValidateHookProfile），把它们列成缺失会误导成「补数据就能用」。
func fieldLedger(view providerView) (filled []string, unfilled []string) {
	filled = []string{"provider_id", "supported", "status"}
	unfilled = []string{}
	if !view.Supported {
		if view.Reason != "" {
			filled = append(filled, "reason")
		} else {
			unfilled = append(unfilled, "reason")
		}
		return filled, unfilled
	}
	declared := map[string]bool{
		"adapter":        view.Adapter != "",
		"target":         len(view.Target) > 0,
		"timeout_unit":   view.TimeoutUnit != "",
		"event_matchers": len(view.EventMatchers) > 0,
		"feature_flag":   view.FeatureFlag != nil,
	}
	for _, field := range supportedProfileFields {
		if declared[field] {
			filled = append(filled, field)
			continue
		}
		unfilled = append(unfilled, field)
	}
	return filled, unfilled
}

func writeJSON(responseWriter http.ResponseWriter, status int, payload any) {
	responseWriter.Header().Set("Content-Type", "application/json")
	responseWriter.WriteHeader(status)
	encoder := json.NewEncoder(responseWriter)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}

func writeError(responseWriter http.ResponseWriter, status int, code string, message string) {
	writeJSON(responseWriter, status, errorResponse{OK: false, Error: code, Message: message})
}
