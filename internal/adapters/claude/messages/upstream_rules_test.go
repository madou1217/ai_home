package messages

import (
	"net/http"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/inference"
	testsupportrules "github.com/madou1217/ai_home/internal/testsupport/upstreamrules"
)

// deniedMessagesBody 是账号自定义规则要识别的上游正文。
const deniedMessagesBody = `{"type":"error","error":{"type":"custom_denied","message":"denied by account rule"}}`

// rulesFixtureFor 在标准 Claude 夹具上注入真实规则求值端口。
func rulesFixtureFor(
	t *testing.T,
	client HTTPClient,
	marker string,
) claudeAdapterFixture {
	t.Helper()

	probe := newClaudeAdapterFixture(t, client)
	evaluator, err := testsupportrules.NewEvaluator(
		"claude",
		probe.accountRef,
		testsupportrules.SingleRuleJSON(
			"账号自定额度耗尽",
			"quota_exhausted",
			[]int{http.StatusForbidden},
			"body",
			"contains",
			marker,
		),
	)
	if err != nil {
		t.Fatalf("NewEvaluator() error = %v", err)
	}
	credential, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey:  "synthetic-claude-api-key",
		BaseURL: "https://upstream.example",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	return newClaudeAdapterFixtureWithOptions(
		t,
		client,
		credential,
		claudeAdapterFixtureOptions{rules: evaluator},
	)
}

// forbiddenMessagesClient 返回预设 403 正文，不访问网络。
func forbiddenMessagesClient() *claudeRecordingHTTPClient {
	return &claudeRecordingHTTPClient{
		response: claudeHTTPResponse(http.StatusForbidden, "application/json", deniedMessagesBody),
	}
}

// TestAccountRulesOverrideMessagesFailureClassification 锁定 Canonical Messages
// Adapter 的规则优先级：同一份 403 正文，命中账号规则时按规则映射的状态与作用域
// 记账，未接入规则时保持内置启发式。
func TestAccountRulesOverrideMessagesFailureClassification(t *testing.T) {
	t.Parallel()

	t.Run("命中规则", func(t *testing.T) {
		fixture := rulesFixtureFor(t, forbiddenMessagesClient(), "custom_denied")

		if err := fixture.coordinator.Execute(
			t.Context(),
			newClaudeAdapterRequest(t, false),
			func(inference.StreamEvent) error { return nil },
		); err != nil {
			t.Fatalf("Coordinator.Execute() error = %v", err)
		}
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
		fixture := newClaudeAdapterFixture(t, forbiddenMessagesClient())

		if err := fixture.coordinator.Execute(
			t.Context(),
			newClaudeAdapterRequest(t, false),
			func(inference.StreamEvent) error { return nil },
		); err != nil {
			t.Fatalf("Coordinator.Execute() error = %v", err)
		}
		if len(fixture.recorder.failures) != 1 {
			t.Fatalf("failures = %v", fixture.recorder.failures)
		}
		if kind := fixture.recorder.failures[0].RuntimeKind(); kind != runtimecore.FailurePermissionDenied {
			t.Fatalf("kind = %q, want permission_denied", kind)
		}
	})

	t.Run("正文不匹配", func(t *testing.T) {
		fixture := rulesFixtureFor(t, forbiddenMessagesClient(), "never_present_marker")

		if err := fixture.coordinator.Execute(
			t.Context(),
			newClaudeAdapterRequest(t, false),
			func(inference.StreamEvent) error { return nil },
		); err != nil {
			t.Fatalf("Coordinator.Execute() error = %v", err)
		}
		if len(fixture.recorder.failures) != 1 {
			t.Fatalf("failures = %v", fixture.recorder.failures)
		}
		if kind := fixture.recorder.failures[0].RuntimeKind(); kind != runtimecore.FailurePermissionDenied {
			t.Fatalf("kind = %q, want permission_denied", kind)
		}
	})
}

// TestAccountRulesMatchMessagesStreamFailureEnvelope 锁定流内失败事件的规则优先级。
func TestAccountRulesMatchMessagesStreamFailureEnvelope(t *testing.T) {
	t.Parallel()

	stream := "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"custom_denied\",\"message\":\"denied by account rule\"}}\n\n"
	probe := newClaudeAdapterFixture(
		t,
		&claudeRecordingHTTPClient{
			response: claudeHTTPResponse(http.StatusOK, "text/event-stream", stream),
		},
	)
	evaluator, err := testsupportrules.NewEvaluator(
		"claude",
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
	credential, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey:  "synthetic-claude-api-key",
		BaseURL: "https://upstream.example",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	fixture := newClaudeAdapterFixtureWithOptions(
		t,
		&claudeRecordingHTTPClient{
			response: claudeHTTPResponse(http.StatusOK, "text/event-stream", stream),
		},
		credential,
		claudeAdapterFixtureOptions{rules: evaluator},
	)

	if err := fixture.coordinator.Execute(
		t.Context(),
		newClaudeAdapterRequest(t, true),
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
