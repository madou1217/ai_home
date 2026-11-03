package codexoauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
)

const maxTokenBodyBytes = 64 * 1024

// flow 私有持有单次 Codex state 和 PKCE verifier。
type flow struct {
	client        *http.Client
	clock         Clock
	tokenEndpoint string
	redirectURI   string
	authorization string
	verifier      string
	state         string
}

// AuthorizationURL 返回一次性 Codex 官方授权地址。
func (flow *flow) AuthorizationURL() string {
	return flow.authorization
}

// Exchange 校验完整回调 URL、换取 Token，并生成标准 auth.json artifact。
func (flow *flow) Exchange(
	ctx context.Context,
	callback string,
) ([]byte, error) {
	defer flow.releasePrivateValues()
	code, err := parseCallback(callback, flow.redirectURI, flow.state)
	if err != nil {
		return nil, err
	}
	tokens, err := flow.exchangeTokens(ctx, code)
	if err != nil {
		return nil, err
	}
	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:   tokens.AccessToken,
		RefreshToken:  tokens.RefreshToken,
		IDToken:       tokens.IDToken,
		RefreshedAtMS: flow.clock().UTC().UnixMilli(),
	})
	if err != nil {
		return nil, accountauth.ErrProviderRejected
	}
	authJSON, err := authfile.Encode(auth)
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	artifacts, err := json.Marshal(struct {
		AuthJSON json.RawMessage `json:"auth_json"`
	}{
		AuthJSON: authJSON,
	})
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	return artifacts, nil
}

// releasePrivateValues 让一次性 Flow 完成后不再引用 state、verifier 或授权 URL。
func (flow *flow) releasePrivateValues() {
	flow.authorization = ""
	flow.verifier = ""
	flow.state = ""
}

// tokenResponse 是 Codex token endpoint 的三个必填凭据。
type tokenResponse struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

// exchangeTokens 按官方 form-urlencoded 合同换取 Token。
func (flow *flow) exchangeTokens(
	ctx context.Context,
	code string,
) (tokenResponse, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", flow.redirectURI)
	form.Set("client_id", clientID)
	form.Set("code_verifier", flow.verifier)
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		flow.tokenEndpoint,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return tokenResponse{}, accountauth.ErrProviderUnavailable
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	response, err := flow.client.Do(request)
	if err != nil {
		return tokenResponse{}, accountauth.ErrProviderUnavailable
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode >= 400 && response.StatusCode < 500 {
			return tokenResponse{}, accountauth.ErrProviderRejected
		}
		return tokenResponse{}, accountauth.ErrProviderUnavailable
	}
	var tokens tokenResponse
	if err := oauthutil.DecodeJSONResponse(
		response.Body,
		maxTokenBodyBytes,
		&tokens,
	); err != nil ||
		!validSecret(tokens.IDToken) ||
		!validSecret(tokens.AccessToken) ||
		!validSecret(tokens.RefreshToken) {
		return tokenResponse{}, accountauth.ErrProviderUnavailable
	}
	return tokens, nil
}
