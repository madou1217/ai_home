// Package agyoauth 实现 Antigravity consumer Google OAuth 的 Token 刷新策略。
package agyoauth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

const (
	tokenEndpoint = "https://oauth2.googleapis.com/token"
	maxTokenBytes = 256 * 1024
)

type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Egress 是账号级出口绑定（读自 Node 的 account:egress:<ref>）。
//
// Mode 取值：空/default（跟随进程默认）、direct（绕过环境代理）、proxy（显式
// proxyUrl）、pool/tun（宿主代理池，Go 尚未承接）。
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
//   - pool/tun：需要宿主代理池，Go 尚未承接，明确失败而不是静默走错出口。
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
			"%w: 账号出口模式 %q 需要宿主代理，Go 尚未承接",
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
	candidates := provider.clientCredentials
	// 凭据自带的自定义客户端优先：Node 的候选链也是先读 oauth.client_id /
	// oauth.token.client_id，再退回内置 secret。
	if auth.ClientID() != "" && auth.ClientSecret() != "" {
		candidates = append(
			[]clientCredential{{
				clientID:     auth.ClientID(),
				clientSecret: auth.ClientSecret(),
			}},
			candidates...,
		)
	}
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
	var lastErr error
	for _, candidate := range candidates {
		refreshed, retry, err := provider.refreshWithClient(
			ctx,
			client,
			auth,
			candidate,
			refreshedAt,
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
// 第二个返回值表示「可以换下一个候选凭据重试」：传输失败和 invalid_client
// 都属此类（与 Node 生产路径一致）。invalid_grant、限流和 5xx 是终态结论，
// 换 secret 不会改变结果，必须立即返回最后错误。
func (provider *Provider) refreshWithClient(
	ctx context.Context,
	client HTTPClient,
	auth *agy.OAuthAuth,
	clientCredential clientCredential,
	refreshedAt time.Time,
) (accountapp.Credential, bool, error) {
	form := url.Values{
		"client_id":     {clientCredential.clientID},
		"client_secret": {clientCredential.clientSecret},
		"refresh_token": {auth.RefreshToken()},
		"grant_type":    {"refresh_token"},
	}
	request, err := http.NewRequestWithContext(
		ctx,
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
		// 单个 client 的网络失败不能终止整个候选链：Node 生产路径在同一位置
		// continue，内置 legacy secret 仍可能拿到 token（2026-10-22 真机）。
		return nil, true, accountcredentials.ErrRefreshUnavailable
	}
	if response == nil || response.Body == nil {
		return nil, true, accountcredentials.ErrRefreshUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		code := oauthutil.DecodeErrorCode(response.Body, maxTokenBytes)
		classified := oauthutil.ClassifyRefreshError(response.StatusCode, code)
		// 保留上游 status 与机器码：Node 的失败结果带 reason/status，Go 只返回
		// 「账号需要重新认证」会把 invalid_client 和 invalid_grant 混成一句话，
		// 迁移后排查只能靠猜。code 是固定枚举，不含 token 或响应正文。
		if code == "" {
			return nil, false, fmt.Errorf(
				"%w: oauth status=%d",
				classified,
				response.StatusCode,
			)
		}
		return nil, code == "invalid_client", fmt.Errorf(
			"%w: oauth status=%d code=%q",
			classified,
			response.StatusCode,
			code,
		)
	}
	var tokens struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		TokenType    string `json:"token_type"`
		IDToken      string `json:"id_token"`
	}
	if err := oauthutil.DecodeJSONResponse(
		response.Body,
		maxTokenBytes,
		&tokens,
	); err != nil || !validSecret(tokens.AccessToken) ||
		(tokens.RefreshToken != "" && !validSecret(tokens.RefreshToken)) ||
		tokens.ExpiresIn <= 0 ||
		tokens.ExpiresIn > (253_402_300_799_999-refreshedAt.UnixMilli())/1000 {
		return nil, false, accountcredentials.ErrInvalidRefreshResult
	}
	refreshToken := auth.RefreshToken()
	if tokens.RefreshToken != "" {
		refreshToken = tokens.RefreshToken
	}
	tokenType := tokens.TokenType
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
		AccessToken:   tokens.AccessToken,
		RefreshToken:  refreshToken,
		ExpiresAtMS:   refreshedAt.UTC().UnixMilli() + tokens.ExpiresIn*1000,
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

func validSecret(value string) bool {
	return value != "" && len(value) <= maxTokenBytes &&
		value == strings.TrimSpace(value) &&
		!strings.ContainsAny(value, "\r\n\x00")
}
