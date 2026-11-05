package aihserver

import (
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

func mustRoutable(t *testing.T, catalog *providers.Catalog, provider, model string) accountapp.RoutableModel {
	t.Helper()
	value, err := accountapp.NewRoutableModel(catalog, provider, model)
	if err != nil {
		t.Fatalf("NewRoutableModel(%s, %s) error = %v", provider, model, err)
	}
	return value
}

func TestGroupAliasTargetsGroupsSortsAndDedupes(t *testing.T) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	models := []accountapp.RoutableModel{
		mustRoutable(t, catalog, "codex", "gpt-5.1"),
		mustRoutable(t, catalog, "codex", "gpt-5.0"),
		mustRoutable(t, catalog, "claude", "claude-opus-4-6"),
		// 重复项：同一 Provider 同一模型出现两次只保留一份。
		mustRoutable(t, catalog, "codex", "gpt-5.1"),
	}
	targets := groupAliasTargets(models)
	codex := targets["codex"]
	if len(codex) != 2 || codex[0] != "gpt-5.0" || codex[1] != "gpt-5.1" {
		t.Fatalf("codex = %v, want 去重并升序 [gpt-5.0 gpt-5.1]", codex)
	}
	if len(targets["claude"]) != 1 {
		t.Fatalf("claude = %v", targets["claude"])
	}
}

func TestGroupAliasTargetsEmptyInput(t *testing.T) {
	if got := groupAliasTargets(nil); len(got) != 0 {
		t.Fatalf("空输入 = %v, want 空表", got)
	}
}
