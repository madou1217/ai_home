package codexresponsesws_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	testsupportrules "github.com/madou1217/ai_home/internal/testsupport/upstreamrules"
)

// wsFixtureAccountRef 是 WS 夹具唯一账号的引用。
const wsFixtureAccountRef = "acct_0123456789abcdef0123"

// deniedHandshakeBody 是账号自定义规则要识别的上游握手失败正文。
const deniedHandshakeBody = `{"error":{"code":"custom_denied","message":"denied by account rule"}}`

// failingHandshakeUpstream 返回预设 403 握手失败，不建立 WS 连接。
func failingHandshakeUpstream(t *testing.T) *httptest.Server {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(response, deniedHandshakeBody)
	}))
	t.Cleanup(server.Close)
	return server
}

// newDialFailureHandler 装配返回指定规则端口的 WS Handler。
func newDialFailureHandler(
	t *testing.T,
	upstream string,
	recorder *attemptRecorder,
	marker string,
) *httptest.Server {
	t.Helper()

	var rules configured.Rules
	if marker != "" {
		evaluator, err := testsupportrules.NewEvaluator(
			"codex",
			wsFixtureAccountRef,
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
		rules = evaluator
	}
	handler := newTestHandlerWithRules(t, upstream, recorder, rules)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

// TestAccountRulesOverrideDialFailureClassification 锁定 WS 握手失败的规则优先级：
// 同一份 403 正文，命中账号规则时按规则映射的状态与作用域记账，
// 未接入规则时保持内置启发式。
func TestAccountRulesOverrideDialFailureClassification(t *testing.T) {
	t.Parallel()

	upstream := failingHandshakeUpstream(t)
	firstFrame := []byte(`{"type":"response.create","model":"gpt-5.6-sol","input":[]}`)

	t.Run("命中规则", func(t *testing.T) {
		recorder := &attemptRecorder{}
		server := newDialFailureHandler(t, upstream.URL, recorder, "custom_denied")
		client, _ := dialGateway(t, server.URL, nil)
		writeClientText(t, client, firstFrame)
		_, payload, _ := readClientMessage(t, client)
		client.CloseNow()

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
		// 规则只改变运行态记账，客户端仍收到上游的真实状态与稳定错误码。
		var envelope struct {
			Status int `json:"status"`
			Error  struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(payload, &envelope); err != nil {
			t.Fatalf("错误帧不可解析: %v (%s)", err, payload)
		}
		if envelope.Status != http.StatusForbidden || envelope.Error.Code != "quota_exhausted" {
			t.Fatalf("status=%d code=%q payload=%s", envelope.Status, envelope.Error.Code, payload)
		}
	})

	t.Run("未接入规则", func(t *testing.T) {
		recorder := &attemptRecorder{}
		server := newDialFailureHandler(t, upstream.URL, recorder, "")
		client, _ := dialGateway(t, server.URL, nil)
		writeClientText(t, client, firstFrame)
		_, _, _ = readClientMessage(t, client)
		client.CloseNow()

		if len(recorder.failures) != 1 {
			t.Fatalf("failures = %v", recorder.failures)
		}
		if kind := recorder.failures[0].RuntimeKind(); kind != runtimecore.FailurePermissionDenied {
			t.Fatalf("kind = %q, want permission_denied", kind)
		}
	})

	t.Run("正文不匹配", func(t *testing.T) {
		recorder := &attemptRecorder{}
		server := newDialFailureHandler(t, upstream.URL, recorder, "never_present_marker")
		client, _ := dialGateway(t, server.URL, nil)
		writeClientText(t, client, firstFrame)
		_, _, _ = readClientMessage(t, client)
		client.CloseNow()

		if len(recorder.failures) != 1 {
			t.Fatalf("failures = %v", recorder.failures)
		}
		if kind := recorder.failures[0].RuntimeKind(); kind != runtimecore.FailurePermissionDenied {
			t.Fatalf("kind = %q, want permission_denied", kind)
		}
	})
}
