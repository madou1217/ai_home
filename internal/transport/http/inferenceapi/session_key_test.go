package inferenceapi_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// TestRequestSessionKeyPrefersHeadersInNodeOrder 验证请求头优先且顺序与 Node 一致。
func TestRequestSessionKeyPrefersHeadersInNodeOrder(t *testing.T) {
	t.Parallel()

	headers := http.Header{}
	headers.Set("X-Session-Id", "header-session")
	headers.Set("X-Conversation-Id", "header-conversation")
	if got := inferenceapi.RequestSessionKey(headers, nil); got != "header-session" {
		t.Fatalf("RequestSessionKey() = %q, want header-session", got)
	}
	headers.Del("X-Session-Id")
	if got := inferenceapi.RequestSessionKey(headers, nil); got != "header-conversation" {
		t.Fatalf("RequestSessionKey() = %q, want header-conversation", got)
	}
}

// TestRequestSessionKeyReadsNodeBodyCandidates 验证请求体候选路径与嵌套读取。
func TestRequestSessionKeyReadsNodeBodyCandidates(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		body string
		want string
	}{
		{name: "session_id", body: `{"session_id":"body-session"}`, want: "body-session"},
		{name: "nested session id", body: `{"session":{"id":"nested-session"}}`, want: "nested-session"},
		{name: "conversation id", body: `{"conversation_id":"conv"}`, want: "conv"},
		{name: "previous response id", body: `{"previous_response_id":"resp_1"}`, want: "resp_1"},
		{name: "metadata thread id", body: `{"metadata":{"thread_id":"meta-thread"}}`, want: "meta-thread"},
		{name: "numeric value", body: `{"session_id":12345}`, want: "12345"},
		{name: "blank trimmed", body: `{"session_id":"  spaced  "}`, want: "spaced"},
		{name: "invalid json", body: `{`, want: ""},
		{name: "no candidate", body: `{"model":"gpt"}`, want: ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			got := inferenceapi.RequestSessionKey(http.Header{}, []byte(testCase.body))
			if got != testCase.want {
				t.Fatalf("RequestSessionKey(%s) = %q, want %q", testCase.body, got, testCase.want)
			}
		})
	}
}

// TestRequestSessionKeyPrefersHeaderOverBody 验证请求头优先于请求体。
func TestRequestSessionKeyPrefersHeaderOverBody(t *testing.T) {
	t.Parallel()

	headers := http.Header{}
	headers.Set("X-Thread-Id", "header-thread")
	got := inferenceapi.RequestSessionKey(headers, []byte(`{"session_id":"body-session"}`))
	if got != "header-thread" {
		t.Fatalf("RequestSessionKey() = %q, want header-thread", got)
	}
}

// TestRequestSessionKeyHashesOversizedToken 验证超长标识被 sha256 归一化。
func TestRequestSessionKeyHashesOversizedToken(t *testing.T) {
	t.Parallel()

	oversized := strings.Repeat("x", 200)
	headers := http.Header{}
	headers.Set("X-Session-Id", oversized)
	sum := sha256.Sum256([]byte(oversized))
	want := "sha256:" + hex.EncodeToString(sum[:])
	if got := inferenceapi.RequestSessionKey(headers, nil); got != want {
		t.Fatalf("RequestSessionKey(oversized) = %q, want %q", got, want)
	}
	// 128 字符及以内原样保留。
	bounded := strings.Repeat("y", 128)
	headers.Set("X-Session-Id", bounded)
	if got := inferenceapi.RequestSessionKey(headers, nil); got != bounded {
		t.Fatalf("RequestSessionKey(128) = %q, want unchanged", got)
	}
}

// TestContextWithRequestSessionKeyInjectsAndReadsBack 验证注入的会话键可回读。
func TestContextWithRequestSessionKeyInjectsAndReadsBack(t *testing.T) {
	t.Parallel()

	headers := http.Header{}
	headers.Set("X-Session-Id", "ctx-session")
	ctx := inferenceapi.ContextWithRequestSessionKey(
		context.Background(),
		headers,
		nil,
	)
	if got := inferencegateway.RequestSessionKey(ctx); got != "ctx-session" {
		t.Fatalf("RequestSessionKey(ctx) = %q, want ctx-session", got)
	}
	// 无标识时原样返回，不注入空值。
	empty := inferenceapi.ContextWithRequestSessionKey(
		context.Background(),
		http.Header{},
		nil,
	)
	if got := inferencegateway.RequestSessionKey(empty); got != "" {
		t.Fatalf("RequestSessionKey(empty ctx) = %q, want empty", got)
	}
}
