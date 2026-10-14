package codexresponseshttp

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	testsupportrules "github.com/madou1217/ai_home/internal/testsupport/upstreamrules"
)

// forbiddenBody 是账号自定义规则要识别的上游正文。
const forbiddenBody = `{"error":{"code":"custom_policy_denied","message":"denied by account rule"}}`

// rulesFixture 在标准夹具上注入真实规则求值端口（投影存储 → 求值器）。
func rulesFixture(t *testing.T, upstream string, rulesJSON string) (*Handler, *testRecorder) {
	t.Helper()

	handler, recorder, source := fixture(t, upstream, 1)
	if len(source.selections) != 1 {
		t.Fatalf("selections = %d, want 1", len(source.selections))
	}
	evaluator, err := testsupportrules.NewEvaluator(
		"codex",
		string(source.selections[0].AccountRef),
		rulesJSON,
	)
	if err != nil {
		t.Fatalf("NewEvaluator() error = %v", err)
	}
	handler.Rules = evaluator
	return handler, recorder
}

// TestAccountRulesOverrideBuiltinClassification 锁定分类点的规则优先级：
// 同一份 403 正文，命中账号规则时按规则映射的状态与作用域记账，
// 未注入规则时保持内置启发式（permission_denied / 账号+模型作用域）。
func TestAccountRulesOverrideBuiltinClassification(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(response, forbiddenBody)
	}))
	defer upstream.Close()
	rulesJSON := testsupportrules.SingleRuleJSON(
		"账号自定权限拒绝",
		"quota_exhausted",
		[]int{http.StatusForbidden},
		"body",
		"contains",
		"custom_policy_denied",
	)

	t.Run("命中规则", func(t *testing.T) {
		handler, recorder := rulesFixture(t, upstream.URL, rulesJSON)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native"}`)))
		if len(recorder.failures) != 1 {
			t.Fatalf("failures = %v", recorder.failures)
		}
		failure := recorder.failures[0]
		if failure.RuntimeKind() != runtimecore.FailureQuotaExhausted {
			t.Fatalf("kind = %q, want quota_exhausted", failure.RuntimeKind())
		}
		if failure.BlockDirective().Scope() != runtimecore.BlockScopeAccount {
			t.Fatalf("scope = %q, want account", failure.BlockDirective().Scope())
		}
		// 规则只改变运行态记账，不改写交付给客户端的真实上游响应。
		if response.Code != http.StatusForbidden || response.Body.String() != forbiddenBody {
			t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
		}
	})

	t.Run("未接入规则", func(t *testing.T) {
		handler, recorder, _ := fixture(t, upstream.URL, 1)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native"}`)))
		if len(recorder.failures) != 1 {
			t.Fatalf("failures = %v", recorder.failures)
		}
		if kind := recorder.failures[0].RuntimeKind(); kind != runtimecore.FailurePermissionDenied {
			t.Fatalf("kind = %q, want permission_denied", kind)
		}
	})

	t.Run("账号不匹配", func(t *testing.T) {
		handler, recorder, _ := fixture(t, upstream.URL, 1)
		evaluator, err := testsupportrules.NewEvaluator(
			"codex",
			"acct_000000000000000000ff",
			rulesJSON,
		)
		if err != nil {
			t.Fatalf("NewEvaluator() error = %v", err)
		}
		handler.Rules = evaluator
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native"}`)))
		if len(recorder.failures) != 1 {
			t.Fatalf("failures = %v", recorder.failures)
		}
		// 规则属于另一个账号时不得生效：投影按 accountRef 隔离。
		if kind := recorder.failures[0].RuntimeKind(); kind != runtimecore.FailurePermissionDenied {
			t.Fatalf("kind = %q, want permission_denied", kind)
		}
	})
}
