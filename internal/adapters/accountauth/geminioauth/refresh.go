// Package geminioauth 实现 Gemini CLI（Code Assist）登录态的 OAuth 刷新策略。
//
// 协议事实与 Node lib/server/gemini-token-refresh.js 同源：
//
//	POST https://oauth2.googleapis.com/token
//	Content-Type: application/json
//	{client_id, client_secret, refresh_token, grant_type:"refresh_token"}
//	→ {access_token, expires_in, token_type?, scope?}
//
// 凭据文档是 Gemini CLI 的 oauth_creds.json 投影：
//
//	{oauthCreds:{access_token, refresh_token, expiry_date, ...}, googleAccounts:{active}}
//
// 为什么必须刷新：access_token 只有约 1 小时有效期，账号池加载与额度探测都读
// oauthCreds.access_token；不续期时账号会在登录一小时后集体 401。
//
// 到期窗口（5 分钟）与失败抑制（30 秒 / 失效 grant 24 小时）由
// accountcredentials.Resolver 统一实现，这里只负责协议交换与文档合并。
package geminioauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/tokenrefresh"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const (
	providerID = "gemini"
	// defaultTokenEndpoint 是 Google OAuth 的全局令牌端点。
	defaultTokenEndpoint = "https://oauth2.googleapis.com/token"
	// defaultClientID 是 Gemini CLI 公开的 installed-app OAuth Client ID（与 Node 同值）。
	defaultClientID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
	// defaultClientSecret 是 Gemini CLI 公开的 installed-app 客户端密钥（与 Node 同值）。
	defaultClientSecret = "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" // gitleaks:allow -- Gemini CLI 公开客户端元数据。
	// requestTimeout 对齐 Node DEFAULT_REFRESH_TIMEOUT_MS（15s）。
	requestTimeout = 15 * time.Second
)

// HTTPClient 是刷新策略唯一依赖的传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Options 是可注入的端点与时钟。
//
// TokenEndpoint 只服务测试与自建网关覆盖；生产构造器留空即用 Google 官方端点。
type Options struct {
	TokenEndpoint string
	Clock         func() time.Time
}

// Provider 是无共享可变状态的 gemini 刷新策略。
type Provider struct {
	client   HTTPClient
	endpoint string
	clock    func() time.Time
	decoder  *nativeaccount.Decoder
}

var _ tokenrefresh.Refresher = (*Provider)(nil)

// New 创建固定调用 Google 官方令牌端点的策略。
func New(client HTTPClient, options Options) (*Provider, error) {
	endpoint := strings.TrimSpace(options.TokenEndpoint)
	if endpoint == "" {
		endpoint = defaultTokenEndpoint
	}
	parsed, err := url.Parse(endpoint)
	if client == nil ||
		err != nil ||
		parsed.Scheme == "" ||
		parsed.Host == "" ||
		parsed.User != nil {
		return nil, accountcredentials.ErrInvalidDependencies
	}
	clock := options.Clock
	if clock == nil {
		clock = time.Now
	}
	return &Provider{
		client:   client,
		endpoint: endpoint,
		clock:    clock,
		decoder:  nativeaccount.NewDecoder(),
	}, nil
}

// ProviderID 返回规范 Provider ID。
func (*Provider) ProviderID() string { return providerID }

// ExpiresAt 读取 oauthCreds 的过期时间。
//
// 字段在历史快照里混用过 expires_at / expiry_date（毫秒）与 expiry（ISO），
// 三处都认；都缺失时回退 access_token 的 JWT exp。仍然不可判定就返回 false：
// 解析器据此不做主动刷新，与 Node（tokenExpiresAt 缺失时不动）一致。
func (provider *Provider) ExpiresAt(
	credential accountapp.Credential,
) (time.Time, bool) {
	if provider == nil {
		return time.Time{}, false
	}
	oauth := oauthSection(credential)
	if oauth == nil {
		return time.Time{}, false
	}
	for _, key := range []string{"expires_at", "expiresAt", "expiry_date", "expiryDate", "expiry"} {
		if expiresAt, ok := tokenrefresh.TimestampMS(oauth[key]); ok {
			return expiresAt, true
		}
	}
	accessToken := tokenrefresh.Text(oauth, "access_token", "accessToken")
	if expiresAt, ok := tokenrefresh.JWTExpiry(accessToken); ok {
		return expiresAt, true
	}
	// Node 的兜底：过期时间不可判定时，只要 access_token 缺失就刷新（此时账号本来
	// 就用不了）。返回已过去的时间而不是零值，解析器才会把它当成「立即到期」。
	if accessToken == "" &&
		tokenrefresh.Secret(oauth, "refresh_token", "refreshToken") != "" {
		return provider.clock().UTC().Add(-time.Minute), true
	}
	return time.Time{}, false
}

// refreshResponse 是 Google OAuth refresh 成功响应的允许字段。
type refreshResponse struct {
	AccessToken     string `json:"access_token"`
	AccessTokenAlt  string `json:"accessToken"`
	ExpiresIn       any    `json:"expires_in"`
	ExpiresInAlt    any    `json:"expiresIn"`
	TokenType       string `json:"token_type"`
	TokenTypeAlt    string `json:"tokenType"`
	Scope           string `json:"scope"`
	RefreshToken    string `json:"refresh_token"`
	RefreshTokenAlt string `json:"refreshToken"`
}

// Refresh 用 refresh_token 换取新 Access Token，并把结果合并回 oauthCreds。
func (provider *Provider) Refresh(
	ctx context.Context,
	credential accountapp.Credential,
) (accountapp.Credential, error) {
	if provider == nil ||
		provider.client == nil ||
		provider.decoder == nil ||
		ctx == nil ||
		credential == nil ||
		credential.ProviderID() != providerID {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	native, valid := credential.(*accountcore.NativeCredential)
	if !valid || native == nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	document, err := tokenrefresh.DecodeDocument(native.Payload())
	if err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	sectionKey, oauth := oauthSectionWithKey(document)
	if oauth == nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	refreshToken := tokenrefresh.Secret(oauth, "refresh_token", "refreshToken")
	// 没有 refresh_token 说明只剩已过期的 access_token，任何重放都换不到新 grant。
	if refreshToken == "" {
		return nil, accountcredentials.ErrReauthenticationRequired
	}
	clientID := tokenrefresh.Secret(oauth, "client_id", "clientId")
	if clientID == "" {
		clientID = defaultClientID
	}
	clientSecret := tokenrefresh.Secret(oauth, "client_secret", "clientSecret")
	if clientSecret == "" {
		clientSecret = defaultClientSecret
	}

	requestBody, err := json.Marshal(map[string]string{
		"client_id":     clientID,
		"client_secret": clientSecret,
		"refresh_token": refreshToken,
		"grant_type":    "refresh_token",
	})
	if err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	defer clearBytes(requestBody)

	now := provider.clock().UTC()
	if now.IsZero() || now.UnixMilli() <= 0 {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	requestContext, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestContext,
		http.MethodPost,
		provider.endpoint,
		bytes.NewReader(requestBody),
	)
	if err != nil {
		return nil, accountcredentials.ErrRefreshUnavailable
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")

	response, err := provider.client.Do(request)
	if err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return nil, errors.Join(accountcredentials.ErrRefreshUnavailable, contextErr)
		}
		return nil, accountcredentials.ErrRefreshUnavailable
	}
	if response == nil || response.Body == nil {
		return nil, accountcredentials.ErrRefreshUnavailable
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		// 共享分类器：invalid_grant 或 401/403 → 需要重新认证；其它 4xx → 被拒绝；
		// 5xx/429/408 → 暂时不可用。错误码只取机器码，不含响应正文。
		return nil, oauthutil.ClassifyRefreshError(
			response.StatusCode,
			oauthutil.DecodeErrorCode(response.Body, tokenrefresh.MaxDocumentBytes),
		)
	}

	var tokens refreshResponse
	if err := oauthutil.DecodeJSONResponse(
		response.Body,
		tokenrefresh.MaxDocumentBytes,
		&tokens,
	); err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	accessToken := firstNonEmpty(tokens.AccessToken, tokens.AccessTokenAlt)
	if !tokenrefresh.ValidSecret(accessToken) {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}

	nextOauth := tokenrefresh.CloneObject(oauth)
	nextOauth["access_token"] = accessToken
	nextOauth["last_refresh"] = tokenrefresh.ISOString(now)
	expiresIn := tokenrefresh.Integer(tokens.ExpiresIn)
	if expiresIn <= 0 {
		expiresIn = tokenrefresh.Integer(tokens.ExpiresInAlt)
	}
	expiresAt, hasExpiry := time.Time{}, false
	if expiresIn > 0 {
		expiresAt, hasExpiry = tokenrefresh.TimestampMS(
			float64(now.UnixMilli() + expiresIn*1000),
		)
	} else {
		// 响应没给 expires_in 时，若新令牌是 JWT 就按 exp 推断；仍推断不出则
		// 保留原过期字段（Node 同样不改），下一轮解析会按原值再次尝试。
		expiresAt, hasExpiry = tokenrefresh.JWTExpiry(accessToken)
	}
	if hasExpiry {
		// 三个字段同时写：Gemini CLI 读 expiry_date，Node 读 expires_at，展示层读 expiry。
		millis := expiresAt.UnixMilli()
		nextOauth["expires_at"] = millis
		nextOauth["expiry_date"] = millis
		nextOauth["expiry"] = tokenrefresh.ISOString(expiresAt)
	}
	if tokenType := firstNonEmpty(tokens.TokenType, tokens.TokenTypeAlt); tokenType != "" {
		nextOauth["token_type"] = tokenType
	}
	if tokens.Scope != "" {
		nextOauth["scope"] = tokens.Scope
	}
	if rotated := firstNonEmpty(tokens.RefreshToken, tokens.RefreshTokenAlt); rotated != "" {
		nextOauth["refresh_token"] = rotated
	}

	nextDocument := tokenrefresh.CloneObject(document)
	nextDocument[sectionKey] = nextOauth
	encoded, err := json.Marshal(nextDocument)
	if err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	refreshed, err := provider.decoder.DecodeNativeAuth(providerID, encoded)
	if err != nil || refreshed == nil || refreshed.ProviderID() != providerID {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	return refreshed, nil
}

// oauthSection 只接受 gemini 登录态原生凭据里的 oauthCreds 对象。
func oauthSection(credential accountapp.Credential) map[string]any {
	native, valid := credential.(*accountcore.NativeCredential)
	if !valid || native == nil || native.ProviderID() != providerID {
		return nil
	}
	document, err := tokenrefresh.DecodeDocument(native.Payload())
	if err != nil {
		return nil
	}
	_, oauth := oauthSectionWithKey(document)
	return oauth
}

// oauthSectionWithKey 同时返回实际命中的字段名，写回时沿用同一个键。
func oauthSectionWithKey(document map[string]any) (string, map[string]any) {
	for _, key := range []string{"oauthCreds", "oauth_creds"} {
		if oauth := tokenrefresh.Object(document[key]); oauth != nil {
			return key, oauth
		}
	}
	return "", nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// clearBytes 覆盖含 Refresh Token 的临时请求体。
func clearBytes(data []byte) {
	for index := range data {
		data[index] = 0
	}
}
