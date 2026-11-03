package claude

import "errors"

var errInvalidProfileTime = errors.New("Claude OAuth 公开资料时间无效")

// OAuthProfileInput 是创建 Claude OAuth 公开账号资料所需的输入。
type OAuthProfileInput struct {
	// AccountUUID 是 Claude 账号的稳定 UUID。
	AccountUUID string
	// Email 是账号公开邮箱。
	Email string
	// OrganizationUUID 是当前组织 UUID；空值表示未知。
	OrganizationUUID string
	// OrganizationName 是当前组织名称；空值表示未知。
	OrganizationName string
	// OrganizationRole 是账号在组织中的角色；空值表示未知。
	OrganizationRole string
	// WorkspaceRole 是账号在工作区中的角色；空值表示未知。
	WorkspaceRole string
	// DisplayName 是账号展示名称；空值表示未知。
	DisplayName string
	// HasExtraUsageEnabled 区分官方未提供、明确关闭和明确开启。
	HasExtraUsageEnabled *bool
	// BillingType 是官方原始计费类型；空值表示未知。
	BillingType string
	// AccountCreatedAtMS 是账号创建时间的 Unix 毫秒；零表示未知。
	AccountCreatedAtMS int64
	// SubscriptionCreatedAtMS 是当前订阅创建时间的 Unix 毫秒；零表示未知。
	SubscriptionCreatedAtMS int64
}

// OAuthProfile 是与 OAuth 凭据分离的只读 Claude 公开账号资料。
type OAuthProfile struct {
	accountUUID             string
	email                   string
	organizationUUID        string
	organizationName        string
	organizationRole        string
	workspaceRole           string
	displayName             string
	extraUsageEnabled       bool
	hasExtraUsageState      bool
	billingType             string
	accountCreatedAtMS      int64
	subscriptionCreatedAtMS int64
}

// NewOAuthProfile 校验并创建不可变的 Claude OAuth 公开资料。
func NewOAuthProfile(input OAuthProfileInput) (OAuthProfile, error) {
	accountUUID, err := normalizeUUID(input.AccountUUID, true, errInvalidAccountUUID)
	if err != nil {
		return OAuthProfile{}, err
	}
	email, err := normalizeEmail(input.Email)
	if err != nil || email == "" {
		return OAuthProfile{}, errInvalidEmail
	}
	organizationUUID, err := normalizeUUID(input.OrganizationUUID, false, errInvalidOrgUUID)
	if err != nil {
		return OAuthProfile{}, err
	}
	organizationName, err := normalizeMetadata(input.OrganizationName)
	if err != nil {
		return OAuthProfile{}, err
	}
	organizationRole, err := normalizeMetadata(input.OrganizationRole)
	if err != nil {
		return OAuthProfile{}, err
	}
	workspaceRole, err := normalizeMetadata(input.WorkspaceRole)
	if err != nil {
		return OAuthProfile{}, err
	}
	displayName, err := normalizeMetadata(input.DisplayName)
	if err != nil {
		return OAuthProfile{}, err
	}
	billingType, err := normalizeMetadata(input.BillingType)
	if err != nil {
		return OAuthProfile{}, err
	}
	if !validOptionalUnixMillis(input.AccountCreatedAtMS) ||
		!validOptionalUnixMillis(input.SubscriptionCreatedAtMS) {
		return OAuthProfile{}, errInvalidProfileTime
	}

	profile := OAuthProfile{
		accountUUID:             accountUUID,
		email:                   email,
		organizationUUID:        organizationUUID,
		organizationName:        organizationName,
		organizationRole:        organizationRole,
		workspaceRole:           workspaceRole,
		displayName:             displayName,
		billingType:             billingType,
		accountCreatedAtMS:      input.AccountCreatedAtMS,
		subscriptionCreatedAtMS: input.SubscriptionCreatedAtMS,
	}
	if input.HasExtraUsageEnabled != nil {
		profile.extraUsageEnabled = *input.HasExtraUsageEnabled
		profile.hasExtraUsageState = true
	}
	return profile, nil
}

// AccountUUID 返回稳定 Claude 账号 UUID。
func (profile OAuthProfile) AccountUUID() string {
	return profile.accountUUID
}

// Email 返回规范化后的公开邮箱。
func (profile OAuthProfile) Email() string {
	return profile.email
}

// OrganizationUUID 返回当前组织 UUID。
func (profile OAuthProfile) OrganizationUUID() string {
	return profile.organizationUUID
}

// OrganizationName 返回当前组织名称。
func (profile OAuthProfile) OrganizationName() string {
	return profile.organizationName
}

// OrganizationRole 返回账号在组织中的角色。
func (profile OAuthProfile) OrganizationRole() string {
	return profile.organizationRole
}

// WorkspaceRole 返回账号在工作区中的角色。
func (profile OAuthProfile) WorkspaceRole() string {
	return profile.workspaceRole
}

// DisplayName 返回账号展示名称。
func (profile OAuthProfile) DisplayName() string {
	return profile.displayName
}

// ExtraUsageEnabled 返回额外用量开关值以及官方是否提供过该值。
func (profile OAuthProfile) ExtraUsageEnabled() (bool, bool) {
	return profile.extraUsageEnabled, profile.hasExtraUsageState
}

// BillingType 返回官方原始计费类型。
func (profile OAuthProfile) BillingType() string {
	return profile.billingType
}

// AccountCreatedAtMS 返回账号创建时间的 Unix 毫秒。
func (profile OAuthProfile) AccountCreatedAtMS() int64 {
	return profile.accountCreatedAtMS
}

// SubscriptionCreatedAtMS 返回当前订阅创建时间的 Unix 毫秒。
func (profile OAuthProfile) SubscriptionCreatedAtMS() int64 {
	return profile.subscriptionCreatedAtMS
}

// Identity 返回认证凭据绑定所需的最小稳定身份。
func (profile OAuthProfile) Identity() OAuthIdentity {
	return OAuthIdentity{AccountUUID: profile.accountUUID}
}

// validOptionalUnixMillis 校验零值或四位年份范围内的正 Unix 毫秒。
func validOptionalUnixMillis(value int64) bool {
	return value >= 0 && value <= maxUnixMillis
}
