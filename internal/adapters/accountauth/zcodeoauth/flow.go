package zcodeoauth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

const maxTokenBodyBytes = 64 * 1024

// flow 私有持有单次 ZCode state 与区域。
type flow struct {
	client        *http.Client
	region        region
	authStrategy  string
	tokenEndpoint string
	authorization string
	state         string
	// account 是 Exchange 从 token 响应解析出的展示字段；不含凭据。
	account accountauth.Account
}

// tokenRequestProvider 是 token 交换请求体里的 provider 字段。
//
// Node 的 custom-scheme 分支无论区域都发 zai（区域只影响授权入口与凭据键前缀），
// 这里逐项对齐：擅自改成区域名会让 Go 与 Node 的请求体分叉。
const tokenRequestProvider = "zai"

// tokenRequest 是 ZCode token endpoint 的请求体，字段与 Node 的 custom-scheme 交换逐项一致。
type tokenRequest struct {
	Provider    string `json:"provider"`
	Code        string `json:"code"`
	RedirectURI string `json:"redirect_uri"`
	State       string `json:"state"`
}

// tokenEnvelope 是 ZCode 的业务包装响应：HTTP 200 也可能是失败（code != 0）。
type tokenEnvelope struct {
	Code *int            `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

// tokenData 是 data 字段；zai / bigmodel 只出现一个，另一个为空。
type tokenData struct {
	Token    string          `json:"token"`
	User     json.RawMessage `json:"user"`
	Zai      *providerTokens `json:"zai"`
	Bigmodel *providerTokens `json:"bigmodel"`
}

// providerTokens 是区域维度的 provider 凭据。
type providerTokens struct {
	AccessToken   string `json:"access_token"`
	AccessTokenC  string `json:"accessToken"`
	RefreshToken  string `json:"refresh_token"`
	RefreshTokenC string `json:"refreshToken"`
}

// accessToken 返回上游给的 provider access token（兼容 camelCase）。
func (tokens providerTokens) accessToken() string {
	if value := strings.TrimSpace(tokens.AccessToken); value != "" {
		return value
	}
	return strings.TrimSpace(tokens.AccessTokenC)
}

// refreshTokenValue 返回可选 refresh token（兼容 camelCase）。
func (tokens providerTokens) refreshTokenValue() string {
	if value := strings.TrimSpace(tokens.RefreshToken); value != "" {
		return value
	}
	return strings.TrimSpace(tokens.RefreshTokenC)
}

// AuthorizationURL 返回一次性 ZCode 授权地址。
func (flow *flow) AuthorizationURL() string {
	return flow.authorization
}

// OAuthState 仅向应用服务内部暴露 state，用于协议回调按 state 认领在途 Job。
func (flow *flow) OAuthState() string {
	if flow == nil {
		return ""
	}
	return flow.state
}

// AuthStrategy 返回本次 ZCode 流程采用的子策略标识。
func (flow *flow) AuthStrategy() string {
	if flow == nil {
		return ""
	}
	return flow.authStrategy
}

// AccountClaims 返回 Exchange 从 token 响应解析出的公开账号字段。
//
// 在 Exchange 之前调用返回零值；这些字段只用于登录结果展示。
func (flow *flow) AccountClaims() accountauth.Account {
	if flow == nil {
		return accountauth.Account{}
	}
	return flow.account
}

// Exchange 校验粘贴的回调、换取 Token，并生成可注册的 native_auth_json。
func (flow *flow) Exchange(
	ctx context.Context,
	callback string,
) ([]byte, error) {
	defer flow.releasePrivateValues()
	code, err := parseCallback(callback, redirectURI, flow.state)
	if err != nil {
		return nil, err
	}
	result, err := flow.exchangeTokens(ctx, code)
	if err != nil {
		return nil, err
	}
	return flow.buildArtifacts(result)
}

// releasePrivateValues 让一次性 Flow 完成后不再引用 state 或授权 URL。
func (flow *flow) releasePrivateValues() {
	flow.authorization = ""
	flow.state = ""
}

// exchangeResult 是一次成功交换的结果。
type exchangeResult struct {
	accessToken  string
	refreshToken string
	zcodeJWToken string
	user         map[string]any
}

// exchangeTokens 按 Node 的合同换取 Token：JSON 请求体 + 业务包装响应。
func (flow *flow) exchangeTokens(
	ctx context.Context,
	code string,
) (exchangeResult, error) {
	payload, err := json.Marshal(tokenRequest{
		Provider:    tokenRequestProvider,
		Code:        code,
		RedirectURI: redirectURI,
		State:       flow.state,
	})
	if err != nil {
		return exchangeResult{}, accountauth.ErrProviderUnavailable
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		flow.tokenEndpoint,
		bytes.NewReader(payload),
	)
	if err != nil {
		return exchangeResult{}, accountauth.ErrProviderUnavailable
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	response, err := flow.client.Do(request)
	if err != nil {
		return exchangeResult{}, accountauth.ErrProviderUnavailable
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode >= 400 && response.StatusCode < 500 {
			return exchangeResult{}, accountauth.ErrProviderRejected
		}
		return exchangeResult{}, accountauth.ErrProviderUnavailable
	}
	var envelope tokenEnvelope
	if err := oauthutil.DecodeJSONResponse(
		response.Body,
		maxTokenBodyBytes,
		&envelope,
	); err != nil {
		return exchangeResult{}, accountauth.ErrProviderUnavailable
	}
	// 业务包装：code 缺省视为成功，非 0 一律是上游明确拒绝。
	if envelope.Code != nil && *envelope.Code != 0 {
		return exchangeResult{}, accountauth.ErrProviderRejected
	}
	var data tokenData
	if len(envelope.Data) == 0 ||
		json.Unmarshal(envelope.Data, &data) != nil {
		return exchangeResult{}, accountauth.ErrProviderRejected
	}
	tokens := providerTokensOf(data, flow.region.id)
	if tokens == nil {
		return exchangeResult{}, accountauth.ErrProviderRejected
	}
	accessToken := tokens.accessToken()
	zcodeJWToken := strings.TrimSpace(data.Token)
	// 缺 data.token 或 provider access_token 是半截凭据：写盘后只会在后续请求里
	// 以更难定位的方式暴露，因此直接判上游拒绝。
	if !validSecret(accessToken) || !validSecret(zcodeJWToken) {
		return exchangeResult{}, accountauth.ErrProviderRejected
	}
	return exchangeResult{
		accessToken:  accessToken,
		refreshToken: tokens.refreshTokenValue(),
		zcodeJWToken: zcodeJWToken,
		user:         decodeUser(data.User),
	}, nil
}

// providerTokensOf 取指定区域（或 zai / bigmodel 的兜底）凭据。
func providerTokensOf(data tokenData, regionID string) *providerTokens {
	if regionID == "bigmodel" && data.Bigmodel != nil {
		return data.Bigmodel
	}
	if data.Zai != nil {
		return data.Zai
	}
	return data.Bigmodel
}

// decodeUser 把 user 字段解成对象；非对象或空一律视为缺失。
func decodeUser(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var user map[string]any
	if json.Unmarshal(raw, &user) != nil || len(user) == 0 {
		return nil
	}
	return user
}

// buildArtifacts 生成 nativeaccount 能解码的 native_auth_json。
//
// 形状与 zcode-credential-writer 落盘的 plaintext credentials 相同（键前缀由区域决定），
// 只是这里不加密：解密后的 credentials 才是账号注册链的输入。
func (flow *flow) buildArtifacts(result exchangeResult) ([]byte, error) {
	credentials := map[string]any{
		"oauth:active_provider":    flow.region.id,
		flow.region.accessTokenKey: result.accessToken,
		"zcodejwttoken":            result.zcodeJWToken,
	}
	if result.refreshToken != "" {
		credentials[flow.region.refreshTokenKey] = result.refreshToken
	}
	if profile := buildUserProfile(result.user); profile != nil {
		encoded, err := json.Marshal(profile)
		if err != nil {
			return nil, accountauth.ErrInvalidArtifacts
		}
		credentials[flow.region.userInfoKey] = string(encoded)
		flow.account = accountFromProfile(profile)
	}
	nativeAuth, err := json.Marshal(map[string]any{"credentials": credentials})
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	artifacts, err := json.Marshal(struct {
		NativeAuthJSON json.RawMessage `json:"native_auth_json"`
	}{
		NativeAuthJSON: nativeAuth,
	})
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	return artifacts, nil
}

// userProfile 是写入 credentials 的身份形状。
//
// 桌面端只认 {id, username, displayName}；user_id 是 Go 侧解码器做身份一致性
// 校验的锚点（与 zcodejwttoken 的 subject 必须同源），多一个键不影响桌面端。
type userProfile struct {
	ID          string         `json:"id"`
	Username    string         `json:"username"`
	DisplayName string         `json:"displayName"`
	UserID      string         `json:"user_id"`
	Email       string         `json:"email,omitempty"`
	RawProfile  map[string]any `json:"rawProfile,omitempty"`
}

// buildUserProfile 把上游 user 归一成桌面端认识的形状（见 lib/account/zcode-identity.js）。
//
// 上游没给 id 或展示名时返回 nil：不写半截身份，至少登录本身还能成立。
func buildUserProfile(user map[string]any) *userProfile {
	if user == nil {
		return nil
	}
	id := firstText(user, "customerNumber", "user_id", "userId", "id", "sub")
	name := firstText(user, "customerName", "nickName", "name", "username", "display_name")
	email := firstText(user, "email")
	label := name
	if label == "" {
		label = email
	}
	if label == "" {
		label = id
	}
	if id == "" || label == "" {
		return nil
	}
	return &userProfile{
		ID:          id,
		Username:    label,
		DisplayName: label,
		UserID:      id,
		Email:       email,
		RawProfile:  user,
	}
}

// accountFromProfile 把身份形状投影成登录结果展示字段。
func accountFromProfile(profile *userProfile) accountauth.Account {
	return accountauth.Account{
		Email:       profile.Email,
		DisplayName: profile.DisplayName,
	}
}

// firstText 返回第一个非空字符串字段（去空白）。
func firstText(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := record[key].(string); ok {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}
