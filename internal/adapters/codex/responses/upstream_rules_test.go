package responses

import (
	"net/http"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	testsupportrules "github.com/madou1217/ai_home/internal/testsupport/upstreamrules"
)

// deniedAdapterBody 是账号自定义规则要识别的上游正文。
const deniedAdapterBody = `{"error":{"code":"custom_denied","message":"denied by account rule"}}`

// TestAccountRulesOverrideAdapterFailureClassification 锁定 Canonical Adapter 的规则优先级：
// 同一份 403 正文，命中账号规则时按规则映射的状态与作用域记账，
// 未接入规则时保持内置启发式。
func TestAccountRulesOverrideAdapterFailureClassification(t *testing.T) {
	t.Parallel()

	upstream := func() *recordingHTTPClient {
		return &recordingHTTPClient{
			response: httpResponse(http.StatusForbidden, "application/json", deniedAdapterBody),
		}
	}
	rulesJSON := func(marker string) string {
		return testsupportrules.SingleRuleJSON(
			"账号自定额度耗尽",
			"quota_exhausted",
			[]int{http.StatusForbidden},
			"body",
			"contains",
			marker,
		)
	}
	run := func(t *testing.T, fixture adapterCoordinatorFixture) []inference.StreamEvent {
		t.Helper()

		events := make([]inference.StreamEvent, 0, 1)
		if err := fixture.coordinator.Execute(
			t.Context(),
			newAdapterTextRequest(t, false),
			func(event inference.StreamEvent) error {
				events = append(events, event)
				return nil
			},
		); err != nil {
			t.Fatalf("Coordinator.Execute() error = %v", err)
		}
		return events
	}

	t.Run("命中规则", func(t *testing.T) {
		probe := newAdapterCoordinatorFixture(t, upstream())
		evaluator, err := testsupportrules.NewEvaluator(
			"codex",
			probe.accountRef,
			rulesJSON("custom_denied"),
		)
		if err != nil {
			t.Fatalf("NewEvaluator() error = %v", err)
		}
		fixture := newAdapterCoordinatorFixtureWithRules(t, upstream(), evaluator)

		run(t, fixture)

		if len(fixture.recorder.failures) != 1 {
			t.Fatalf("failures = %v", fixture.recorder.failures)
		}
		failure := fixture.recorder.failures[0]
		if failure.RuntimeKind() != runtimecore.FailureQuotaExhausted {
			t.Fatalf("kind = %q, want quota_exhausted", failure.RuntimeKind())
		}
		if failure.BlockDirective().Scope() != runtimecore.BlockScopeAccount {
			t.Fatalf("scope = %q, want account", failure.BlockDirective().Scope())
		}
	})

	t.Run("未接入规则", func(t *testing.T) {
		fixture := newAdapterCoordinatorFixture(t, upstream())

		run(t, fixture)

		if len(fixture.recorder.failures) != 1 {
			t.Fatalf("failures = %v", fixture.recorder.failures)
		}
		if kind := fixture.recorder.failures[0].RuntimeKind(); kind != runtimecore.FailurePermissionDenied {
			t.Fatalf("kind = %q, want permission_denied", kind)
		}
	})

	t.Run("正文不匹配", func(t *testing.T) {
		probe := newAdapterCoordinatorFixture(t, upstream())
		evaluator, err := testsupportrules.NewEvaluator(
			"codex",
			probe.accountRef,
			rulesJSON("never_present_marker"),
		)
		if err != nil {
			t.Fatalf("NewEvaluator() error = %v", err)
		}
		fixture := newAdapterCoordinatorFixtureWithRules(t, upstream(), evaluator)

		run(t, fixture)

		if len(fixture.recorder.failures) != 1 {
			t.Fatalf("failures = %v", fixture.recorder.failures)
		}
		if kind := fixture.recorder.failures[0].RuntimeKind(); kind != runtimecore.FailurePermissionDenied {
			t.Fatalf("kind = %q, want permission_denied", kind)
		}
	})
}

// TestAccountRulesMatchAdapterStreamFailureEnvelope 锁定流内失败事件的规则优先级。
func TestAccountRulesMatchAdapterStreamFailureEnvelope(t *testing.T) {
	t.Parallel()

	upstream := func() *recordingHTTPClient {
		return &recordingHTTPClient{
			response: httpResponse(
				http.StatusOK,
				"text/event-stream",
				"data: {\"type\":\"response.failed\",\"error\":{\"code\":\"custom_denied\",\"message\":\"denied by account rule\"}}\n\n",
			),
		}
	}
	probe := newAdapterCoordinatorFixture(t, upstream())
	evaluator, err := testsupportrules.NewEvaluator(
		"codex",
		probe.accountRef,
		testsupportrules.SingleRuleJSON(
			"账号自定账单阻塞",
			"billing_blocked",
			nil,
			"body",
			"contains",
			"custom_denied",
		),
	)
	if err != nil {
		t.Fatalf("NewEvaluator() error = %v", err)
	}
	fixture := newAdapterCoordinatorFixtureWithRules(t, upstream(), evaluator)

	if err := fixture.coordinator.Execute(
		t.Context(),
		newAdapterTextRequest(t, true),
		func(inference.StreamEvent) error { return nil },
	); err != nil {
		t.Fatalf("Coordinator.Execute() error = %v", err)
	}
	if len(fixture.recorder.failures) != 1 {
		t.Fatalf("failures = %v", fixture.recorder.failures)
	}
	if kind := fixture.recorder.failures[0].RuntimeKind(); kind != runtimecore.FailureBillingBlocked {
		t.Fatalf("kind = %q, want billing_blocked", kind)
	}
}
