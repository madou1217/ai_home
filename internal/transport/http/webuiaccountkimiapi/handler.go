// Package webuiaccountkimiapi 承接 kimi 的账号级 WebUI 能力：
//
//	GET  /v1/management/webui/accounts/{provider}/{accountRef}/plan-stats
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/desktop-session/start
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/desktop-session/poll
//	GET  /v1/management/webui/accounts/{provider}/{accountRef}/desktop-session/watch
//
// 上游协议在 internal/adapters/kimi/{desktopsession,planstats}；本包只做鉴权、
// Provider 作用域、账号存在性、HTTP/SSE 形状与错误码映射。Node 不再保留这四条
// 路由的本地实现：Go 不可用时由 Node 明确返回 503，而不是悄悄走第二套逻辑。
package webuiaccountkimiapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/kimi/desktopsession"
	"github.com/madou1217/ai_home/internal/adapters/kimi/planstats"
)

const (
	// Path 是账号管理契约前缀。
	Path = "/v1/management/webui/accounts"
	// PlanStatsSuffix 由共享 wiring 拼在 Path 之后。
	PlanStatsSuffix = "/{provider}/{accountRef}/plan-stats"
	// DesktopSessionStartSuffix 是扫码登录起始路由。
	DesktopSessionStartSuffix = "/{provider}/{accountRef}/desktop-session/start"
	// DesktopSessionPollSuffix 是扫码状态轮询路由。
	DesktopSessionPollSuffix = "/{provider}/{accountRef}/desktop-session/poll"
	// DesktopSessionWatchSuffix 是扫码状态 SSE 路由。
	DesktopSessionWatchSuffix = "/{provider}/{accountRef}/desktop-session/watch"

	// maxBodyBytes 与 Node readRequestBody({maxBytes: 64 * 1024}) 一致。
	maxBodyBytes = 64 * 1024

	// missingSessionMessage 与 Node 的 desktop_session_missing 文案一致。
	missingSessionMessage = "该账号尚未完成桌面端授权，无法读取套餐配额。"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("kimi 账号接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// AccountReader 是账号身份读端口（由 *sqliteaccount.Store 实现）。
//
// 只用来确认「账号引用存在且属于该 Provider」；凭据是否存在属于后续用例判定。
type AccountReader interface {
	GetByRef(ctx context.Context, accountRef accountcore.AccountRef) (accountcore.Account, error)
}

// Dependencies 汇总四条路由的依赖。
type Dependencies struct {
	Authorizer Authorizer
	Accounts   AccountReader
	Desktop    *desktopsession.Service
	PlanStats  *planstats.Service
}

// Handler 处理 kimi 的账号级路由。
type Handler struct {
	authorizer Authorizer
	accounts   AccountReader
	desktop    *desktopsession.Service
	planStats  *planstats.Service
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		dependencies.Accounts == nil ||
		dependencies.Desktop == nil ||
		dependencies.PlanStats == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		accounts:   dependencies.Accounts,
		desktop:    dependencies.Desktop,
		planStats:  dependencies.PlanStats,
	}, nil
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

type planStatsView struct {
	OK     bool            `json:"ok"`
	Stats  planstats.Stats `json:"stats"`
	Cached bool            `json:"cached"`
}

type loginStartView struct {
	OK          bool   `json:"ok"`
	Code        string `json:"code"`
	QRURL       string `json:"qrUrl"`
	ExpiresAtMS int64  `json:"expiresAtMs"`
}

type loginStatusView struct {
	OK     bool   `json:"ok"`
	Status string `json:"status"`
}

type statusEvent struct {
	Type   string `json:"type"`
	Status string `json:"status"`
}

type errorEvent struct {
	Type  string `json:"type"`
	Error string `json:"error"`
}

type pollRequest struct {
	Code string `json:"code"`
}

// ServeHTTP 按路径分派四条路由；方法已由 ServeMux 的模式约束。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable,
			"kimi_account_unavailable", "kimi 账号服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	path := request.URL.Path
	switch {
	case strings.HasSuffix(path, "/desktop-session/start"):
		if !requireMethod(response, request, http.MethodPost) {
			return
		}
		handler.serveDesktopSessionStart(response, request)
	case strings.HasSuffix(path, "/desktop-session/poll"):
		if !requireMethod(response, request, http.MethodPost) {
			return
		}
		handler.serveDesktopSessionPoll(response, request)
	case strings.HasSuffix(path, "/desktop-session/watch"):
		if !requireMethod(response, request, http.MethodGet) {
			return
		}
		handler.serveDesktopSessionWatch(response, request)
	case strings.HasSuffix(path, "/plan-stats"):
		if !requireMethod(response, request, http.MethodGet) {
			return
		}
		handler.servePlanStats(response, request)
	default:
		writeError(response, http.StatusNotFound, "not_found", "")
	}
}

// requireMethod 在直接调用 Handler 时给出 405；ServeMux 已按方法注册。
func requireMethod(response http.ResponseWriter, request *http.Request, method string) bool {
	if request.Method == method {
		return true
	}
	response.Header().Set("Allow", method)
	writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 "+method)
	return false
}

// servePlanStats 读取套餐配额。
//
// 错误语义与 Node handleKimiPlanStatsRequest 一致：未托管桌面端返回 400 +
// desktop_session_missing（前端据此打开扫码弹窗），token 续期失败 401，其余 502。
func (handler *Handler) servePlanStats(response http.ResponseWriter, request *http.Request) {
	accountRef, ok := handler.authorizeAccount(response, request)
	if !ok {
		return
	}
	refresh := request.URL.Query().Get("refresh") == "1"
	result, err := handler.planStats.Fetch(request.Context(), accountRef, refresh)
	if err != nil {
		writePlanStatsError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, planStatsView{
		OK: true, Stats: result.Stats, Cached: result.Cached,
	})
}

// writePlanStatsError 把领域错误映射成 Node 同一张状态码表。
func writePlanStatsError(response http.ResponseWriter, err error) {
	code := errorCode(err)
	switch {
	case code == "desktop_session_missing":
		writeJSON(response, http.StatusBadRequest, errorView{
			OK: false, Error: "desktop_session_missing",
			Code: "desktop_session_missing", Message: missingSessionMessage,
		})
	case isDesktopSessionError(err):
		writeError(response, http.StatusUnauthorized, code, "")
	case code != "":
		writeError(response, http.StatusBadGateway, code, "")
	default:
		writeError(response, http.StatusBadGateway, "plan_stats_failed:"+truncate(err.Error(), 120), "")
	}
}

// serveDesktopSessionStart 创建官方登录二维码。
func (handler *Handler) serveDesktopSessionStart(response http.ResponseWriter, request *http.Request) {
	accountRef, ok := handler.authorizeAccount(response, request)
	if !ok {
		return
	}
	result, err := handler.desktop.Start(request.Context(), accountRef)
	if err != nil {
		if failureCode := errorCode(err); failureCode != "" {
			writeError(response, http.StatusBadGateway, failureCode, "")
			return
		}
		writeError(response, http.StatusBadGateway,
			"create_qrcode_failed:"+truncate(err.Error(), 120), "")
		return
	}
	writeJSON(response, http.StatusOK, loginStartView{
		OK: true, Code: result.Code, QRURL: result.QRURL, ExpiresAtMS: result.ExpiresAtMS,
	})
}

// serveDesktopSessionPoll 轮询扫码状态；SUCCESS 时会话已由领域层写入账号凭据。
func (handler *Handler) serveDesktopSessionPoll(response http.ResponseWriter, request *http.Request) {
	accountRef, ok := handler.authorizeAccount(response, request)
	if !ok {
		return
	}
	code := strings.TrimSpace(readPollCode(request))
	if code == "" {
		writeError(response, http.StatusBadRequest, "missing_code", "")
		return
	}
	result, err := handler.desktop.Poll(request.Context(), accountRef, code)
	if err != nil {
		if desktopsession.IsStoreFailure(err) {
			writeError(response, http.StatusInternalServerError, "desktop_session_store_failed", "")
			return
		}
		if failureCode := errorCode(err); failureCode != "" {
			writeError(response, http.StatusBadGateway, failureCode, "")
			return
		}
		writeError(response, http.StatusBadGateway,
			"qrcode_status_failed:"+truncate(err.Error(), 120), "")
		return
	}
	writeJSON(response, http.StatusOK, loginStatusView{OK: true, Status: string(result.Status)})
}

// serveDesktopSessionWatch 以 SSE 推送扫码状态。
//
// 上游只有轮询接口，2s 的节奏在 Go 领域层；Node 只透传字节流，WebUI 只收事件。
func (handler *Handler) serveDesktopSessionWatch(response http.ResponseWriter, request *http.Request) {
	accountRef, ok := handler.authorizeAccount(response, request)
	if !ok {
		return
	}
	code := strings.TrimSpace(request.URL.Query().Get("code"))
	if code == "" {
		writeError(response, http.StatusBadRequest, "missing_code", "")
		return
	}
	flusher, supported := response.(http.Flusher)
	if !supported {
		writeError(response, http.StatusInternalServerError, "sse_unsupported", "")
		return
	}
	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	flusher.Flush()

	handler.desktop.Watch(
		request.Context(),
		accountRef,
		code,
		func(status desktopsession.LoginStatus, err error) bool {
			if err != nil {
				return writeEvent(response, flusher, errorEvent{
					Type: "error", Error: watchErrorCode(err),
				})
			}
			return writeEvent(response, flusher, statusEvent{
				Type: "status", Status: string(status.Status),
			})
		},
	)
}

// watchErrorCode 与 Node watch 的错误码映射一致：store 失败保持原码，其余异常加前缀。
func watchErrorCode(err error) string {
	if desktopsession.IsStoreFailure(err) {
		return "desktop_session_store_failed"
	}
	if code := errorCode(err); code != "" {
		return code
	}
	return "qrcode_status_failed:" + truncate(err.Error(), 120)
}

// authorizeAccount 校验 Provider 作用域与账号归属，返回路径里的账号引用。
//
// Provider 作用域与 Node requireAccountRouteScope 一致：只有 kimi 有这四个能力，
// 其它 Provider 是 400 unsupported_provider；账号不存在或归属不符都是 404。
func (handler *Handler) authorizeAccount(
	response http.ResponseWriter,
	request *http.Request,
) (string, bool) {
	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider == "" || accountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "")
		return "", false
	}
	if provider != desktopsession.ProviderID {
		writeError(response, http.StatusBadRequest, "unsupported_provider", "")
		return "", false
	}
	ref, err := accountcore.ParseAccountRef(accountRef)
	if err != nil {
		writeError(response, http.StatusNotFound, "account_not_found", "")
		return "", false
	}
	account, err := handler.accounts.GetByRef(request.Context(), ref)
	if err != nil {
		if errors.Is(err, accountapp.ErrAccountNotFound) {
			writeError(response, http.StatusNotFound, "account_not_found", "")
			return "", false
		}
		writeError(response, http.StatusInternalServerError, "account_lookup_failed", truncate(err.Error(), 120))
		return "", false
	}
	if strings.ToLower(account.ProviderID()) != provider {
		writeError(response, http.StatusNotFound, "account_not_found", "")
		return "", false
	}
	return accountRef, true
}

// readPollCode 解析 {code} 请求体；非法 JSON 归为缺 code（与 Node 同语义）。
func readPollCode(request *http.Request) string {
	if request.Body == nil {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil || len(body) > maxBodyBytes {
		return ""
	}
	var payload pollRequest
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	return payload.Code
}

// writeEvent 写一帧 SSE 并立即 flush；返回 false 表示下游已断开。
func writeEvent(response http.ResponseWriter, flusher http.Flusher, payload any) bool {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payload); err != nil {
		return false
	}
	frame := append([]byte("data: "), bytes.TrimRight(buffer.Bytes(), "\n")...)
	frame = append(frame, '\n', '\n')
	if _, err := response.Write(frame); err != nil {
		return false
	}
	flusher.Flush()
	return true
}

// errorCode 提取领域错误码；非领域错误返回空串。
func errorCode(err error) string {
	type coded interface {
		ErrorCode() string
	}
	var domainError coded
	if errors.As(err, &domainError) && domainError != nil {
		return domainError.ErrorCode()
	}
	return ""
}

// isDesktopSessionError 判断错误是否来自桌面会话领域（token 续期失败 = 401）。
func isDesktopSessionError(err error) bool {
	var domainError *desktopsession.Error
	return errors.As(err, &domainError) && domainError != nil
}

// truncate 截断排查文本。
func truncate(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit]
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
