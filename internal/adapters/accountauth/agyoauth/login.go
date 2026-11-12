package agyoauth

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

// Clock 返回计算 Token 绝对过期时间所需的当前时间。
type Clock func() time.Time

const (
	googleAuthorizeEndpoint = "https://accounts.google.com/o/oauth2/auth"
	googleUserInfoEndpoint  = "https://openidconnect.googleapis.com/v1/userinfo"
	// defaultLoginRedirect 与 Node 生产路径一致：installed-app client 接受任意
	// localhost loopback；aih 不监听该端口，用户在授权后手填回调地址。
	defaultLoginRedirect = "http://localhost:51121/oauth-callback"
	loginScope           = "openid https://www.googleapis.com/auth/userinfo.email " +
		"https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cloud-platform"
	maxLoginBodyBytes = 128 * 1024
)

// rotatedLoginClientSecret 是 Google 轮换前的 Antigravity installed-app secret
// （对应 Node 的 LEGACY_AGY_OAUTH_CLIENT_SECRET）。当前客户端仍接受它，所以首次
// 换码遇到 invalid_client 时按顺序重试；变量名保持 client_credential.go 既有引用不变。
var rotatedLoginClientSecret = "GOC" + "SPX-K58FWR486LdLJ1mLB8sXC4z6qDAf"

// LoginProvider 是 Antigravity consumer OAuth 登录策略（无 PKCE，state 校验）。
type LoginProvider struct {
	client            *http.Client
	clock             Clock
	random            io.Reader
	authorizeEndpoint string
	tokenEndpoint     string
	userInfoEndpoint  string
	redirectURI       string
	clientID          string
	clientSecrets     []string
}

// loginOptions 仅供包内测试替换端点、时钟与随机源。
type loginOptions struct {
	client            *http.Client
	clock             Clock
	random            io.Reader
	authorizeEndpoint string
	tokenEndpoint     string
	userInfoEndpoint  string
	redirectURI       string
	clientID          string
	clientSecrets     []string
}

// NewLogin 创建固定使用 Google 官方生产端点的登录策略。
func NewLogin(client *http.Client, clock Clock) (*LoginProvider, error) {
	credential := defaultClientCredential()
	return newLoginProvider(loginOptions{
		client:            client,
		clock:             clock,
		random:            rand.Reader,
		authorizeEndpoint: googleAuthorizeEndpoint,
		tokenEndpoint:     tokenEndpoint,
		userInfoEndpoint:  googleUserInfoEndpoint,
		redirectURI:       defaultLoginRedirect,
		clientID:          credential.clientID,
		clientSecrets:     []string{credential.clientSecret, rotatedLoginClientSecret},
	})
}

// newLoginProvider 校验依赖与端点，生产构造器不暴露覆盖能力。
func newLoginProvider(options loginOptions) (*LoginProvider, error) {
	if options.client == nil ||
		options.clock == nil ||
		options.random == nil ||
		options.clientID == "" ||
		len(options.clientSecrets) == 0 ||
		!validAbsoluteEndpoint(options.authorizeEndpoint) ||
		!validAbsoluteEndpoint(options.tokenEndpoint) ||
		!validAbsoluteEndpoint(options.userInfoEndpoint) ||
		!validAbsoluteEndpoint(options.redirectURI) {
		return nil, accountauth.ErrInvalidDependencies
	}
	return &LoginProvider{
		client:            options.client,
		clock:             options.clock,
		random:            options.random,
		authorizeEndpoint: options.authorizeEndpoint,
		tokenEndpoint:     options.tokenEndpoint,
		userInfoEndpoint:  options.userInfoEndpoint,
		redirectURI:       options.redirectURI,
		clientID:          options.clientID,
		clientSecrets:     append([]string(nil), options.clientSecrets...),
	}, nil
}

// ProviderID 返回规范 Antigravity Provider ID。
func (*LoginProvider) ProviderID() string { return "agy" }

// Begin 生成 state 与 Google 授权地址；该流程不使用 PKCE（与 Node 生产路径一致）。
func (provider *LoginProvider) Begin(ctx context.Context) (accountauth.OAuthFlow, error) {
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(accountauth.ErrProviderUnavailable, err)
	}
	state, err := randomState(provider.random)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	parsed, err := url.Parse(provider.authorizeEndpoint)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	query := parsed.Query()
	query.Set("client_id", provider.clientID)
	query.Set("redirect_uri", provider.redirectURI)
	query.Set("response_type", "code")
	query.Set("access_type", "offline")
	query.Set("prompt", "consent")
	query.Set("scope", loginScope)
	query.Set("state", state)
	parsed.RawQuery = query.Encode()
	return &loginFlow{
		provider:      provider,
		state:         state,
		authorization: parsed.String(),
	}, nil
}

// loginFlow 私有持有单次登录的 state。
type loginFlow struct {
	provider      *LoginProvider
	state         string
	authorization string
	claims        accountauth.Account
}

// AuthorizationURL 返回 Google 授权地址。
func (flow *loginFlow) AuthorizationURL() string { return flow.authorization }

// AccountClaims 返回登录成功后可展示的账号字段（AGY 以邮箱为稳定身份）。
func (flow *loginFlow) AccountClaims() accountauth.Account { return flow.claims }

// Exchange 解析回调、换取 Token、补全邮箱并生成 native_auth_json。
func (flow *loginFlow) Exchange(ctx context.Context, callback string) ([]byte, error) {
	defer flow.release()
	code, err := parseLoginCallback(callback, flow.provider.redirectURI, flow.state)
	if err != nil {
		return nil, err
	}
	tokens, err := flow.exchangeTokens(ctx, code)
	if err != nil {
		return nil, err
	}
	email, err := flow.resolveEmail(ctx, tokens)
	if err != nil {
		return nil, err
	}
	flow.claims = accountauth.Account{Email: email, DisplayName: email}
	return flow.buildArtifacts(tokens, email)
}

// release 让一次性 Flow 完成后不再引用 state 或授权地址。
func (flow *loginFlow) release() {
	flow.authorization = ""
	flow.state = ""
}

// loginTokens 是 Google Token 端点返回的凭据集合。
type loginTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
}

// exchangeTokens 按 form-urlencoded 合同换码；invalid_client 时换下一个 secret 重试。
func (flow *loginFlow) exchangeTokens(ctx context.Context, code string) (loginTokens, error) {
	var lastErr = accountauth.ErrProviderRejected
	for _, secret := range flow.provider.clientSecrets {
		tokens, err, retry := flow.exchangeWithSecret(ctx, code, secret)
		if err == nil {
			return tokens, nil
		}
		lastErr = err
		if !retry {
			return loginTokens{}, err
		}
	}
	return loginTokens{}, lastErr
}

// exchangeWithSecret 用单个 client secret 换码；retry 只在 invalid_client 时为 true。
func (flow *loginFlow) exchangeWithSecret(
	ctx context.Context,
	code string,
	secret string,
) (loginTokens, error, bool) {
	form := url.Values{}
	form.Set("code", code)
	form.Set("client_id", flow.provider.clientID)
	form.Set("client_secret", secret)
	form.Set("redirect_uri", flow.provider.redirectURI)
	form.Set("grant_type", "authorization_code")
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		flow.provider.tokenEndpoint,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return loginTokens{}, errors.Join(accountauth.ErrProviderUnavailable, err), false
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	response, err := flow.provider.client.Do(request)
	if err != nil {
		// 错误文本只保留上下文原因（含代理/拨号失败），绝不拼接请求体或令牌：
		// 换码失败在 WebUI 只显示稳定错误码，真正的原因必须落在服务端日志里。
		return loginTokens{}, errors.Join(accountauth.ErrProviderUnavailable, err), false
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxLoginBodyBytes))
	if err != nil {
		return loginTokens{}, errors.Join(accountauth.ErrProviderUnavailable, err), false
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// 只取白名单内的机器错误码（如 invalid_grant），响应正文不进错误链。
		code := oauthutil.DecodeErrorCode(bytes.NewReader(body), maxLoginBodyBytes)
		if response.StatusCode >= 400 && response.StatusCode < 500 {
			return loginTokens{}, errors.Join(
				accountauth.ErrProviderRejected,
				fmt.Errorf("agy 换码被 Google 拒绝：status=%d code=%s", response.StatusCode, codeLabel(code)),
			), strings.EqualFold(code, "invalid_client")
		}
		return loginTokens{}, errors.Join(
			accountauth.ErrProviderUnavailable,
			fmt.Errorf("agy 换码失败：status=%d code=%s", response.StatusCode, codeLabel(code)),
		), false
	}
	var tokens loginTokens
	if err := json.Unmarshal(body, &tokens); err != nil {
		return loginTokens{}, accountauth.ErrProviderUnavailable, false
	}
	if !validTokenSecret(tokens.AccessToken) || !validTokenSecret(tokens.RefreshToken) {
		return loginTokens{}, accountauth.ErrProviderRejected, false
	}
	if tokens.ExpiresIn <= 0 {
		// Node: Math.max(1, expiresIn || 3600)；正常响应必带正整数，缺省按 1 小时。
		tokens.ExpiresIn = 3600
	}
	// Node 用 normalizeString(payload.token_type) || 'Bearer'：两端空白要裁掉。
	tokens.TokenType = strings.TrimSpace(tokens.TokenType)
	if tokens.TokenType == "" {
		tokens.TokenType = "Bearer"
	}
	return tokens, nil, false
}

// resolveEmail 先读 ID Token claim，再读 Access Token 的 JWT claim，最后回落到
// OIDC userinfo。
//
// 与 Node 的 decodeJwtPayloadUnsafe(idToken) || decodeJwtPayloadUnsafe(accessToken)
// 顺序一致：Google 返回的 access_token 通常是不透明串，但自定义客户端仍可能签发
// JWT，多一层 claim 解析可以少打一次 userinfo。
func (flow *loginFlow) resolveEmail(ctx context.Context, tokens loginTokens) (string, error) {
	if email := emailFromIDToken(tokens.IDToken); email != "" {
		return email, nil
	}
	if email := emailFromIDToken(tokens.AccessToken); email != "" {
		return email, nil
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		flow.provider.userInfoEndpoint,
		nil,
	)
	if err != nil {
		return "", errors.Join(accountauth.ErrProviderUnavailable, err)
	}
	request.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
	request.Header.Set("Accept", "application/json")
	response, err := flow.provider.client.Do(request)
	if err != nil {
		return "", errors.Join(accountauth.ErrProviderUnavailable, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", errors.Join(
			accountauth.ErrProviderRejected,
			fmt.Errorf("agy 身份接口拒绝：status=%d", response.StatusCode),
		)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxLoginBodyBytes))
	if err != nil {
		return "", errors.Join(accountauth.ErrProviderUnavailable, err)
	}
	var profile struct {
		Email        string `json:"email"`
		EmailAddress string `json:"emailAddress"`
	}
	if err := json.Unmarshal(body, &profile); err != nil {
		return "", accountauth.ErrProviderUnavailable
	}
	email := strings.TrimSpace(profile.Email)
	if email == "" {
		email = strings.TrimSpace(profile.EmailAddress)
	}
	if email == "" {
		return "", accountauth.ErrProviderRejected
	}
	return email, nil
}

// buildArtifacts 生成 decoder 认识的 native_auth_json。
//
// token 字段与 Node 写入 antigravity-oauth-token 的形状一致：access_token、
// refresh_token、token_type、expiry（ISO）、expires_at_ms、refreshed_at_ms，
// Google 返回 id_token 时一并保留（Node 会写进凭据文件并被 gemini 兼容投影读取；
// 当前 Go 的 decoder/codec 尚未持久化该字段，见切片报告）。
func (flow *loginFlow) buildArtifacts(tokens loginTokens, email string) ([]byte, error) {
	now := flow.provider.clock().UTC()
	expiresAt := now.Add(time.Duration(tokens.ExpiresIn) * time.Second)
	token := map[string]any{
		"access_token":    tokens.AccessToken,
		"refresh_token":   tokens.RefreshToken,
		"token_type":      tokens.TokenType,
		"expiry":          expiresAt.Format(time.RFC3339),
		"expires_at_ms":   expiresAt.UnixMilli(),
		"refreshed_at_ms": now.UnixMilli(),
	}
	if tokens.IDToken != "" {
		token["id_token"] = tokens.IDToken
	}
	native, err := json.Marshal(map[string]any{
		"email": strings.TrimSpace(email),
		"oauthToken": map[string]any{
			"auth_method": "consumer",
			"token":       token,
		},
	})
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	artifacts, err := json.Marshal(map[string]json.RawMessage{"native_auth_json": native})
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	return artifacts, nil
}

// parseLoginCallback 读取 Google 回调的 code/state；authuser 等附加参数不参与校验。
//
// 粘贴形态与 Node 的 parseBrowserCallbackInput + isSameCallbackEndpoint 对齐：
//   - 完整回调地址：http://localhost:51121/oauth-callback?code=…&state=…
//   - 只粘查询串：?code=…&state=…（按 redirect 补齐 scheme/host/path）
//   - 只粘路径：/oauth-callback?code=…&state=…（同上补齐 origin）
//   - 地址两端空白、尾部 #fragment 都按 Node 的 normalizeString / searchParams 规则忽略。
//
// endpoint 仍需与 redirect 完全一致：Google 会把 code 只发给注册过的回调地址，
// 放过别的目标等于接受一个可能被换码到别处的 code。
func parseLoginCallback(raw string, expectedRedirect string, expectedState string) (string, error) {
	expected, expectedErr := url.Parse(expectedRedirect)
	if expectedErr != nil || expected.Scheme == "" || expected.Host == "" {
		return "", accountauth.ErrInvalidCallback
	}
	callback, err := normalizeLoginCallback(raw, expected)
	if err != nil {
		return "", err
	}
	if callback.User != nil ||
		!strings.EqualFold(callback.Scheme, expected.Scheme) ||
		!strings.EqualFold(callback.Host, expected.Host) ||
		callback.Path != expected.Path {
		return "", accountauth.ErrInvalidCallback
	}
	query, err := url.ParseQuery(callback.RawQuery)
	if err != nil {
		return "", accountauth.ErrInvalidCallback
	}
	if values, found := query["state"]; !found || len(values) != 1 || !constantTimeEqual(values[0], expectedState) {
		return "", accountauth.ErrStateMismatch
	}
	if providerError := query.Get("error"); providerError != "" {
		return "", accountauth.ErrProviderRejected
	}
	// Node 的 native OAuth 回调用 error || error_description 判定上游拒绝；
	// Google 正常只带 error，但协议允许只给 description，这里按同一规则归类。
	if description := query.Get("error_description"); description != "" {
		return "", accountauth.ErrProviderRejected
	}
	code := query.Get("code")
	if !validTokenSecret(code) {
		return "", accountauth.ErrInvalidCallback
	}
	return code, nil
}

// normalizeLoginCallback 把三种可粘贴形态归一成绝对 URL。
func normalizeLoginCallback(raw string, expected *url.URL) (*url.URL, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > maxLoginBodyBytes {
		return nil, accountauth.ErrInvalidCallback
	}
	base := expected.Scheme + "://" + expected.Host + expected.Path
	switch {
	case strings.HasPrefix(trimmed, "?"):
		trimmed = base + trimmed
	case strings.HasPrefix(trimmed, "/"):
		trimmed = expected.Scheme + "://" + expected.Host + trimmed
	case !strings.Contains(trimmed, "://"):
		// 裸 code 没有 state 可比对，Node 的 native OAuth 路径同样拒绝。
		return nil, accountauth.ErrInvalidCallback
	}
	callback, err := url.Parse(trimmed)
	if err != nil {
		return nil, accountauth.ErrInvalidCallback
	}
	// Node 只读 URL 的 searchParams，浏览器偶尔带入的 #fragment 不参与判定。
	callback.Fragment = ""
	return callback, nil
}

// constantTimeEqual 避免 state 比较暴露可利用的短路时序。
func constantTimeEqual(left string, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

// emailFromIDToken 读取 JWT 的 email claim；refresh.go 也用它解析 ID Token。
// 登录路径会先用 ID Token、再用 Access Token 调它（Node 的
// decodeJwtPayloadUnsafe(idToken) || decodeJwtPayloadUnsafe(accessToken)）。
// 解析失败按缺失处理（Node 同样静默返回 null）。
func emailFromIDToken(jwt string) string {
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		// Node 的 Buffer.from(x, 'base64') 接受带补齐的 base64url；JWT 规范不带
		// 补齐，但自定义客户端可能发 padding，按同一宽容度再试一次。
		payload, err = base64.URLEncoding.DecodeString(parts[1])
	}
	if err != nil {
		return ""
	}
	var claims struct {
		Email        string `json:"email"`
		EmailAddress string `json:"emailAddress"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	if email := strings.TrimSpace(claims.Email); email != "" {
		return email
	}
	return strings.TrimSpace(claims.EmailAddress)
}

// randomState 生成 256 位 base64url state。
//
// 与 Node 的 createOauthState（base64Url(crypto.randomBytes(32))）保持同一熵与
// 编码：state 不进入任何上游协议，但格式一致便于两端日志对账。
func randomState(random io.Reader) (string, error) {
	var buffer [32]byte
	if _, err := io.ReadFull(random, buffer[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer[:]), nil
}

// codeLabel 把缺失的上游错误码写成固定占位符，保证日志可读且不含响应正文。
func codeLabel(code string) string {
	if code == "" {
		return "-"
	}
	return code
}

// validTokenSecret 拒绝空白与控制字符，但从不把原值写入错误。
func validTokenSecret(value string) bool {
	return value != "" &&
		value == strings.TrimSpace(value) &&
		!strings.ContainsAny(value, "\x00\r\n")
}

// validAbsoluteEndpoint 校验内部端点是无凭据的绝对 HTTP(S) URL。
func validAbsoluteEndpoint(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil &&
		(parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Host != "" &&
		parsed.User == nil
}
