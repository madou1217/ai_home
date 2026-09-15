package codex

import (
	"errors"
	"fmt"
	"strings"
)

const (
	maxAccountProfileEmailLength        = 320
	maxAccountProfileSubscriptionLength = 128
)

// ErrInvalidAccountProfile 表示 Codex 公开资料不满足稳定身份或展示字段约束。
var ErrInvalidAccountProfile = errors.New("codex 公开账号资料无效")

// AccountProfile 是可独立持久化且不包含 Token 的 Codex 公开资料。
type AccountProfile struct {
	userID       string
	accountID    string
	email        string
	plan         Plan
	isFedRAMP    bool
	identitySeed string
}

// NewAccountProfile 从经过 ID Token 解析的资料创建不可变公开资料。
func NewAccountProfile(source Profile) (AccountProfile, error) {
	if source.UserID != strings.TrimSpace(source.UserID) ||
		!isIdentityComponent(source.UserID) {
		return AccountProfile{}, ErrInvalidAccountProfile
	}
	if source.AccountID != PersonalAccountID &&
		(source.AccountID != strings.TrimSpace(source.AccountID) ||
			!isIdentityComponent(source.AccountID)) {
		return AccountProfile{}, ErrInvalidAccountProfile
	}
	email := normalizePublicMetadata(source.Email)
	if email != source.Email || len(email) > maxAccountProfileEmailLength {
		return AccountProfile{}, ErrInvalidAccountProfile
	}
	plan := ParsePlan(source.Plan.Raw())
	if plan.Raw() != source.Plan.Raw() ||
		len(plan.Raw()) > maxAccountProfileSubscriptionLength {
		return AccountProfile{}, ErrInvalidAccountProfile
	}
	return AccountProfile{
		userID:       source.UserID,
		accountID:    source.AccountID,
		email:        email,
		plan:         plan,
		isFedRAMP:    source.IsFedRAMP,
		identitySeed: oauthIdentitySeed(source.UserID),
	}, nil
}

// ProviderID 返回 Codex 规范 Provider ID。
func (AccountProfile) ProviderID() string {
	return ProviderID
}

// IdentitySeed 返回与 Codex OAuth 凭据一致的稳定账号身份种子。
func (profile AccountProfile) IdentitySeed() string {
	return profile.identitySeed
}

// IsValid 判断公开资料是否由领域构造器完整创建。
func (profile AccountProfile) IsValid() bool {
	return profile.identitySeed != "" &&
		profile.identitySeed == oauthIdentitySeed(profile.userID)
}

// DisplayName 返回当前 Codex ID Token 未提供的展示名称。
func (AccountProfile) DisplayName() string {
	return ""
}

// Email 返回 ID Token 提供的公开邮箱。
func (profile AccountProfile) Email() string {
	return profile.email
}

// SubscriptionKind 返回稳定套餐分类。
func (profile AccountProfile) SubscriptionKind() string {
	return profile.plan.Family().String()
}

// SubscriptionRaw 返回上游原始套餐值。
func (profile AccountProfile) SubscriptionRaw() string {
	return profile.plan.Raw()
}

// UserID 返回稳定 ChatGPT 用户 ID。
func (profile AccountProfile) UserID() string {
	return profile.userID
}

// AccountID 返回 ChatGPT 工作区 ID 或 personal。
//
// 工作区属于上游协议元数据，保留用于回写上游，不参与本地账号身份派生。
func (profile AccountProfile) AccountID() string {
	return profile.accountID
}

// Plan 返回 Codex 套餐值。
func (profile AccountProfile) Plan() Plan {
	return profile.plan
}

// IsFedRAMP 返回工作区 FedRAMP 标记。
func (profile AccountProfile) IsFedRAMP() bool {
	return profile.isFedRAMP
}

// oauthIdentitySeed 集中定义 Codex OAuth 凭据和公开资料共享的身份格式。
//
// 身份只取稳定用户 ID。ChatGPT 工作区 ID（account_id / chatgpt_account_id）是上游
// 协议元数据：按 README「导入 / 导出去重规则」，它不得作为本地 accountRef 身份，
// 因此不参与身份种子派生，只经 UpstreamAccountID 保留并回写上游。同一用户在不同
// 工作区之间切换不会改变本地账号身份，与 Node 的账号寻址规则一致。
func oauthIdentitySeed(userID string) string {
	return fmt.Sprintf("oauth:codex:%s", userID)
}
