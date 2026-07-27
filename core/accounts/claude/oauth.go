package claude

import "fmt"

// OAuthIdentity 是 Claude secure storage 之外的最小稳定账号身份。
//
// Claude Code 把 Token 放在 Keychain 或 .credentials.json，却把账号 UUID 放在独立
// oauthAccount 配置中，因此 Adapter 必须显式提供该上下文，不能从 Token 猜测。
type OAuthIdentity struct {
	// AccountUUID 是 Claude 账号的稳定 UUID，OAuth 领域值必须提供。
	AccountUUID string
}

// OAuthInput 是创建 OAuthAuth 所需的完整输入。
type OAuthInput struct {
	// AccessToken 是当前请求使用的 Bearer Token。
	AccessToken string
	// RefreshToken 是刷新 Access Token 使用的长期凭据。
	RefreshToken string
	// ExpiresAtMS 是 Access Token 的绝对 Unix 毫秒过期时间。
	ExpiresAtMS int64
	// RefreshTokenExpiresAtMS 是 Refresh Token 的可选绝对 Unix 毫秒过期时间；零表示官方未提供。
	RefreshTokenExpiresAtMS int64
	// ClientID 是签发该凭据的可选 OAuth 客户端标识。
	ClientID string
	// Scopes 是官方 OAuth 授予的权限集合，必须包含 user:inference。
	Scopes []string
	// Identity 来自官方 oauthAccount，而不是 secure storage Token 容器。
	Identity OAuthIdentity
}

// OAuthAuth 是构造后不可变的 Claude.ai OAuth 认证值。
type OAuthAuth struct {
	accessToken             *secretValue
	refreshToken            *secretValue
	expiresAtMS             int64
	refreshTokenExpiresAtMS int64
	clientID                string
	scopes                  []string
	identity                OAuthIdentity
	identitySeed            string
}

// NewOAuthAuth 校验凭据、权限和外部身份后构建只读 OAuth 值。
func NewOAuthAuth(input OAuthInput) (*OAuthAuth, error) {
	accessToken, err := requireSecret(input.AccessToken)
	if err != nil {
		return nil, err
	}
	refreshToken, err := requireSecret(input.RefreshToken)
	if err != nil {
		return nil, err
	}
	if input.ExpiresAtMS <= 0 || input.ExpiresAtMS > maxUnixMillis {
		return nil, errInvalidExpiry
	}
	if input.RefreshTokenExpiresAtMS < 0 || input.RefreshTokenExpiresAtMS > maxUnixMillis {
		return nil, errInvalidRefreshExpiry
	}
	clientID, err := normalizeMetadata(input.ClientID)
	if err != nil {
		return nil, err
	}
	scopes, err := validateScopes(input.Scopes)
	if err != nil {
		return nil, err
	}
	identity, err := ValidateOAuthIdentity(input.Identity)
	if err != nil {
		return nil, err
	}

	return &OAuthAuth{
		accessToken:             newSecretValue(accessToken),
		refreshToken:            newSecretValue(refreshToken),
		expiresAtMS:             input.ExpiresAtMS,
		refreshTokenExpiresAtMS: input.RefreshTokenExpiresAtMS,
		clientID:                clientID,
		scopes:                  scopes,
		identity:                identity,
		identitySeed:            fmt.Sprintf("oauth:claude:uuid:%s", identity.AccountUUID),
	}, nil
}

// ValidateOAuthIdentity 校验并规范化 secure storage 之外的账号身份上下文。
func ValidateOAuthIdentity(input OAuthIdentity) (OAuthIdentity, error) {
	accountUUID, err := normalizeUUID(input.AccountUUID, true, errInvalidAccountUUID)
	if err != nil {
		return OAuthIdentity{}, err
	}
	return OAuthIdentity{
		AccountUUID: accountUUID,
	}, nil
}

// Kind 返回 oauth 认证类型。
func (*OAuthAuth) Kind() AuthKind {
	return AuthKindOAuth
}

// Mode 返回可刷新 OAuth 模式。
func (*OAuthAuth) Mode() OAuthMode {
	return OAuthModeRefreshable
}

// IdentitySeed 返回只依赖稳定账号 UUID 的本地身份种子。
func (auth *OAuthAuth) IdentitySeed() string {
	if auth == nil {
		return ""
	}
	return auth.identitySeed
}

// AccessToken 返回请求适配器所需的原始 Access Token。
func (auth *OAuthAuth) AccessToken() string {
	if auth == nil {
		return ""
	}
	return auth.accessToken.reveal()
}

// RefreshToken 返回刷新适配器所需的原始 Refresh Token。
func (auth *OAuthAuth) RefreshToken() string {
	if auth == nil {
		return ""
	}
	return auth.refreshToken.reveal()
}

// ExpiresAtMS 返回 Access Token 的绝对 Unix 毫秒过期时间。
func (auth *OAuthAuth) ExpiresAtMS() int64 {
	if auth == nil {
		return 0
	}
	return auth.expiresAtMS
}

// RefreshTokenExpiresAtMS 返回 Refresh Token 的绝对 Unix 毫秒过期时间；零表示未知。
func (auth *OAuthAuth) RefreshTokenExpiresAtMS() int64 {
	if auth == nil {
		return 0
	}
	return auth.refreshTokenExpiresAtMS
}

// ClientID 返回签发当前 OAuth 凭据的客户端标识；空值表示官方未提供。
func (auth *OAuthAuth) ClientID() string {
	if auth == nil {
		return ""
	}
	return auth.clientID
}

// Scopes 返回 OAuth 权限集合的副本。
func (auth *OAuthAuth) Scopes() []string {
	if auth == nil {
		return nil
	}
	return append([]string(nil), auth.scopes...)
}

// HasScope 判断 OAuth 是否拥有指定的精确权限。
func (auth *OAuthAuth) HasScope(scope string) bool {
	if auth == nil {
		return false
	}
	for _, current := range auth.scopes {
		if current == scope {
			return true
		}
	}
	return false
}

// Identity 返回账号身份上下文的值副本。
func (auth *OAuthAuth) Identity() OAuthIdentity {
	if auth == nil {
		return OAuthIdentity{}
	}
	return auth.identity
}

// AccountUUID 返回稳定 Claude 账号 UUID。
func (auth *OAuthAuth) AccountUUID() string {
	return auth.Identity().AccountUUID
}

// Summary 返回不包含 Token 的认证摘要。
func (auth *OAuthAuth) Summary() AuthSummary {
	if auth == nil {
		return AuthSummary{}
	}
	return AuthSummary{
		Kind:        AuthKindOAuth,
		OAuthMode:   OAuthModeRefreshable,
		AccountUUID: auth.identity.AccountUUID,
		ExpiresAtMS: auth.expiresAtMS,
	}
}

// String 返回不包含 Token 的安全摘要。
func (auth *OAuthAuth) String() string {
	if auth == nil {
		return "claude.OAuthAuth<nil>"
	}
	return auth.Summary().String()
}

// GoString 为指针的 %#v 格式化提供安全摘要。
func (auth *OAuthAuth) GoString() string {
	return auth.String()
}

// Format 覆盖所有合法 fmt verb，避免值格式化时反射私有字段。
func (auth OAuthAuth) Format(state fmt.State, _ rune) {
	formatAuthSummary(state, (&auth).Summary())
}

// seal 将 OAuthAuth 限定为 Auth 的包内实现。
func (*OAuthAuth) seal() {}
