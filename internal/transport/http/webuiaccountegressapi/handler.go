// Package webuiaccountegressapi 提供账号级出口绑定的读写入口。
//
// 契约来源是 Node 的 GET|POST /v0/webui/accounts/:provider/:accountRef/egress
// （lib/server/webui-zcode-egress-routes.js）。本包承接「设置」本身：路径/账号校验、
// 入参校验、绑定落盘与分配投影；运行态应用（启动/重启客户端、探测、池车道规划）仍在
// Node，由 Node 的薄壳在写入后执行。
//
// 错误码与 Node 逐字一致；Node 的 500 响应不带 message，这里同样不把数据库细节外抛。
package webuiaccountegressapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/agy/egress"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// Path 是账号出口设置的管理契约前缀。
	//
	//	GET  /v1/management/webui/accounts/{provider}/{accountRef}/egress
	//	POST /v1/management/webui/accounts/{provider}/{accountRef}/egress
	Path = "/v1/management/webui/accounts"

	maxRequestBodyBytes = 16 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("账号出口设置接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// BindingStore 是绑定读写端口（生产实现是 egress.Store）。
type BindingStore interface {
	Read(ctx context.Context, accountRef string) (egress.Binding, bool, error)
	Replace(ctx context.Context, accountRef string, mode string, proxyURL string, scope any, strategy string) (egress.Binding, error)
	Clear(ctx context.Context, accountRef string) error
}

// Dependencies 汇总读写依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	// Catalog 判定 provider 是否已知（Node 的 EGRESS_SUPPORTED_PROVIDERS = 全部 provider）。
	Catalog *providers.Catalog
	Store   BindingStore
}

// Handler 处理账号出口绑定的读写。
type Handler struct {
	aiHomeDir  string
	catalog    *providers.Catalog
	store      BindingStore
	authorizer Authorizer
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || strings.TrimSpace(dependencies.AIHomeDir) == "" ||
		dependencies.Catalog == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		aiHomeDir:  strings.TrimSpace(dependencies.AIHomeDir),
		catalog:    dependencies.Catalog,
		store:      dependencies.Store,
	}, nil
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

type responseView struct {
	OK         bool           `json:"ok"`
	Provider   string         `json:"provider"`
	AccountRef string         `json:"accountRef"`
	Binding    map[string]any `json:"binding"`
	// Previous 只在写入路径出现：Node 失败回滚需要「写入前的原绑定」。
	// 缺省/null 表示写入前没有绑定，回滚就是解绑。
	Previous map[string]any `json:"previous,omitempty"`
}

// ServeHTTP 接受 GET（读）与 POST（写）。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "egress_unavailable", "账号出口服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET/POST")
		return
	}
	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider == "" || accountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "")
		return
	}
	// 与 Node EGRESS_SUPPORTED_PROVIDERS（全部已知 provider）一致：只认规范 ID，
	// 别名（如 openai → codex）不算独立 provider。
	if canonical, known := handler.catalog.CanonicalID(provider); !known || canonical != provider {
		writeError(response, http.StatusBadRequest, "egress_unsupported_provider", "")
		return
	}
	databasePath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "ai_home_dir_unavailable", "")
		return
	}
	owner, found, err := appstate.LookupAccountProvider(request.Context(), databasePath, accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, errorForMethod(request.Method), "")
		return
	}
	if !found {
		writeError(response, http.StatusNotFound, "account_not_found", "")
		return
	}
	if strings.ToLower(strings.TrimSpace(owner)) != provider {
		writeError(response, http.StatusConflict, "account_provider_mismatch", "")
		return
	}
	if request.Method == http.MethodGet {
		handler.read(response, request, provider, accountRef)
		return
	}
	handler.write(response, request, provider, accountRef)
}

func (handler *Handler) read(response http.ResponseWriter, request *http.Request, provider string, accountRef string) {
	binding, found, err := handler.store.Read(request.Context(), accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "egress_binding_read_failed", "")
		return
	}
	writeJSON(response, http.StatusOK, responseView{
		OK: true, Provider: provider, AccountRef: accountRef, Binding: bindingView(binding, found),
	})
}

func (handler *Handler) write(response http.ResponseWriter, request *http.Request, provider string, accountRef string) {
	var payload any
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxRequestBodyBytes))
	if err := decoder.Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_json_body", "")
		return
	}
	object, ok := payload.(map[string]any)
	if !ok || object == nil {
		writeError(response, http.StatusBadRequest, "invalid_request_body", "")
		return
	}
	// Node 用 String(payload.mode).trim().toLowerCase()：标量都参与比较，对象/数组
	// 会得到非模式文本。这里按同一口径处理——标量照转，非标量直接判非法，
	// 绝不能把「mode 传了对象」静默解释成解绑。
	modeText, scalar := scalarText(object["mode"])
	if !scalar {
		writeError(response, http.StatusBadRequest, "invalid_egress_mode", "")
		return
	}
	mode := strings.ToLower(modeText)
	proxyURL, proxyScalar := scalarText(object["proxyUrl"])
	if !proxyScalar {
		if mode == egress.ModeURL {
			writeError(response, http.StatusBadRequest, "invalid_proxy_url", "")
			return
		}
		proxyURL = ""
	}
	if mode != "" && !egress.IsKnownMode(mode) {
		writeError(response, http.StatusBadRequest, "invalid_egress_mode", "")
		return
	}
	// 与 Node 一致：只有显式 url 模式才在保存这一刻校验地址；空地址 = 解绑。
	if mode == egress.ModeURL && proxyURL != "" {
		if issue := egress.ProxyURLIssueForProvider(proxyURL, provider); issue != "" {
			writeError(response, http.StatusBadRequest, issue, "")
			return
		}
	}
	shouldClear := mode == "" || (mode == egress.ModeURL && proxyURL == "")

	previous, hadPrevious, err := handler.store.Read(request.Context(), accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "egress_binding_read_failed", "")
		return
	}

	if shouldClear {
		if err := handler.store.Clear(request.Context(), accountRef); err != nil {
			writeError(response, http.StatusInternalServerError, "egress_binding_write_failed", "")
			return
		}
		writeJSON(response, http.StatusOK, responseView{
			OK: true, Provider: provider, AccountRef: accountRef,
			Binding: nil, Previous: bindingView(previous, hadPrevious),
		})
		return
	}

	written, err := handler.store.Replace(
		request.Context(), accountRef, mode, proxyURL, object["scope"], textValue(object["strategy"]),
	)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "egress_binding_write_failed", "")
		return
	}
	writeJSON(response, http.StatusOK, responseView{
		OK: true, Provider: provider, AccountRef: accountRef,
		Binding: written.View(), Previous: bindingView(previous, hadPrevious),
	})
}

func bindingView(binding egress.Binding, found bool) map[string]any {
	if !found {
		return nil
	}
	return binding.View()
}

func errorForMethod(method string) string {
	if method == http.MethodPost {
		return "egress_binding_write_failed"
	}
	return "egress_binding_read_failed"
}

func textValue(value any) string {
	text, _ := scalarText(value)
	return text
}

// scalarText 复刻 Node 的 String(value || ”).trim()：假值（nil / false / 0 / 空串）
// 一律空串，真标量转文本，对象与数组判为非标量（ok=false）。
func scalarText(value any) (string, bool) {
	switch typed := value.(type) {
	case nil:
		return "", true
	case string:
		return strings.TrimSpace(typed), true
	case bool:
		if typed {
			return "true", true
		}
		return "", true
	case float64:
		if typed == 0 {
			return "", true
		}
		return strconv.FormatFloat(typed, 'g', -1, 64), true
	default:
		return "", false
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
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
