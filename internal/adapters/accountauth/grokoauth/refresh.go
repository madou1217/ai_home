// Package grokoauth 实现 Grok（build-cli 登录态）的 OAuth 刷新策略。
//
// 协议事实与 Node lib/server/grok-token-refresh.js、lib/account/grok-auth-profile.js 同源：
//
//	POST https://auth.x.ai/oauth2/token
//	Content-Type: application/x-www-form-urlencoded
//	grant_type=refresh_token&client_id=...&refresh_token=...
//	→ {access_token, refresh_token?, expires_in?}
//
// 凭据文档是 Grok CLI 的 auth 快照：
//
//	{auth:{"<profileKey>":{key, refresh_token, expires_at, user_id, ...}}}
//
// profileKey 的形态是 <scope>::<clientId>，client id 缺失时从键的 :: 后半段取。
// 文档也可能是「顶层直接就是 profile」的形态，两种都认。
//
// 刷新只替换同一个 profile 里的令牌字段：user_id / principal_id 是身份证据，
// 改掉就会换账号（见 nativeaccount.grokIdentity）。
package grokoauth

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
	providerID = "grok"
	// defaultTokenEndpoint 是 xAI 的 OAuth 令牌端点（与 Node 同值）。
	defaultTokenEndpoint = "https://auth.x.ai/oauth2/token"
	// defaultClientID 是 Grok CLI 的公开 OIDC Client ID（与 Node 同值）。
	defaultClientID = "b1a00492-073a-47ea-816f-4c329264a828"
	// requestTimeout 对齐 Node DEFAULT_REFRESH_TIMEOUT_MS（15s）。
	requestTimeout = 15 * time.Second
)

// HTTPClient 是刷新策略唯一依赖的传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Options 是可注入的端点与时钟；生产构造器留空即用 xAI 官方端点。
type Options struct {
	TokenEndpoint string
	Clock         func() time.Time
}

// Provider 是无共享可变状态的 grok 刷新策略。
type Provider struct {
	client   HTTPClient
	endpoint string
	clock    func() time.Time
	decoder  *nativeaccount.Decoder
}

var _ tokenrefresh.Refresher = (*Provider)(nil)

// New 创建固定调用 xAI 官方令牌端点的策略。
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

// ExpiresAt 读取当前 profile 的 Access Token 过期时间。
//
// 与 Node readGrokAuthProfile 同序：先看 access_token 的 JWT exp（每次签发都会
// 前进），再看 expires_at / expiresAt / expired。都不可判定时返回 false：
// Node 的 shouldRefreshToken 在过期未知时同样不主动刷新。
func (*Provider) ExpiresAt(
	credential accountapp.Credential,
) (time.Time, bool) {
	native, valid := credential.(*accountcore.NativeCredential)
	if !valid || native == nil || native.ProviderID() != providerID {
		return time.Time{}, false
	}
	document, err := tokenrefresh.DecodeDocument(native.Payload())
	if err != nil {
		return time.Time{}, false
	}
	_, profile := selectProfile(native.Payload(), document)
	if profile == nil {
		return time.Time{}, false
	}
	if expiresAt, ok := tokenrefresh.JWTExpiry(
		tokenrefresh.Text(profile, "access_token", "accessToken", "key"),
	); ok {
		return expiresAt, true
	}
	for _, key := range []string{"expires_at", "expiresAt", "expired"} {
		if expiresAt, ok := tokenrefresh.TimestampMS(profile[key]); ok {
			return expiresAt, true
		}
	}
	return time.Time{}, false
}

// refreshResponse 是 xAI OAuth refresh 成功响应的允许字段。
type refreshResponse struct {
	AccessToken     string `json:"access_token"`
	AccessTokenAlt  string `json:"accessToken"`
	Key             string `json:"key"`
	RefreshToken    string `json:"refresh_token"`
	RefreshTokenAlt string `json:"refreshToken"`
	ExpiresIn       any    `json:"expires_in"`
	ExpiresInAlt    any    `json:"expiresIn"`
}

// Refresh 用当前 profile 的 refresh_token 换取新令牌并写回同一个 profile。
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
	authKey, auth := authSection(document)
	profileKey, profile := selectProfile(native.Payload(), document)
	if profile == nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	refreshToken := tokenrefresh.Secret(profile, "refresh_token", "refreshToken")
	if refreshToken == "" {
		return nil, accountcredentials.ErrReauthenticationRequired
	}

	clientID := tokenrefresh.Secret(
		profile,
		"oidc_client_id",
		"oidcClientId",
		"client_id",
		"clientId",
	)
	// 与 Node 同序：先看 profile 自带字段，再看 <scope>::<clientId> 的键后缀，
	// 最后才从 access token 的 aud 推导（键后缀是 CLI 落盘时写入的权威值）。
	if clientID == "" {
		clientID = clientIDFromProfileKey(profileKey)
	}
	if clientID == "" {
		clientID = jwtClientID(tokenrefresh.Text(profile, "access_token", "accessToken", "key"))
	}
	if clientID == "" {
		clientID = defaultClientID
	}

	form := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {clientID},
		"refresh_token": {refreshToken},
	}
	requestBody := []byte(form.Encode())
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
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
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
	accessToken := firstNonEmpty(tokens.AccessToken, tokens.AccessTokenAlt, tokens.Key)
	if !tokenrefresh.ValidSecret(accessToken) {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	nextRefreshToken := firstNonEmpty(tokens.RefreshToken, tokens.RefreshTokenAlt)
	if nextRefreshToken == "" {
		// 上游没轮换时保留旧 grant：把账号刷成没有 refresh_token 的死快照更糟。
		nextRefreshToken = refreshToken
	}

	nextProfile := tokenrefresh.CloneObject(profile)
	nextProfile["key"] = accessToken
	// 文档里如果用的是 access_token / accessToken 形态，必须同步更新，否则读侧
	// 按 server 的字段优先级仍会读到旧值。
	if _, exists := nextProfile["access_token"]; exists {
		nextProfile["access_token"] = accessToken
	}
	if _, exists := nextProfile["accessToken"]; exists {
		nextProfile["accessToken"] = accessToken
	}
	nextProfile["refresh_token"] = nextRefreshToken
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
		expiresAt, hasExpiry = tokenrefresh.JWTExpiry(accessToken)
	}
	if hasExpiry {
		// 与 Node 的落盘形态一致：profile 里的 expires_at 是 ISO 字符串。
		nextProfile["expires_at"] = tokenrefresh.ISOString(expiresAt)
	}

	if profileKey == "" {
		// 顶层直接 profile：auth 就是 profile 本身（或文档没有 auth 层）。
		auth = nextProfile
	} else {
		auth[profileKey] = nextProfile
	}
	if authKey != "" {
		document[authKey] = auth
	} else {
		document = auth
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	refreshed, err := provider.decoder.DecodeNativeAuth(providerID, encoded)
	if err != nil || refreshed == nil || refreshed.ProviderID() != providerID {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	return refreshed, nil
}

// authSection 返回 auth 容器的键名与对象；没有 auth 层时键名为空、对象是文档本身。
func authSection(document map[string]any) (string, map[string]any) {
	if auth := tokenrefresh.Object(document["auth"]); auth != nil {
		return "auth", auth
	}
	return "", document
}

// selectProfile 按文档顺序选择第一个带令牌字段的 profile。
//
// 为什么必须保序：auth 快照可能同时存在多个 profile（Node 的 readGrokProfileKey
// 取对象键的第一个）。Go map 无序，直接用 map 迭代会随机挑一个 profile 去轮换，
// 与 Node 写回的位置不一致。
func selectProfile(payload []byte, document map[string]any) (string, map[string]any) {
	authKey, auth := authSection(document)
	if auth == nil {
		return "", nil
	}
	if hasToken(auth) {
		return "", auth
	}
	raw := payload
	if authKey != "" {
		var envelope map[string]json.RawMessage
		if json.Unmarshal(payload, &envelope) != nil || envelope[authKey] == nil {
			return "", nil
		}
		raw = envelope[authKey]
	}
	for _, key := range orderedKeys(raw) {
		profile := tokenrefresh.Object(auth[key])
		if profile != nil && hasToken(profile) {
			return key, profile
		}
	}
	return "", nil
}

// hasToken 判断对象是否带任一令牌字段（与 Node readGrokProfileKey 同集合）。
func hasToken(profile map[string]any) bool {
	return tokenrefresh.Text(
		profile,
		"key",
		"access_token",
		"accessToken",
		"refresh_token",
		"refreshToken",
	) != ""
}

// orderedKeys 按 JSON 文档顺序返回对象键（不解析值内容）。
func orderedKeys(raw []byte) []string {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil
	}
	keys := make([]string, 0, 4)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil
		}
		key, ok := token.(string)
		if !ok {
			return nil
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil
		}
		keys = append(keys, key)
	}
	return keys
}

// clientIDFromProfileKey 取 <scope>::<clientId> 的后半段。
func clientIDFromProfileKey(profileKey string) string {
	index := strings.LastIndex(profileKey, "::")
	if index < 0 {
		return ""
	}
	return strings.TrimSpace(profileKey[index+2:])
}

// jwtClientID 从 access token 的 client_id / aud 声明推导 client id。
//
// aud 可能是字符串也可能是数组；只作为请求元数据，不参与身份判定。
func jwtClientID(token string) string {
	claims := tokenrefresh.JWTClaims(token)
	if claims == nil {
		return ""
	}
	if clientID, ok := claims["client_id"].(string); ok && tokenrefresh.ValidSecret(clientID) {
		return strings.TrimSpace(clientID)
	}
	switch audience := claims["aud"].(type) {
	case string:
		if tokenrefresh.ValidSecret(audience) {
			return strings.TrimSpace(audience)
		}
	case []any:
		for _, item := range audience {
			if value, ok := item.(string); ok && tokenrefresh.ValidSecret(value) {
				return strings.TrimSpace(value)
			}
		}
	}
	return ""
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
