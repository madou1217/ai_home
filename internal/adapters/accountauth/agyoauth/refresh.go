// Package agyoauth 实现 Antigravity consumer Google OAuth 的 Token 刷新策略。
package agyoauth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
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

// Provider 是无共享可变账号状态的 AGY OAuth 刷新策略。
// 并发合并与版本 CAS 由 accountcredentials.Resolver 统一负责。
type Provider struct {
	client            HTTPClient
	tokenEndpoint     string
	clientCredentials []clientCredential
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
	auth, valid := credential.(*agy.OAuthAuth)
	if provider == nil || provider.client == nil || ctx == nil ||
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
	var lastErr error
	for _, candidate := range provider.clientCredentials {
		refreshed, retry, err := provider.refreshWithClient(
			ctx,
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
	response, err := provider.client.Do(request)
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
	refreshed, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         auth.Email(),
		AccessToken:   tokens.AccessToken,
		RefreshToken:  refreshToken,
		ExpiresAtMS:   refreshedAt.UTC().UnixMilli() + tokens.ExpiresIn*1000,
		RefreshedAtMS: refreshedAt.UTC().UnixMilli(),
		TokenType:     tokenType,
		AuthMethod:    auth.AuthMethod(),
	})
	if err != nil || refreshed.IdentitySeed() != auth.IdentitySeed() {
		return nil, false, accountcredentials.ErrInvalidRefreshResult
	}
	return refreshed, false, nil
}

func validSecret(value string) bool {
	return value != "" && len(value) <= maxTokenBytes &&
		value == strings.TrimSpace(value) &&
		!strings.ContainsAny(value, "\r\n\x00")
}
