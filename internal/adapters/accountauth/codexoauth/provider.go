// Package codexoauth 实现 Codex 官方 ChatGPT OAuth Authorization Code + PKCE 流程。
package codexoauth

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

const (
	providerID        = "codex"
	authorizeEndpoint = "https://auth.openai.com/oauth/authorize"
	tokenEndpoint     = "https://auth.openai.com/oauth/token"
	clientID          = "app_EMoamEEZ73f0CkXaXp7hrann" // gitleaks:allow -- Codex 官方公开 OAuth Client ID。
	redirectURI       = "http://localhost:1455/auth/callback"
	oauthScope        = "openid profile email offline_access api.connectors.read api.connectors.invoke"
)

// Clock 返回生成官方 auth.json last_refresh 所需的当前时间。
type Clock func() time.Time

// Provider 是无可变会话状态的 Codex OAuth Strategy。
type Provider struct {
	client            *http.Client
	clock             Clock
	random            io.Reader
	authorizeEndpoint string
	tokenEndpoint     string
	redirectURI       string
}

// providerOptions 仅供包内测试替换网络端点和随机源。
type providerOptions struct {
	client            *http.Client
	clock             Clock
	random            io.Reader
	authorizeEndpoint string
	tokenEndpoint     string
	redirectURI       string
}

// New 创建固定使用 Codex 官方生产 OAuth 端点的 Strategy。
func New(client *http.Client, clock Clock) (*Provider, error) {
	return newProvider(providerOptions{
		client:            client,
		clock:             clock,
		random:            rand.Reader,
		authorizeEndpoint: authorizeEndpoint,
		tokenEndpoint:     tokenEndpoint,
		redirectURI:       redirectURI,
	})
}

// newProvider 校验可注入依赖，生产构造器不会暴露端点覆盖能力。
func newProvider(options providerOptions) (*Provider, error) {
	if options.client == nil ||
		options.clock == nil ||
		options.random == nil ||
		!validAbsoluteURL(options.authorizeEndpoint) ||
		!validAbsoluteURL(options.tokenEndpoint) ||
		!validAbsoluteURL(options.redirectURI) {
		return nil, accountauth.ErrInvalidDependencies
	}
	return &Provider{
		client:            options.client,
		clock:             options.clock,
		random:            options.random,
		authorizeEndpoint: options.authorizeEndpoint,
		tokenEndpoint:     options.tokenEndpoint,
		redirectURI:       options.redirectURI,
	}, nil
}

// ProviderID 返回规范 Codex Provider ID。
func (*Provider) ProviderID() string {
	return providerID
}

// Begin 生成 64 字节 PKCE verifier、32 字节 state 和官方授权 URL。
func (provider *Provider) Begin(ctx context.Context) (accountauth.OAuthFlow, error) {
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(accountauth.ErrProviderUnavailable, err)
	}
	pkce, err := oauthutil.GeneratePKCE(provider.random, 64)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	state, err := oauthutil.GenerateState(provider.random, 32)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	authorizationURL, err := provider.buildAuthorizationURL(pkce.Challenge, state)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	return &flow{
		client:        provider.client,
		clock:         provider.clock,
		tokenEndpoint: provider.tokenEndpoint,
		redirectURI:   provider.redirectURI,
		authorization: authorizationURL,
		verifier:      pkce.Verifier,
		state:         state,
	}, nil
}

// buildAuthorizationURL 精确生成 Codex CLI 当前使用的官方查询参数。
func (provider *Provider) buildAuthorizationURL(
	challenge string,
	state string,
) (string, error) {
	parsed, err := url.Parse(provider.authorizeEndpoint)
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	query.Set("response_type", "code")
	query.Set("client_id", clientID)
	query.Set("redirect_uri", provider.redirectURI)
	query.Set("scope", oauthScope)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	query.Set("id_token_add_organizations", "true")
	query.Set("codex_cli_simplified_flow", "true")
	query.Set("state", state)
	query.Set("originator", "codex_cli_rs")
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

// validAbsoluteURL 校验内部端点是无凭据的绝对 HTTP(S) URL。
func validAbsoluteURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil &&
		(parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Host != "" &&
		parsed.User == nil
}

// String 返回不包含 Flow 私有值的固定 Provider 摘要。
func (provider *Provider) String() string {
	if provider == nil {
		return "codexoauth.Provider<nil>"
	}
	return fmt.Sprintf("codexoauth.Provider{%s}", providerID)
}
