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
	records   map[string]map[Source]Record
}

func newFakeRepository() *fakeRepository {
	return &fakeRepository{
		providers: map[string]string{},
		records:   map[string]map[Source]Record{},
	}
}

func (repository *fakeRepository) AccountProvider(_ context.Context, accountRef string) (string, bool, error) {
	provider, ok := repository.providers[accountRef]
	return provider, ok, nil
}

func (repository *fakeRepository) Load(
	_ context.Context,
	accountRef string,
	source Source,
) (Record, bool, error) {
	bySource, ok := repository.records[accountRef]
	if !ok {
		return Record{}, false, nil
	}
	record, ok := bySource[source]
	if !ok {
		return Record{}, false, nil
	}
	if len(record.Rules) == 0 && len(record.GroupIDs) == 0 {
		return Record{}, false, nil
	}
	return cloneRecord(record), true, nil
}

func (repository *fakeRepository) List(
	_ context.Context,
	source Source,
) ([]Record, error) {
	records := make([]Record, 0)
	for _, bySource := range repository.records {
		if record, ok := bySource[source]; ok && (len(record.Rules) > 0 || len(record.GroupIDs) > 0) {
			records = append(records, cloneRecord(record))
		}
	}
	return records, nil
}

func (repository *fakeRepository) ReplaceAccount(_ context.Context, record Record) error {
	if _, ok := repository.providers[record.AccountRef]; !ok {
		return ErrAccountNotFound
	}
	repository.records[record.AccountRef] = map[Source]Record{SourceAccount: cloneRecord(record)}
	return nil
}

func (repository *fakeRepository) ReplaceProjection(_ context.Context, records []Record) error {
	for ref, bySource := range repository.records {
		delete(bySource, SourceProjection)
		if len(bySource) == 0 {
			delete(repository.records, ref)
		}
	}
	for _, record := range records {
		if repository.records[record.AccountRef] == nil {
			repository.records[record.AccountRef] = map[Source]Record{}
		}
		repository.records[record.AccountRef][SourceProjection] = cloneRecord(record)
	}
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
		Source:     record.Source,
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

// 账号级配置存在时优先于兼容投影，并且组规则只展开一次。
func TestAccountConfigurationWinsOverProjection(t *testing.T) {
	ctx := context.Background()
	repository := newFakeRepository()
	repository.providers["acct_0123456789abcdef0123"] = "codex"
	groups := fakeGroups{groups: []mappingcore.Group{
		testGroup(t, "group_active", "codex", true, "from-group"),
	}}
	service := newTestService(t, repository, groups, "codex")
	if _, err := service.ReplaceAccount(ctx, "acct_0123456789abcdef0123", AccountInput{
		GroupIDs: []string{"group_active"},
		Rules:    []rulescore.Rule{testRule(t, "account-own")},
	}); err != nil {
		t.Fatalf("ReplaceAccount() error = %v", err)
	}
	if _, err := service.ReplaceProjection(ctx, []ProjectionAccount{{
		AccountRef: "acct_0123456789abcdef0123",
		Provider:   "codex",
		Rules:      []rulescore.Rule{testRule(t, "projection-only")},
	}}); err != nil {
		t.Fatalf("ReplaceProjection() error = %v", err)
	}
	view, err := service.Effective(ctx, "acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("Effective() error = %v", err)
	}
	if view.Source != SourceAccount {
		t.Fatalf("Source = %q, want %q", view.Source, SourceAccount)
	}
	assertRuleNames(t, view.EffectiveRules, []string{"from-group", "account-own"})
}

// 双写对拍：账号级拼装结果与旧 Node 推来的有效规则不一致时，必须报出账号。
func TestReplaceProjectionReportsMismatchedAccounts(t *testing.T) {
	ctx := context.Background()
	repository := newFakeRepository()
	repository.providers["acct_0123456789abcdef0123"] = "codex"
	groups := fakeGroups{groups: []mappingcore.Group{
		testGroup(t, "group_active", "codex", true, "from-group"),
	}}
	service := newTestService(t, repository, groups, "codex")
	if _, err := service.ReplaceAccount(ctx, "acct_0123456789abcdef0123", AccountInput{
		GroupIDs: []string{"group_active"},
		Rules:    []rulescore.Rule{testRule(t, "account-own")},
	}); err != nil {
		t.Fatalf("ReplaceAccount() error = %v", err)
	}
	result, err := service.ReplaceProjection(ctx, []ProjectionAccount{{
		AccountRef: "acct_0123456789abcdef0123",
		Provider:   "codex",
		Rules:      []rulescore.Rule{testRule(t, "different")},
	}})
	if err != nil {
		t.Fatalf("ReplaceProjection() error = %v", err)
	}
	if !reflect.DeepEqual(result.Mismatched, []string{"acct_0123456789abcdef0123"}) {
		t.Fatalf("Mismatched = %+v", result.Mismatched)
	}

	same, err := service.ReplaceProjection(ctx, []ProjectionAccount{{
		AccountRef: "acct_0123456789abcdef0123",
		Provider:   "codex",
		Rules:      []rulescore.Rule{testRule(t, "from-group"), testRule(t, "account-own")},
	}})
	if err != nil {
		t.Fatalf("ReplaceProjection() error = %v", err)
	}
	if len(same.Mismatched) != 0 {
		t.Fatalf("Mismatched = %+v, want empty", same.Mismatched)
	}
}

// 有效规则可以超过 20 条：上限是「每个来源 20 条」，不是拼装后的总数。
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

func TestReplaceProjectionDropsUnknownAccountsAndUnsupportedProviders(t *testing.T) {
	ctx := context.Background()
	repository := newFakeRepository()
	repository.providers["acct_0123456789abcdef0123"] = "codex"
	repository.providers["acct_ffffffffffffffffffff"] = "claude"
	service := newTestService(t, repository, fakeGroups{}, "codex")
	result, err := service.ReplaceProjection(ctx, []ProjectionAccount{
		{AccountRef: "acct_0123456789abcdef0123", Provider: "codex", Rules: []rulescore.Rule{testRule(t, "ok")}},
		{AccountRef: "acct_0123456789abcdef0123", Provider: "codex", Rules: []rulescore.Rule{testRule(t, "dup")}},
		{AccountRef: "acct_ffffffffffffffffffff", Provider: "claude", Rules: []rulescore.Rule{testRule(t, "no")}},
		{AccountRef: "acct_00000000000000000000", Provider: "codex", Rules: []rulescore.Rule{testRule(t, "missing")}},
	})
	if err != nil {
		t.Fatalf("ReplaceProjection() error = %v", err)
	}
	if !reflect.DeepEqual(result.Accepted, []string{"acct_0123456789abcdef0123"}) {
		t.Fatalf("Accepted = %+v", result.Accepted)
	}
	if len(result.Dropped) != 3 {
		t.Fatalf("Dropped = %+v, want 3", result.Dropped)
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
