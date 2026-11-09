package kirooauth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kiro"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"

	_ "modernc.org/sqlite"
)

// 协议事实（与 Node lib/account/kiro-device-authorization.js 同口径）：
//
//	POST https://oidc.<region>.amazonaws.com/client/register
//	  {clientName, clientType:"public", scopes, grantTypes:[device_code URN, refresh_token]}
//	  → {clientId, clientSecret, clientSecretExpiresAt}
//	POST https://oidc.<region>.amazonaws.com/device_authorization
//	  {clientId, clientSecret, startUrl}
//	  → {deviceCode, userCode, verificationUri(Complete), interval, expiresIn}
//	POST https://oidc.<region>.amazonaws.com/token
//	  {clientId, clientSecret, grantType:device_code URN, deviceCode}
//	  → {accessToken, refreshToken, expiresIn} | 400 {error:"authorization_pending"|"slow_down"|...}
//	POST https://codewhisperer.<region>.amazonaws.com/  （GetUsageLimits，补身份证据）
//
// 设备码流程没有回调：Job 框架用 Begin 拿验证地址与短码、用 Poll 推进。
const (
	// oidcClientName 是 OIDC public client 的登记名；官方 CLI 也用固定名字。
	oidcClientName = "aih"
	oidcClientType = "public"
	// builderIDStartURL 是 public Builder ID 的固定入口（官方 CLI 的 START_URL）。
	builderIDStartURL = "https://view.awsapps.com/start"

	registerPath            = "/client/register"
	deviceAuthorizationPath = "/device_authorization"
	deviceTokenPath         = "/token"

	deviceGrantType  = "urn:ietf:params:oauth:grant-type:device_code"
	refreshGrantType = "refresh_token"

	// usageTarget 是 GetUsageLimits 的 AWS JSON 1.0 操作名；身份证据只能来自它。
	usageTarget = "AmazonCodeWhispererService.GetUsageLimits"
	// evidenceSource 与 Node kiro-identity.js 完全一致，decoder 会逐字段校验。
	evidenceSource  = "aws-codewhisperer:GetUsageLimits"
	evidenceVersion = 1

	maxBodyBytes      = 64 * 1024
	maxUsageBodyBytes = 1024 * 1024

	// slowDownStep 是 RFC 8628 slow_down 的退避步长（与 Node 的 +5s 一致）。
	slowDownStep    = 5 * time.Second
	minInterval     = time.Second
	defaultInterval = 5 * time.Second
	maxInterval     = 30 * time.Second
	// defaultTokenTTL 与 Node 一致：上游没给 expiresIn 时按 1h 计。
	defaultTokenTTL = time.Hour
)

// Clock 返回判断设备码与令牌是否过期所需的当前时间。
type Clock func() time.Time

// oidcScopes 是官方 CLI 的 scopes（sso:account:access 被官方排除，这里也不请求）。
var oidcScopes = []string{
	"codewhisperer:completions",
	"codewhisperer:analysis",
	"codewhisperer:conversations",
}

// 编译期断言：登录流程必须同时满足 Job 框架的四个端口。
var (
	_ accountauth.OAuthProvider         = (*LoginProvider)(nil)
	_ accountauth.DeviceFlow            = (*loginFlow)(nil)
	_ accountauth.DeviceCodeProvider    = (*loginFlow)(nil)
	_ accountauth.AccountClaimsProvider = (*loginFlow)(nil)
)

// LoginProvider 是 AWS SSO OIDC Builder ID 设备码登录策略。
//
// 每次 Begin 都重新登记一个 public client：Node 的入口也是每次登录注册一次，
// clientSecret 有独立有效期，复用会让过期时间变成账号刷新链路的隐藏故障点。
type LoginProvider struct {
	client    *http.Client
	clock     Clock
	oidcBase  func(region string) string
	usageBase func(region string) string
}

// loginOptions 仅供包内测试替换端点与时钟。
type loginOptions struct {
	client    *http.Client
	clock     Clock
	oidcBase  func(region string) string
	usageBase func(region string) string
}

// NewLogin 创建固定使用 AWS 生产端点的 Builder ID 登录策略。
func NewLogin(client *http.Client, clock Clock) (*LoginProvider, error) {
	return newLogin(loginOptions{
		client: client,
		clock:  clock,
		oidcBase: func(region string) string {
			return "https://oidc." + region + ".amazonaws.com"
		},
		usageBase: func(region string) string {
			return "https://codewhisperer." + region + ".amazonaws.com"
		},
	})
}

// newLogin 校验可注入依赖；生产构造器不暴露端点覆盖能力。
func newLogin(options loginOptions) (*LoginProvider, error) {
	if options.client == nil ||
		options.clock == nil ||
		options.oidcBase == nil ||
		options.usageBase == nil {
		return nil, accountauth.ErrInvalidDependencies
	}
	return &LoginProvider{
		client:    options.client,
		clock:     options.clock,
		oidcBase:  options.oidcBase,
		usageBase: options.usageBase,
	}, nil
}

// ProviderID 返回规范 kiro Provider ID。
func (*LoginProvider) ProviderID() string { return ProviderID }

// Begin 登记 OIDC client 并申请设备码，把 verification_uri(_complete) 作为授权地址。
func (provider *LoginProvider) Begin(ctx context.Context) (accountauth.OAuthFlow, error) {
	if provider == nil || provider.client == nil || provider.clock == nil {
		return nil, accountauth.ErrInvalidDependencies
	}
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(accountauth.ErrProviderUnavailable, err)
	}
	// WebUI 的 Builder ID 入口不传 region/startUrl（Node 同路径只用默认值）；
	// 企业 IdC 的 startUrl 由 CLI 承担，不在这一层开放配置面。
	region := kiro.DefaultRegion
	registration, err := provider.registerClient(ctx, region)
	if err != nil {
		return nil, err
	}
	started, err := provider.startDeviceAuthorization(ctx, region, registration)
	if err != nil {
		return nil, err
	}
	return &loginFlow{
		client:        provider.client,
		clock:         provider.clock,
		oidcBase:      provider.oidcBase(region),
		usageBase:     provider.usageBase(region),
		region:        region,
		registration:  registration,
		deviceCode:    started.deviceCode,
		userCode:      started.userCode,
		authorization: started.verificationURIComplete,
		expiresAt:     provider.clock().UTC().Add(time.Duration(started.expiresIn) * time.Second),
		interval:      normalizeInterval(started.interval),
	}, nil
}

// oidcRegistration 是一次 /client/register 的结果，随 artifact 一起落库。
type oidcRegistration struct {
	clientID              string
	clientSecret          string
	clientSecretExpiresAt string
	region                string
}

// registerClient 走 /client/register 登记 public client。
func (provider *LoginProvider) registerClient(
	ctx context.Context,
	region string,
) (oidcRegistration, error) {
	result, err := postJSON(
		ctx,
		provider.client,
		provider.oidcBase(region)+registerPath,
		map[string]any{
			"clientName": oidcClientName,
			"clientType": oidcClientType,
			"scopes":     oidcScopes,
			"grantTypes": []string{deviceGrantType, refreshGrantType},
		},
		maxBodyBytes,
	)
	if err != nil {
		return oidcRegistration{}, err
	}
	if result.status != http.StatusOK {
		return oidcRegistration{}, statusError(result.status)
	}
	var payload struct {
		ClientID              string  `json:"clientId"`
		ClientSecret          string  `json:"clientSecret"`
		ClientSecretExpiresAt float64 `json:"clientSecretExpiresAt"`
	}
	if err := oauthutil.DecodeJSONResponse(bytes.NewReader(result.body), maxBodyBytes, &payload); err != nil {
		return oidcRegistration{}, accountauth.ErrProviderUnavailable
	}
	if !validLoginSecret(payload.ClientID) || !validLoginSecret(payload.ClientSecret) {
		return oidcRegistration{}, accountauth.ErrProviderRejected
	}
	registration := oidcRegistration{
		clientID:     payload.ClientID,
		clientSecret: payload.ClientSecret,
		region:       region,
	}
	if payload.ClientSecretExpiresAt > 0 {
		registration.clientSecretExpiresAt = time.Unix(
			int64(payload.ClientSecretExpiresAt),
			0,
		).UTC().Format(time.RFC3339)
	}
	return registration, nil
}

// startedDevice 是一次 /device_authorization 的结果。
type startedDevice struct {
	deviceCode              string
	userCode                string
	verificationURIComplete string
	interval                int64
	expiresIn               int64
}

// startDeviceAuthorization 申请用户码；校验失败时立刻拒绝，避免界面永远轮询。
func (provider *LoginProvider) startDeviceAuthorization(
	ctx context.Context,
	region string,
	registration oidcRegistration,
) (startedDevice, error) {
	result, err := postJSON(
		ctx,
		provider.client,
		provider.oidcBase(region)+deviceAuthorizationPath,
		map[string]any{
			"clientId":     registration.clientID,
			"clientSecret": registration.clientSecret,
			"startUrl":     builderIDStartURL,
		},
		maxBodyBytes,
	)
	if err != nil {
		return startedDevice{}, err
	}
	if result.status != http.StatusOK {
		return startedDevice{}, statusError(result.status)
	}
	var payload struct {
		DeviceCode              string `json:"deviceCode"`
		UserCode                string `json:"userCode"`
		VerificationURI         string `json:"verificationUri"`
		VerificationURIComplete string `json:"verificationUriComplete"`
		Interval                int64  `json:"interval"`
		ExpiresIn               int64  `json:"expiresIn"`
	}
	if err := oauthutil.DecodeJSONResponse(bytes.NewReader(result.body), maxBodyBytes, &payload); err != nil {
		return startedDevice{}, accountauth.ErrProviderUnavailable
	}
	verification := strings.TrimSpace(payload.VerificationURI)
	complete := strings.TrimSpace(payload.VerificationURIComplete)
	if complete == "" {
		// Node 的回落：没有 complete 链接时用基础验证地址。
		complete = verification
	}
	authorization, err := resolveVerificationURL(provider.oidcBase(region), complete)
	if err != nil {
		return startedDevice{}, accountauth.ErrProviderRejected
	}
	if !validLoginSecret(payload.DeviceCode) ||
		!validLoginSecret(payload.UserCode) ||
		!validAuthorizationURL(authorization) ||
		payload.ExpiresIn <= 0 {
		return startedDevice{}, accountauth.ErrProviderRejected
	}
	return startedDevice{
		deviceCode:              payload.DeviceCode,
		userCode:                payload.UserCode,
		verificationURIComplete: authorization,
		interval:                payload.Interval,
		expiresIn:               payload.ExpiresIn,
	}, nil
}

// loginFlow 私有持有一次设备码会话。
type loginFlow struct {
	client        *http.Client
	clock         Clock
	oidcBase      string
	usageBase     string
	region        string
	registration  oidcRegistration
	deviceCode    string
	userCode      string
	authorization string
	expiresAt     time.Time
	interval      time.Duration
	// grant 在 token 已经签发后保留：device code 已被消费，再次请求只会得到
	// expired_token，身份探测的瞬时失败必须靠这份 grant 重试而不是重新轮询。
	grant *deviceGrant
	// terminal 缓存终态：轮询是幂等的，重复 Poll 不再打上游。
	terminal *PollResult
	claims   accountauth.Account
}

// PollStatus 复用应用层设备码词汇。
type PollStatus = accountauth.DeviceStatus

const (
	// PollPending 表示用户还没完成授权。
	PollPending = accountauth.DevicePending
	// PollSlowDown 表示轮询过快，应按 Interval 退避。
	PollSlowDown = accountauth.DeviceSlowDown
	// PollReady 表示授权完成，Artifacts 可交给账号注册链。
	PollReady = accountauth.DeviceReady
	// PollFailed 表示上游明确拒绝（access_denied 等）。
	PollFailed = accountauth.DeviceFailed
	// PollExpired 表示设备码已过期，需要重新发起。
	PollExpired = accountauth.DeviceExpired
)

// PollResult 是一次轮询的结果（与应用层 DevicePoll 同构）。
type PollResult = accountauth.DevicePoll

var (
	// ErrAuthorizationPending 表示设备授权尚未完成（Exchange 单次轮询的返回值）。
	ErrAuthorizationPending = errors.New("kiro 设备授权尚未完成")
	// ErrSlowDown 表示轮询过快（Exchange 单次轮询的返回值）。
	ErrSlowDown = errors.New("kiro 设备授权轮询过快")
)

// AuthorizationURL 返回浏览器验证地址（优先带 code 的完整链接）。
func (flow *loginFlow) AuthorizationURL() string { return flow.authorization }

// UserCode 返回需要用户核对/输入的设备码。
func (flow *loginFlow) UserCode() string { return flow.userCode }

// PollInterval 返回当前建议的轮询间隔。
func (flow *loginFlow) PollInterval() time.Duration { return flow.interval }

// AccountClaims 返回 ready 后可直接展示的公开账号字段。
func (flow *loginFlow) AccountClaims() accountauth.Account {
	if flow == nil {
		return accountauth.Account{}
	}
	return flow.claims
}

// Exchange 执行一次轮询，供只认 Exchange 的调用方使用。
//
// 设备码流程没有回调：Job 框架按 PollInterval 反复调用 Poll；这里只抹平端口，
// pending / slow_down 用可识别的哨兵错误返回，不能当成终态失败。
func (flow *loginFlow) Exchange(ctx context.Context, _ string) ([]byte, error) {
	result, err := flow.Poll(ctx)
	if err != nil {
		return nil, err
	}
	switch result.Status {
	case PollReady:
		return result.Artifacts, nil
	case PollPending:
		return nil, ErrAuthorizationPending
	case PollSlowDown:
		return nil, ErrSlowDown
	default:
		return nil, accountauth.ErrProviderRejected
	}
}

// Poll 执行一次设备码轮询。
//
// 正常返回只包含 pending / slow_down / ready / failed / expired；网络与 5xx
// 以 accountauth.ErrProviderUnavailable 返回，由调用方决定是否重试。
func (flow *loginFlow) Poll(ctx context.Context) (PollResult, error) {
	if flow == nil || flow.client == nil {
		return PollResult{}, accountauth.ErrInvalidDependencies
	}
	if flow.terminal != nil {
		return *flow.terminal, nil
	}
	if flow.grant != nil {
		// token 已签发：只重试身份探测，绝不能再拿同一个 device code 换码。
		return flow.materialize(ctx, *flow.grant)
	}
	if !flow.clock().UTC().Before(flow.expiresAt) {
		return flow.finish(PollResult{Status: PollExpired}), nil
	}
	result, err := postJSON(
		ctx,
		flow.client,
		flow.oidcBase+deviceTokenPath,
		map[string]any{
			"clientId":     flow.registration.clientID,
			"clientSecret": flow.registration.clientSecret,
			"grantType":    deviceGrantType,
			"deviceCode":   flow.deviceCode,
		},
		maxBodyBytes,
	)
	if err != nil {
		return PollResult{}, err
	}
	return flow.interpretToken(ctx, result)
}

// deviceTokenPayload 是设备码轮询的成功响应。
type deviceTokenPayload struct {
	AccessToken  string  `json:"accessToken"`
	RefreshToken string  `json:"refreshToken"`
	ExpiresIn    float64 `json:"expiresIn"`
}

// deviceError 是设备码轮询的业务错误体。
type deviceError struct {
	Error string `json:"error"`
}

// deviceGrant 是一次成功换码的结果。
type deviceGrant struct {
	accessToken  string
	refreshToken string
	expiresAt    time.Time
	region       string
}

// interpretToken 把 /token 的状态码与业务错误归一成轮询状态。
func (flow *loginFlow) interpretToken(
	ctx context.Context,
	result *httpResult,
) (PollResult, error) {
	// 408/429 是「先别问」，与 slow_down 等价。
	if result.status == http.StatusRequestTimeout || result.status == http.StatusTooManyRequests {
		return flow.slowDown(), nil
	}
	if result.status >= 500 {
		return PollResult{}, accountauth.ErrProviderUnavailable
	}
	if result.status >= 400 && result.status < 500 {
		return flow.handleDeviceError(result), nil
	}
	var payload deviceTokenPayload
	if err := oauthutil.DecodeJSONResponse(bytes.NewReader(result.body), maxBodyBytes, &payload); err != nil {
		return PollResult{}, accountauth.ErrProviderUnavailable
	}
	// 账号凭据必须能刷新：刷新链路同时需要 access/refresh，缺一不允许落库。
	if !validLoginSecret(payload.AccessToken) || !validLoginSecret(payload.RefreshToken) {
		return PollResult{}, accountauth.ErrProviderRejected
	}
	ttl := defaultTokenTTL
	if payload.ExpiresIn > 0 {
		ttl = time.Duration(payload.ExpiresIn * float64(time.Second))
	}
	grant := deviceGrant{
		accessToken:  payload.AccessToken,
		refreshToken: payload.RefreshToken,
		expiresAt:    flow.clock().UTC().Add(ttl),
		region:       flow.region,
	}
	flow.grant = &grant
	// 设备码已被消费：之后只走身份探测，不再回 token 端点。
	flow.deviceCode = ""
	return flow.materialize(ctx, grant)
}

// handleDeviceError 把 4xx 业务错误归一成轮询状态。
func (flow *loginFlow) handleDeviceError(result *httpResult) PollResult {
	var failure deviceError
	if err := oauthutil.DecodeJSONResponse(bytes.NewReader(result.body), maxBodyBytes, &failure); err != nil {
		// 4xx 却读不出业务错误：上游合同已经异常，按失败收敛，避免无限轮询。
		return flow.finish(PollResult{Status: PollFailed})
	}
	switch strings.ToLower(strings.TrimSpace(failure.Error)) {
	case "authorization_pending":
		return PollResult{Status: PollPending, Interval: flow.interval}
	case "slow_down":
		return flow.slowDown()
	case "expired_token":
		return flow.finish(PollResult{Status: PollExpired})
	case "access_denied":
		return flow.finish(PollResult{Status: PollFailed})
	default:
		// clientSecret 过期/被吊销属于明确拒绝；继续轮询只会拖到设备码过期。
		return flow.finish(PollResult{Status: PollFailed})
	}
}

// slowDown 按 RFC 8628 的步长拉长轮询间隔。
func (flow *loginFlow) slowDown() PollResult {
	flow.interval += slowDownStep
	if flow.interval > maxInterval {
		flow.interval = maxInterval
	}
	return PollResult{Status: PollSlowDown, Interval: flow.interval}
}

// finish 记录终态并释放一次性设备码。
func (flow *loginFlow) finish(result PollResult) PollResult {
	flow.terminal = &result
	flow.deviceCode = ""
	return result
}

// materialize 用 access token 读取 GetUsageLimits 补齐身份证据，并生成可注册的 artifact。
func (flow *loginFlow) materialize(
	ctx context.Context,
	grant deviceGrant,
) (PollResult, error) {
	usage, err := flow.fetchUsageLimits(ctx, grant)
	if err != nil {
		if errors.Is(err, accountauth.ErrProviderRejected) {
			// 身份证明失败是确定性的：同一个 token 再问一次也不会有 userId，
			// 继续轮询只会把失败拖成「设备码过期」。
			return flow.finish(PollResult{Status: PollFailed}), nil
		}
		return PollResult{}, err
	}
	now := flow.clock().UTC()
	artifacts, err := buildArtifacts(flow.registration, grant, usage, now)
	if err != nil {
		return PollResult{}, err
	}
	flow.claims = accountauth.Account{
		Email:       usage.email,
		DisplayName: usage.email,
	}
	return flow.finish(PollResult{
		Status:    PollReady,
		Artifacts: artifacts,
		Account:   flow.claims,
	}), nil
}

// usageLimits 是身份探测需要的公开字段。
type usageLimits struct {
	userID string
	email  string
}

// fetchUsageLimits 调 GetUsageLimits 读取 userInfo.userId。
//
// 身份只认 userId：OIDC client id 标识的是应用而不是人，拿它做账号名会把所有
// Builder ID 账号并成一个。401/403 与「没有 userId」是确定性失败，立刻收敛；
// 5xx 与网络错误交给上层重试（grant 已缓存，不会重复换码）。
func (flow *loginFlow) fetchUsageLimits(
	ctx context.Context,
	grant deviceGrant,
) (usageLimits, error) {
	endpoint, err := url.Parse(strings.TrimSuffix(flow.usageBase, "/") + "/")
	if err != nil {
		return usageLimits{}, accountauth.ErrProviderUnavailable
	}
	input := map[string]string{
		"origin":          "CLI",
		"resourceType":    "AGENTIC_REQUEST",
		"isEmailRequired": "true",
	}
	query := url.Values{}
	for key, value := range input {
		query.Set(key, value)
	}
	endpoint.RawQuery = query.Encode()
	body, err := json.Marshal(input)
	if err != nil {
		return usageLimits{}, accountauth.ErrProviderUnavailable
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return usageLimits{}, accountauth.ErrProviderUnavailable
	}
	request.Header.Set("Authorization", "Bearer "+grant.accessToken)
	request.Header.Set("Content-Type", "application/x-amz-json-1.0")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("x-amz-target", usageTarget)
	response, err := flow.client.Do(request)
	if err != nil {
		return usageLimits{}, accountauth.ErrProviderUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return usageLimits{}, accountauth.ErrProviderRejected
	}
	if response.StatusCode != http.StatusOK {
		return usageLimits{}, accountauth.ErrProviderUnavailable
	}
	document, err := io.ReadAll(io.LimitReader(response.Body, maxUsageBodyBytes+1))
	if err != nil || len(document) == 0 || len(document) > maxUsageBodyBytes {
		return usageLimits{}, accountauth.ErrProviderUnavailable
	}
	var payload struct {
		UserInfo struct {
			UserID string `json:"userId"`
			Email  string `json:"email"`
		} `json:"userInfo"`
	}
	if err := oauthutil.DecodeJSONResponse(bytes.NewReader(document), maxUsageBodyBytes, &payload); err != nil {
		return usageLimits{}, accountauth.ErrProviderUnavailable
	}
	subject := strings.TrimSpace(payload.UserInfo.UserID)
	if !accountcore.ValidNativeSubject(subject) {
		return usageLimits{}, accountauth.ErrProviderRejected
	}
	return usageLimits{userID: subject, email: strings.TrimSpace(payload.UserInfo.Email)}, nil
}

// buildArtifacts 生成 native_auth_json：形状与 Node 从 data.sqlite3 投影出的凭据一致。
//
// 必须同时写 database（base64 sqlite）而不只是 auth/registration：Node 的启动链路
// （materializeProviderAuth → KIRO_TEST_DB_PATH）把 data.sqlite3 交给 kiro-cli，
// 只有 auth 的账号在那边会被判成 missing_projection，登录成功却打不开客户端。
func buildArtifacts(
	registration oidcRegistration,
	grant deviceGrant,
	usage usageLimits,
	now time.Time,
) ([]byte, error) {
	endpoint := "https://codewhisperer." + grant.region + ".amazonaws.com"
	binding := tokenBinding(endpoint, grant.accessToken, grant.refreshToken)
	if binding == "" {
		return nil, accountauth.ErrInvalidArtifacts
	}
	authRow := map[string]any{
		"access_token":  grant.accessToken,
		"refresh_token": grant.refreshToken,
		// 与 Node 的 toISOString() 同形：带毫秒的 UTC 时间。
		"expires_at": grant.expiresAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		"region":     grant.region,
	}
	registrationRow := map[string]any{
		"client_id":     registration.clientID,
		"client_secret": registration.clientSecret,
		"region":        registration.region,
		"oauth_flow":    "DeviceCode",
		"scopes":        oidcScopes,
	}
	if registration.clientSecretExpiresAt != "" {
		registrationRow["client_secret_expires_at"] = registration.clientSecretExpiresAt
	}
	database, err := buildCredentialDatabase(registrationRow, authRow)
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	nativeAuth, err := json.Marshal(map[string]any{
		"auth":         authRow,
		"registration": registrationRow,
		// flavor 显式落库：Builder ID 永远走 OIDC 刷新，不靠「有没有 registration」猜。
		"flavor":   "oidc",
		"database": database,
		"identityEvidence": map[string]any{
			"version":      evidenceVersion,
			"source":       evidenceSource,
			"endpoint":     endpoint,
			"subject":      usage.userID,
			"tokenBinding": binding,
			"observedAtMs": now.UnixMilli(),
		},
	})
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	artifacts, err := json.Marshal(struct {
		NativeAuthJSON json.RawMessage `json:"native_auth_json"`
	}{NativeAuthJSON: nativeAuth})
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	return artifacts, nil
}

// credentialDatabaseKeys 是 kiro-cli auth_kv 里 Builder ID 需要的两行。
const (
	credentialRegistrationKey = "kirocli:odic:device-registration"
	credentialTokenKey        = "kirocli:odic:token"
)

// buildCredentialDatabase 生成与 Node writeKiroCredentialDatabase 同构的 data.sqlite3，
// 返回整库文件的 base64。
//
// 为什么在这里临时建库：native_auth_json 的 database 是二进制快照，JSON 无法表达；
// Node 与 kiro-cli 都按 auth_kv 表读取，只有真实 SQLite 文件能同时满足两边。
func buildCredentialDatabase(
	registration map[string]any,
	auth map[string]any,
) (string, error) {
	directory, err := os.MkdirTemp("", "aih-kiro-login-")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(directory) }()
	databasePath := filepath.Join(directory, "data.sqlite3")
	registrationJSON, err := json.Marshal(registration)
	if err != nil {
		return "", err
	}
	authJSON, err := json.Marshal(auth)
	if err != nil {
		return "", err
	}
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		return "", err
	}
	closed := false
	defer func() {
		if !closed {
			_ = database.Close()
		}
	}()
	if _, err := database.Exec(`CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		return "", err
	}
	insert, err := database.Prepare(`INSERT INTO auth_kv (key, value) VALUES (?, ?)`)
	if err != nil {
		return "", err
	}
	defer func() { _ = insert.Close() }()
	if _, err := insert.Exec(credentialRegistrationKey, string(registrationJSON)); err != nil {
		return "", err
	}
	if _, err := insert.Exec(credentialTokenKey, string(authJSON)); err != nil {
		return "", err
	}
	// 必须先关库再读文件：modernc 的写入在 Close 前不保证全部刷盘。
	if err := database.Close(); err != nil {
		return "", err
	}
	closed = true
	bytes, err := os.ReadFile(databasePath)
	if err != nil || len(bytes) == 0 {
		return "", accountauth.ErrInvalidArtifacts
	}
	return base64.StdEncoding.EncodeToString(bytes), nil
}

// tokenBinding 复刻 Node 的 kiroTokenBinding：JSON.stringify 无空格、不转义 HTML。
func tokenBinding(endpoint, access, refresh string) string {
	if !validLoginSecret(access) || !validLoginSecret(refresh) {
		return ""
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode([]string{endpoint, access, refresh}); err != nil {
		return ""
	}
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte{0x0a})
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

// httpResult 是一次已读取完的上游响应。
type httpResult struct {
	status int
	body   []byte
}

// postJSON 发送 JSON 请求；4xx 也交给调用方判断（设备码轮询的 pending /
// slow_down 都是 4xx 业务错误）。
func postJSON(
	ctx context.Context,
	client *http.Client,
	endpoint string,
	payload any,
	limit int64,
) (*httpResult, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, accountauth.ErrProviderUnavailable
	}
	return &httpResult{status: response.StatusCode, body: body}, nil
}

// statusError 把非 200 的握手响应映射成稳定错误：4xx 是合同/凭据问题，5xx 可重试。
func statusError(status int) error {
	if status >= 400 && status < 500 {
		return accountauth.ErrProviderRejected
	}
	return accountauth.ErrProviderUnavailable
}

// normalizeInterval 把上游的秒级间隔收敛到 [1s, 30s]，缺省 5s。
func normalizeInterval(seconds int64) time.Duration {
	if seconds <= 0 {
		return defaultInterval
	}
	interval := time.Duration(seconds) * time.Second
	if interval < minInterval {
		return minInterval
	}
	if interval > maxInterval {
		return maxInterval
	}
	return interval
}

// resolveVerificationURL 把上游返回的验证地址补成绝对地址。
//
// AWS 当前返回的是绝对地址；这里仍按 Node/opencode 的容错处理相对引用，
// 否则界面上会出现一段点不开的路径。
func resolveVerificationURL(base string, raw string) (string, error) {
	reference, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || strings.TrimSpace(raw) == "" {
		return "", accountauth.ErrProviderRejected
	}
	if reference.IsAbs() {
		return reference.String(), nil
	}
	parsedBase, err := url.Parse(base)
	if err != nil || parsedBase.Host == "" {
		return "", accountauth.ErrProviderRejected
	}
	parsedBase.Path = strings.TrimSuffix(parsedBase.Path, "/") + "/"
	parsedBase.RawQuery = ""
	parsedBase.Fragment = ""
	return parsedBase.ResolveReference(reference).String(), nil
}

// validAuthorizationURL 校验验证地址是浏览器可直接打开的绝对地址。
func validAuthorizationURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil &&
		(parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Host != "" &&
		parsed.User == nil
}

// validLoginSecret 拒绝空白和控制字符，但从不把原值写入错误。
func validLoginSecret(value string) bool {
	return value != "" &&
		value == strings.TrimSpace(value) &&
		strings.IndexFunc(value, func(character rune) bool {
			return character == 0 || character == 0x0d || character == 0x0a
		}) < 0
}
