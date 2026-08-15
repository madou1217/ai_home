package aihserver_test

import "testing"

// TestRealClaudeFixtureSourceConfiguredRequiresCompleteSource 验证真实 Claude
// 验收只在一组完整来源存在时运行，避免半配置被误判为可用。
func TestRealClaudeFixtureSourceConfiguredRequiresCompleteSource(t *testing.T) {
	t.Setenv(realClaudeHTTPNativeCredentialsEnv, "")
	t.Setenv(realClaudeHTTPNativeConfigEnv, "")
	t.Setenv(realClaudeSub2APIFileEnv, "")
	t.Setenv(realClaudeSub2APIEmailEnv, "")
	t.Setenv(realClaudeHTTPAccountHomeEnv, "")
	t.Setenv(realClaudeHTTPAccountIDEnv, "")
	if realClaudeFixtureSourceConfigured() {
		t.Fatal("空来源不应启用真实 Claude 验收")
	}

	t.Setenv(realClaudeHTTPAccountHomeEnv, "/tmp/aih-real-claude-source")
	if realClaudeFixtureSourceConfigured() {
		t.Fatal("缺少账号别名时不应启用数据库来源")
	}
	t.Setenv(realClaudeHTTPAccountIDEnv, "7")
	if !realClaudeFixtureSourceConfigured() {
		t.Fatal("完整数据库来源应启用真实 Claude 验收")
	}
}

// TestRealClaudeFixtureSourceConfiguredAcceptsExistingSourcePairs 保证原生
// artifact 与 sub2api 的既有来源合同不被数据库来源改动破坏。
func TestRealClaudeFixtureSourceConfiguredAcceptsExistingSourcePairs(t *testing.T) {
	t.Setenv(realClaudeHTTPNativeCredentialsEnv, "/tmp/credentials.json")
	t.Setenv(realClaudeHTTPNativeConfigEnv, "/tmp/claude.json")
	t.Setenv(realClaudeSub2APIFileEnv, "")
	t.Setenv(realClaudeSub2APIEmailEnv, "")
	t.Setenv(realClaudeHTTPAccountHomeEnv, "")
	t.Setenv(realClaudeHTTPAccountIDEnv, "")
	if !realClaudeFixtureSourceConfigured() {
		t.Fatal("完整原生 artifact 来源应启用真实 Claude 验收")
	}

	t.Setenv(realClaudeHTTPNativeCredentialsEnv, "")
	t.Setenv(realClaudeHTTPNativeConfigEnv, "")
	t.Setenv(realClaudeSub2APIFileEnv, "/tmp/sub2api.json")
	t.Setenv(realClaudeSub2APIEmailEnv, "account@example.test")
	if !realClaudeFixtureSourceConfigured() {
		t.Fatal("完整 sub2api 来源应启用真实 Claude 验收")
	}
}
