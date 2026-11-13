// Package desktopsession 托管 kimi 桌面版（Kimi Work）的 web session。
//
// 协议事实与 Node lib/server/kimi-desktop-session.js 同源：桌面 App 的登录态是
// kimi.com web session（access_token/refresh_token），与 kimi-code CLI 的 OAuth
// token（scope=kimi-code）不可互换。托管入口使用官方扫码登录 RPC：
//
//	POST {base}/account.gateway.v1.AuthService/CreateLoginQRCode
//	POST {base}/account.gateway.v1.AuthService/GetLoginQRCodeStatus  {code}
//	POST {base}/account.gateway.v1.AuthService/RefreshToken              {refresh_token}
//
// 用户用微信扫码确认后，GetLoginQRCodeStatus 返回 STATUS_SUCCESS + web tokens；
// 本包把会话写进账号凭据（nativeAuth.desktopSession），桌面启动时再物化到隔离
// profile 的 token store。refresh_token 随用轮换，RefreshToken RPC 负责续期。
package desktopsession

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// ProviderID 是本包唯一服务的 Provider。
	ProviderID = "kimi"
	// DefaultAuthBaseURL 与 Node DEFAULT_AUTH_BASE_URL 同值。
	DefaultAuthBaseURL = "https://auth.kimi.com/api"
	// defaultTimeout 与 Node DEFAULT_TIMEOUT_MS（10s）一致。
	defaultTimeout = 10 * time.Second
	// accessTokenSkew 与 Node ACCESS_TOKEN_SKEW_MS 一致：web access_token 实测
	// 15 分钟有效，提前 2 分钟续期。
	accessTokenSkew = 2 * time.Minute
	// qrCodeTTL 与 Node QR_CODE_TTL_MS 一致。
	qrCodeTTL = 3 * time.Minute
	// maxResponseBytes 约束上游响应，避免异常网关把内存打满。
	maxResponseBytes = 1 << 20
	// authService 是官方 Connect RPC 服务名。
	authService = "account.gateway.v1.AuthService"
)

// Status 是官方二维码状态枚举（字符串值与上游一致）。
type Status string

const (
	// StatusPending 表示二维码已生成、等待扫码。
	StatusPending Status = "STATUS_PENDING"
	// StatusScanned 表示已扫码、等待确认。
	StatusScanned Status = "STATUS_SCANNED"
	// StatusExpired 表示二维码已过期。
	StatusExpired Status = "STATUS_EXPIRED"
	// StatusSuccess 表示登录确认完成，tokens 已下发。
	StatusSuccess Status = "STATUS_SUCCESS"
)

var (
	// ErrInvalidDependencies 表示 Service 缺少凭据存储或 HTTP 传输。
	ErrInvalidDependencies = errors.New("kimi 桌面端会话依赖无效")
	// ErrInvalidAccountRef 表示账号引用不是合法形态。
	ErrInvalidAccountRef = errors.New("kimi 桌面端会话账号引用无效")
)

// Session 是托管的 web session（与 Node nativeAuth.desktopSession 同形）。
type Session struct {
	AccessToken  string
	RefreshToken string
	UserID       string
	UpdatedAtMS  int64
}

// LoginStart 是一次扫码登录的公开结果。
type LoginStart struct {
	Code        string
	QRURL       string
	ExpiresAtMS int64
}

// LoginStatus 是一次扫码状态查询的结果；Success 时带 web tokens。
type LoginStatus struct {
	Status       Status
	AccessToken  string
	RefreshToken string
	UserID       string
}

// Store 读写账号的托管会话（生产由 CredentialStore 实现）。
//
// found=false 表示账号没有托管会话（不是错误）；返回 error 表示存储不可用，
// 调用方必须失败关闭，不能把它当成「未登录」静默继续。
type Store interface {
	Read(ctx context.Context, accountRef string) (Session, bool, error)
	Write(ctx context.Context, accountRef string, session Session) error
}

// HTTPClient 是上游 RPC 的唯一传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// TransportResolver 按账号解析出口（账号级 egress 绑定）。
//
// 返回 nil 表示没有绑定，使用默认客户端；返回 error 表示解析失败，调用方必须
// fail-closed（与 Node resolveProviderAccountEgressRequestOptions 一致）。
type TransportResolver func(ctx context.Context, accountRef string) (HTTPClient, error)

// Error 是带稳定错误码的领域失败。
//
// Code 与 Node 的 error 字段逐字对齐（例如 create_qrcode_http_502、qrcode_status_http_500、
// desktop_session_refresh_unauthorized）；Detail 仅用于排查，不写入上游凭据。
type Error struct {
	Code   string
	Detail string
}

// Error 输出 code 或 code: detail。
func (err *Error) Error() string {
	if err == nil {
		return ""
	}
	if strings.TrimSpace(err.Detail) == "" {
		return err.Code
	}
	return err.Code + ": " + err.Detail
}

// ErrorCode 让上层按稳定错误码分支，不必依赖文案。
func (err *Error) ErrorCode() string {
	if err == nil {
		return ""
	}
	return err.Code
}

// newError 创建只带错误码的领域失败。
func newError(code string) *Error { return &Error{Code: code} }

// errorCode 提取领域错误码；非领域错误返回空串。
func errorCode(err error) string {
	var domainError *Error
	if errors.As(err, &domainError) && domainError != nil {
		return domainError.Code
	}
	return ""
}

// IsMissingSession 判断错误是否表示账号没有托管会话。
func IsMissingSession(err error) bool {
	return errorCode(err) == "desktop_session_missing"
}

// IsStoreFailure 判断错误是否表示托管会话写入失败。
func IsStoreFailure(err error) bool {
	return errorCode(err) == "desktop_session_store_failed"
}

// Options 是可注入的端点与时钟参数。
type Options struct {
	// BaseURL 默认 DefaultAuthBaseURL；生产可由宿主配置覆盖。
	BaseURL string
	// HTTPClient 是默认传输；Transport 返回 nil 时使用它。
	HTTPClient HTTPClient
	// Transport 解析账号级出口；nil 表示全部直连默认客户端。
	Transport TransportResolver
	// Timeout 是单次 RPC 上限；零值使用 defaultTimeout。
	Timeout time.Duration
	// Now 是时钟（测试用）；nil 使用 time.Now。
	Now func() time.Time
}

// Service 是扫码登录与 token 续期的用例层。
type Service struct {
	store     Store
	client    HTTPClient
	transport TransportResolver
	baseURL   string
	timeout   time.Duration
	now       func() time.Time
}

// New 创建生产可用的 Service。
func New(store Store, options Options) (*Service, error) {
	if store == nil {
		return nil, ErrInvalidDependencies
	}
	baseURL := strings.TrimRight(strings.TrimSpace(options.BaseURL), "/")
	if baseURL == "" {
		baseURL = DefaultAuthBaseURL
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		store:     store,
		client:    client,
		transport: options.Transport,
		baseURL:   baseURL,
		timeout:   timeout,
		now:       now,
	}, nil
}

// Start 创建官方登录二维码。
func (service *Service) Start(ctx context.Context, accountRef string) (LoginStart, error) {
	if _, err := normalizeAccountRef(accountRef); err != nil {
		return LoginStart{}, err
	}
	status, payload, err := service.call(ctx, accountRef, "CreateLoginQRCode", map[string]any{}, "")
	if err != nil {
		return LoginStart{}, err
	}
	code := readStringField(payload, "code")
	if status != http.StatusOK || code == "" {
		return LoginStart{}, newError(fmt.Sprintf("create_qrcode_http_%s", statusText(status)))
	}
	return LoginStart{
		Code: code,
		// 与官方登录页一致：微信扫码打开 /wechat/mp/auth?id=<code> 完成确认。
		QRURL:       "https://www.kimi.com/wechat/mp/auth?id=" + strings.ReplaceAll(url.QueryEscape(code), "+", "%20"),
		ExpiresAtMS: service.now().Add(qrCodeTTL).UnixMilli(),
	}, nil
}

// Status 查询一次扫码状态；不写入会话。
func (service *Service) Status(ctx context.Context, accountRef string, code string) (LoginStatus, error) {
	normalizedCode := strings.TrimSpace(code)
	if normalizedCode == "" {
		return LoginStatus{}, newError("missing_code")
	}
	if _, err := normalizeAccountRef(accountRef); err != nil {
		return LoginStatus{}, err
	}
	status, payload, err := service.call(ctx, accountRef, "GetLoginQRCodeStatus", map[string]any{"code": normalizedCode}, "")
	if err != nil {
		return LoginStatus{}, err
	}
	if status != http.StatusOK || payload == nil {
		return LoginStatus{}, newError(fmt.Sprintf("qrcode_status_http_%s", statusText(status)))
	}
	state := Status(strings.TrimSpace(readStringField(payload, "status")))
	if state == "" {
		state = StatusPending
	}
	result := LoginStatus{Status: state}
	if state == StatusSuccess {
		// 官方 Kimi Work 3.2.1 的 Connect 客户端把 protobuf 字段解码为 camelCase；
		// 保留 snake_case 兼容直接返回 proto field name 的网关。
		result.AccessToken = readStringField(payload, "accessToken", "access_token")
		result.RefreshToken = readStringField(payload, "refreshToken", "refresh_token")
		result.UserID = readStringField(payload, "userId", "user_id")
		if result.AccessToken == "" || result.RefreshToken == "" {
			return LoginStatus{}, newError("qrcode_success_without_tokens")
		}
	}
	return result, nil
}

// Poll 查询扫码状态，并在 STATUS_SUCCESS 时把会话托管进账号凭据。
func (service *Service) Poll(ctx context.Context, accountRef string, code string) (LoginStatus, error) {
	result, err := service.Status(ctx, accountRef, code)
	if err != nil {
		return LoginStatus{}, err
	}
	if result.Status == StatusSuccess {
		if err := service.persist(ctx, accountRef, result); err != nil {
			return LoginStatus{}, newError("desktop_session_store_failed")
		}
	}
	return result, nil
}

// Watch 按 2s 间隔查询官方二维码状态并逐条回调；SSE 语义由调用方负责。
//
// emit 返回 false 表示下游已断开，立即停止；SUCCESS 与 EXPIRED 是终态。
// 上游失败时回调一次带错误码的结果（Status 为空）后返回。
func (service *Service) Watch(ctx context.Context, accountRef string, code string, emit func(LoginStatus, error) bool) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		result, err := service.Poll(ctx, accountRef, code)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			emit(LoginStatus{}, err)
			return
		}
		if !emit(result, nil) {
			return
		}
		if result.Status == StatusSuccess || result.Status == StatusExpired {
			return
		}
		timer.Reset(2 * time.Second)
	}
}

// EnsureAccessToken 返回可用于 Membership RPC 的新鲜 accessToken。
//
// access_token 过期（或 2 分钟内到期）时用托管的 refresh_token 走 RefreshToken RPC
// 续期并回写；refresh_token 随用轮换，必须整份写回。
func (service *Service) EnsureAccessToken(ctx context.Context, accountRef string) (string, error) {
	session, found, err := service.store.Read(ctx, accountRef)
	if err != nil {
		return "", err
	}
	if !found {
		return "", newError("desktop_session_missing")
	}
	expiryMS := parseJWTExpiryMS(session.AccessToken)
	if session.AccessToken != "" && expiryMS-service.now().UnixMilli() > accessTokenSkew.Milliseconds() {
		return session.AccessToken, nil
	}
	refreshed, err := service.refresh(ctx, accountRef, session)
	if err != nil {
		return "", err
	}
	return refreshed.AccessToken, nil
}

// ForceRefresh 无条件用 refresh_token 续期一次并回写。
//
// 用于 Membership RPC 返回 401/403 的场景：落盘的 access_token 可能刚好失效，
// 与 Node refreshWebAccessToken 的策略一致。
func (service *Service) ForceRefresh(ctx context.Context, accountRef string) (string, error) {
	session, found, err := service.store.Read(ctx, accountRef)
	if err != nil {
		return "", err
	}
	if !found {
		return "", newError("desktop_session_missing")
	}
	refreshed, err := service.refresh(ctx, accountRef, session)
	if err != nil {
		return "", err
	}
	return refreshed.AccessToken, nil
}

// refresh 调用 RefreshToken RPC 并回写轮换后的会话。
func (service *Service) refresh(
	ctx context.Context,
	accountRef string,
	session Session,
) (Session, error) {
	refreshToken := strings.TrimSpace(session.RefreshToken)
	if refreshToken == "" {
		return Session{}, newError("missing_refresh_token")
	}
	status, payload, err := service.call(
		ctx, accountRef, "RefreshToken", map[string]any{"refresh_token": refreshToken}, "",
	)
	if err != nil {
		return Session{}, err
	}
	accessToken := readStringField(payload, "accessToken", "access_token")
	if status != http.StatusOK || accessToken == "" {
		if status == http.StatusUnauthorized || status == http.StatusForbidden {
			return Session{}, newError("desktop_session_refresh_unauthorized")
		}
		return Session{}, newError(fmt.Sprintf("desktop_session_refresh_http_%s", statusText(status)))
	}
	nextRefreshToken := readStringField(payload, "refreshToken", "refresh_token")
	if nextRefreshToken == "" {
		nextRefreshToken = refreshToken
	}
	refreshed := Session{
		AccessToken:  accessToken,
		RefreshToken: nextRefreshToken,
		UserID:       session.UserID,
		UpdatedAtMS:  service.now().UnixMilli(),
	}
	// Node 回写失败被忽略（只返回刷新后的 token）；保持同一语义：RefreshToken RPC
	// 已经轮换 grant，写盘失败会在下一次 RPC 用旧 grant 报 invalid_grant，但本次
	// 调用仍能用新 token 完成请求。
	_ = service.store.Write(ctx, accountRef, refreshed)
	return refreshed, nil
}

// persist 把 STATUS_SUCCESS 的会话写入账号凭据。
func (service *Service) persist(ctx context.Context, accountRef string, status LoginStatus) error {
	return service.store.Write(ctx, accountRef, Session{
		AccessToken:  strings.TrimSpace(status.AccessToken),
		RefreshToken: strings.TrimSpace(status.RefreshToken),
		UserID:       strings.TrimSpace(status.UserID),
		UpdatedAtMS:  service.now().UnixMilli(),
	})
}
