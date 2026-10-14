package configured

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// quotaBody 是 4router 事故里真实的额度耗尽正文。
const quotaBody = `{"error":{"code":"INSUFFICIENT_BALANCE","message":"insufficient balance"}}`

// decodeRules 解出 Node 归一化格式的规则集合。
// decodeRules 解码并校验一组规则，等价于存储层推送后的形态。
func decodeRules(t *testing.T, raw string) []rulescore.Rule {
	t.Helper()

	var rules []rulescore.Rule
	if err := json.Unmarshal([]byte(raw), &rules); err != nil {
		t.Fatalf("解码规则失败: %v", err)
	}
	validated, err := rulescore.Validate(rules)
	if err != nil {
		t.Fatalf("校验规则失败: %v", err)
	}
	return validated
}

// ruleFor 构造一条命中指定状态的单匹配条件规则。
func ruleFor(t *testing.T, kind string, matcher string) rulescore.Rule {
	t.Helper()

	rules := decodeRules(t, `[{"name":"测试","kind":"`+kind+`","enabled":true,"statuses":[429],"matchers":[`+matcher+`]}]`)
	if len(rules) != 1 {
		t.Fatalf("规则数 = %d, want 1", len(rules))
	}
	return rules[0]
}

// TestClassifyMapsEveryKindToRuntimeFailure 锁定状态到运行态分类的映射：
// 硬阻塞必须带账号级作用域且无冷却，短期失败必须带领域允许的有限冷却。
func TestClassifyMapsEveryKindToRuntimeFailure(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		kind      rulescore.Kind
		wantKind  runtimecore.FailureKind
		wantScope runtimecore.BlockScope
		wantRetry time.Duration
	}{
		{"账单阻塞", rulescore.KindBillingBlocked, runtimecore.FailureBillingBlocked, runtimecore.BlockScopeAccount, 0},
		{"额度耗尽", rulescore.KindQuotaExhausted, runtimecore.FailureQuotaExhausted, runtimecore.BlockScopeAccount, 0},
		{"权限不足", rulescore.KindPermissionDenied, runtimecore.FailurePermissionDenied, runtimecore.BlockScopeAccount, 0},
		{"凭据无效", rulescore.KindAuthInvalid, runtimecore.FailureCredentialRejected, runtimecore.BlockScopeAccount, 0},
		{"限流", rulescore.KindRateLimited, runtimecore.FailureRateLimited, "", rateLimitedCooldown},
		{"上游不可用", rulescore.KindServiceUnavailable, runtimecore.FailureUpstreamUnavailable, "", serviceUnavailableCooldown},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			classification, err := Classify(ruleFor(t, string(testCase.kind), `{"source":"body","operator":"contains","value":"x"}`))
			if err != nil {
				t.Fatalf("Classify() error = %v", err)
			}
			if classification.Kind() != testCase.wantKind {
				t.Fatalf("kind = %q, want %q", classification.Kind(), testCase.wantKind)
			}
			if classification.RetryAfter() != testCase.wantRetry {
				t.Fatalf("retryAfter = %s, want %s", classification.RetryAfter(), testCase.wantRetry)
			}
			directive := classification.BlockDirective()
			if testCase.wantScope == "" {
				if !directive.IsZero() {
					t.Fatalf("非硬阻塞携带了阻塞指令: %#v", directive)
				}
				return
			}
			if directive.Scope() != testCase.wantScope || !directive.IsValidFor(testCase.wantKind) {
				t.Fatalf("directive = %#v", directive)
			}
		})
	}
}

// TestClassifyRejectsUnknownKind 验证未注册状态不会被悄悄映射成别的失败类型。
func TestClassifyRejectsUnknownKind(t *testing.T) {
	t.Parallel()

	if _, err := Classify(rulescore.Rule{}); !errors.Is(err, rulescore.ErrInvalidRules) {
		t.Fatalf("error = %v, want ErrInvalidRules", err)
	}
}

// TestEvaluateMapsMatchedRuleAndIgnoresOtherStatuses 验证求值只在命中时映射。
func TestEvaluateMapsMatchedRuleAndIgnoresOtherStatuses(t *testing.T) {
	t.Parallel()

	rules := decodeRules(t, `[
	  {
	    "name": "额度耗尽",
	    "kind": "quota_exhausted",
	    "enabled": true,
	    "statuses": [429],
	    "matchers": [{"source": "body", "operator": "contains", "value": "INSUFFICIENT_BALANCE"}]
	  }
	]`)
	classification, matched, err := Evaluate(rules, 429, []byte(quotaBody))
	if err != nil || !matched {
		t.Fatalf("Evaluate() = %v, %v, %v", classification, matched, err)
	}
	if classification.Kind() != runtimecore.FailureQuotaExhausted {
		t.Fatalf("kind = %q", classification.Kind())
	}
	if _, matched, err := Evaluate(rules, 402, []byte(quotaBody)); err != nil || matched {
		t.Fatalf("非白名单状态被命中: %v, %v", matched, err)
	}
	if _, matched, err := Evaluate(rules, 429, []byte(`{"error":{"code":"rate_limit"}}`)); err != nil || matched {
		t.Fatalf("不匹配正文被命中: %v, %v", matched, err)
	}
	if _, matched, err := Evaluate(rules, 200, []byte(quotaBody)); err != nil || matched {
		t.Fatalf("无失败证据被命中: %v, %v", matched, err)
	}
}

// TestClassifyWithRulesPrefersConfiguredRulesOverBuiltin 锁定优先级：
// 用户配置的规则必须覆盖内置启发式，否则配置在 Go 路径上等于失效。
func TestClassifyWithRulesPrefersConfiguredRulesOverBuiltin(t *testing.T) {
	t.Parallel()

	store, err := rulesapp.NewStore(rulesapp.Options{SupportedProviders: []string{"codex"}})
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if _, err := store.Replace([]rulesapp.AccountRules{
		rulesapp.NewAccountRules(
			"codex:acct-1",
			"codex",
			decodeRules(t, `[
			  {
			    "name": "额度耗尽",
			    "kind": "quota_exhausted",
			    "enabled": true,
			    "statuses": [429],
			    "matchers": [{"source": "body", "operator": "contains", "value": "INSUFFICIENT_BALANCE"}]
			  }
			]`),
		),
	}); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	builtinCalled := false
	builtin := func() (sharedfailure.Classification, error) {
		builtinCalled = true
		return sharedfailure.NewClassification(runtimecore.FailureRateLimited, time.Minute)
	}
	classification, err := ClassifyWithRules(
		NewEvaluator(store),
		"codex:acct-1",
		429,
		[]byte(quotaBody),
		builtin,
	)
	if err != nil {
		t.Fatalf("ClassifyWithRules() error = %v", err)
	}
	if builtinCalled {
		t.Fatal("命中配置规则后仍调用了内置分类器")
	}
	if classification.Kind() != runtimecore.FailureQuotaExhausted {
		t.Fatalf("kind = %q, want quota_exhausted", classification.Kind())
	}
	if classification.BlockDirective().Scope() != runtimecore.BlockScopeAccount {
		t.Fatalf("directive = %#v", classification.BlockDirective())
	}
}

// TestClassifyWithRulesFallsBackToBuiltin 验证未接入/未命中时零行为差异：
// nil 端口、空账号引用、未知账号、正文不匹配都必须走内置分类。
func TestClassifyWithRulesFallsBackToBuiltin(t *testing.T) {
	t.Parallel()

	store, err := rulesapp.NewStore(rulesapp.Options{SupportedProviders: []string{"codex"}})
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if _, err := store.Replace([]rulesapp.AccountRules{
		rulesapp.NewAccountRules(
			"codex:acct-1",
			"codex",
			decodeRules(t, `[
			  {
			    "name": "额度耗尽",
			    "kind": "quota_exhausted",
			    "enabled": true,
			    "statuses": [429],
			    "matchers": [{"source": "body", "operator": "contains", "value": "INSUFFICIENT_BALANCE"}]
			  }
			]`),
		),
	}); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	cases := []struct {
		name       string
		rules      Rules
		accountRef string
		statusCode int
		body       string
	}{
		{"端口缺席", nil, "codex:acct-1", 429, quotaBody},
		{"账号引用为空", NewEvaluator(store), "", 429, quotaBody},
		{"账号未知", NewEvaluator(store), "codex:other", 429, quotaBody},
		{"正文不匹配", NewEvaluator(store), "codex:acct-1", 429, `{"error":{"code":"rate_limit"}}`},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			builtinCalled := false
			classification, err := ClassifyWithRules(
				testCase.rules,
				testCase.accountRef,
				testCase.statusCode,
				[]byte(testCase.body),
				func() (sharedfailure.Classification, error) {
					builtinCalled = true
					return sharedfailure.NewClassification(runtimecore.FailureUpstreamUnavailable, time.Second)
				},
			)
			if err != nil {
				t.Fatalf("ClassifyWithRules() error = %v", err)
			}
			if !builtinCalled {
				t.Fatal("未命中配置规则却没有回落到内置分类")
			}
			if classification.Kind() != runtimecore.FailureUpstreamUnavailable {
				t.Fatalf("kind = %q", classification.Kind())
			}
		})
	}
}

// TestEvaluatorDegradesWithoutStore 验证存储缺席时求值器整体退化为不承接。
func TestEvaluatorDegradesWithoutStore(t *testing.T) {
	t.Parallel()

	if evaluator := NewEvaluator(nil); evaluator != nil {
		t.Fatalf("NewEvaluator(nil) = %#v, want nil", evaluator)
	}
	var evaluator *Evaluator
	if _, matched := evaluator.Evaluate("codex:acct-1", 429, []byte(quotaBody)); matched {
		t.Fatal("空求值器命中了规则")
	}
}

// TestClassifySSEWithRulesPrefersConfiguredRulesOverBuiltin 锁定流内事件的优先级：
// SSE / WebSocket 帧的失败事件同样必须由账号自定义规则接管。
func TestClassifySSEWithRulesPrefersConfiguredRulesOverBuiltin(t *testing.T) {
	t.Parallel()

	store, err := rulesapp.NewStore(rulesapp.Options{SupportedProviders: []string{"codex"}})
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if _, err := store.Replace([]rulesapp.AccountRules{
		rulesapp.NewAccountRules(
			"codex:acct-1",
			"codex",
			decodeRules(t, `[
			  {
			    "name": "服务不可用",
			    "kind": "service_unavailable",
			    "enabled": true,
			    "statuses": [],
			    "matchers": [{"source": "body", "operator": "contains", "value": "upstream_overloaded"}]
			  }
			]`),
		),
	}); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	builtinCalled := false
	classification, observed, err := ClassifySSEWithRules(
		NewEvaluator(store),
		"codex:acct-1",
		200,
		[]byte(`{"type":"error","error":{"message":"upstream_overloaded"}}`),
		func() (sharedfailure.Classification, bool, error) {
			builtinCalled = true
			classification, builtinErr := sharedfailure.NewClassification(runtimecore.FailureMalformedResponse, 0)
			return classification, true, builtinErr
		},
	)
	if err != nil {
		t.Fatalf("ClassifySSEWithRules() error = %v", err)
	}
	if builtinCalled {
		t.Fatal("命中配置规则后仍调用了内置观察器")
	}
	if !observed || classification.Kind() != runtimecore.FailureUpstreamUnavailable {
		t.Fatalf("classification = %q observed=%v", classification.Kind(), observed)
	}
}

// TestClassifySSEWithRulesNeverOverridesSuccessEvents 验证没有失败证据的普通
// 内容事件不会被规则改写成失败：这是把规则放在流内事件前的安全前提。
func TestClassifySSEWithRulesNeverOverridesSuccessEvents(t *testing.T) {
	t.Parallel()

	store, err := rulesapp.NewStore(rulesapp.Options{SupportedProviders: []string{"codex"}})
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if _, err := store.Replace([]rulesapp.AccountRules{
		rulesapp.NewAccountRules(
			"codex:acct-1",
			"codex",
			decodeRules(t, `[
			  {
			    "name": "宽泛匹配",
			    "kind": "quota_exhausted",
			    "enabled": true,
			    "statuses": [],
			    "matchers": [{"source": "body", "operator": "contains", "value": "error"}]
			  }
			]`),
		),
	}); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	// response.created 携带 "error": null 与包含 error 字样的内容，但没有失败证据。
	successEvent := []byte(`{"type":"response.created","error":null,"note":"no error yet"}`)
	builtinCalled := false
	_, observed, err := ClassifySSEWithRules(
		NewEvaluator(store),
		"codex:acct-1",
		200,
		successEvent,
		func() (sharedfailure.Classification, bool, error) {
			builtinCalled = true
			return sharedfailure.Classification{}, false, nil
		},
	)
	if err != nil {
		t.Fatalf("ClassifySSEWithRules() error = %v", err)
	}
	if !builtinCalled {
		t.Fatal("普通内容事件没有回落到内置观察器")
	}
	if observed {
		t.Fatal("普通内容事件被配置规则改写成了失败")
	}
}

// TestClassifySSEWithRulesFallsBackToBuiltin 验证未接入规则时的零行为差异。
func TestClassifySSEWithRulesFallsBackToBuiltin(t *testing.T) {
	t.Parallel()

	builtinCalled := false
	builtin := func() (sharedfailure.Classification, bool, error) {
		builtinCalled = true
		classification, err := sharedfailure.NewClassification(runtimecore.FailureUpstreamUnavailable, time.Second)
		return classification, true, err
	}
	for _, sample := range []struct {
		name       string
		rules      Rules
		accountRef string
		body       []byte
	}{
		{name: "未接入", rules: nil, accountRef: "codex:acct-1", body: []byte(quotaBody)},
		{name: "空账号", rules: NewEvaluator(nil), accountRef: "", body: []byte(quotaBody)},
		{name: "空正文", rules: NewEvaluator(nil), accountRef: "codex:acct-1", body: nil},
	} {
		sample := sample
		t.Run(sample.name, func(t *testing.T) {
			builtinCalled = false
			classification, observed, err := ClassifySSEWithRules(
				sample.rules,
				sample.accountRef,
				200,
				sample.body,
				builtin,
			)
			if err != nil || !observed {
				t.Fatalf("ClassifySSEWithRules() = %v, %v, %v", classification, observed, err)
			}
			if !builtinCalled {
				t.Fatal("没有回落到内置观察器")
			}
		})
	}
}
