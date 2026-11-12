package aihserver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeHostFile 在宿主 HOME 下写一个文件。
func writeHostFile(t *testing.T, root string, segments []string, content string) {
	t.Helper()
	path := filepath.Join(append([]string{root}, segments...)...)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
}

// TestProviderLocalAuthIdentityReadsOfficialArtifact 锁死本机指纹端口：
// 只认「读宿主登录态」这一类来源，指纹来自官方 artifact 的解码结果。
func TestProviderLocalAuthIdentityReadsOfficialArtifact(t *testing.T) {
	hostHomeDir := t.TempDir()
	writeHostFile(t, hostHomeDir, []string{".codex", "auth.json"},
		`{"auth_mode":"apikey","OPENAI_API_KEY":"sk-host-test"}`)
	port := providerLocalAuthIdentity(hostHomeDir)
	if port == nil {
		t.Fatal("宿主 HOME 已知时必须接线")
	}
	seed, ok := port(context.Background(), "codex", "codex-host-local")
	if !ok || !strings.HasPrefix(seed, "api_key:codex:") {
		t.Fatalf("seed/ok = %q/%v，期望 codex 的 api_key 种子", seed, ok)
	}
	// 同一份登录态再算一次必须得到同一指纹（去重的前提）。
	again, ok := port(context.Background(), "codex", "codex-host-local")
	if !ok || again != seed {
		t.Fatalf("第二次 = %q/%v，期望与第一次一致", again, ok)
	}
}

// TestProviderLocalAuthIdentitySkipsOtherSources 锁死来源类型与 Provider 的边界。
func TestProviderLocalAuthIdentitySkipsOtherSources(t *testing.T) {
	hostHomeDir := t.TempDir()
	writeHostFile(t, hostHomeDir, []string{".codex", "auth.json"},
		`{"auth_mode":"apikey","OPENAI_API_KEY":"sk-host-test"}`)
	port := providerLocalAuthIdentity(hostHomeDir)
	cases := []struct {
		name     string
		provider string
		sourceID string
	}{
		{name: "扫描类来源没有指纹", provider: "codex", sourceID: "codex-host-scan"},
		{name: "来源与 Provider 不匹配", provider: "codex", sourceID: "claude-host-local"},
		{name: "没有官方 artifact 策略", provider: "gemini", sourceID: "gemini-host-local"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if seed, ok := port(context.Background(), testCase.provider, testCase.sourceID); ok || seed != "" {
				t.Fatalf("seed/ok = %q/%v，期望不判指纹", seed, ok)
			}
		})
	}
}

// TestProviderLocalAuthIdentityWithoutLoginState 锁死「读不到就不判指纹」。
func TestProviderLocalAuthIdentityWithoutLoginState(t *testing.T) {
	port := providerLocalAuthIdentity(t.TempDir())
	if seed, ok := port(context.Background(), "claude", "claude-host-local"); ok || seed != "" {
		t.Fatalf("seed/ok = %q/%v，宿主没有 claude 登录态时不该有指纹", seed, ok)
	}
}

// TestProviderLocalAuthIdentityRequiresHostHome 锁死未接线：宿主 HOME 未知时端口为 nil，
// 调用方据此把 alreadyImported 列为未填字段。
func TestProviderLocalAuthIdentityRequiresHostHome(t *testing.T) {
	if port := providerLocalAuthIdentity("   "); port != nil {
		t.Fatal("宿主 HOME 未知时不该接线")
	}
}

// TestProviderAuthIdentitiesRequiresStore 同上：账号存储未装配时端口为 nil。
func TestProviderAuthIdentitiesRequiresStore(t *testing.T) {
	if port := providerAuthIdentities(nil); port != nil {
		t.Fatal("账号存储缺失时不该接线")
	}
}
