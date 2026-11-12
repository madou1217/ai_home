// Package agyoauth 实现 Antigravity consumer Google OAuth 的 Token 刷新策略。
package agyoauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

const (
	tokenEndpoint = "https://oauth2.googleapis.com/token"
	maxTokenBytes = 256 * 1024
	// refreshAttemptTimeout 对齐 Node DEFAULT_REFRESH_TIMEOUT_MS（15s）。
	// Node 的 fetchWithTimeout 是每个候选凭据各自计时：一个候选卡死不能吃掉
	// 后续候选的预算，否则内置 legacy secret 根本没机会被尝试。
	refreshAttemptTimeout = 15 * time.Second
	// maxOAuthErrorDetail 对齐 Node sanitizeResponseText(text, 320)。
	maxOAuthErrorDetail = 320
)

type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Egress 是账号级出口绑定（读自 Node 的 account:egress:<ref>）。
//
// Mode 取值：空/default（跟随进程默认）、direct（绕过环境代理）、proxy（显式
// proxyUrl）。pool/tun/system/url 由宿主解析成 concrete target 后再以
// direct/proxy 传入，刷新策略不需要理解每种出口模式。
type Egress struct {
	Mode     string
	ProxyURL string
}

// EgressResolver 读取账号出口绑定；未绑定返回零值。
type EgressResolver func(context.Context, accountcore.AccountRef) (Egress, error)

// ClientFactory 按代理地址创建传输；空地址表示直连（不使用环境代理）。
type ClientFactory func(proxyURL string) HTTPClient

// Provider 是无共享可变账号状态的 AGY OAuth 刷新策略。
// 并发合并与版本 CAS 由 accountcredentials.Resolver 统一负责。
type Provider struct {
	client            HTTPClient
	tokenEndpoint     string
	clientCredentials []clientCredential
	clientFactory     ClientFactory
	egress            EgressResolver
	// attemptTimeout 是单个候选凭据的换码超时；零值回落到 refreshAttemptTimeout。
	// 单独成字段只为让测试用毫秒级预算验证「候选超时继续下一个」。
	attemptTimeout time.Duration
}

var _ accountcredentials.RefreshStrategy = (*Provider)(nil)

// New 创建固定调用 Google 官方 Token Endpoint 的策略。
func New(client HTTPClient) (*Provider, error) {
	return newProvider(client, tokenEndpoint)
}

func newProvider(client HTTPClient, endpoint string) (*Provider, error) {
	parsed, err := url.Parse(endpoint)
	if client == nil || err != nil || parsed.Scheme == "" ||
		parsed.Host == "" || parsed.User != nil {
		return nil, accountcredentials.ErrInvalidDependencies
	}
	return &Provider{
		client:            client,
		tokenEndpoint:     endpoint,
		clientCredentials: defaultClientCredentials(),
		attemptTimeout:    refreshAttemptTimeout,
	}, nil
}

// NewWithEgress 创建带账号级出口的刷新策略。
//
// 只有 agy 这类「Go 独立刷新 + 账号可能有自定义出口」的 Provider 需要它；
// 两个依赖必须同时提供。
func NewWithEgress(
	client HTTPClient,
	factory ClientFactory,
	resolver EgressResolver,
) (*Provider, error) {
	if client == nil || factory == nil || resolver == nil {
		return nil, accountcredentials.ErrInvalidDependencies
	}
	provider, err := New(client)
	if err != nil {
		return nil, err
	}
	provider.clientFactory = factory
	provider.egress = resolver
	return provider, nil
}

func (*Provider) ProviderID() string { return agy.ProviderID }

func (*Provider) ExpiresAt(
	credential accountapp.Credential,
) (time.Time, bool) {
	auth, valid := credential.(*agy.OAuthAuth)
	if !valid || auth == nil || auth.ExpiresAtMS() <= 0 {
		return time.Time{}, false
	}
	return time.UnixMilli(auth.ExpiresAtMS()).UTC(), true
}

// Refresh 使用 form-urlencoded Google OAuth 合同取得新 Access Token。
func (provider *Provider) Refresh(
	ctx context.Context,
	credential accountapp.Credential,
	refreshedAt time.Time,
) (accountapp.Credential, error) {
	if provider == nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	return provider.refresh(ctx, credential, refreshedAt, provider.client)
}

// RefreshWithAccount 按账号出口绑定选择传输后刷新。
//
// 出口模式：
//   - 空/default：跟随进程默认传输（与环境变量代理一致）；
//   - direct：显式不走代理；
//   - proxy：使用绑定里的 proxyUrl；
//   - 其它未知模式：明确失败而不是静默走错出口；pool/tun/system/url 由
//     宿主 egress 解析器先落到 direct/proxy。
func (provider *Provider) RefreshWithAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	refreshedAt time.Time,
) (accountapp.Credential, error) {
	if provider == nil || provider.egress == nil || provider.clientFactory == nil {
		return provider.Refresh(ctx, credential, refreshedAt)
	}
	if !accountRef.IsValid() {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	binding, err := provider.egress(ctx, accountRef)
	if err != nil {
		return nil, errors.Join(accountcredentials.ErrRefreshUnavailable, err)
	}
	switch strings.ToLower(strings.TrimSpace(binding.Mode)) {
	case "", "default":
		return provider.Refresh(ctx, credential, refreshedAt)
	case "direct":
		return provider.refresh(
			ctx,
			credential,
			refreshedAt,
			provider.clientFactory(""),
		)
	case "proxy":
		proxyURL := strings.TrimSpace(binding.ProxyURL)
		if proxyURL == "" {
			return nil, fmt.Errorf(
				"%w: 账号出口为 proxy 但缺少 proxyUrl",
				accountcredentials.ErrRefreshUnavailable,
			)
		}
		return provider.refresh(
			ctx,
			credential,
			refreshedAt,
			provider.clientFactory(proxyURL),
		)
	default:
		return nil, fmt.Errorf(
			"%w: 账号出口模式 %q 未被宿主解析",
			accountcredentials.ErrRefreshUnavailable,
			binding.Mode,
		)
	}
}

// refresh 使用指定传输执行一次完整刷新。
func (provider *Provider) refresh(
	ctx context.Context,
	credential accountapp.Credential,
	refreshedAt time.Time,
	client HTTPClient,
) (accountapp.Credential, error) {
	auth, valid := credential.(*agy.OAuthAuth)
	if provider == nil || client == nil || ctx == nil ||
		!valid || auth == nil || refreshedAt.IsZero() ||
		refreshedAt.UnixMilli() <= 0 {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	// Google 轮换 installed-app client secret 后，登录可能已经落在新 secret 上，
	// 而旧 secret 对 refresh 不再被接受。Node 生产路径同样按顺序尝试候选凭据，
	// 只在 invalid_client 时换下一个；这里必须保持一致，否则登录成功、刷新必败。
	if len(provider.clientCredentials) == 0 {
		return nil, accountcredentials.ErrInvalidDependencies
	}
	// 每次刷新都重新构造候选切片：Provider 被所有账号共享，不能把去重结果写回
	// provider.clientCredentials 的底层数组（并发刷新时是数据竞争）。
	candidates := make([]clientCredential, 0, len(provider.clientCredentials)+1)
	// 凭据自带的自定义客户端优先：Node 的候选链也是先读 oauth.client_id /
	// oauth.token.client_id，再退回内置 secret。
	if auth.ClientID() != "" && auth.ClientSecret() != "" {
		candidates = append(candidates, clientCredential{
			clientID:     auth.ClientID(),
			clientSecret: auth.ClientSecret(),
		})
	}
	candidates = append(candidates, provider.clientCredentials...)
	// 去重：账号自带的客户端可能与内置默认完全相同，失败时不应该对同一个
	// client 连续发两次（Node 的 addCredentialCandidate 同样按 id+secret 去重）。
	seen := make(map[string]struct{}, len(candidates))
	unique := candidates[:0]
	for _, candidate := range candidates {
		key := candidate.clientID + "\x00" + candidate.clientSecret
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, candidate)
	}
	candidates = unique
	// knownSecrets 对齐 Node knownOauthSecrets：上游错误正文里若回显了 refresh
	// token / access token / client secret，写进错误前必须先替换。Node 用同一份
	// 清单做 detail 脱敏，Go 不返回响应正文，只对保留下来的 OAuth description 生效。
	knownSecrets := make([]string, 0, len(candidates)+2)
	knownSecrets = append(knownSecrets, auth.RefreshToken(), auth.AccessToken())
	for _, candidate := range candidates {
		knownSecrets = append(knownSecrets, candidate.clientSecret)
	}
	var lastErr error
	for _, candidate := range candidates {
		refreshed, retry, err := provider.refreshWithClient(
			ctx,
			client,
			auth,
			candidate,
			refreshedAt,
			knownSecrets,
		)
		if err == nil {
			return refreshed, nil
		}
		lastErr = err
		if !retry {
			return nil, err
		}
	}
	return nil, lastErr
}

// refreshWithClient 使用单个客户端凭据发起一次换码。
//
// 第二个返回值表示「可以换下一个候选凭据重试」：传输失败（含候选级 15s 超时）
// 和 invalid_client 都属此类（与 Node 生产路径一致）。invalid_grant、限流和
// 5xx 是终态结论，换 secret 不会改变结果，必须立即返回最后错误。
func (provider *Provider) refreshWithClient(
	ctx context.Context,
	client HTTPClient,
	auth *agy.OAuthAuth,
	clientCredential clientCredential,
	refreshedAt time.Time,
	knownSecrets []string,
) (accountapp.Credential, bool, error) {
	form := url.Values{
		"client_id":     {clientCredential.clientID},
		"client_secret": {clientCredential.clientSecret},
		"refresh_token": {auth.RefreshToken()},
		"grant_type":    {"refresh_token"},
	}
	// Node 的 fetchWithTimeout 按候选计时：每个候选各自 15s。这里用派生上下文
	// 实现同样语义，同时不会把调用方更短的截止时间延长。
	attemptTimeout := provider.attemptTimeout
	if attemptTimeout <= 0 {
		attemptTimeout = refreshAttemptTimeout
	}
	attemptCtx, cancel := context.WithTimeout(ctx, attemptTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		attemptCtx,
		http.MethodPost,
		provider.tokenEndpoint,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return nil, false, accountcredentials.ErrRefreshUnavailable
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")
	response, err := client.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, false, errors.Join(accountcredentials.ErrRefreshUnavailable, ctxErr)
		}
		// 单个 client 的网络失败或候选级超时不能终止整个候选链：Node 生产路径
		// 在同一位置 continue，内置 legacy secret 仍可能拿到 token（2026-10-22 真机）。
		return nil, true, accountcredentials.ErrRefreshUnavailable
	}
	if response == nil || response.Body == nil {
		return nil, true, accountcredentials.ErrRefreshUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		// 错误体解析复刻 Node parseOAuthErrorPayload：error 既可能是字符串，
		// 也可能是带 status/code/message 的对象（Google 的 OAuth 错误两种都会发）。
		parsed := parseOAuthErrorPayload(response.Body, maxTokenBytes)
		code := normalizeOAuthErrorCode(parsed.code, knownSecrets)
		classified := oauthutil.ClassifyRefreshError(response.StatusCode, code)
		// 保留上游 status、机器码和脱敏后的 description：Node 的失败结果带
		// reason/status/detail，只回报「账号需要重新认证」会把 invalid_client
		// 和 invalid_grant 混成一句话，迁移后排查只能靠猜。description 先按
		// knownSecrets 脱敏并截断到 320 字符，绝不含 token 或完整响应正文。
		detail := redactKnownOauthSecrets(parsed.description, knownSecrets)
		format := "%w: oauth status=%d"
		arguments := []any{classified, response.StatusCode}
		if code != "" {
			format += " code=%q"
			arguments = append(arguments, code)
		}
		if detail != "" {
			format += " detail=%q"
			arguments = append(arguments, detail)
		}
		// 只有 invalid_client 值得换下一个客户端凭据（Node
		// shouldTryNextClientCredential 的判定与此完全相同）。
		return nil, code == "invalid_client", fmt.Errorf(format, arguments...)
	}
	// 同时接受 snake_case 与 camelCase：Node 读的是
	// payload.access_token || payload.accessToken 等成对字段。
	var tokens struct {
		AccessToken       string `json:"access_token"`
		AccessTokenAlias  string `json:"accessToken"`
		RefreshToken      string `json:"refresh_token"`
		RefreshTokenAlias string `json:"refreshToken"`
		ExpiresIn         int64  `json:"expires_in"`
		ExpiresInAlias    int64  `json:"expiresIn"`
		TokenType         string `json:"token_type"`
		TokenTypeAlias    string `json:"tokenType"`
		IDToken           string `json:"id_token"`
	}
	accessToken := ""
	expiresIn := int64(0)
	refreshToken := ""
	tokenType := ""
	if err := oauthutil.DecodeJSONResponse(
		response.Body,
		maxTokenBytes,
		&tokens,
	); err == nil {
		accessToken = sanitizeAccessToken(
			firstNonEmptyString(tokens.AccessToken, tokens.AccessTokenAlias),
		)
		expiresIn = tokens.ExpiresIn
		if expiresIn <= 0 {
			expiresIn = tokens.ExpiresInAlias
		}
		refreshToken = sanitizeAccessToken(
			firstNonEmptyString(tokens.RefreshToken, tokens.RefreshTokenAlias),
		)
		// Node 对 token_type 用 String(...).trim()：纯空白视同缺失，回落到旧值。
		tokenType = strings.TrimSpace(
			firstNonEmptyString(tokens.TokenType, tokens.TokenTypeAlias),
		)
	}
	if accessToken == "" {
		// 读响应体时撞上候选级超时也是「换下一个候选」：Node 的 fetch 超时覆盖
		// 整个 body 读取，AbortError 同样走 refresh_exception → continue。
		if attemptCtx.Err() != nil && ctx.Err() == nil {
			return nil, true, accountcredentials.ErrRefreshUnavailable
		}
		// Node 的 sanitizeAccessToken 对空值/控制字符直接判 missing_access_token。
		return nil, false, accountcredentials.ErrInvalidRefreshResult
	}
	// 故意不同于 Node：Node 在缺少 expires_in 时沿用旧 expiry，写回的凭据立刻
	// 又是「已过期」，之后每个请求都会再刷一次。Go 拒绝没有生命周期的结果，
	// 让上游契约异常以一次明确失败暴露，而不是变成刷新热循环。
	if expiresIn <= 0 ||
		expiresIn > (253_402_300_799_999-refreshedAt.UnixMilli())/1000 {
		return nil, false, accountcredentials.ErrInvalidRefreshResult
	}
	// refresh_token 轮换：Node 的 sanitizeAccessToken 失败时按「未轮换」处理，
	// 保留旧值而不是丢掉刚拿到的 access_token。
	nextRefreshToken := auth.RefreshToken()
	if refreshToken != "" {
		nextRefreshToken = refreshToken
	}
	refreshToken = nextRefreshToken
	if tokenType == "" {
		tokenType = auth.TokenType()
	}
	// 账户身份以 Google 返回的 id_token 为准：账号邮箱在 Google 侧被改名后，
	// 只沿用旧 email 会让凭据与账号引用脱节。id_token 解析失败时退回旧邮箱，
	// 既保持稳定身份，也不把一个坏 token 变成刷新失败。
	email := auth.Email()
	if tokenEmail := emailFromIDToken(tokens.IDToken); validEmailAddress(tokenEmail) {
		email = tokenEmail
	}
	refreshed, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         email,
		AccessToken:   accessToken,
		RefreshToken:  refreshToken,
		ExpiresAtMS:   refreshedAt.UTC().UnixMilli() + expiresIn*1000,
		RefreshedAtMS: refreshedAt.UTC().UnixMilli(),
		TokenType:     tokenType,
		AuthMethod:    auth.AuthMethod(),
		ClientID:      auth.ClientID(),
		ClientSecret:  auth.ClientSecret(),
	})
	// 身份可能变化（Google 侧改了邮箱）：这里不拒绝，交给 Resolver 判定是
	// 迁移账号（Go 独有账号）还是拒绝（宿主拥有身份映射）。Node 就是直接
	// 采用 id_token 的新身份，拒绝会丢掉官方返回的合法结果。
	if err != nil {
		return nil, false, accountcredentials.ErrInvalidRefreshResult
	}
	return refreshed, false, nil
}

// validEmailAddress 只接受纯邮箱地址，拒绝 "Name <mail>" 形式与空值。
func validEmailAddress(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return false
	}
	address, err := mail.ParseAddress(trimmed)
	return err == nil && address.Address == trimmed
}

// sanitizeAccessToken 复刻 Node 的 sanitizeAccessToken：先 trim，空值或含
// 控制字符（\r \n NUL）一律视为缺失并返回空串，调用方按「没拿到」处理。
// 轮换后的 refresh_token 也走同一规则：无效就保留旧值，不回滚整次刷新。
func sanitizeAccessToken(value string) string {
	token := strings.TrimSpace(value)
	if token == "" || len(token) > maxTokenBytes ||
		strings.ContainsAny(token, "\r\n\x00") {
		return ""
	}
	return token
}

// firstNonEmptyString 返回第一个非空原始值（不 trim，清洗交给 sanitizeAccessToken）。
// 对应 Node 的 payload.access_token || payload.accessToken 取值方式。
func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// oauthErrorPayload 是 OAuth 错误响应的低敏投影，对应 Node parseOAuthErrorPayload。
type oauthErrorPayload struct {
	code        string
	description string
}

// parseOAuthErrorPayload 复刻 Node 的三种解析形态：
//   - {"error":"invalid_grant","error_description":"..."}
//   - {"error":{"status":"invalid_client","message":"..."}}（Google 认证错误）
//   - 非 JSON 纯文本（网关 HTML、空体等）
//
// 只有 code 会参与换候选判断与分类；description 仅用于日志，写前必须脱敏。
func parseOAuthErrorPayload(reader io.Reader, maxBytes int64) oauthErrorPayload {
	if reader == nil || maxBytes <= 0 {
		return oauthErrorPayload{}
	}
	raw, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil || int64(len(raw)) > maxBytes || !utf8.Valid(raw) {
		return oauthErrorPayload{}
	}
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return oauthErrorPayload{}
	}
	// Node 只在 JSON 顶层是对象时才读字段；其它形态一律把原文当 description。
	if !strings.HasPrefix(text, "{") {
		return oauthErrorPayload{description: text}
	}
	var payload struct {
		Error            json.RawMessage `json:"error"`
		ErrorDescription string          `json:"error_description"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return oauthErrorPayload{description: text}
	}
	if len(payload.Error) == 0 {
		return oauthErrorPayload{
			description: strings.TrimSpace(payload.ErrorDescription),
		}
	}
	var direct string
	if err := json.Unmarshal(payload.Error, &direct); err == nil {
		return oauthErrorPayload{
			code:        direct,
			description: strings.TrimSpace(payload.ErrorDescription),
		}
	}
	var nested struct {
		Status  string `json:"status"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(payload.Error, &nested); err != nil {
		return oauthErrorPayload{
			description: strings.TrimSpace(payload.ErrorDescription),
		}
	}
	description := strings.TrimSpace(payload.ErrorDescription)
	if description == "" {
		description = strings.TrimSpace(nested.Message)
	}
	// Node 取 error.status || error.code：Google 认证错误把机器码放在 status，
	// 只读 code 会让 invalid_client 变成空码，进而丢掉 legacy secret 回退。
	return oauthErrorPayload{
		code: firstNonEmptyString(
			strings.TrimSpace(nested.Status),
			strings.TrimSpace(nested.Code),
		),
		description: description,
	}
}

// normalizeOAuthErrorCode 把上游错误码收敛为可安全写日志的固定字符集。
//
// 与 Node normalizeOAuthErrorCode 等价：先按 knownSecrets 脱敏，命中过脱敏的
// 值直接作废；只允许 [a-z0-9_.:-]{1,80}。Node 用大小写不敏感正则，这里统一
// 小写，保证 INVALID_CLIENT 也能触发换候选。
func normalizeOAuthErrorCode(value string, knownSecrets []string) string {
	code := redactKnownOauthSecrets(value, knownSecrets)
	if code == "" || strings.Contains(code, "[redacted]") {
		return ""
	}
	code = strings.ToLower(code)
	if len(code) > 80 {
		return ""
	}
	for _, character := range code {
		switch {
		case character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '_', character == '-',
			character == '.', character == ':':
			continue
		default:
			return ""
		}
	}
	return code
}

// redactKnownOauthSecrets 复刻 Node 同名函数：先替换秘密的 URL 编码形态，
// 再替换原文，最后折叠空白并截断到 320 字符。
func redactKnownOauthSecrets(value string, knownSecrets []string) string {
	text := value
	for _, secret := range knownSecrets {
		normalized := strings.TrimSpace(secret)
		if normalized == "" {
			continue
		}
		if encoded := url.QueryEscape(normalized); encoded != normalized {
			text = strings.ReplaceAll(text, encoded, "[redacted]")
		}
		text = strings.ReplaceAll(text, normalized, "[redacted]")
	}
	return sanitizeResponseText(text)
}

// sanitizeResponseText 对齐 Node response-body.js 的同名函数：控制字符与连续
// 空白折叠成单个空格，两端去空白，最多保留 320 个字符。
func sanitizeResponseText(value string) string {
	cleaned := strings.Map(func(character rune) rune {
		if character < 0x20 || character == 0x7f {
			return ' '
		}
		return character
	}, value)
	collapsed := strings.Join(strings.Fields(cleaned), " ")
	if runes := []rune(collapsed); len(runes) > maxOAuthErrorDetail {
		return string(runes[:maxOAuthErrorDetail])
	}
	return collapsed
}
