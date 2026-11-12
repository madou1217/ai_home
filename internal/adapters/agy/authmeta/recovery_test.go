package authmeta

import (
	"testing"
	"time"
)

// recoverableMetadata 表示一份「access token 仍新鲜」的 OAuth 元数据。
func recoverableMetadata(now time.Time) Metadata {
	return Metadata{
		Configured:       true,
		HasAccessToken:   true,
		HasRefreshToken:  true,
		TokenExpiresAtMS: now.Add(time.Hour).UnixMilli(),
	}
}

// TestCanRecoverAuthInvalidBlock 覆盖 Node canRecoverAgyAuthInvalidBlock 的全部分支。
// 核心口径：有记录原因的失败一律不恢复；静态凭据只能修无原因的旧块。
func TestCanRecoverAuthInvalidBlock(t *testing.T) {
	now := fixedNow()
	expired := Metadata{HasAccessToken: true, TokenExpiresAtMS: now.Add(-time.Hour).UnixMilli()}
	refreshOnly := Metadata{HasRefreshToken: true}
	noCredentials := Metadata{Configured: true}

	cases := []struct {
		name     string
		provider string
		status   RuntimeStatus
		metadata Metadata
		want     bool
	}{
		{"agy 无原因且有新鲜 token", "agy", NewRuntimeStatus("auth_invalid", 0, ""), recoverableMetadata(now), true},
		{"agy 无原因且只有 refresh_token", "AGY ", NewRuntimeStatus("auth_invalid", 0, ""), refreshOnly, true},
		{"无原因但 token 已过期且无 refresh", "agy", NewRuntimeStatus("auth_invalid", 0, ""), expired, false},
		{"无原因但没有可用凭据", "agy", NewRuntimeStatus("auth_invalid", 0, ""), noCredentials, false},
		{"有原因不恢复", "agy", NewRuntimeStatus("auth_invalid", 0, "token expired"), recoverableMetadata(now), false},
		{"reason 空白串按无原因处理（JS 真值语义）", "agy", RuntimeStatus{
			Status: "auth_invalid", Reason: "   ", Detail: "上游 401",
		}, recoverableMetadata(now), true},
		{"detail 提供原因时不恢复", "agy", RuntimeStatus{
			Status: "auth_invalid", Detail: "invalid_grant",
		}, recoverableMetadata(now), false},
		{"lastFailureReason 提供原因时不恢复", "agy", RuntimeStatus{
			Status: "auth_invalid", LastFailureReason: "expired",
		}, recoverableMetadata(now), false},
		{"lastError 提供原因时不恢复", "agy", RuntimeStatus{
			Status: "auth_invalid", LastError: "401",
		}, recoverableMetadata(now), false},
		{"非 agy 不恢复", "codex", NewRuntimeStatus("auth_invalid", 0, ""), recoverableMetadata(now), false},
		{"非 auth_invalid 不恢复", "agy", NewRuntimeStatus("rate_limited", 0, ""), recoverableMetadata(now), false},
		{"healthy 不恢复", "agy", NewRuntimeStatus("healthy", 0, ""), recoverableMetadata(now), false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := CanRecoverAuthInvalidBlock(testCase.provider, testCase.status, testCase.metadata, now); got != testCase.want {
				t.Fatalf("CanRecoverAuthInvalidBlock() = %v, want %v", got, testCase.want)
			}
		})
	}
}

// TestIsNonRecoverableAuthInvalidBlock 覆盖 agy_not_signed_in 的不可恢复判定。
// 这条闸门在 core/accounts/status_transition.go 已有实现，本包保持同一口径供视图层使用。
func TestIsNonRecoverableAuthInvalidBlock(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		status   RuntimeStatus
		want     bool
	}{
		{"标准原因", "agy", NewRuntimeStatus("auth_invalid", 0, "agy_not_signed_in"), true},
		{"大小写不敏感", " AGY ", NewRuntimeStatus("auth_invalid", 0, "AGY_NOT_SIGNED_IN"), true},
		{"原因带空白", "agy", NewRuntimeStatus("auth_invalid", 0, " agy_not_signed_in "), true},
		{"原因来自 lastFailureReason", "agy", RuntimeStatus{
			Status: "auth_invalid", LastFailureReason: "agy_not_signed_in",
		}, true},
		{"其它原因不算不可恢复", "agy", NewRuntimeStatus("auth_invalid", 0, "expired"), false},
		{"没有原因不算不可恢复", "agy", NewRuntimeStatus("auth_invalid", 0, ""), false},
		{"非 auth_invalid", "agy", NewRuntimeStatus("rate_limited", 0, "agy_not_signed_in"), false},
		{"非 agy", "codex", NewRuntimeStatus("auth_invalid", 0, "agy_not_signed_in"), false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := IsNonRecoverableAuthInvalidBlock(testCase.provider, testCase.status); got != testCase.want {
				t.Fatalf("IsNonRecoverableAuthInvalidBlock() = %v, want %v", got, testCase.want)
			}
		})
	}
}

// TestResolveRuntimeStatus 覆盖可恢复时对外呈现 healthy、不可恢复时原样返回。
func TestResolveRuntimeStatus(t *testing.T) {
	now := fixedNow()
	blocked := NewRuntimeStatus("auth_invalid", now.Add(time.Hour).UnixMilli(), "")

	resolved := ResolveRuntimeStatus("agy", blocked, recoverableMetadata(now), now)
	if resolved.Status != "healthy" || resolved.UntilMS != 0 || resolved.Reason != "" {
		t.Fatalf("恢复后运行态 = %+v", resolved)
	}
	if resolved.Detail != "" || resolved.LastFailureReason != "" || resolved.LastError != "" {
		t.Fatalf("恢复后不应保留失败详情: %+v", resolved)
	}

	withReason := RuntimeStatus{
		Status:  "auth_invalid",
		UntilMS: now.Add(time.Hour).UnixMilli(),
		Reason:  "expired",
	}
	unchanged := ResolveRuntimeStatus("agy", withReason, recoverableMetadata(now), now)
	if unchanged != withReason {
		t.Fatalf("有原因时应原样返回: %+v", unchanged)
	}

	noCredentials := ResolveRuntimeStatus("agy", blocked, Metadata{}, now)
	if noCredentials != blocked {
		t.Fatalf("无凭据时应原样返回: %+v", noCredentials)
	}
}

// TestRecoveryUsesParsedMetadata 把解析与恢复串起来：
//   - OAuth artifact 有 refresh_token → 旧空块可恢复；
//   - 只有环境变量 token 的账号 → Node 的元数据没有 refresh/expiry，同样不可恢复。
func TestRecoveryUsesParsedMetadata(t *testing.T) {
	now := fixedNow()
	status := NewRuntimeStatus("auth_invalid", now.Add(time.Hour).UnixMilli(), "")

	oauth := CredentialRecord{NativeAuth: []byte(
		`{"email":"a@b.test","oauthToken":{"token":{"access_token":"a","refresh_token":"r","expiry":"2026-11-12T13:30:00Z"}}}`)}
	if !CanRecoverAuthInvalidBlock("agy", status, ReadMetadata(oauth, now), now) {
		t.Fatal("有 refresh_token 的 OAuth 凭据应可恢复旧空块")
	}

	envOnly := CredentialRecord{Env: map[string]string{EnvAccessTokenKey: "env-token"}}
	if CanRecoverAuthInvalidBlock("agy", status, ReadMetadata(envOnly, now), now) {
		t.Fatal("环境变量 token 没有过期信息，不应被当成可恢复凭据")
	}
}

// TestRecoverableOAuthEvidenceValue 固定证据名：它同时是 Go 状态转移的事件键。
func TestRecoverableOAuthEvidenceValue(t *testing.T) {
	if RecoverableOAuthEvidence != "agy_oauth_credentials_recoverable" {
		t.Fatalf("evidence = %q", RecoverableOAuthEvidence)
	}
}
