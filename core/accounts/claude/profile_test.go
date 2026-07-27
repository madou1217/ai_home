package claude

import "testing"

// TestNewOAuthProfilePreservesCompletePublicAccount 验证 Claude oauthAccount 的公开字段具有独立模型。
func TestNewOAuthProfilePreservesCompletePublicAccount(t *testing.T) {
	extraUsageEnabled := false
	profile, err := NewOAuthProfile(OAuthProfileInput{
		AccountUUID:             testAccountUUID,
		Email:                   "Owner@Example.COM",
		OrganizationUUID:        testOrgUUID,
		OrganizationName:        "AI Home Team",
		OrganizationRole:        "admin",
		WorkspaceRole:           "developer",
		DisplayName:             "Owner",
		HasExtraUsageEnabled:    &extraUsageEnabled,
		BillingType:             "stripe_subscription",
		AccountCreatedAtMS:      1_735_789_445_678,
		SubscriptionCreatedAtMS: 1_738_552_706_000,
	})
	if err != nil {
		t.Fatalf("创建 OAuth 公开资料失败: %v", err)
	}

	if profile.AccountUUID() != "123e4567-e89b-12d3-a456-426614174000" {
		t.Fatalf("账号 UUID 未规范化: %q", profile.AccountUUID())
	}
	if profile.Email() != "owner@example.com" || profile.OrganizationUUID() != testOrgUUID {
		t.Fatalf("公开身份错误: %q / %q", profile.Email(), profile.OrganizationUUID())
	}
	if profile.OrganizationName() != "AI Home Team" ||
		profile.OrganizationRole() != "admin" ||
		profile.WorkspaceRole() != "developer" {
		t.Fatal("组织公开资料丢失")
	}
	if profile.DisplayName() != "Owner" || profile.BillingType() != "stripe_subscription" {
		t.Fatal("展示或计费公开资料丢失")
	}
	if enabled, known := profile.ExtraUsageEnabled(); !known || enabled {
		t.Fatalf("额外用量 false 三态丢失: enabled=%t known=%t", enabled, known)
	}
	if profile.AccountCreatedAtMS() != 1_735_789_445_678 ||
		profile.SubscriptionCreatedAtMS() != 1_738_552_706_000 {
		t.Fatal("公开资料时间戳丢失")
	}
}

// TestOAuthProfileKeepsUnknownExtraUsageDistinct 验证缺失与 false 不会合并。
func TestOAuthProfileKeepsUnknownExtraUsageDistinct(t *testing.T) {
	profile, err := NewOAuthProfile(OAuthProfileInput{
		AccountUUID: testAccountUUID,
		Email:       "owner@example.com",
	})
	if err != nil {
		t.Fatalf("创建最小 OAuth 公开资料失败: %v", err)
	}
	if _, known := profile.ExtraUsageEnabled(); known {
		t.Fatal("缺失额外用量状态应保持未知")
	}
}

// TestNewOAuthProfileRejectsInvalidPublicData 验证公开资料的边界约束集中在领域构造器。
func TestNewOAuthProfileRejectsInvalidPublicData(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*OAuthProfileInput)
	}{
		{name: "账号 UUID 无效", mutate: func(input *OAuthProfileInput) { input.AccountUUID = "not-a-uuid" }},
		{name: "邮箱无效", mutate: func(input *OAuthProfileInput) { input.Email = "not-an-email" }},
		{name: "组织 UUID 无效", mutate: func(input *OAuthProfileInput) { input.OrganizationUUID = "not-a-uuid" }},
		{name: "展示名含控制字符", mutate: func(input *OAuthProfileInput) { input.DisplayName = "Owner\nForged" }},
		{name: "账号创建时间为负数", mutate: func(input *OAuthProfileInput) { input.AccountCreatedAtMS = -1 }},
		{name: "订阅创建时间越界", mutate: func(input *OAuthProfileInput) { input.SubscriptionCreatedAtMS = maxUnixMillis + 1 }},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := OAuthProfileInput{
				AccountUUID: testAccountUUID,
				Email:       "owner@example.com",
			}
			test.mutate(&input)
			if _, err := NewOAuthProfile(input); err == nil {
				t.Fatal("无效公开资料应被拒绝")
			}
		})
	}
}
