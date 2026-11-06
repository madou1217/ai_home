package upstreamrules

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"testing"

	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// fakeRepository 是内存版持久化端口；只实现服务用到的语义，不模拟事务。
type fakeRepository struct {
	providers map[string]string
	records   map[string]Record
}

func newFakeRepository() *fakeRepository {
	return &fakeRepository{
		providers: map[string]string{},
		records:   map[string]Record{},
	}
}

func (repository *fakeRepository) AccountProvider(_ context.Context, accountRef string) (string, bool, error) {
	provider, ok := repository.providers[accountRef]
	return provider, ok, nil
}

func (repository *fakeRepository) Load(_ context.Context, accountRef string) (Record, bool, error) {
	record, ok := repository.records[accountRef]
	if !ok {
		return Record{}, false, nil
	}
	if len(record.Rules) == 0 && len(record.GroupIDs) == 0 {
		return Record{}, false, nil
	}
	return cloneRecord(record), true, nil
}

func (repository *fakeRepository) ReplaceAccount(_ context.Context, record Record) error {
	if _, ok := repository.providers[record.AccountRef]; !ok {
		return ErrAccountNotFound
	}
	repository.records[record.AccountRef] = cloneRecord(record)
	return nil
}

func (repository *fakeRepository) DeleteAccountRules(_ context.Context, accountRef string) (bool, error) {
	if _, ok := repository.records[accountRef]; !ok {
		return false, nil
	}
	delete(repository.records, accountRef)
	return true, nil
}

func (repository *fakeRepository) ListAccountRefs(_ context.Context) ([]string, error) {
	refs := make([]string, 0, len(repository.records))
	for ref := range repository.records {
		refs = append(refs, ref)
	}
	sort.Strings(refs)
	return refs, nil
}

func cloneRecord(record Record) Record {
	return Record{
		AccountRef: record.AccountRef,
		Provider:   record.Provider,
		GroupIDs:   append([]string(nil), record.GroupIDs...),
		Rules:      append([]rulescore.Rule(nil), record.Rules...),
	}
}

type fakeGroups struct {
	groups []mappingcore.Group
	err    error
}

func (source fakeGroups) List(context.Context) ([]mappingcore.Group, error) {
	if source.err != nil {
		return nil, source.err
	}
	return source.groups, nil
}

func testRule(t *testing.T, name string) rulescore.Rule {
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

func testGroup(t *testing.T, id string, provider string, enabled bool, ruleNames ...string) mappingcore.Group {
	t.Helper()
	rules := make([]rulescore.Rule, 0, len(ruleNames))
	for _, name := range ruleNames {
		rules = append(rules, testRule(t, name))
	}
	group, err := mappingcore.NewGroup(mappingcore.Input{
		ID:       id,
		Name:     id,
		Provider: provider,
		Enabled:  &enabled,
		Entries:  mappingcore.EntriesFromRules(rules),
	})
	if err != nil {
		t.Fatalf("构造映射组失败: %v", err)
	}
	return group
}

func newTestService(t *testing.T, repository Repository, groups GroupSource, providers ...string) *Service {
	t.Helper()
	service, err := NewService(Options{
		Repository:         repository,
		Groups:             groups,
		SupportedProviders: providers,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service
}

// 组规则按挂载顺序在前，账号规则在后；组内顺序与账号内顺序都保持。
func TestAssemblyOrdersGroupRulesBeforeAccountRules(t *testing.T) {
	ctx := context.Background()
	repository := newFakeRepository()
	repository.providers["acct_0123456789abcdef0123"] = "codex"
	groups := fakeGroups{groups: []mappingcore.Group{
		testGroup(t, "group_first", "codex", true, "group-first-a", "group-first-b"),
		testGroup(t, "group_second", "all", true, "group-second"),
	}}
	service := newTestService(t, repository, groups, "codex")
	view, err := service.ReplaceAccount(ctx, "acct_0123456789abcdef0123", AccountInput{
		GroupIDs: []string{"group_second", "group_first"},
		Rules:    []rulescore.Rule{testRule(t, "account-own")},
	})
	if err != nil {
		t.Fatalf("ReplaceAccount() error = %v", err)
	}
	assertRuleNames(t, view.EffectiveRules, []string{
		"group-second", "group-first-a", "group-first-b", "account-own",
	})
}

// 停用组与 Provider 不匹配的组必须跳过；缺失组也不能让整次求值失败。
func TestAssemblySkipsDisabledMismatchedAndMissingGroups(t *testing.T) {
	ctx := context.Background()
	repository := newFakeRepository()
	repository.providers["acct_0123456789abcdef0123"] = "codex"
	groups := fakeGroups{groups: []mappingcore.Group{
		testGroup(t, "group_disabled", "all", false, "disabled"),
		testGroup(t, "group_claude", "claude", true, "claude-only"),
		testGroup(t, "group_active", "codex", true, "active"),
	}}
	service := newTestService(t, repository, groups, "codex")
	view, err := service.ReplaceAccount(ctx, "acct_0123456789abcdef0123", AccountInput{
		GroupIDs: []string{"group_disabled", "group_claude", "missing", "group_active"},
		Rules:    []rulescore.Rule{testRule(t, "account-own")},
	})
	if err != nil {
		t.Fatalf("ReplaceAccount() error = %v", err)
	}
	assertRuleNames(t, view.EffectiveRules, []string{"active", "account-own"})
}

// 有效规则可以超过 20 条：上限是「组与账号各自 20 条」，不是拼装后的总数。
func TestEffectiveRulesCanExceedPerSourceLimit(t *testing.T) {
	ctx := context.Background()
	repository := newFakeRepository()
	repository.providers["acct_0123456789abcdef0123"] = "codex"
	groupRules := make([]rulescore.Rule, 0, rulescore.MaxRules)
	for index := range rulescore.MaxRules {
		groupRules = append(groupRules, testRule(t, "group-"+string(rune('a'+index))))
	}
	group, err := mappingcore.NewGroup(mappingcore.Input{
		ID:       "group_full",
		Name:     "group_full",
		Provider: "codex",
		Enabled:  boolPointer(true),
		Entries:  mappingcore.EntriesFromRules(groupRules),
	})
	if err != nil {
		t.Fatalf("构造映射组失败: %v", err)
	}
	accountRules := make([]rulescore.Rule, 0, rulescore.MaxRules)
	for index := range rulescore.MaxRules {
		accountRules = append(accountRules, testRule(t, "account-"+string(rune('a'+index))))
	}
	service := newTestService(t, repository, fakeGroups{groups: []mappingcore.Group{group}}, "codex")
	view, err := service.ReplaceAccount(ctx, "acct_0123456789abcdef0123", AccountInput{
		GroupIDs: []string{"group_full"},
		Rules:    accountRules,
	})
	if err != nil {
		t.Fatalf("ReplaceAccount() error = %v", err)
	}
	if len(view.EffectiveRules) != 2*rulescore.MaxRules {
		t.Fatalf("有效规则数 = %d, want %d", len(view.EffectiveRules), 2*rulescore.MaxRules)
	}
}

func TestDeleteAccountIsIdempotent(t *testing.T) {
	ctx := context.Background()
	repository := newFakeRepository()
	repository.providers["acct_0123456789abcdef0123"] = "codex"
	service := newTestService(t, repository, fakeGroups{}, "codex")
	if _, err := service.ReplaceAccount(ctx, "acct_0123456789abcdef0123", AccountInput{
		Rules: []rulescore.Rule{testRule(t, "own")},
	}); err != nil {
		t.Fatalf("ReplaceAccount() error = %v", err)
	}
	deleted, err := service.DeleteAccount(ctx, "acct_0123456789abcdef0123")
	if err != nil || !deleted {
		t.Fatalf("DeleteAccount() = %v, %v", deleted, err)
	}
	deleted, err = service.DeleteAccount(ctx, "acct_0123456789abcdef0123")
	if err != nil || deleted {
		t.Fatalf("second DeleteAccount() = %v, %v", deleted, err)
	}
}

func assertRuleNames(t *testing.T, rules []rulescore.Rule, expected []string) {
	t.Helper()
	names := make([]string, 0, len(rules))
	for _, rule := range rules {
		names = append(names, rule.Name())
	}
	if !reflect.DeepEqual(names, expected) {
		t.Fatalf("规则顺序 = %v, want %v", names, expected)
	}
}

func boolPointer(value bool) *bool { return &value }
