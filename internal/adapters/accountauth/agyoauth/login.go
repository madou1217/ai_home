package agyoauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
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

// rotatedClientSecret 是 Google 轮换后的 Antigravity installed-app secret。
// 旧 secret 仍被现有客户端接受，所以首次换码遇到 invalid_client 时按顺序重试。
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
		return loginTokens{}, accountauth.ErrProviderUnavailable, false
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	response, err := flow.provider.client.Do(request)
	if err != nil {
		return loginTokens{}, accountauth.ErrProviderUnavailable, false
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxLoginBodyBytes))
	if err != nil {
		return loginTokens{}, accountauth.ErrProviderUnavailable, false
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode >= 400 && response.StatusCode < 500 {
			var failure struct {
				Error string `json:"error"`
			}
			_ = json.Unmarshal(body, &failure)
			return loginTokens{}, accountauth.ErrProviderRejected,
				strings.EqualFold(strings.TrimSpace(failure.Error), "invalid_client")
		}
		return loginTokens{}, accountauth.ErrProviderUnavailable, false
	}
	var tokens loginTokens
	if err := json.Unmarshal(body, &tokens); err != nil {
		return loginTokens{}, accountauth.ErrProviderUnavailable, false
	}
	if !validTokenSecret(tokens.AccessToken) || !validTokenSecret(tokens.RefreshToken) {
		return loginTokens{}, accountauth.ErrProviderRejected, false
	}
	if tokens.ExpiresIn <= 0 {
		tokens.ExpiresIn = 3600
	}
	if strings.TrimSpace(tokens.TokenType) == "" {
		tokens.TokenType = "Bearer"
	}
	return tokens, nil, false
}

// resolveEmail 先读 ID Token claim，缺失时回落到 OIDC userinfo。
func (flow *loginFlow) resolveEmail(ctx context.Context, tokens loginTokens) (string, error) {
	if email := emailFromIDToken(tokens.IDToken); email != "" {
		return email, nil
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		flow.provider.userInfoEndpoint,
		nil,
	)
	if err != nil {
		return "", accountauth.ErrProviderUnavailable
	}
	request.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
	request.Header.Set("Accept", "application/json")
	response, err := flow.provider.client.Do(request)
	if err != nil {
		return "", accountauth.ErrProviderUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", accountauth.ErrProviderRejected
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxLoginBodyBytes))
	if err != nil {
		return "", accountauth.ErrProviderUnavailable
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

// buildArtifacts 生成 decoder 认识的 native_auth_json；id_token 不在快照字段内。
func (flow *loginFlow) buildArtifacts(tokens loginTokens, email string) ([]byte, error) {
	now := flow.provider.clock().UTC()
	expiresAt := now.Add(time.Duration(tokens.ExpiresIn) * time.Second)
	native, err := json.Marshal(map[string]any{
		"email": strings.TrimSpace(email),
		"oauthToken": map[string]any{
			"auth_method": "consumer",
			"token": map[string]any{
				"access_token":    tokens.AccessToken,
				"refresh_token":   tokens.RefreshToken,
				"token_type":      tokens.TokenType,
				"expiry":          expiresAt.Format(time.RFC3339),
				"expires_at_ms":   expiresAt.UnixMilli(),
				"refreshed_at_ms": now.UnixMilli(),
			},
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
func parseLoginCallback(raw string, expectedRedirect string, expectedState string) (string, error) {
	if raw == "" || len(raw) > maxLoginBodyBytes || !strings.Contains(raw, "://") {
		return "", accountauth.ErrInvalidCallback
	}
	callback, err := url.Parse(raw)
	expected, expectedErr := url.Parse(expectedRedirect)
	if err != nil ||
		expectedErr != nil ||
		callback.User != nil ||
		callback.Fragment != "" ||
		!strings.EqualFold(callback.Scheme, expected.Scheme) ||
		!strings.EqualFold(callback.Host, expected.Host) ||
		callback.Path != expected.Path {
		return "", accountauth.ErrInvalidCallback
	}
	query, err := url.ParseQuery(callback.RawQuery)
	if err != nil {
		return "", accountauth.ErrInvalidCallback
	}
	if values, found := query["state"]; !found || len(values) != 1 || values[0] != expectedState {
		return "", accountauth.ErrStateMismatch
	}
	if providerError := query.Get("error"); providerError != "" {
		return "", accountauth.ErrProviderRejected
	}
	code := query.Get("code")
	if !validTokenSecret(code) {
		return "", accountauth.ErrInvalidCallback
	}
	return code, nil
}

// emailFromIDToken 读取 ID Token 的 email claim；解析失败按缺失处理。
func emailFromIDToken(idToken string) string {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
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

// randomState 生成 128 位十六进制 state。
func randomState(random io.Reader) (string, error) {
	var buffer [16]byte
	if _, err := io.ReadFull(random, buffer[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer[:]), nil
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
