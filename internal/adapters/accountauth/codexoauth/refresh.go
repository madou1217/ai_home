package codexoauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

var _ accountcredentials.RefreshStrategy = (*Provider)(nil)

// refreshTokenResponse 是 Codex OAuth refresh 成功响应的允许字段。
type refreshTokenResponse struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

// ExpiresAt 只读取 Codex Access Token exp；ID Token 过期不参与可用性判断。
func (*Provider) ExpiresAt(
	credential accountapp.Credential,
) (time.Time, bool) {
	auth, valid := credential.(*codex.OAuthAuth)
	if !valid || auth == nil || auth.AccessExpiresAtMS() <= 0 {
		return time.Time{}, false
	}
	return time.UnixMilli(auth.AccessExpiresAtMS()).UTC(), true
}

// Refresh 使用官方 Codex refresh_token JSON 合同取得新 Access Token。
func (provider *Provider) Refresh(
	ctx context.Context,
	credential accountapp.Credential,
	refreshedAt time.Time,
) (accountapp.Credential, error) {
	auth, valid := credential.(*codex.OAuthAuth)
	if provider == nil ||
		provider.client == nil ||
		!valid ||
		auth == nil ||
		refreshedAt.IsZero() ||
		refreshedAt.UnixMilli() <= 0 {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	requestBody, err := json.Marshal(struct {
		ClientID     string `json:"client_id"`
		GrantType    string `json:"grant_type"`
		RefreshToken string `json:"refresh_token"`
	}{
		ClientID:     clientID,
		GrantType:    "refresh_token",
		RefreshToken: auth.RefreshToken(),
	})
	if err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	defer clearRefreshBytes(requestBody)
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		provider.tokenEndpoint,
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
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, errors.Join(
				accountcredentials.ErrRefreshUnavailable,
				ctxErr,
			)
		}
		return nil, accountcredentials.ErrRefreshUnavailable
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		return nil, oauthutil.ClassifyRefreshError(
			response.StatusCode,
			oauthutil.DecodeErrorCode(
				response.Body,
				maxTokenBodyBytes,
			),
		)
	}
	var tokens refreshTokenResponse
	if err := oauthutil.DecodeJSONResponse(
		response.Body,
		maxTokenBodyBytes,
		&tokens,
	); err != nil ||
		!validSecret(tokens.AccessToken) ||
		(tokens.RefreshToken != "" && !validSecret(tokens.RefreshToken)) ||
		(tokens.IDToken != "" && !validSecret(tokens.IDToken)) {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	refreshToken := auth.RefreshToken()
	if tokens.RefreshToken != "" {
		refreshToken = tokens.RefreshToken
	}
	idToken := auth.IDToken()
	if tokens.IDToken != "" {
		idToken = tokens.IDToken
	}
	refreshed, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:       tokens.AccessToken,
		RefreshToken:      refreshToken,
		IDToken:           idToken,
		RefreshedAtMS:     refreshedAt.UTC().UnixMilli(),
		ExplicitAccountID: auth.UpstreamAccountID(),
	})
	if err != nil || refreshed.IdentitySeed() != auth.IdentitySeed() {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	return refreshed, nil
}

// clearRefreshBytes 覆盖包含 Refresh Token 的临时 JSON 缓冲区。
func clearRefreshBytes(data []byte) {
	for index := range data {
		data[index] = 0
	}
}
