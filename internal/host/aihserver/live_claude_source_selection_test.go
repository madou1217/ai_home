package aihserver_test

import "testing"

// TestRealClaudeFixtureSourceConfiguredRequiresCompleteSource 验证真实 Claude
// 验收只在一组完整来源存在时��行，避免半配置被误判为可用。
//
// sub2api 文档来源与数据库拷贝来源已于 2026-10-23 移除（前者格式废弃，
// 后者依赖已被删除的 sub2api 导出器）；现在唯一的真实来源是原生 artifact 对。
func TestRealClaudeFixtureSourceConfiguredRequiresCompleteSource(t *testing.T) {
	t.Setenv(realClaudeHTTPNativeCredentialsEnv, "")
	t.Setenv(realClaudeHTTPNativeConfigEnv, "")
	if realClaudeFixtureSourceConfigured() {
		t.Fatal("空来源不应启用真实 Claude 验收")
	}

	t.Setenv(realClaudeHTTPNativeCredentialsEnv, "/tmp/credentials.json")
	if realClaudeFixtureSourceConfigured() {
		t.Fatal("只有一半原生 artifact 来源时不应启用真实 Claude 验收")
	}
}

// TestRealClaudeFixtureSourceConfiguredAcceptsNativeArtifactPair 保证原生
// artifact 这一组来源合同仍然成立。
func TestRealClaudeFixtureSourceConfiguredAcceptsNativeArtifactPair(t *testing.T) {
	t.Setenv(realClaudeHTTPNativeCredentialsEnv, "/tmp/credentials.json")
	t.Setenv(realClaudeHTTPNativeConfigEnv, "/tmp/claude.json")
	if !realClaudeFixtureSourceConfigured() {
		t.Fatal("完整原生 artifact 来源应启用真实 Claude 验收")
	}
}
