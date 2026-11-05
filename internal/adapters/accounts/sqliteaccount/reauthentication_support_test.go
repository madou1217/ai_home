package sqliteaccount

import "testing"

// 2026-11-06 cline 账号同步每轮 500 的根因：cline 的凭据形态与下面这些 Provider 完全相同
// （oauth + native_auth_json），但白名单漏了它。这个用例锁住「原生 JSON 凭据都能原地重新认证」。
func TestSupportsReauthenticationCoversNativeAuthJSONProviders(t *testing.T) {
	providers := []string{
		"gemini", "opencode", "grok", "qoder", "qodercn", "kimi", "kiro", "zcode",
		"cline", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn",
	}
	for _, providerID := range providers {
		if !supportsReauthentication(providerID, "oauth", "native_auth_json") {
			t.Errorf("%s 的 oauth/native_auth_json 凭据应支持原地重新认证", providerID)
		}
		if supportsReauthentication(providerID, "api_key", "") {
			t.Errorf("%s 的 api_key 凭据不应声明支持原地重新认证", providerID)
		}
	}
}

func TestSupportsReauthenticationRejectsUnknownProvider(t *testing.T) {
	if supportsReauthentication("plugin-unknown", "oauth", "native_auth_json") {
		t.Fatal("未登记 Provider 不应默认支持原地重新认证")
	}
}

func TestSupportsReauthenticationKeepsProviderSpecificModes(t *testing.T) {
	if !supportsReauthentication("codex", "oauth", "") {
		t.Fatal("codex oauth 应支持原地重新认证")
	}
	if supportsReauthentication("codex", "oauth", "native_auth_json") {
		t.Fatal("codex 的 authMode 必须为空")
	}
	if !supportsReauthentication("claude", "oauth", "refreshable") {
		t.Fatal("claude oauth/refreshable 应支持原地重新认证")
	}
}
