package claudeoauth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
	"github.com/madou1217/ai_home/internal/adapters/claude/oauthaccount"
	"github.com/madou1217/ai_home/internal/adapters/claude/securestorage"
)

const (
	maxTokenBodyBytes = 64 * 1024
	maxProfileBytes   = 128 * 1024
	maxUnixMillis     = int64(253_402_300_799_999)
)

// requestedScopes 是写入 Claude 官方 secure storage 的规范权限顺序。
var requestedScopes = []string{
	"org:create_api_key",
	"user:profile",
	"user:inference",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
}

// flow 私有持有单次 Claude state 和 PKCE verifier。
type flow struct {
	client          *http.Client
	clock           Clock
	tokenEndpoint   string
	profileEndpoint string
	redirectURI     string
	authorization   string
	verifier        string
	state           string
}

// AuthorizationURL 返回一次性 Claude 官方手动授权地址。
func (flow *flow) AuthorizationURL() string {
	return flow.authorization
}

// Exchange 校验手动 code#state 或完整回调 URL，并生成两个官方 artifact。
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
	profileResponse, err := flow.fetchProfile(ctx, tokens.AccessToken)
	if err != nil {
		return nil, err
	}
	return flow.buildArtifacts(tokens, profileResponse)
}

// releasePrivateValues 让一次性 Flow 完成后不再引用 state、verifier 或授权 URL。
func (flow *flow) releasePrivateValues() {
	flow.authorization = ""
	flow.verifier = ""
	flow.state = ""
}

// tokenResponse 是 Claude token endpoint 的注册所需字段。
type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
}

// exchangeTokens 按官方 JSON 合同换取 Claude Token。
func (flow *flow) exchangeTokens(
	ctx context.Context,
	code string,
) (tokenResponse, error) {
	requestBody, err := json.Marshal(struct {
		GrantType    string `json:"grant_type"`
		Code         string `json:"code"`
		RedirectURI  string `json:"redirect_uri"`
		ClientID     string `json:"client_id"`
		CodeVerifier string `json:"code_verifier"`
		State        string `json:"state"`
	}{
		GrantType:    "authorization_code",
		Code:         code,
		RedirectURI:  flow.redirectURI,
		ClientID:     clientID,
		CodeVerifier: flow.verifier,
		State:        flow.state,
	})
	if err != nil {
		return tokenResponse{}, accountauth.ErrProviderUnavailable
	}
	defer clear(requestBody)
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		flow.tokenEndpoint,
		bytes.NewReader(requestBody),
	)
	if err != nil {
		return tokenResponse{}, accountauth.ErrProviderUnavailable
	}
	request.Header.Set("Content-Type", "application/json")
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
		!validSecret(tokens.AccessToken) ||
		!validSecret(tokens.RefreshToken) ||
		tokens.ExpiresIn <= 0 {
		return tokenResponse{}, accountauth.ErrProviderUnavailable
	}
	return tokens, nil
}

// profileResponse 是 Claude 官方 Profile API 的账号和组织公开资料。
type profileResponse struct {
	Account      *profileAccount      `json:"account"`
	Organization *profileOrganization `json:"organization"`
}

// profileAccount 描述 Profile API 返回的稳定账号身份。
type profileAccount struct {
	UUID        string `json:"uuid"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
	CreatedAt   string `json:"created_at"`
}

// profileOrganization 描述 Profile API 返回的订阅和组织资料。
type profileOrganization struct {
	UUID                  string `json:"uuid"`
	Name                  string `json:"name"`
	OrganizationType      string `json:"organization_type"`
	RateLimitTier         string `json:"rate_limit_tier"`
	BillingType           string `json:"billing_type"`
	HasExtraUsageEnabled  *bool  `json:"has_extra_usage_enabled"`
	SubscriptionCreatedAt string `json:"subscription_created_at"`
}

// fetchProfile 使用 Access Token 确认账号 UUID、邮箱和订阅资料。
func (flow *flow) fetchProfile(
	ctx context.Context,
	accessToken string,
) (profileResponse, error) {
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		flow.profileEndpoint,
		nil,
	)
	if err != nil {
		return profileResponse{}, accountauth.ErrProviderUnavailable
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := flow.client.Do(request)
	if err != nil {
		return profileResponse{}, accountauth.ErrProviderUnavailable
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == http.StatusUnauthorized ||
			response.StatusCode == http.StatusForbidden {
			return profileResponse{}, accountauth.ErrProviderRejected
		}
		return profileResponse{}, accountauth.ErrProviderUnavailable
	}
	var profile profileResponse
	if err := oauthutil.DecodeJSONResponse(
		response.Body,
		maxProfileBytes,
		&profile,
	); err != nil ||
		profile.Account == nil ||
		profile.Organization == nil {
		return profileResponse{}, accountauth.ErrProviderUnavailable
	}
	return profile, nil
}

// buildArtifacts 从可信 Token 与 Profile 创建官方 secure storage 和 oauthAccount JSON。
func (flow *flow) buildArtifacts(
	tokens tokenResponse,
	upstream profileResponse,
) ([]byte, error) {
	nowMilliseconds := flow.clock().UTC().UnixMilli()
	if nowMilliseconds <= 0 ||
		tokens.ExpiresIn > (maxUnixMillis-nowMilliseconds)/1000 {
		return nil, accountauth.ErrProviderUnavailable
	}
	expiresAt := nowMilliseconds + tokens.ExpiresIn*1000
	scopes := strings.Fields(tokens.Scope)
	if len(scopes) == 0 {
		scopes = append([]string(nil), requestedScopes...)
	}
	accountProfile, err := newOAuthProfile(upstream)
	if err != nil {
		return nil, accountauth.ErrProviderRejected
	}
	subscription, err := claude.NewSubscription(
		subscriptionType(upstream.Organization.OrganizationType),
		upstream.Organization.RateLimitTier,
	)
	if err != nil {
		return nil, accountauth.ErrProviderRejected
	}
	auth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  tokens.AccessToken,
		RefreshToken: tokens.RefreshToken,
		ExpiresAtMS:  expiresAt,
		Scopes:       scopes,
		Identity:     accountProfile.Identity(),
	})
	if err != nil {
		return nil, accountauth.ErrProviderRejected
	}
	credentialsJSON, err := securestorage.Encode(securestorage.DecodedOAuth{
		Auth:         auth,
		Subscription: subscription,
	})
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	globalConfigJSON, err := oauthaccount.Encode(accountProfile)
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	artifacts, err := json.Marshal(struct {
		CredentialsJSON  json.RawMessage `json:"credentials_json"`
		GlobalConfigJSON json.RawMessage `json:"global_config_json"`
	}{
		CredentialsJSON:  credentialsJSON,
		GlobalConfigJSON: globalConfigJSON,
	})
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	return artifacts, nil
}

// newOAuthProfile 把官方 RFC3339 时间和公开字段转换为 Claude 领域资料。
func newOAuthProfile(upstream profileResponse) (claude.OAuthProfile, error) {
	accountCreatedAt, err := optionalUnixMillis(upstream.Account.CreatedAt)
	if err != nil {
		return claude.OAuthProfile{}, err
	}
	subscriptionCreatedAt, err := optionalUnixMillis(
		upstream.Organization.SubscriptionCreatedAt,
	)
	if err != nil {
		return claude.OAuthProfile{}, err
	}
	return claude.NewOAuthProfile(claude.OAuthProfileInput{
		AccountUUID:             upstream.Account.UUID,
		Email:                   upstream.Account.Email,
		OrganizationUUID:        upstream.Organization.UUID,
		OrganizationName:        upstream.Organization.Name,
		DisplayName:             upstream.Account.DisplayName,
		HasExtraUsageEnabled:    upstream.Organization.HasExtraUsageEnabled,
		BillingType:             upstream.Organization.BillingType,
		AccountCreatedAtMS:      accountCreatedAt,
		SubscriptionCreatedAtMS: subscriptionCreatedAt,
	})
}

// optionalUnixMillis 把可选 RFC3339 字符串转换为 Unix 毫秒。
func optionalUnixMillis(value string) (int64, error) {
	if value == "" {
		return 0, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || parsed.UnixMilli() <= 0 {
		return 0, accountauth.ErrProviderRejected
	}
	return parsed.UnixMilli(), nil
}

// subscriptionType 复用 Claude Code 对 organization_type 的官方映射。
func subscriptionType(organizationType string) string {
	switch organizationType {
	case "claude_max":
		return "max"
	case "claude_pro":
		return "pro"
	case "claude_team":
		return "team"
	case "claude_enterprise":
		return "enterprise"
	default:
		return ""
	}
}

// clear 覆盖包含授权码和 verifier 的临时 JSON 请求缓冲区。
func clear(data []byte) {
	for index := range data {
		data[index] = 0
	}
}
