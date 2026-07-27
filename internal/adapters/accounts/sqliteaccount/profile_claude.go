package sqliteaccount

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
)

// claudeProfileCodec 编解码 Claude OAuth 公开资料和订阅。
type claudeProfileCodec struct{}

// ProviderID 返回 Claude 规范 Provider ID。
func (claudeProfileCodec) ProviderID() string {
	return claude.ProviderID
}

// Encode 把经过领域校验的 Claude 公开资料编码为 v1 JSON。
func (claudeProfileCodec) Encode(
	profile accountapp.PublicProfile,
) (encodedProfile, error) {
	value, ok := profile.(claude.AccountProfile)
	if !ok || !value.IsValid() {
		return encodedProfile{}, ErrInvalidProfileDocument
	}
	oauth := value.OAuthProfile()
	extraUsageEnabled, hasExtraUsageState := oauth.ExtraUsageEnabled()
	var extraUsageEnabledJSON *bool
	if hasExtraUsageState {
		extraUsageEnabledJSON = &extraUsageEnabled
	}
	payload, err := encodeProfileJSON(claudeProfileV1{
		AccountUUID:             oauth.AccountUUID(),
		OrganizationUUID:        oauth.OrganizationUUID(),
		OrganizationName:        oauth.OrganizationName(),
		OrganizationRole:        oauth.OrganizationRole(),
		WorkspaceRole:           oauth.WorkspaceRole(),
		ExtraUsageEnabled:       extraUsageEnabledJSON,
		BillingType:             oauth.BillingType(),
		AccountCreatedAtMS:      oauth.AccountCreatedAtMS(),
		SubscriptionCreatedAtMS: oauth.SubscriptionCreatedAtMS(),
		RateLimitTier:           value.Subscription().RateLimitTier(),
	})
	return encodedProfile{
		displayName:      value.DisplayName(),
		email:            value.Email(),
		subscriptionKind: value.SubscriptionKind(),
		subscriptionRaw:  value.SubscriptionRaw(),
		json:             payload,
	}, err
}

// Decode 解析 v1 JSON 并通过 Claude 公开资料构造器重新校验。
func (claudeProfileCodec) Decode(
	document encodedProfile,
) (accountapp.PublicProfile, error) {
	var payload claudeProfileV1
	if err := decodeProfileJSON(document.json, &payload); err != nil {
		return nil, err
	}
	oauth, err := claude.NewOAuthProfile(claude.OAuthProfileInput{
		AccountUUID:             payload.AccountUUID,
		Email:                   document.email,
		OrganizationUUID:        payload.OrganizationUUID,
		OrganizationName:        payload.OrganizationName,
		OrganizationRole:        payload.OrganizationRole,
		WorkspaceRole:           payload.WorkspaceRole,
		DisplayName:             document.displayName,
		HasExtraUsageEnabled:    payload.ExtraUsageEnabled,
		BillingType:             payload.BillingType,
		AccountCreatedAtMS:      payload.AccountCreatedAtMS,
		SubscriptionCreatedAtMS: payload.SubscriptionCreatedAtMS,
	})
	if err != nil {
		return nil, ErrInvalidProfileDocument
	}
	subscription, err := claude.NewSubscription(
		document.subscriptionRaw,
		payload.RateLimitTier,
	)
	if err != nil {
		return nil, ErrInvalidProfileDocument
	}
	profile, err := claude.NewAccountProfile(oauth, subscription)
	if err != nil || profile.SubscriptionKind() != document.subscriptionKind {
		return nil, ErrInvalidProfileDocument
	}
	return profile, nil
}

// claudeProfileV1 是 Claude 公开资料 JSON 的唯一 v1 结构。
type claudeProfileV1 struct {
	AccountUUID             string `json:"account_uuid"`
	OrganizationUUID        string `json:"organization_uuid"`
	OrganizationName        string `json:"organization_name"`
	OrganizationRole        string `json:"organization_role"`
	WorkspaceRole           string `json:"workspace_role"`
	ExtraUsageEnabled       *bool  `json:"extra_usage_enabled"`
	BillingType             string `json:"billing_type"`
	AccountCreatedAtMS      int64  `json:"account_created_at_ms"`
	SubscriptionCreatedAtMS int64  `json:"subscription_created_at_ms"`
	RateLimitTier           string `json:"rate_limit_tier"`
}
