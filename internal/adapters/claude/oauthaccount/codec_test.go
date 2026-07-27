package oauthaccount

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/accounts/claude"
)

// TestDecodeOfficialOAuthAccount 验证 Claude 全局配置中的完整公开账号资料可被提取。
func TestDecodeOfficialOAuthAccount(t *testing.T) {
	data := []byte(`{
		"hasCompletedOnboarding": true,
		"oauthAccount": {
			"accountUuid": "123E4567-E89B-12D3-A456-426614174000",
			"emailAddress": "Owner@Example.COM",
			"organizationUuid": "223e4567-e89b-12d3-a456-426614174000",
			"organizationName": "AI Home Team",
			"organizationRole": "admin",
			"workspaceRole": "developer",
			"displayName": "Owner",
			"hasExtraUsageEnabled": false,
			"billingType": "stripe_subscription",
			"accountCreatedAt": "2025-01-02T03:04:05.678Z",
			"subscriptionCreatedAt": "2025-02-03T04:05:06Z"
		}
	}`)
	profile, err := Decode(data)
	if err != nil {
		t.Fatalf("解析 oauthAccount 失败: %v", err)
	}
	if profile.AccountUUID() != "123e4567-e89b-12d3-a456-426614174000" {
		t.Fatalf("账号 UUID 未规范化: %s", profile.AccountUUID())
	}
	if profile.Email() != "owner@example.com" {
		t.Fatalf("邮箱未规范化: %s", profile.Email())
	}
	if profile.OrganizationUUID() != "223e4567-e89b-12d3-a456-426614174000" {
		t.Fatalf("组织 UUID 错误: %s", profile.OrganizationUUID())
	}
	if profile.OrganizationName() != "AI Home Team" ||
		profile.OrganizationRole() != "admin" ||
		profile.WorkspaceRole() != "developer" {
		t.Fatal("组织公开资料解析错误")
	}
	if profile.DisplayName() != "Owner" || profile.BillingType() != "stripe_subscription" {
		t.Fatal("展示或计费公开资料解析错误")
	}
	if enabled, known := profile.ExtraUsageEnabled(); !known || enabled {
		t.Fatalf("额外用量三态解析错误: enabled=%t known=%t", enabled, known)
	}
	accountCreatedAt := time.Date(2025, 1, 2, 3, 4, 5, 678_000_000, time.UTC).UnixMilli()
	subscriptionCreatedAt := time.Date(2025, 2, 3, 4, 5, 6, 0, time.UTC).UnixMilli()
	if profile.AccountCreatedAtMS() != accountCreatedAt ||
		profile.SubscriptionCreatedAtMS() != subscriptionCreatedAt {
		t.Fatal("RFC3339 公开资料时间解析错误")
	}
}

// TestDecodeAllowsMissingOrganization 验证个人账号不强制要求组织 UUID。
func TestDecodeAllowsMissingOrganization(t *testing.T) {
	profile, err := Decode([]byte(`{"oauthAccount":{"accountUuid":"123e4567-e89b-12d3-a456-426614174000","emailAddress":"owner@example.com"}}`))
	if err != nil {
		t.Fatalf("解析个人账号失败: %v", err)
	}
	if profile.OrganizationUUID() != "" {
		t.Fatalf("个人账号组织应为空: %s", profile.OrganizationUUID())
	}
	if _, known := profile.ExtraUsageEnabled(); known {
		t.Fatal("缺失额外用量状态应保持未知")
	}
}

// TestOAuthAccountRoundTripPreservesPublicData 验证写回时保留完整公开资料和未来字段。
func TestOAuthAccountRoundTripPreservesPublicData(t *testing.T) {
	existing := []byte(`{
		"theme": "dark",
		"oauthAccount": {
			"accountUuid": "old",
			"emailAddress": "old@example.com",
			"futureProfileField": {"preserved": true}
		}
	}`)
	extraUsageEnabled := true
	profile, err := claudeProfileForAdapter(&extraUsageEnabled)
	if err != nil {
		t.Fatalf("创建公开资料失败: %v", err)
	}
	encoded, err := Upsert(existing, profile)
	if err != nil {
		t.Fatalf("写回 oauthAccount 失败: %v", err)
	}

	var document map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("写回结果不是 JSON: %v", err)
	}
	if string(document["theme"]) != `"dark"` {
		t.Fatalf("其他全局配置被修改: %s", document["theme"])
	}
	var account map[string]json.RawMessage
	if err := json.Unmarshal(document["oauthAccount"], &account); err != nil {
		t.Fatalf("oauthAccount 输出无效: %v", err)
	}
	if string(account["futureProfileField"]) != `{"preserved":true}` {
		t.Fatalf("未来公开资料字段被修改: %s", account["futureProfileField"])
	}

	roundTrip, err := Decode(encoded)
	if err != nil {
		t.Fatalf("写回结果无法重新解析: %v", err)
	}
	if roundTrip.AccountUUID() != profile.AccountUUID() ||
		roundTrip.Email() != profile.Email() ||
		roundTrip.DisplayName() != profile.DisplayName() ||
		roundTrip.AccountCreatedAtMS() != profile.AccountCreatedAtMS() {
		t.Fatal("公开资料往返后发生变化")
	}
	if enabled, known := roundTrip.ExtraUsageEnabled(); !known || !enabled {
		t.Fatal("额外用量 true 三态往返后丢失")
	}
}

// TestDecodeRejectsInvalidOAuthAccount 验证身份 Adapter 不接受 AIH 别名或不稳定身份。
func TestDecodeRejectsInvalidOAuthAccount(t *testing.T) {
	tests := []struct {
		name string
		data []byte
	}{
		{name: "畸形 JSON", data: []byte(`{"oauthAccount":`)},
		{name: "缺少 oauthAccount", data: []byte(`{}`)},
		{name: "oauthAccount 为 null", data: []byte(`{"oauthAccount":null}`)},
		{name: "snake_case 容器", data: []byte(`{"oauth_account":{"accountUuid":"123e4567-e89b-12d3-a456-426614174000"}}`)},
		{name: "缺少账号 UUID", data: []byte(`{"oauthAccount":{"emailAddress":"owner@example.com"}}`)},
		{name: "缺少邮箱", data: []byte(`{"oauthAccount":{"accountUuid":"123e4567-e89b-12d3-a456-426614174000"}}`)},
		{name: "snake_case UUID", data: []byte(`{"oauthAccount":{"account_uuid":"123e4567-e89b-12d3-a456-426614174000","emailAddress":"owner@example.com"}}`)},
		{name: "snake_case 展示名", data: []byte(`{"oauthAccount":{"accountUuid":"123e4567-e89b-12d3-a456-426614174000","emailAddress":"owner@example.com","display_name":"Owner"}}`)},
		{name: "额外用量类型错误", data: []byte(`{"oauthAccount":{"accountUuid":"123e4567-e89b-12d3-a456-426614174000","emailAddress":"owner@example.com","hasExtraUsageEnabled":"false"}}`)},
		{name: "账号时间格式错误", data: []byte(`{"oauthAccount":{"accountUuid":"123e4567-e89b-12d3-a456-426614174000","emailAddress":"owner@example.com","accountCreatedAt":"2025-01-02"}}`)},
		{name: "重复 oauthAccount", data: []byte(`{"oauthAccount":{},"oauthAccount":{}}`)},
		{name: "重复账号 UUID", data: []byte(`{"oauthAccount":{"accountUuid":"123e4567-e89b-12d3-a456-426614174000","accountUuid":"223e4567-e89b-12d3-a456-426614174000","emailAddress":"owner@example.com"}}`)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Decode(test.data); err == nil {
				t.Fatal("无效 oauthAccount 应被拒绝")
			} else if !errors.Is(err, ErrInvalidOAuthAccount) {
				t.Fatalf("错误类型不稳定: %v", err)
			}
		})
	}
}

// claudeProfileForAdapter 返回 oauthAccount 往返测试使用的完整公开资料。
func claudeProfileForAdapter(extraUsageEnabled *bool) (claude.OAuthProfile, error) {
	return claude.NewOAuthProfile(claude.OAuthProfileInput{
		AccountUUID:             "123e4567-e89b-12d3-a456-426614174000",
		Email:                   "owner@example.com",
		OrganizationUUID:        "223e4567-e89b-12d3-a456-426614174000",
		OrganizationName:        "AI Home Team",
		OrganizationRole:        "admin",
		WorkspaceRole:           "developer",
		DisplayName:             "Owner",
		HasExtraUsageEnabled:    extraUsageEnabled,
		BillingType:             "stripe_subscription",
		AccountCreatedAtMS:      time.Date(2025, 1, 2, 3, 4, 5, 678_000_000, time.UTC).UnixMilli(),
		SubscriptionCreatedAtMS: time.Date(2025, 2, 3, 4, 5, 6, 0, time.UTC).UnixMilli(),
	})
}
