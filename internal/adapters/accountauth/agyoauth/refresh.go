// Package agyoauth 实现 Antigravity consumer Google OAuth 的 Token 刷新策略。
package agyoauth

import (
	"context"
	"errors"
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
	client           HTTPClient
	tokenEndpoint    string
	clientCredential clientCredential
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
		client:           client,
		tokenEndpoint:    endpoint,
		clientCredential: defaultClientCredential(),
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
	form := url.Values{
		"client_id":     {provider.clientCredential.clientID},
		"client_secret": {provider.clientCredential.clientSecret},
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
		return nil, accountcredentials.ErrRefreshUnavailable
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")
	response, err := provider.client.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, errors.Join(accountcredentials.ErrRefreshUnavailable, ctxErr)
		}
		return nil, accountcredentials.ErrRefreshUnavailable
	}
	if response == nil || response.Body == nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		return nil, accountcredentials.ErrRefreshUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		return nil, oauthutil.ClassifyRefreshError(
			response.StatusCode,
			oauthutil.DecodeErrorCode(response.Body, maxTokenBytes),
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
		return nil, accountcredentials.ErrInvalidRefreshResult
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
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	return refreshed, nil
}

func validSecret(value string) bool {
	return value != "" && len(value) <= maxTokenBytes &&
		value == strings.TrimSpace(value) &&
		!strings.ContainsAny(value, "\r\n\x00")
}
