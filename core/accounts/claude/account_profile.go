package claude

import (
	"errors"
	"fmt"
)

// ErrInvalidAccountProfile 表示 Claude 公开资料和订阅不满足领域约束。
var ErrInvalidAccountProfile = errors.New("claude 公开账号资料无效")

// AccountProfile 是 oauthAccount 公开资料与 secure storage 订阅的只读组合。
type AccountProfile struct {
	oauth        OAuthProfile
	subscription Subscription
	identitySeed string
}

// NewAccountProfile 重新校验公开资料和订阅并创建不可变组合。
func NewAccountProfile(
	oauth OAuthProfile,
	subscription Subscription,
) (AccountProfile, error) {
	extraUsageEnabled, hasExtraUsageState := oauth.ExtraUsageEnabled()
	var extraUsageEnabledInput *bool
	if hasExtraUsageState {
		extraUsageEnabledInput = &extraUsageEnabled
	}
	validatedOAuth, err := NewOAuthProfile(OAuthProfileInput{
		AccountUUID:             oauth.AccountUUID(),
		Email:                   oauth.Email(),
		OrganizationUUID:        oauth.OrganizationUUID(),
		OrganizationName:        oauth.OrganizationName(),
		OrganizationRole:        oauth.OrganizationRole(),
		WorkspaceRole:           oauth.WorkspaceRole(),
		DisplayName:             oauth.DisplayName(),
		HasExtraUsageEnabled:    extraUsageEnabledInput,
		BillingType:             oauth.BillingType(),
		AccountCreatedAtMS:      oauth.AccountCreatedAtMS(),
		SubscriptionCreatedAtMS: oauth.SubscriptionCreatedAtMS(),
	})
	if err != nil {
		return AccountProfile{}, ErrInvalidAccountProfile
	}
	validatedSubscription, err := NewSubscription(
		subscription.RawType(),
		subscription.RateLimitTier(),
	)
	if err != nil {
		return AccountProfile{}, ErrInvalidAccountProfile
	}
	return AccountProfile{
		oauth:        validatedOAuth,
		subscription: validatedSubscription,
		identitySeed: oauthIdentitySeed(validatedOAuth.AccountUUID()),
	}, nil
}

// ProviderID 返回 Claude 规范 Provider ID。
func (AccountProfile) ProviderID() string {
	return ProviderID
}

// IdentitySeed 返回与 Claude OAuth 凭据一致的稳定账号身份种子。
func (profile AccountProfile) IdentitySeed() string {
	return profile.identitySeed
}

// IsValid 判断公开资料是否由领域构造器完整创建。
func (profile AccountProfile) IsValid() bool {
	return profile.identitySeed != "" &&
		profile.identitySeed == oauthIdentitySeed(profile.oauth.AccountUUID())
}

// DisplayName 返回 Claude 公开展示名称。
func (profile AccountProfile) DisplayName() string {
	return profile.oauth.DisplayName()
}

// Email 返回 Claude 公开邮箱。
func (profile AccountProfile) Email() string {
	return profile.oauth.Email()
}

// SubscriptionKind 返回稳定订阅分类。
func (profile AccountProfile) SubscriptionKind() string {
	return profile.subscription.Kind().String()
}

// SubscriptionRaw 返回官方 subscriptionType 原始值。
func (profile AccountProfile) SubscriptionRaw() string {
	return profile.subscription.RawType()
}

// OAuthProfile 返回不含凭据的 Claude 公开资料值。
func (profile AccountProfile) OAuthProfile() OAuthProfile {
	return profile.oauth
}

// Subscription 返回 Claude 订阅值。
func (profile AccountProfile) Subscription() Subscription {
	return profile.subscription
}

// oauthIdentitySeed 集中定义 Claude OAuth 凭据和公开资料共享的身份格式。
func oauthIdentitySeed(accountUUID string) string {
	return fmt.Sprintf("oauth:claude:uuid:%s", accountUUID)
}
