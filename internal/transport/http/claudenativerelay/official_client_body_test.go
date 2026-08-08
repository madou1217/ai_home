package claudenativerelay

import (
	"encoding/json"
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
