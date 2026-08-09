package claudenativerelay

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// TestRealClaudeCodeBodyStaysByteIdentical 锁定透传语义不被破坏。
//
// Relay 的价值就是逐字节转发官方客户端已经证明可用的请求；一旦对已带身份的
// 正文做序列化往返，字段顺序与数值表示都可能改变，等于把「透传」偷换成「重建」。
func TestRealClaudeCodeBodyStaysByteIdentical(t *testing.T) {
	t.Parallel()

	body := []byte(`{"model":"claude-opus-4-6","system":[{"type":"text",` +
		`"text":"You are Claude Code, Anthropic's official CLI for Claude.` +
		`\n\nCWD: /tmp"}],"messages":[]}`)
	if got := ensureOfficialIdentityBody(body); !bodyUnchanged(body, got) {
		t.Fatalf("已带身份的正文被改写:\n原始 %s\n结果 %s", body, got)
	}
}

// TestStringSystemAlsoRecognized 验证 system 为纯字符串时同样识别身份。
func TestStringSystemAlsoRecognized(t *testing.T) {
	t.Parallel()

	body := []byte(`{"model":"claude-opus-4-6","system":` +
		`"You are Claude Code, Anthropic's official CLI for Claude."}`)
	if got := ensureOfficialIdentityBody(body); !bodyUnchanged(body, got) {
		t.Fatalf("字符串形态的身份未被识别: %s", got)
	}
}

// TestMissingIdentityGetsPrepended 验证缺失时补齐且客户端内容原样保留在后。
func TestMissingIdentityGetsPrepended(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name string
		body string
		want []string
	}{
		{
			name: "无 system 字段",
			body: `{"model":"claude-opus-4-6","messages":[]}`,
			want: []string{officialSystemIdentity},
		},
		{
			name: "字符串 system",
			body: `{"model":"claude-opus-4-6","system":"你是验收助手。"}`,
			want: []string{officialSystemIdentity, "你是验收助手。"},
		},
		{
			name: "数组 system",
			body: `{"model":"claude-opus-4-6","system":[{"type":"text","text":"甲"},` +
				`{"type":"text","text":"乙"}]}`,
			want: []string{officialSystemIdentity, "甲", "乙"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			rewritten := ensureOfficialIdentityBody([]byte(test.body))
			if bodyUnchanged([]byte(test.body), rewritten) {
				t.Fatalf("缺身份的正文未被补齐: %s", rewritten)
			}
			var envelope struct {
				Model  string           `json:"model"`
				System []systemBlockDTO `json:"system"`
			}
			if err := json.Unmarshal(rewritten, &envelope); err != nil {
				t.Fatalf("Unmarshal() error = %v body = %s", err, rewritten)
			}
			if envelope.Model != "claude-opus-4-6" {
				t.Fatalf("model 被破坏: %s", rewritten)
			}
			if len(envelope.System) != len(test.want) {
				t.Fatalf("system 块数 = %d, want %d: %s",
					len(envelope.System), len(test.want), rewritten)
			}
			for index, want := range test.want {
				if envelope.System[index].Text != want {
					t.Fatalf("system[%d] = %q, want %q",
						index, envelope.System[index].Text, want)
				}
			}
		})
	}
}

// TestUnparseableBodyStaysUntouched 验证无法识别的正文一律不改写。
func TestUnparseableBodyStaysUntouched(t *testing.T) {
	t.Parallel()

	for _, body := range []string{
		"not-json",
		`[1,2,3]`,
		`{"model":"claude-opus-4-6","system":42}`,
	} {
		raw := []byte(body)
		if got := ensureOfficialIdentityBody(raw); !bodyUnchanged(raw, got) {
			t.Fatalf("无法识别的正文被改写: %s -> %s", body, got)
		}
	}
}

// TestOfficialClientHeadersCompleteTheContract 锁定普通客户端的外层标识补齐。
//
// 三项缺一都会让整条透传通道对普通客户端不可用：缺 anthropic-version 上游直接
// 400；缺 claude-code beta 与 x-app/User-Agent 会被判为非订阅调用而限流。
func TestOfficialClientHeadersCompleteTheContract(t *testing.T) {
	t.Parallel()

	header := make(http.Header)
	header.Set("anthropic-beta", "oauth-2025-04-20")
	applyOfficialClientHeaders(header)

	if header.Get("anthropic-version") == "" {
		t.Fatal("缺 anthropic-version，上游必然 400")
	}
	if header.Get("x-app") != "cli" ||
		!strings.HasPrefix(header.Get("User-Agent"), "claude-cli/") {
		t.Fatalf("官方客户端标识缺失: %v", header)
	}
	// 必须并入同一行：多行时 Header.Get 只返回第一行，按单值读取的下游会漏掉。
	if values := header.Values("anthropic-beta"); len(values) != 1 ||
		!strings.Contains(values[0], "oauth-2025-04-20") ||
		!strings.Contains(values[0], officialClientBeta) {
		t.Fatalf("anthropic-beta 未并入单行: %v", header.Values("anthropic-beta"))
	}
}

// TestOfficialClientHeadersNeverOverrideClient 验证不覆盖客户端自报值。
//
// 真实 Claude Code 转发过来时自报版本比抓包快照更准确。
func TestOfficialClientHeadersNeverOverrideClient(t *testing.T) {
	t.Parallel()

	header := make(http.Header)
	header.Set("User-Agent", "claude-cli/9.9.9 (external, sdk-cli)")
	header.Set("anthropic-version", "2099-01-01")
	applyOfficialClientHeaders(header)

	if header.Get("User-Agent") != "claude-cli/9.9.9 (external, sdk-cli)" ||
		header.Get("anthropic-version") != "2099-01-01" {
		t.Fatalf("覆盖了客户端自报值: %v", header)
	}
}
