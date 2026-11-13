package main

import (
	"path/filepath"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accountprojection"

	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
)

// TestProviderBinaryName 守住「二进制名来自 Provider 合同」的契约：
// 家族四支共用 codebuddy，显式 BinaryName 的 Provider 用合同值，其余用 Provider ID。
func TestProviderBinaryName(t *testing.T) {
	cases := map[string]string{
		"codex":       "codex",
		"claude":      "claude",
		"codebuddy":   "codebuddy",
		"codebuddycn": "codebuddy",
		"workbuddy":   "codebuddy",
		"workbuddycn": "codebuddy",
		"zcode":       "zcode",
		"agy":         "agy",
		"gemini":      "gemini",
		"cline":       "cline",
		"qoder":       "qodercli",
		"qodercn":     "qoderclicn",
		"kiro":        "kiro-cli",
		"unknown-cli": "",
	}
	for provider, want := range cases {
		if got := providerBinaryName(provider); got != want {
			t.Fatalf("providerBinaryName(%q) = %q, want %q", provider, got, want)
		}
	}
}

// TestHomeDiagnosticsPathsFollowPolicy 保证 home 诊断的路径来自投影 Policy：
// 配置根与 auth 产物必须落在同一个伪 HOME 下。
func TestHomeDiagnosticsPathsFollowPolicy(t *testing.T) {
	policy, ok := codebuddyfamilystorage.Policy("codebuddycn")
	if !ok {
		t.Fatal("codebuddycn 缺少投影策略")
	}
	root := "/tmp/projection"
	for _, binding := range policy.Env {
		value := environmentValue(root, binding)
		if binding.Key == "CODEBUDDY_CONFIG_DIR" && value != filepath.Join(root, ".codebuddy-cn") {
			t.Fatalf("CODEBUDDY_CONFIG_DIR = %q", value)
		}
	}
	if len(policy.AuthArtifacts) != 1 {
		t.Fatalf("auth artifacts = %d, want 1", len(policy.AuthArtifacts))
	}
	authPath := artifactPath(root, policy.AuthArtifacts[0])
	wantAuth := filepath.Join(
		root,
		"Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth",
		"workbuddy-desktop.info",
	)
	if authPath != wantAuth {
		t.Fatalf("auth path = %q, want %q", authPath, wantAuth)
	}
}

// TestPolicyNativeBaseUsesConfigRoot 共享条目必须挂在该 Provider 的配置根下。
func TestPolicyNativeBaseUsesConfigRoot(t *testing.T) {
	policy, ok := codebuddyfamilystorage.Policy("codebuddycn")
	if !ok {
		t.Fatal("codebuddycn 缺少投影策略")
	}
	base := policyNativeBase("/tmp/projection", policy)
	if base != filepath.Join("/tmp/projection", ".codebuddy-cn") {
		t.Fatalf("base = %q", base)
	}
}

// TestProviderHomePolicyCoversCodex codex 用 config_dir 策略；claude 没有投影策略。
func TestProviderHomePolicyCoversCodex(t *testing.T) {
	codexPolicy, ok := providerHomePolicy("codex")
	if !ok || codexPolicy.Mode != accountapp.ModeConfigDir {
		t.Fatalf("codex policy = %#v ok=%v", codexPolicy, ok)
	}
	if _, ok := providerHomePolicy("claude"); ok {
		t.Fatal("claude 不应有 home 投影策略")
	}
}

// TestArtifactPathTreatsEmptyBaseAsHome codex 策略的零值 Base 表示相对 HOME。
func TestArtifactPathTreatsEmptyBaseAsHome(t *testing.T) {
	path := artifactPath("/tmp/root", accountapp.Artifact{Path: []string{".codex", "auth.json"}})
	if path != "/tmp/root/.codex/auth.json" {
		t.Fatalf("artifact path = %q", path)
	}
}
