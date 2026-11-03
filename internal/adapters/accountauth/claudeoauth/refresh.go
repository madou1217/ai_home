package claudeoauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

const refreshScope = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

var _ accountcredentials.RefreshStrategy = (*Provider)(nil)

// refreshTokenResponse 是 Claude OAuth refresh 成功响应的允许字段。
type refreshTokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
}

// ExpiresAt 只识别 Claude refreshable OAuth，不刷新 setup-token 或静态凭据。
func (*Provider) ExpiresAt(
	credential accountapp.Credential,
) (time.Time, bool) {
	auth, valid := credential.(*claude.OAuthAuth)
	if !valid || auth == nil || auth.ExpiresAtMS() <= 0 {
		return time.Time{}, false
	}
	return time.UnixMilli(auth.ExpiresAtMS()).UTC(), true
}

// Refresh 使用 Claude Code 官方 refresh_token JSON 合同取得新 Access Token。
func (provider *Provider) Refresh(
	ctx context.Context,
	credential accountapp.Credential,
	refreshedAt time.Time,
) (accountapp.Credential, error) {
	auth, valid := credential.(*claude.OAuthAuth)
	if provider == nil ||
		provider.client == nil ||
		!valid ||
		auth == nil ||
		refreshedAt.IsZero() ||
		refreshedAt.UnixMilli() <= 0 {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	if auth.RefreshTokenExpiresAtMS() > 0 &&
		auth.RefreshTokenExpiresAtMS() <= refreshedAt.UnixMilli() {
		return nil, accountcredentials.ErrReauthenticationRequired
	}
	requestBody, err := json.Marshal(struct {
		ClientID     string `json:"client_id"`
		GrantType    string `json:"grant_type"`
		RefreshToken string `json:"refresh_token"`
		Scope        string `json:"scope"`
	}{
		ClientID:     clientID,
		GrantType:    "refresh_token",
		RefreshToken: auth.RefreshToken(),
		Scope:        refreshScope,
	})
	if err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	defer clear(requestBody)
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
		tokens.ExpiresIn <= 0 ||
		tokens.ExpiresIn > (maxUnixMillis-refreshedAt.UnixMilli())/1000 {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	refreshToken := auth.RefreshToken()
	if tokens.RefreshToken != "" {
		refreshToken = tokens.RefreshToken
	}
	scopes := auth.Scopes()
	if tokens.Scope != "" {
		scopes = strings.Fields(tokens.Scope)
	}
	expiresAtMS := refreshedAt.UTC().UnixMilli() + tokens.ExpiresIn*1000
	refreshed, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:             tokens.AccessToken,
		RefreshToken:            refreshToken,
		ExpiresAtMS:             expiresAtMS,
		RefreshTokenExpiresAtMS: auth.RefreshTokenExpiresAtMS(),
		ClientID:                auth.ClientID(),
		Scopes:                  scopes,
		Identity:                auth.Identity(),
	})
	if err != nil || refreshed.IdentitySeed() != auth.IdentitySeed() {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	return refreshed, nil
}
