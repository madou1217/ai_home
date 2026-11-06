package sqliteaccount

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	mappingapp "github.com/madou1217/ai_home/application/upstreammapping"
	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

func namedRule(t *testing.T, name string) rulescore.Rule {
	t.Helper()
	raw := fmt.Sprintf(`{"name":%q,"kind":"rate_limited","statuses":[429],"matchers":[{"source":"body","operator":"contains","value":%q}]}`, name, name)
	var rule rulescore.Rule
	if err := json.Unmarshal([]byte(raw), &rule); err != nil {
		t.Fatalf("解析规则失败: %v", err)
	}
	compiled, err := rulescore.NewRule(rule.Name(), rule.Kind(), rule.Enabled(), rule.Statuses(), rule.Matchers())
	if err != nil {
		t.Fatalf("编译规则失败: %v", err)
	}
	return compiled
}

func createRuleGroup(
	t *testing.T,
	service *mappingapp.Service,
	name string,
	provider string,
	rules ...rulescore.Rule,
) mappingcore.Group {
	t.Helper()
	group, err := service.Create(context.Background(), mappingapp.CreateInput{
		Name:     name,
		Provider: provider,
		Rules:    rules,
	})
	if err != nil {
		t.Fatalf("Create(%q) error = %v", name, err)
	}
	return group
}

func newRuleService(t *testing.T, store *Store) *rulesapp.Service {
	t.Helper()
	service, err := rulesapp.NewService(rulesapp.Options{
		Repository:         NewUpstreamErrorRuleRepository(store),
		Groups:             newMappingService(t, store),
		SupportedProviders: []string{"codex", "claude"},
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service
}

func ruleNames(rules []rulescore.Rule) []string {
	names := make([]string, 0, len(rules))
	for _, rule := range rules {
		names = append(names, rule.Name())
	}
	return names
}

func equalNames(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

// 账号规则 + 组挂载落库后可读、可重启恢复，顺序与 Node 一致。
func TestAccountUpstreamErrorRulesPersistAndAssemble(t *testing.T) {
	ctx := context.Background()
	store, dir, _, refs := openRoutingExclusionStore(t)
	mapping := newMappingService(t, store)
	first := createRuleGroup(t, mapping, "第一组", "codex", namedRule(t, "g1-a"), namedRule(t, "g1-b"))
	second := createRuleGroup(t, mapping, "第二组", "all", namedRule(t, "g2"))
	rules := newRuleService(t, store)

	view, err := rules.ReplaceAccount(ctx, refs[0].String(), rulesapp.AccountInput{
		GroupIDs: []string{second.ID(), first.ID()},
		Rules:    []rulescore.Rule{namedRule(t, "account-own")},
	})
	if err != nil {
		t.Fatalf("ReplaceAccount() error = %v", err)
	}
	want := []string{"g2", "g1-a", "g1-b", "account-own"}
	if !equalNames(ruleNames(view.EffectiveRules), want) {
		t.Fatalf("有效规则 = %v, want %v", ruleNames(view.EffectiveRules), want)
	}

	// 重启后从库里恢复：规则与挂载都是持久事实，不靠 Node 再推。
	reopened, err := Open(ctx, OpenOptions{AIHomeDir: dir, Catalog: store.catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	restored, err := newRuleService(t, reopened).Effective(ctx, refs[0].String())
	if err != nil {
		t.Fatalf("Effective() error = %v", err)
	}
	if !equalNames(ruleNames(restored.EffectiveRules), want) {
		t.Fatalf("重启后有效规则 = %v, want %v", ruleNames(restored.EffectiveRules), want)
	}
	if len(restored.GroupIDs) != 2 || restored.GroupIDs[0] != second.ID() {
		t.Fatalf("挂载顺序 = %v", restored.GroupIDs)
	}
}

// 删除账号必须级联清掉规则与组挂载。
func TestAccountUpstreamErrorRulesCascadeOnAccountDelete(t *testing.T) {
	ctx := context.Background()
	store, _, _, refs := openRoutingExclusionStore(t)
	mapping := newMappingService(t, store)
	group := createRuleGroup(t, mapping, "组", "codex", namedRule(t, "group-rule"))
	rules := newRuleService(t, store)
	if _, err := rules.ReplaceAccount(ctx, refs[0].String(), rulesapp.AccountInput{
		GroupIDs: []string{group.ID()},
		Rules:    []rulescore.Rule{namedRule(t, "account-own")},
	}); err != nil {
		t.Fatalf("ReplaceAccount() error = %v", err)
	}
	accountRef, err := accountcore.ParseAccountRef(refs[0].String())
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	if err := store.DeleteAccount(ctx, accountRef); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
	var ruleCount, groupCount int
	if err := store.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM account_upstream_error_rule WHERE account_ref = ?",
		refs[0].String(),
	).Scan(&ruleCount); err != nil {
		t.Fatalf("统计规则失败: %v", err)
	}
	if err := store.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM account_upstream_error_group WHERE account_ref = ?",
		refs[0].String(),
	).Scan(&groupCount); err != nil {
		t.Fatalf("统计组挂载失败: %v", err)
	}
	if ruleCount != 0 || groupCount != 0 {
		t.Fatalf("级联删除后 rules=%d groups=%d, want 0/0", ruleCount, groupCount)
	}
}

// 组被删除后，挂载行保留但拼装必须跳过它——与 Node「找不到组就跳过」一致。
func TestDeletedGroupIsSkippedDuringAssembly(t *testing.T) {
	ctx := context.Background()
	store, _, _, refs := openRoutingExclusionStore(t)
	mapping := newMappingService(t, store)
	group := createRuleGroup(t, mapping, "组", "codex", namedRule(t, "group-rule"))
	rules := newRuleService(t, store)
	if _, err := rules.ReplaceAccount(ctx, refs[0].String(), rulesapp.AccountInput{
		GroupIDs: []string{group.ID()},
		Rules:    []rulescore.Rule{namedRule(t, "account-own")},
	}); err != nil {
		t.Fatalf("ReplaceAccount() error = %v", err)
	}
	if err := mapping.Delete(ctx, group.ID(), nil); err != nil {
		t.Fatalf("Delete(group) error = %v", err)
	}
	view, err := rules.Effective(ctx, refs[0].String())
	if err != nil {
		t.Fatalf("Effective() error = %v", err)
	}
	if !equalNames(ruleNames(view.EffectiveRules), []string{"account-own"}) {
		t.Fatalf("删除组后有效规则 = %v", ruleNames(view.EffectiveRules))
	}
}

// 整体替换：旧规则与旧挂载必须被清掉，不能残留。
func TestReplaceAccountRemovesPreviousConfiguration(t *testing.T) {
	ctx := context.Background()
	store, _, _, refs := openRoutingExclusionStore(t)
	mapping := newMappingService(t, store)
	first := createRuleGroup(t, mapping, "第一组", "codex", namedRule(t, "g1"))
	second := createRuleGroup(t, mapping, "第二组", "codex", namedRule(t, "g2"))
	rules := newRuleService(t, store)
	if _, err := rules.ReplaceAccount(ctx, refs[0].String(), rulesapp.AccountInput{
		GroupIDs: []string{first.ID()},
		Rules:    []rulescore.Rule{namedRule(t, "old")},
	}); err != nil {
		t.Fatalf("ReplaceAccount() error = %v", err)
	}
	view, err := rules.ReplaceAccount(ctx, refs[0].String(), rulesapp.AccountInput{
		GroupIDs: []string{second.ID()},
		Rules:    []rulescore.Rule{namedRule(t, "new")},
	})
	if err != nil {
		t.Fatalf("ReplaceAccount() error = %v", err)
	}
	if !equalNames(ruleNames(view.EffectiveRules), []string{"g2", "new"}) {
		t.Fatalf("替换后有效规则 = %v", ruleNames(view.EffectiveRules))
	}
}

func TestDeleteAccountRulesIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store, _, _, refs := openRoutingExclusionStore(t)
	rules := newRuleService(t, store)
	if _, err := rules.ReplaceAccount(ctx, refs[0].String(), rulesapp.AccountInput{
		Rules: []rulescore.Rule{namedRule(t, "account-own")},
	}); err != nil {
		t.Fatalf("ReplaceAccount() error = %v", err)
	}
	deleted, err := rules.DeleteAccount(ctx, refs[0].String())
	if err != nil || !deleted {
		t.Fatalf("DeleteAccount() = %v, %v", deleted, err)
	}
	deleted, err = rules.DeleteAccount(ctx, refs[0].String())
	if err != nil || deleted {
		t.Fatalf("second DeleteAccount() = %v, %v", deleted, err)
	}
	if _, err := rules.Effective(ctx, refs[0].String()); err != nil {
		t.Fatalf("Effective() after delete error = %v", err)
	}
}

func TestReplaceAccountRejectsUnknownAccount(t *testing.T) {
	ctx := context.Background()
	store, _, _, _ := openRoutingExclusionStore(t)
	rules := newRuleService(t, store)
	_, err := rules.ReplaceAccount(ctx, "acct_00000000000000000000", rulesapp.AccountInput{})
	if !errors.Is(err, rulesapp.ErrAccountNotFound) {
		t.Fatalf("error = %v, want ErrAccountNotFound", err)
	}
}
