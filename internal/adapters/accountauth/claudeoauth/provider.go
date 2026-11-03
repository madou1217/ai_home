// Package claudeoauth 实现 Claude 官方手动 OAuth Authorization Code + PKCE 流程。
package claudeoauth

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

const (
	providerID        = "claude"
	authorizeEndpoint = "https://claude.com/cai/oauth/authorize"
	tokenEndpoint     = "https://platform.claude.com/v1/oauth/token"
	profileEndpoint   = "https://api.anthropic.com/api/oauth/profile"
	clientID          = "9d1c250a-e61b-44d9-88ed-5944d1962f5e" // gitleaks:allow -- Claude 官方公开 OAuth Client ID。
	redirectURI       = "https://platform.claude.com/oauth/code/callback"
	oauthScope        = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
)

// Clock 返回计算 Claude Access Token 绝对过期时间所需的当前时间。
type Clock func() time.Time

// Provider 是无可变会话状态的 Claude OAuth Strategy。
type Provider struct {
	client            *http.Client
	clock             Clock
	random            io.Reader
	authorizeEndpoint string
	tokenEndpoint     string
	profileEndpoint   string
	redirectURI       string
}

// providerOptions 仅供包内测试替换网络端点和随机源。
type providerOptions struct {
	client            *http.Client
	clock             Clock
	random            io.Reader
	authorizeEndpoint string
	tokenEndpoint     string
	profileEndpoint   string
	redirectURI       string
}

// New 创建固定使用 Claude 官方生产 OAuth 端点的 Strategy。
func New(client *http.Client, clock Clock) (*Provider, error) {
	return newProvider(providerOptions{
		client:            client,
		clock:             clock,
		random:            rand.Reader,
		authorizeEndpoint: authorizeEndpoint,
		tokenEndpoint:     tokenEndpoint,
		profileEndpoint:   profileEndpoint,
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
		!validAbsoluteURL(options.profileEndpoint) ||
		!validAbsoluteURL(options.redirectURI) {
		return nil, accountauth.ErrInvalidDependencies
	}
	return &Provider{
		client:            options.client,
		clock:             options.clock,
		random:            options.random,
		authorizeEndpoint: options.authorizeEndpoint,
		tokenEndpoint:     options.tokenEndpoint,
		profileEndpoint:   options.profileEndpoint,
		redirectURI:       options.redirectURI,
	}, nil
}

// ProviderID 返回规范 Claude Provider ID。
func (*Provider) ProviderID() string {
	return providerID
}

// Begin 生成 32 字节 PKCE verifier、32 字节 state 和官方手动授权 URL。
func (provider *Provider) Begin(ctx context.Context) (accountauth.OAuthFlow, error) {
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(accountauth.ErrProviderUnavailable, err)
	}
	pkce, err := oauthutil.GeneratePKCE(provider.random, 32)
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
		client:          provider.client,
		clock:           provider.clock,
		tokenEndpoint:   provider.tokenEndpoint,
		profileEndpoint: provider.profileEndpoint,
		redirectURI:     provider.redirectURI,
		authorization:   authorizationURL,
		verifier:        pkce.Verifier,
		state:           state,
	}, nil
}

// buildAuthorizationURL 精确生成 Claude Code 当前手动登录查询参数。
func (provider *Provider) buildAuthorizationURL(
	challenge string,
	state string,
) (string, error) {
	parsed, err := url.Parse(provider.authorizeEndpoint)
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	query.Set("code", "true")
	query.Set("client_id", clientID)
	query.Set("response_type", "code")
	query.Set("redirect_uri", provider.redirectURI)
	query.Set("scope", oauthScope)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	query.Set("state", state)
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
