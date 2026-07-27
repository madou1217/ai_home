package oauthaccount

import (
	"errors"
	"testing"
)

// TestDecodeOfficialOAuthAccount 验证 Claude 全局配置中的独立账号身份可被提取。
func TestDecodeOfficialOAuthAccount(t *testing.T) {
	data := []byte(`{
		"hasCompletedOnboarding": true,
		"oauthAccount": {
			"accountUuid": "123E4567-E89B-12D3-A456-426614174000",
			"emailAddress": "Owner@Example.COM",
			"organizationUuid": "223e4567-e89b-12d3-a456-426614174000",
			"displayName": "Owner",
			"billingType": "stripe_subscription"
		}
	}`)
	identity, err := Decode(data)
	if err != nil {
		t.Fatalf("解析 oauthAccount 失败: %v", err)
	}
	if identity.AccountUUID != "123e4567-e89b-12d3-a456-426614174000" {
		t.Fatalf("账号 UUID 未规范化: %s", identity.AccountUUID)
	}
	if identity.Email != "owner@example.com" {
		t.Fatalf("邮箱未规范化: %s", identity.Email)
	}
	if identity.OrganizationUUID != "223e4567-e89b-12d3-a456-426614174000" {
		t.Fatalf("组织 UUID 错误: %s", identity.OrganizationUUID)
	}
}

// TestDecodeAllowsMissingOrganization 验证个人账号不强制要求组织 UUID。
func TestDecodeAllowsMissingOrganization(t *testing.T) {
	identity, err := Decode([]byte(`{"oauthAccount":{"accountUuid":"123e4567-e89b-12d3-a456-426614174000","emailAddress":"owner@example.com"}}`))
	if err != nil {
		t.Fatalf("解析个人账号失败: %v", err)
	}
	if identity.OrganizationUUID != "" {
		t.Fatalf("个人账号组织应为空: %s", identity.OrganizationUUID)
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
