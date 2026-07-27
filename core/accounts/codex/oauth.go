package codex

import (
	"errors"
	"fmt"
	"strings"
)

const (
	// PersonalAccountID 是没有 ChatGPT 工作区时使用的稳定身份占位符。
	PersonalAccountID = "personal"
	// maxRFC3339UnixMillis 是四位年份 RFC3339 时间能够表示的最大 Unix 毫秒。
	maxRFC3339UnixMillis int64 = 253_402_300_799_999
)

var (
	errMissingOAuthAccessToken  = errors.New("Codex OAuth 缺少 Access Token")
	errMissingOAuthRefreshToken = errors.New("Codex OAuth 缺少 Refresh Token")
	errMissingOAuthIDToken      = errors.New("Codex OAuth 缺少 ID Token")
	errInvalidOAuthRefreshTime  = errors.New("Codex OAuth 刷新时间无效")
	errInvalidIDToken           = errors.New("Codex OAuth ID Token 无效")
	errMissingOAuthUserID       = errors.New("Codex OAuth 缺少稳定用户 ID")
	errInvalidOAuthAccountID    = errors.New("Codex OAuth 工作区 ID 无效")
	errOAuthAccountIDMismatch   = errors.New("Codex OAuth 显式工作区与 Token claim 不一致")
)

// OAuthInput 是创建 OAuthAuth 所需的完整输入。
type OAuthInput struct {
	// AccessToken 是当前请求使用的 Bearer Token。
	AccessToken string
	// RefreshToken 是刷新 Access Token 使用的长期凭证。
	RefreshToken string
	// IDToken 是解析稳定用户、工作区和公开资料的身份 Token。
	// 调用方必须保证它来自可信 OAuth 登录边界；领域层只解析 claim，不证明 Token 真实性。
	IDToken string
	// RefreshedAtMS 是最近一次成功取得或刷新凭证的毫秒时间戳。
	RefreshedAtMS int64
	// ExplicitAccountID 是调用方明确选择的 ChatGPT 工作区 ID；空表示未指定。
	ExplicitAccountID string
}

// OAuthAuth 是构造后不可变的 Codex OAuth 认证值。
type OAuthAuth struct {
	accessToken       *secretValue
	refreshToken      *secretValue
	idToken           *secretValue
	refreshedAtMS     int64
	accessExpiresAtMS int64
	profile           Profile
	identitySeed      string
}

// NewOAuthAuth 校验凭证结构并构建只读 OAuth 认证值。
//
// 该构造器不校验 JWT 签名、issuer 或 audience；不可信 Token 必须先由集成层验证。
func NewOAuthAuth(input OAuthInput) (*OAuthAuth, error) {
	accessToken, err := requireSecret(input.AccessToken, errMissingOAuthAccessToken)
	if err != nil {
		return nil, err
	}
	refreshToken, err := requireSecret(input.RefreshToken, errMissingOAuthRefreshToken)
	if err != nil {
		return nil, err
	}
	idToken, err := requireSecret(input.IDToken, errMissingOAuthIDToken)
	if err != nil {
		return nil, err
	}
	if input.RefreshedAtMS <= 0 || input.RefreshedAtMS > maxRFC3339UnixMillis {
		return nil, errInvalidOAuthRefreshTime
	}

	profile, err := parseIDTokenProfile(idToken)
	if err != nil {
		return nil, err
	}
	if err := applyExplicitAccountID(&profile, input.ExplicitAccountID); err != nil {
		return nil, err
	}
	profile.Email = normalizePublicMetadata(profile.Email)

	return &OAuthAuth{
		accessToken:       newSecretValue(accessToken),
		refreshToken:      newSecretValue(refreshToken),
		idToken:           newSecretValue(idToken),
		refreshedAtMS:     input.RefreshedAtMS,
		accessExpiresAtMS: readAccessTokenExpiryMS(accessToken),
		profile:           profile,
		identitySeed:      fmt.Sprintf("oauth:codex:%s:%s", profile.UserID, profile.AccountID),
	}, nil
}

// Kind 返回 oauth 认证类型。
func (*OAuthAuth) Kind() AuthKind {
	return AuthKindOAuth
}

// IdentitySeed 返回不含凭证的稳定账号身份种子。
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

// IDToken 返回持久化适配器所需的原始 ID Token。
func (auth *OAuthAuth) IDToken() string {
	if auth == nil {
		return ""
	}
	return auth.idToken.reveal()
}

// RefreshedAtMS 返回最近成功取得或刷新凭证的毫秒时间戳。
func (auth *OAuthAuth) RefreshedAtMS() int64 {
	if auth == nil {
		return 0
	}
	return auth.refreshedAtMS
}

// AccessExpiresAtMS 返回仅从 Access Token exp 派生的过期时间；零表示未知。
func (auth *OAuthAuth) AccessExpiresAtMS() int64 {
	if auth == nil {
		return 0
	}
	return auth.accessExpiresAtMS
}

// Profile 返回公开资料的值副本，调用方修改副本不会影响认证值。
func (auth *OAuthAuth) Profile() Profile {
	if auth == nil {
		return Profile{}
	}
	return auth.profile
}

// UserID 返回稳定 ChatGPT 用户 ID。
func (auth *OAuthAuth) UserID() string {
	return auth.Profile().UserID
}

// AccountID 返回领域有效工作区 ID，个人账号返回 personal。
func (auth *OAuthAuth) AccountID() string {
	return auth.Profile().AccountID
}

// UpstreamAccountID 返回可写入上游协议的真实工作区 ID，个人账号返回空串。
func (auth *OAuthAuth) UpstreamAccountID() string {
	accountID := auth.AccountID()
	if accountID == PersonalAccountID {
		return ""
	}
	return accountID
}

// Email 返回 ID Token 提供的展示邮箱。
func (auth *OAuthAuth) Email() string {
	return auth.Profile().Email
}

// PlanType 返回 ID Token 提供的套餐类型。
func (auth *OAuthAuth) PlanType() string {
	return auth.Profile().Plan.Raw()
}

// Plan 返回同时包含上游原始值和稳定归类的套餐值。
func (auth *OAuthAuth) Plan() Plan {
	return auth.Profile().Plan
}

// IsFedRAMP 返回官方 FedRAMP claim。
func (auth *OAuthAuth) IsFedRAMP() bool {
	return auth.Profile().IsFedRAMP
}

// Summary 返回不包含三个 Token 的认证摘要。
func (auth *OAuthAuth) Summary() AuthSummary {
	if auth == nil {
		return AuthSummary{}
	}
	return AuthSummary{
		Kind:              AuthKindOAuth,
		UserID:            auth.profile.UserID,
		AccountID:         auth.profile.AccountID,
		PlanType:          auth.profile.Plan.Raw(),
		PlanFamily:        auth.profile.Plan.Family(),
		IsFedRAMP:         auth.profile.IsFedRAMP,
		AccessExpiresAtMS: auth.accessExpiresAtMS,
		RefreshedAtMS:     auth.refreshedAtMS,
	}
}

// String 返回不包含三个 Token 的安全摘要。
func (auth *OAuthAuth) String() string {
	if auth == nil {
		return "codex.OAuthAuth<nil>"
	}
	return auth.Summary().String()
}

// GoString 为指针的 %#v 格式化提供安全摘要，值格式化由 Format 统一处理。
func (auth *OAuthAuth) GoString() string {
	return auth.String()
}

// Format 覆盖所有合法 fmt verb，避免非字符串 verb 触发字段反射。
func (auth OAuthAuth) Format(state fmt.State, _ rune) {
	formatAuthSummary(state, (&auth).Summary())
}

// seal 将 OAuthAuth 限定为 Auth 的包内实现。
func (*OAuthAuth) seal() {}

// applyExplicitAccountID 合并显式工作区，并拒绝与 Token claim 冲突的输入。
func applyExplicitAccountID(profile *Profile, explicit string) error {
	accountID := strings.TrimSpace(explicit)
	if accountID == "" {
		return nil
	}
	if accountID == PersonalAccountID || !isIdentityComponent(accountID) {
		return errInvalidOAuthAccountID
	}
	if profile.AccountID != PersonalAccountID && profile.AccountID != accountID {
		return errOAuthAccountIDMismatch
	}
	profile.AccountID = accountID
	return nil
}

// requireSecret 校验必填凭证并将所有错误映射为固定安全文本。
func requireSecret(raw string, missingError error) (string, error) {
	if raw == "" || raw != strings.TrimSpace(raw) || hasControlCharacter(raw) {
		return "", missingError
	}
	return raw, nil
}

// normalizePublicMetadata 丢弃包含控制字符的非关键展示 claim。
func normalizePublicMetadata(raw string) string {
	value := strings.TrimSpace(raw)
	if hasControlCharacter(value) {
		return ""
	}
	return value
}

// hasControlCharacter 检测可能造成日志或协议注入的控制字符。
func hasControlCharacter(value string) bool {
	return strings.IndexFunc(value, func(character rune) bool {
		return character < 0x20 || character == 0x7f
	}) >= 0
}
