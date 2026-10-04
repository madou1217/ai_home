package anthropicmessages

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// Claude Code 2.1.28x 每个会话的首个请求都带的形状（2026-10-05 本机抓包，只取键名与类型）。
const perTurnEffortRequest = `{
	"model":"claude-opus-5-5","max_tokens":4096,"stream":true,
	"output_config":{"effort":"medium"},
	"messages":[
		{"role":"user","content":[{"type":"text","text":"say ok"}]},
		{"role":"system","content":[{"type":"text","text":"context"}],"output_config":{"effort":"medium"}}
	]
}`

func TestRequestDecoderAcceptsPerTurnEffortOnMidConversationSystemMessages(t *testing.T) {
	t.Parallel()
	request, err := NewRequestDecoder().Decode([]byte(perTurnEffortRequest))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	messages := request.Messages()
	last := messages[len(messages)-1]
	if last.Role() != inference.RoleSystem || last.TurnEffort() != inference.ReasoningEffortMedium {
		t.Fatalf("last message role=%q turnEffort=%q", last.Role(), last.TurnEffort())
	}
	for _, message := range messages[:len(messages)-1] {
		if message.TurnEffort() != "" {
			t.Fatalf("turn effort leaked onto %q message", message.Role())
		}
	}
}

func TestRequestDecoderRejectsPerTurnConfigItCannotCarry(t *testing.T) {
	t.Parallel()
	for name, testCase := range map[string]struct {
		message string
		field   string
	}{
		"unconfirmed timing": {`{"role":"system","content":"t","output_config":{"timing":{"type":"now","now":"x"}}}`, "messages[1].output_config.timing(unknown)"},
		"user role":          {`{"role":"user","content":"t","output_config":{"effort":"high"}}`, "messages[1].output_config"},
		"unknown effort":     {`{"role":"system","content":"t","output_config":{"effort":"turbo"}}`, "messages[1].output_config.effort"},
		"effort none":        {`{"role":"system","content":"t","output_config":{"effort":"none"}}`, "messages[1].output_config.effort"},
		"empty config":       {`{"role":"system","content":"t","output_config":{}}`, "messages[1].output_config"},
	} {
		t.Run(name, func(t *testing.T) {
			body := `{"model":"claude-opus-5-5","max_tokens":16,"messages":[{"role":"user","content":"hi"},` + testCase.message + `]}`
			_, err := NewRequestDecoder().Decode([]byte(body))
			if err == nil || !strings.Contains(err.Error(), testCase.field) {
				t.Fatalf("Decode() error = %v, want field %s", err, testCase.field)
			}
		})
	}
}
