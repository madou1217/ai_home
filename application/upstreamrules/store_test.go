package upstreamrules

import (
	"encoding/json"
	"errors"
	"testing"

	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// accountPush 构造一条账号投影，规则由 Node 归一化格式的 JSON 解出。
func accountPush(t *testing.T, accountRef string, provider string, rules string) AccountRules {
	t.Helper()

	return NewAccountRules(accountRef, provider, decodeRules(t, rules))
}

// decodeRules 解出 Node 归一化格式的规则集合。
func decodeRules(t *testing.T, rules string) []rulescore.Rule {
	t.Helper()

	var parsed []rulescore.Rule
	if err := json.Unmarshal([]byte(rules), &parsed); err != nil {
		t.Fatalf("解码规则失败: %v", err)
	}
	return parsed
}

// newTestStore 创建只承接 codex 的投影存储。
func newTestStore(t *testing.T) *Store {
	t.Helper()

	store, err := NewStore(Options{SupportedProviders: []string{"codex"}})
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	return store
}

// quotaRule 是一条命中额度耗尽的规则，供多条用例复用。
const quotaRule = `[
  {
    "name": "额度耗尽",
    "kind": "quota_exhausted",
    "enabled": true,
    "statuses": [429],
    "matchers": [{"source": "body", "operator": "contains", "value": "INSUFFICIENT_BALANCE"}]
  }
]`

// TestReplaceAcceptsSupportedAccountsAndReportsGeneration 锁定推送握手：
// 接受集合是 Node 决定是否交还该账号请求的唯一依据，代次必须单调递增。
func TestReplaceAcceptsSupportedAccountsAndReportsGeneration(t *testing.T) {
	t.Parallel()

	store := newTestStore(t)
	result, err := store.Replace([]AccountRules{
		accountPush(t, "codex:acct-1", "codex", quotaRule),
	})
	if err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	if result.Generation != 1 {
		t.Fatalf("generation = %d, want 1", result.Generation)
	}
	if len(result.Accepted) != 1 || result.Accepted[0] != "codex:acct-1" {
		t.Fatalf("accepted = %#v", result.Accepted)
	}
	if len(result.Dropped) != 0 {
		t.Fatalf("dropped = %#v", result.Dropped)
	}
	rules, ok := store.RulesFor("codex:acct-1")
	if !ok || len(rules) != 1 {
		t.Fatalf("RulesFor() = %#v, %v", rules, ok)
	}
	if _, err := store.Replace(nil); err != nil {
		t.Fatalf("清空投影 error = %v", err)
	}
	if store.Generation() != 2 {
		t.Fatalf("generation = %d, want 2", store.Generation())
	}
	if _, ok := store.RulesFor("codex:acct-1"); ok {
		t.Fatal("清空投影后仍能查到账号规则")
	}
}

// TestReplaceDropsUnsupportedProviderAccounts 验证未接入的 Provider 会被丢弃，
// 从而让 Node 继续把该账号的请求交还自己处理（绝不静默丢失异常语义）。
func TestReplaceDropsUnsupportedProviderAccounts(t *testing.T) {
	t.Parallel()

	store := newTestStore(t)
	result, err := store.Replace([]AccountRules{
		accountPush(t, "claude:acct-2", "claude", quotaRule),
		accountPush(t, "codex:acct-1", "codex", quotaRule),
	})
	if err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	if len(result.Accepted) != 1 || result.Accepted[0] != "codex:acct-1" {
		t.Fatalf("accepted = %#v", result.Accepted)
	}
	if len(result.Dropped) != 1 ||
		result.Dropped[0].AccountRef != "claude:acct-2" ||
		result.Dropped[0].Reason != DropProviderNotSupported {
		t.Fatalf("dropped = %#v", result.Dropped)
	}
	if _, ok := store.RulesFor("claude:acct-2"); ok {
		t.Fatal("未接入的 Provider 账号进入了投影")
	}
}

// TestReplaceDropsInvalidRulesWithoutLosingOtherAccounts 验证逐账号判定：
// 一条 Go 无法承接的规则集合（Node 合法但 RE2 不支持的正则）只影响它自己的账号，
// 其余账号继续由 Go 承接。
func TestReplaceDropsInvalidRulesWithoutLosingOtherAccounts(t *testing.T) {
	t.Parallel()

	store := newTestStore(t)
	jsOnlyRegex := `[
	  {
	    "name": "JS 专属正则",
	    "kind": "quota_exhausted",
	    "enabled": true,
	    "statuses": [403],
	    "matchers": [{"source": "body", "operator": "regex", "value": "(?<=quota) exceeded"}]
	  }
	]`
	result, err := store.Replace([]AccountRules{
		accountPush(t, "codex:broken", "codex", jsOnlyRegex),
		accountPush(t, "codex:acct-1", "codex", quotaRule),
	})
	if err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	if len(result.Accepted) != 1 || result.Accepted[0] != "codex:acct-1" {
		t.Fatalf("accepted = %#v", result.Accepted)
	}
	if len(result.Dropped) != 1 || result.Dropped[0].Reason != DropInvalidRules {
		t.Fatalf("dropped = %#v", result.Dropped)
	}
}

// TestReplaceRejectsInvalidProjectionAndKeepsPrevious 验证结构非法时整体拒绝，
// 已生效的投影不能被半份新投影替换。
func TestReplaceRejectsInvalidProjectionAndKeepsPrevious(t *testing.T) {
	t.Parallel()

	store := newTestStore(t)
	if _, err := store.Replace([]AccountRules{
		accountPush(t, "codex:acct-1", "codex", quotaRule),
	}); err != nil {
		t.Fatalf("首次推送 error = %v", err)
	}
	if _, err := store.Replace([]AccountRules{
		NewAccountRules("  ", "codex", nil),
	}); !errors.Is(err, ErrInvalidProjection) {
		t.Fatalf("空账号引用 error = %v, want ErrInvalidProjection", err)
	}
	if _, err := NewStore(Options{SupportedProviders: []string{"  "}}); !errors.Is(err, ErrInvalidStoreDependencies) {
		t.Fatalf("非法 Provider error = %v", err)
	}
	if store.Generation() != 1 {
		t.Fatalf("非法投影改变了代次: %d", store.Generation())
	}
	if _, ok := store.RulesFor("codex:acct-1"); !ok {
		t.Fatal("整体拒绝后原投影丢失")
	}
}

// TestStoreWithoutSupportedProvidersAcceptsNothing 锁定渐进接入的默认态：
// 未声明任何能力时 Go 不承接任何账号，Node 行为与接入前完全一致。
func TestStoreWithoutSupportedProvidersAcceptsNothing(t *testing.T) {
	t.Parallel()

	store, err := NewStore(Options{})
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	result, err := store.Replace([]AccountRules{
		accountPush(t, "codex:acct-1", "codex", quotaRule),
	})
	if err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	if len(result.Accepted) != 0 || len(result.Dropped) != 1 {
		t.Fatalf("result = %#v", result)
	}
	if providers := store.SupportedProviders(); len(providers) != 0 {
		t.Fatalf("supported = %#v", providers)
	}
}

// TestReplaceAcceptsAccountWithoutEnabledRules 验证停用规则不阻塞接受：
// 该账号没有需要承接的语义，Node 不必再为它交还请求。
func TestReplaceAcceptsAccountWithoutEnabledRules(t *testing.T) {
	t.Parallel()

	store := newTestStore(t)
	disabled := `[
	  {
	    "name": "停用",
	    "kind": "quota_exhausted",
	    "enabled": false,
	    "statuses": [],
	    "matchers": [{"source": "body", "operator": "contains", "value": "INSUFFICIENT_BALANCE"}]
	  }
	]`
	result, err := store.Replace([]AccountRules{
		accountPush(t, "codex:acct-1", "codex", disabled),
	})
	if err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	if len(result.Accepted) != 1 || len(result.Dropped) != 0 {
		t.Fatalf("result = %#v", result)
	}
	rules, ok := store.RulesFor("codex:acct-1")
	if !ok || len(rules) != 1 || rulescore.HasEnabledRule(rules) {
		t.Fatalf("RulesFor() = %#v, %v", rules, ok)
	}
}

// TestSnapshotIsSortedAndIsolated 验证只读诊断返回稳定顺序的副本。
func TestSnapshotIsSortedAndIsolated(t *testing.T) {
	t.Parallel()

	store := newTestStore(t)
	if _, err := store.Replace([]AccountRules{
		accountPush(t, "codex:b", "codex", quotaRule),
		accountPush(t, "codex:a", "codex", quotaRule),
	}); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	snapshot := store.Snapshot()
	if len(snapshot) != 2 ||
		snapshot[0].AccountRef() != "codex:a" ||
		snapshot[1].AccountRef() != "codex:b" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	if snapshot[0].Provider() != "codex" {
		t.Fatalf("provider = %q", snapshot[0].Provider())
	}
}
