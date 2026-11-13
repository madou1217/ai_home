package codebuddyfamilystorage

import (
	"strings"
	"testing"
)

// TestPolicyMatchesNodeToolchainCaches 守住与 Node HOST_TOOLCHAIN_CACHES 的逐项对齐：
// 少一条就意味着某个账号会重新长出一份工具链缓存。
func TestPolicyMatchesNodeToolchainCaches(t *testing.T) {
	policy, ok := Policy("codebuddycn")
	if !ok {
		t.Fatal("codebuddycn 缺少投影策略")
	}
	want := []string{
		"go",
		".npm",
		".bun",
		".volta",
		".local/bin",
		"Library/Caches/go-build",
		"Library/Caches/Homebrew",
		"Library/Caches/bun",
		"Library/Caches/pip",
	}
	got := make([]string, 0, len(policy.SharedHostCaches)-1)
	for _, link := range policy.SharedHostCaches {
		if len(link.Exclude) > 0 {
			continue
		}
		got = append(got, strings.Join(link.Projection, "/"))
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("shared host caches = %v, want %v", got, want)
	}
}

// TestPolicyKeepsDesktopStatePrivate 桌面端加密/连接器状态必须留在账号投影里。
func TestPolicyKeepsDesktopStatePrivate(t *testing.T) {
	policy, ok := Policy("codebuddycn")
	if !ok {
		t.Fatal("codebuddycn 缺少投影策略")
	}
	private := make(map[string]bool, len(policy.PrivateArtifacts))
	for _, spec := range policy.PrivateArtifacts {
		private[strings.Join(spec.Path, "/")] = true
	}
	for _, want := range []string{
		"electron-user-data",
		".codebuddy/diagnostics",
		"Library/Preferences/com.apple.security.plist",
		".workbuddy-key-fallback",
		"Library/Application Support/CodeBuddyExtension/Cache",
		"Library/Application Support/CodeBuddyExtension/Logs",
		".codebuddy-cn/sessions",
	} {
		if !private[want] {
			t.Fatalf("缺少账号私有路径 %q（现有 %v）", want, private)
		}
	}
}

// TestAllFamilyProvidersShareCaches 四个 Provider 的缓存策略必须一致。
func TestAllFamilyProvidersShareCaches(t *testing.T) {
	for _, providerID := range ProviderIDs() {
		policy, ok := Policy(providerID)
		if !ok {
			t.Fatalf("%s 缺少投影策略", providerID)
		}
		// 9 条工具链缓存 + 1 条带排除的桌面 Library/Caches。
		if len(policy.SharedHostCaches) != 10 {
			t.Fatalf("%s shared host caches = %d, want 10", providerID, len(policy.SharedHostCaches))
		}
		last := policy.SharedHostCaches[len(policy.SharedHostCaches)-1]
		if strings.Join(last.Projection, "/") != "Library/Caches" || len(last.Exclude) != 4 {
			t.Fatalf("%s desktop caches link = %#v", providerID, last)
		}
	}
}

// TestWorkbuddyConfigDirEnv WorkBuddy 两支必须同时拿到 WORKBUDDY_CONFIG_DIR，
// CodeBuddy 两支不能凭空多出这个变量。
func TestWorkbuddyConfigDirEnv(t *testing.T) {
	cases := map[string]bool{
		"codebuddy":   false,
		"codebuddycn": false,
		"workbuddy":   true,
		"workbuddycn": true,
	}
	for providerID, want := range cases {
		policy, ok := Policy(providerID)
		if !ok {
			t.Fatalf("%s 缺少投影策略", providerID)
		}
		found := false
		for _, binding := range policy.Env {
			if binding.Key == "WORKBUDDY_CONFIG_DIR" {
				found = true
			}
		}
		if found != want {
			t.Fatalf("%s WORKBUDDY_CONFIG_DIR = %v, want %v", providerID, found, want)
		}
	}
}
