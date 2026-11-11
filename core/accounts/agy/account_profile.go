package agy

import (
	"errors"
	"strings"
)

const maxAccountProfileEmailLength = 320

// ErrInvalidAccountProfile 表示 agy 公开资料不满足邮箱身份约束。
var ErrInvalidAccountProfile = errors.New("agy 公开账号资料无效")

// AccountProfile 是可独立持久化、且不含任何 Token 的 agy 公开资料。
//
// agy 的原生凭据里没有比邮箱更稳定的字段，邮箱就是账号身份
// （与 NewNativeEmailIdentity 同源）。登录成功后把邮箱落进账号资料，
// 账号页与 CLI 才能显示它是谁的号；少了这条，凭据里有 email、资料表却是空的。
type AccountProfile struct {
	email        string
	identitySeed string
}

// NewAccountProfile 从规范邮箱创建公开资料。
func NewAccountProfile(email string) (AccountProfile, error) {
	normalized := normalizeProfileEmail(email)
	if normalized == "" {
		return AccountProfile{}, ErrInvalidAccountProfile
	}
	return AccountProfile{
		email:        normalized,
		identitySeed: "oauth:" + ProviderID + ":" + normalized,
	}, nil
}

// normalizeProfileEmail 与 core/accounts 的 normalizeNativeEmail 同口径：
// 小写、去空白、必须是单一 @ 的裸地址。身份种子必须逐字节一致，
// 否则资料派生的 accountRef 会和凭据派生的对不上。
func normalizeProfileEmail(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" || len(normalized) > maxAccountProfileEmailLength {
		return ""
	}
	if strings.Count(normalized, "@") != 1 {
		return ""
	}
	local, domain, _ := strings.Cut(normalized, "@")
	if local == "" || domain == "" || strings.ContainsAny(normalized, " \t\r\n<>") {
		return ""
	}
	return normalized
}

// ProviderID 返回 agy 规范 Provider ID。
func (AccountProfile) ProviderID() string { return ProviderID }

// IdentitySeed 返回与 agy OAuth 凭据一致的稳定账号身份种子。
func (profile AccountProfile) IdentitySeed() string { return profile.identitySeed }

// IsValid 判断公开资料是否由领域构造器完整创建。
func (profile AccountProfile) IsValid() bool {
	return profile.identitySeed != "" && profile.identitySeed == "oauth:"+ProviderID+":"+profile.email
}

// DisplayName 返回展示名；agy 以邮箱为标识，不额外造名。
func (AccountProfile) DisplayName() string { return "" }

// Email 返回稳定公开邮箱。
func (profile AccountProfile) Email() string { return profile.email }

// SubscriptionKind 返回稳定套餐分类；agy 登录不携带套餐信息。
func (AccountProfile) SubscriptionKind() string { return "" }

// SubscriptionRaw 返回上游原始套餐值；agy 登录不携带套餐信息。
func (AccountProfile) SubscriptionRaw() string { return "" }
