package messages

import (
	"encoding/json"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
)

// Claude Code 的按轮 effort 经 Canonical 解码、Claude 编码后仍在原来的 system 消息上，
// 并带上 Claude Code 同样声明的 beta。
func TestPerTurnEffortSurvivesTheCanonicalRoundTrip(t *testing.T) {
	t.Parallel()
	request, err := anthropicmessages.NewRequestDecoder().Decode([]byte(`{
		"model":"claude-opus-5-5","max_tokens":4096,
		"messages":[
			{"role":"user","content":[{"type":"text","text":"say ok"}]},
			{"role":"system","content":[{"type":"text","text":"context"}],"output_config":{"effort":"medium"}},
			{"role":"system","content":[{"type":"text","text":"later"}]},
			{"role":"user","content":"next"},
			{"role":"system","content":"bumped","output_config":{"effort":"xhigh"}}
		]
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-opus-5-5", false)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	for _, beta := range []string{betaPerTurnControl, betaEffort, betaClaudeCode} {
		if !containsBeta(encoded.betaHeaders, beta) {
			t.Fatalf("missing beta %s in %v", beta, encoded.betaHeaders)
		}
	}
	var payload struct {
		Messages []messageDTO `json:"messages"`
	}
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Messages) != 5 {
		t.Fatalf("system messages with a turn effort must not merge: %#v", payload.Messages)
	}
	first, plain, bumped := payload.Messages[1], payload.Messages[2], payload.Messages[4]
	if first.Role != "system" || first.OutputConfig == nil || first.OutputConfig.Effort != "medium" || first.Content[0].Text != "context" {
		t.Fatalf("first turn = %#v", first)
	}
	if plain.OutputConfig != nil {
		t.Fatalf("plain system message gained an output_config: %#v", plain)
	}
	if bumped.OutputConfig == nil || bumped.OutputConfig.Effort != "max" {
		t.Fatalf("xhigh must map to Anthropic max: %#v", bumped.OutputConfig)
	}
	var raw struct {
		Messages []map[string]json.RawMessage `json:"messages"`
	}
	_ = json.Unmarshal(encoded.payload, &raw)
	if _, present := raw.Messages[0]["output_config"]; present {
		t.Fatal("user messages must not carry output_config on the wire")
	}
}

func TestRequestsWithoutTurnEffortDoNotDeclarePerTurnControl(t *testing.T) {
	t.Parallel()
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolAnthropicMessages,
		Model:          "claude-sonnet-5",
		Messages: []inference.Message{
			mustMessage(t, inference.RoleUser, mustText(t, "first")),
			mustMessage(t, inference.RoleSystem, mustText(t, "mid")),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := encodeRequest(request, "claude-sonnet-5", false)
	if err != nil {
		t.Fatal(err)
	}
	if containsBeta(encoded.betaHeaders, betaPerTurnControl) {
		t.Fatalf("per-turn-control declared without a turn effort: %v", encoded.betaHeaders)
	}
}
