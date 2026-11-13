// Package webuiaccountrefreshusageapi 提供「只刷新单账号额度」的管理写入口。
//
// 路由（由共享 wiring 注册，本包只导出模式常量）：
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh-usage
//
// 与 Node 的 handleRefreshAccountUsageRequest 的差异：Node 返回 202 + 后台 Job，
// WebUI 再订阅 account-refresh-job 事件并重取列表；Go 侧是同步语义——探测完成、
// 快照落库后直接返回刷新后的窗口列表，调用方不需要再查一次。
//
// 额度事实的权威副本是 Go 的额度快照表，本包不写库：探测端口（QuotaProbe）负责
// 访问 Provider 并持久化，本包只做鉴权、路由校验、超时控制和响应投影。
package webuiaccountrefreshusageapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const (
	// Path 是账号管理契约前缀。
	Path = "/v1/management/webui/accounts"
	// RefreshUsageSuffix 由共享 wiring 拼在 Path 之后，构成管理路由模式。
	//
	//	POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh-usage
	RefreshUsageSuffix = "/{provider}/{accountRef}/refresh-usage"

	// DefaultTimeout 是单账号额度探测的默认上限：超过即放弃本次刷新。
	DefaultTimeout = 15 * time.Second
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("额度刷新接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// AccountLookup 提供账号是否存在及其 Provider 归属。
//
// 只暴露一个窄方法：路由需要的全部账号事实就是「这个 ref 是否存在、属于哪个
// Provider」，与 webuiquotaresetapi 的读端口同形，接线可复用同一适配器。
type AccountLookup interface {
	LookupProvider(ctx context.Context, accountRef string) (string, bool, error)
}

// QuotaProbe 刷新并持久化一个账号的额度快照，返回归一后的窗口列表。
//
// 实现负责访问 Provider、写入 Go 的额度事实表；返回错误表示本次刷新没有产生
// 可信快照，调用方不得用旧快照冒充成功。
type QuotaProbe interface {
	ProbeQuota(ctx context.Context, provider string, accountRef string) (Snapshot, error)
}

// Dependencies 汇总刷新依赖。QuotaProbe 为 nil 是合法配置：接口返回 501，
// 明确表示 Go 侧还没接入探测，而不是返回空窗口冒充「没有额度」。
type Dependencies struct {
	Authorizer Authorizer
	Accounts   AccountLookup
	QuotaProbe QuotaProbe
	// IsAPIKeyAccount 判定目标账号是否处于 API Key 模式；为 true 时直接拒绝额度刷新。
	IsAPIKeyAccount func(ctx context.Context, provider string, accountRef string) bool
	// AIHomeDir 预留给探测适配器定位数据根（额度事实表所在目录）；本包不读取。
	AIHomeDir string
	// Timeout 是单账号探测上限；零值或负值使用 DefaultTimeout。
	Timeout time.Duration
}

// Handler 处理单账号额度刷新。
type Handler struct {
	authorizer      Authorizer
	accounts        AccountLookup
	probe           QuotaProbe
	isAPIKeyAccount func(ctx context.Context, provider string, accountRef string) bool
	timeout         time.Duration
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Accounts == nil {
		return nil, ErrInvalidDependencies
	}
	timeout := dependencies.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &Handler{
		authorizer:      dependencies.Authorizer,
		accounts:        dependencies.Accounts,
		probe:           dependencies.QuotaProbe,
		isAPIKeyAccount: dependencies.IsAPIKeyAccount,
		timeout:         timeout,
	}, nil
}

type refreshUsageView struct {
	OK           bool         `json:"ok"`
	Provider     string       `json:"provider"`
	AccountRef   string       `json:"accountRef"`
	PlanType     string       `json:"planType,omitempty"`
	Source       string       `json:"source,omitempty"`
	CapturedAt   string       `json:"capturedAt"`
	CapturedAtMS int64        `json:"capturedAtMs"`
	Windows      []windowView `json:"windows"`
}

// windowView 是额度窗口的对外投影：字段名与 WebUI 账号页的窗口条目一致。
//
// resetIn 这类相对时间由展示层按 resetAtMs 现算，不在响应里固化。
type windowView struct {
	LimitID       string   `json:"limitId,omitempty"`
	LimitName     string   `json:"limitName,omitempty"`
	Bucket        string   `json:"bucket"`
	Kind          string   `json:"kind"`
	Scope         string   `json:"scope"`
	ScopeKey      string   `json:"scopeKey,omitempty"`
	RemainingPct  *float64 `json:"remainingPct"`
	WindowSeconds *int64   `json:"windowSeconds,omitempty"`
	WindowMinutes *int64   `json:"windowMinutes,omitempty"`
	ResetAtMS     *int64   `json:"resetAtMs"`
	Availability  string   `json:"availability"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 POST。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	writeNoStoreHeaders(response)
	if handler == nil || handler.authorizer == nil || handler.accounts == nil {
		writeError(response, http.StatusServiceUnavailable,
			"quota_refresh_unavailable", "额度刷新服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}

	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider == "" || accountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "")
		return
	}

	owner, found, err := handler.accounts.LookupProvider(request.Context(), accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "account_lookup_failed", "")
		return
	}
	if !found || strings.ToLower(strings.TrimSpace(owner)) != provider {
		writeError(response, http.StatusNotFound, "account_not_found",
			"未找到 "+provider+" 账号 "+accountRef)
		return
	}
	if handler.isAPIKeyAccount != nil && handler.isAPIKeyAccount(request.Context(), provider, accountRef) {
		writeErrorWithCode(response, http.StatusBadRequest,
			"refresh_usage_unsupported", "api_key_usage_refresh_unsupported",
			"API Key 账号不支持额度刷新。")
		return
	}

	if handler.probe == nil {
		writeError(response, http.StatusNotImplemented, "quota_probe_unavailable",
			"Go 侧尚未接入额度探测，未刷新任何额度。")
		return
	}

	ctx, cancel := context.WithTimeout(request.Context(), handler.timeout)
	defer cancel()
	snapshot, probeErr := handler.probe.ProbeQuota(ctx, provider, accountRef)
	if probeErr != nil {
		switch {
		case errors.Is(probeErr, context.DeadlineExceeded) ||
			errors.Is(ctx.Err(), context.DeadlineExceeded):
			writeError(response, http.StatusGatewayTimeout, "quota_probe_timeout",
				"额度探测超时，未写入任何额度快照。")
		case request.Context().Err() != nil:
			// 客户端已断开，写响应没有意义。
			return
		default:
			writeError(response, http.StatusBadGateway, "quota_probe_failed",
				"额度探测失败，未写入任何额度快照。")
		}
		return
	}
	if err := snapshot.validate(provider, accountRef); err != nil {
		writeError(response, http.StatusBadGateway, "quota_probe_invalid_snapshot",
			"额度探测结果与目标账号不一致，未写入任何额度快照。")
		return
	}

	writeJSON(response, http.StatusOK, refreshUsageView{
		OK:           true,
		Provider:     provider,
		AccountRef:   accountRef,
		PlanType:     strings.TrimSpace(snapshot.PlanType),
		Source:       strings.TrimSpace(snapshot.Source),
		CapturedAt:   snapshot.CapturedAt.UTC().Format(time.RFC3339Nano),
		CapturedAtMS: snapshot.CapturedAt.UnixMilli(),
		Windows:      newWindowViews(snapshot.Windows),
	})
}

// newWindowViews 把探测结果投影成窗口列表，未知值保持 JSON null。
func newWindowViews(windows []Window) []windowView {
	views := make([]windowView, 0, len(windows))
	for _, window := range windows {
		view := windowView{
			LimitID:      strings.TrimSpace(window.LimitID),
			LimitName:    strings.TrimSpace(window.LimitName),
			Bucket:       strings.TrimSpace(window.Bucket),
			Kind:         window.Kind,
			Scope:        window.Scope,
			ScopeKey:     strings.TrimSpace(window.ScopeKey),
			Availability: window.Availability,
		}
		if window.RemainingPct != nil {
			remaining := *window.RemainingPct
			view.RemainingPct = &remaining
		}
		if window.WindowSeconds > 0 {
			seconds := window.WindowSeconds
			view.WindowSeconds = &seconds
			// 整分钟窗口额外给出分钟数，展示层的「5h / 7d」标签直接可用。
			if seconds%60 == 0 {
				minutes := seconds / 60
				view.WindowMinutes = &minutes
			}
		}
		if !window.ResetAt.IsZero() {
			resetAtMS := window.ResetAt.UnixMilli()
			view.ResetAtMS = &resetAtMS
		}
		views = append(views, view)
	}
	return views
}

// writeNoStoreHeaders 关闭所有缓存层：额度快照属于账号隐私，且每次刷新都应重新取。
func writeNoStoreHeaders(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
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

func writeErrorWithCode(response http.ResponseWriter, status int, errSlug string, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: errSlug, Code: code, Message: message})
}
