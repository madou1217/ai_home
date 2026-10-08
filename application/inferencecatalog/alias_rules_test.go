package inferencecatalog_test

import (
	"context"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencecatalog"
	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/core/inference"
)

func enabledAlias(id string, alias string, target string, options ...func(*modelalias.Record)) modelalias.Record {
	record := modelalias.Record{ID: id, Alias: alias, Target: target}
	for _, option := range options {
		option(&record)
	}
	return record
}

func withScope(provider string) func(*modelalias.Record) {
	return func(record *modelalias.Record) { record.Provider = provider }
}

func withTargetProvider(provider string) func(*modelalias.Record) {
	return func(record *modelalias.Record) { record.TargetProvider = provider }
}

func withPriority(priority int32) func(*modelalias.Record) {
	return func(record *modelalias.Record) { record.Priority = priority }
}

func withDisabled() func(*modelalias.Record) {
	disabled := false
	return func(record *modelalias.Record) { record.Enabled = &disabled }
}

func aliasStore(t testing.TB, records ...modelalias.Record) *modelalias.Store {
	t.Helper()
	store := modelalias.NewStore()
	if _, err := store.Replace(records); err != nil {
		t.Fatalf("Store.Replace() error = %v", err)
	}
	return store
}

// TestBuilderCompilesAliasProjectionIntoRoutes 验证 Node 的别名投影被编译为
// 真实路由：别名请求解析到目标模型，且目标 Provider 来自目标模型自身。
func TestBuilderCompilesAliasProjectionIntoRoutes(t *testing.T) {
	t.Parallel()

	catalog := newProviderCatalog(t)
	reader := &modelReader{
		models: []accountapp.RoutableModel{
			newRoutableModel(t, catalog, "claude", "claude-opus-5"),
			newRoutableModel(t, catalog, "codex", "gpt-5.6-sol"),
		},
	}
	builder := newBuilder(t, reader).WithAliasStore(aliasStore(t,
		enabledAlias("a1", "best-model", "gpt-5.6-sol"),
	))
	snapshot, err := builder.Build(context.Background())
	if err != nil {
		t.Fatalf("Builder.Build() error = %v", err)
	}
	compilation := snapshot.AliasCompilation()
	if len(compilation.AcceptedIDs) != 1 || compilation.AcceptedIDs[0] != "a1" {
		t.Fatalf("accepted = %#v", compilation.AcceptedIDs)
	}
	if len(compilation.Dropped) != 0 {
		t.Fatalf("dropped = %#v", compilation.Dropped)
	}

	plan, err := snapshot.Resolve(context.Background(), newTextRequest(
		t, inference.ClientProtocolOpenAIChatCompletions, "best-model",
	))
	if err != nil {
		t.Fatalf("Resolve(best-model) error = %v", err)
	}
	routes := plan.Candidates()
	if len(routes) != 1 ||
		routes[0].ProviderID() != inference.ProviderCodex ||
		routes[0].EffectiveModel() != "gpt-5.6-sol" {
		t.Fatalf("Resolve(best-model) routes = %#v", routes)
	}
}

// TestBuilderKeepsAliasesGoCannotRepresentOnNode 验证 Go 只接受能忠实执行的别名：
// 作用域超出 Go 的客户端协议、目标不可路由、以及被禁用的别名都不产出路由。
func TestBuilderKeepsAliasesGoCannotRepresentOnNode(t *testing.T) {
	t.Parallel()

	catalog := newProviderCatalog(t)
	reader := &modelReader{
		models: []accountapp.RoutableModel{
			newRoutableModel(t, catalog, "codex", "gpt-5.6-sol"),
		},
	}
	builder := newBuilder(t, reader).WithAliasStore(aliasStore(t,
		enabledAlias("gemini-scope", "gemini-best", "gpt-5.6-sol", withScope("gemini")),
		enabledAlias("unknown-target", "ghost", "no-such-model"),
		enabledAlias("disabled", "off", "gpt-5.6-sol", withDisabled()),
	))
	snapshot, err := builder.Build(context.Background())
	if err != nil {
		t.Fatalf("Builder.Build() error = %v", err)
	}
	compilation := snapshot.AliasCompilation()
	if len(compilation.AcceptedIDs) != 0 {
		t.Fatalf("accepted = %#v, want none", compilation.AcceptedIDs)
	}
	reasons := map[string]inferencecatalog.AliasDropReason{}
	for _, drop := range compilation.Dropped {
		reasons[drop.ID] = drop.Reason
	}
	if reasons["gemini-scope"] != inferencecatalog.AliasDropScopeUnsupported {
		t.Fatalf("gemini-scope reason = %q", reasons["gemini-scope"])
	}
	if reasons["unknown-target"] != inferencecatalog.AliasDropTargetNotRoutable {
		t.Fatalf("unknown-target reason = %q", reasons["unknown-target"])
	}
	if _, present := reasons["disabled"]; present {
		t.Fatalf("disabled alias should be ignored, got %q", reasons["disabled"])
	}
}

// TestBuilderPrefersHigherAliasPriority 验证同模式多目标时按 priority 降序排列，
// 与 Node resolveAliasCandidates 的顺序语义一致。
func TestBuilderPrefersHigherAliasPriority(t *testing.T) {
	t.Parallel()

	catalog := newProviderCatalog(t)
	reader := &modelReader{
		models: []accountapp.RoutableModel{
			newRoutableModel(t, catalog, "codex", "gpt-5.6-sol"),
			newRoutableModel(t, catalog, "codex", "gpt-6-sol"),
		},
	}
	builder := newBuilder(t, reader).WithAliasStore(aliasStore(t,
		enabledAlias("low", "fast", "gpt-5.6-sol", withPriority(1)),
		enabledAlias("high", "fast", "gpt-6-sol", withPriority(9)),
	))
	snapshot, err := builder.Build(context.Background())
	if err != nil {
		t.Fatalf("Builder.Build() error = %v", err)
	}
	plan, err := snapshot.Resolve(context.Background(), newTextRequest(
		t, inference.ClientProtocolOpenAIChatCompletions, "fast",
	))
	if err != nil {
		t.Fatalf("Resolve(fast) error = %v", err)
	}
	routes := plan.Candidates()
	if len(routes) != 2 || routes[0].EffectiveModel() != "gpt-6-sol" {
		t.Fatalf("Resolve(fast) routes = %#v", routes)
	}
}

// TestBuilderHonoursExplicitAliasTargetProvider 验证显式 targetProvider 只指向该 Provider。
func TestBuilderHonoursExplicitAliasTargetProvider(t *testing.T) {
	t.Parallel()

	catalog := newProviderCatalog(t)
	reader := &modelReader{
		models: []accountapp.RoutableModel{
			newRoutableModel(t, catalog, "claude", "claude-opus-5"),
		},
	}
	builder := newBuilder(t, reader).WithAliasStore(aliasStore(t,
		enabledAlias("a1", "sonnet", "claude-opus-5", withTargetProvider("claude")),
	))
	snapshot, err := builder.Build(context.Background())
	if err != nil {
		t.Fatalf("Builder.Build() error = %v", err)
	}
	plan, err := snapshot.Resolve(context.Background(), newTextRequest(
		t, inference.ClientProtocolAnthropicMessages, "sonnet",
	))
	if err != nil {
		t.Fatalf("Resolve(sonnet) error = %v", err)
	}
	routes := plan.Candidates()
	if len(routes) != 1 ||
		routes[0].ProviderID() != inference.ProviderClaude ||
		routes[0].ProtocolID() != inference.ProtocolClaudeMessages {
		t.Fatalf("Resolve(sonnet) routes = %#v", routes)
	}
}
