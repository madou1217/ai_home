package claudenativerelay

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	testsupportrules "github.com/madou1217/ai_home/internal/testsupport/upstreamrules"
)

// deniedRelayBody 是账号自定义规则要识别的上游正文。
const deniedRelayBody = `{"type":"error","error":{"type":"custom_denied","message":"denied by account rule"}}`

// newRelayHandlerWithRules 在标准 Relay 夹具上注入真实规则求值端口。
func newRelayHandlerWithRules(
	t *testing.T,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	client HTTPClient,
	recorder *relayAttemptRecorder,
	rules configured.Rules,
) *Handler {
	t.Helper()

	authorizer, err := NewScopedTokenAuthorizer(relayTokenResolver{
		token:      testRelayToken,
		accountRef: accountRef,
	})
	if err != nil {
		t.Fatalf("NewScopedTokenAuthorizer() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer: authorizer,
		Credentials: &relayCredentialResolver{
			accountRef: accountRef,
			credential: credential,
		},
		Client:         client,
		Attempts:       recorder,
		ModelRefreshes: &relayModelRefreshScheduler{},
		Clock:          relayTestClock,
		Rules:          rules,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

// forbiddenRelayClient 返回预设 403 正文，不访问网络。
func forbiddenRelayClient() HTTPClient {
	return &relayFailureClient{
		status: http.StatusText(http.StatusForbidden),
		code:   http.StatusForbidden,
		body:   deniedRelayBody,
		header: http.Header{"Content-Type": []string{"application/json"}},
	}
}

// quotaRuleJSON 是命中 403 自定义正文的账号规则。
func quotaRuleJSON(t *testing.T, marker string) string {
	t.Helper()

	return testsupportrules.SingleRuleJSON(
		"账号自定额度耗尽",
		"quota_exhausted",
		[]int{http.StatusForbidden},
		"body",
		"contains",
		marker,
	)
}

// TestAccountRulesOverrideRelayClassification 锁定 Native Relay 的规则优先级：
// 同一份 403 正文，命中账号规则时按规则映射的状态与作用域记账，
// 未接入规则时保持内置启发式，且交付给客户端的字节始终与上游一致。
func TestAccountRulesOverrideRelayClassification(t *testing.T) {
	accountRef, credential := newRelayOAuthCredential(t)

	t.Run("命中规则", func(t *testing.T) {
		evaluator, err := testsupportrules.NewEvaluator(
			"claude",
			accountRef.String(),
			quotaRuleJSON(t, "custom_denied"),
		)
		if err != nil {
			t.Fatalf("NewEvaluator() error = %v", err)
		}
		recorder := &relayAttemptRecorder{}
		handler := newRelayHandlerWithRules(t, accountRef, credential, forbiddenRelayClient(), recorder, evaluator)
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, newNativeRelayRequest(t, `{"model":"claude-opus-5"}`))

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
		// 规则求值需要的预读不得改变透传字节。
		if response.Code != http.StatusForbidden || response.Body.String() != deniedRelayBody {
			t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
		}
	})

	t.Run("未接入规则", func(t *testing.T) {
		recorder := &relayAttemptRecorder{}
		handler := newRelayHandlerWithRules(t, accountRef, credential, forbiddenRelayClient(), recorder, nil)
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, newNativeRelayRequest(t, `{"model":"claude-opus-5"}`))

		if len(recorder.failures) != 1 {
			t.Fatalf("failures = %v", recorder.failures)
		}
		if kind := recorder.failures[0].RuntimeKind(); kind != runtimecore.FailurePermissionDenied {
			t.Fatalf("kind = %q, want permission_denied", kind)
		}
		if response.Code != http.StatusForbidden || response.Body.String() != deniedRelayBody {
			t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
		}
	})

	t.Run("正文不匹配", func(t *testing.T) {
		evaluator, err := testsupportrules.NewEvaluator(
			"claude",
			accountRef.String(),
			quotaRuleJSON(t, "never_present_marker"),
		)
		if err != nil {
			t.Fatalf("NewEvaluator() error = %v", err)
		}
		recorder := &relayAttemptRecorder{}
		handler := newRelayHandlerWithRules(t, accountRef, credential, forbiddenRelayClient(), recorder, evaluator)
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, newNativeRelayRequest(t, `{"model":"claude-opus-5"}`))

		if len(recorder.failures) != 1 {
			t.Fatalf("failures = %v", recorder.failures)
		}
		if kind := recorder.failures[0].RuntimeKind(); kind != runtimecore.FailurePermissionDenied {
			t.Fatalf("kind = %q, want permission_denied", kind)
		}
	})
}

// TestAccountRulesMatchStreamFailureEnvelope 锁定流内失败事件的规则优先级：
// SSE 的 error 事件正文同样要经过账号规则，而不是只看内置观察器。
func TestAccountRulesMatchStreamFailureEnvelope(t *testing.T) {
	accountRef, credential := newRelayOAuthCredential(t)
	stream := strings.Join([]string{
		"event: error",
		`data: {"type":"error","error":{"type":"custom_denied","message":"denied by account rule"}}`,
		"",
		"",
	}, "\n")
	evaluator, err := testsupportrules.NewEvaluator(
		"claude",
		accountRef.String(),
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
	recorder := &relayAttemptRecorder{}
	handler := newRelayHandlerWithRules(
		t,
		accountRef,
		credential,
		&relayFailureClient{
			status: http.StatusText(http.StatusOK),
			code:   http.StatusOK,
			body:   stream,
			header: http.Header{"Content-Type": []string{"text/event-stream"}},
		},
		recorder,
		evaluator,
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, newNativeRelayRequest(t, `{"model":"claude-opus-5","stream":true}`))

	if len(recorder.failures) != 1 {
		t.Fatalf("failures = %v", recorder.failures)
	}
	if kind := recorder.failures[0].RuntimeKind(); kind != runtimecore.FailureBillingBlocked {
		t.Fatalf("kind = %q, want billing_blocked", kind)
	}
	if body, _ := io.ReadAll(strings.NewReader(response.Body.String())); string(body) != stream {
		t.Fatalf("body = %q", string(body))
	}
}
