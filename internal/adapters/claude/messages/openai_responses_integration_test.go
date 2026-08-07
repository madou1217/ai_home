package messages

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
)

// TestResponsesReasoningRoundTripsToClaudeThinking 验证 Responses 用
// summary + encrypted_content 承载的 Claude thinking 可以无损回到原生 Messages。
func TestResponsesReasoningRoundTripsToClaudeThinking(t *testing.T) {
	t.Parallel()

	signature := testClaudeThinkingSignature()
	requestBody, err := json.Marshal(map[string]any{
		"model": "claude-sonnet-4-6",
		"input": []map[string]any{
			{
				"type":              "reasoning",
				"summary":           []map[string]string{{"type": "summary_text", "text": "internal reasoning"}},
				"encrypted_content": signature,
			},
			{
				"type": "message",
				"role": "assistant",
				"content": []map[string]string{{
					"type": "output_text",
					"text": "visible answer",
				}},
			},
			{
				"type": "message",
				"role": "user",
				"content": []map[string]string{{
					"type": "input_text",
					"text": "continue",
				}},
			},
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	adapter, err := openairesponses.NewAdapter(time.Now)
	if err != nil {
		t.Fatalf("openairesponses.NewAdapter() error = %v", err)
	}
	request, err := adapter.Decode(requestBody)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-sonnet-4-6", false)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}

	var payload struct {
		Messages []struct {
			Role    string `json:"role"`
			Content []struct {
				Type      string `json:"type"`
				Thinking  string `json:"thinking"`
				Signature string `json:"signature"`
				Text      string `json:"text"`
			} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal(payload) error = %v", err)
	}
	if len(payload.Messages) != 2 ||
		payload.Messages[0].Role != "assistant" ||
		len(payload.Messages[0].Content) != 2 ||
		payload.Messages[0].Content[0].Type != "thinking" ||
		payload.Messages[0].Content[0].Thinking != "internal reasoning" ||
		payload.Messages[0].Content[0].Signature != signature ||
		payload.Messages[0].Content[1].Type != "text" ||
		payload.Messages[0].Content[1].Text != "visible answer" ||
		payload.Messages[1].Role != "user" {
		t.Fatalf("Messages reasoning round-trip = %#v payload=%s", payload.Messages, encoded.payload)
	}
}

// TestClaudeReasoningProjectionDoesNotDependOnClientProtocol 验证上游 Adapter
// 仅依据 Canonical 内容和 Claude signature 投影，不反向读取客户端协议。
func TestClaudeReasoningProjectionDoesNotDependOnClientProtocol(t *testing.T) {
	t.Parallel()

	signature := testClaudeThinkingSignature()
	summary, err := inference.NewReasoningSummaryContent("先分析历史")
	if err != nil {
		t.Fatalf("NewReasoningSummaryContent() error = %v", err)
	}
	encrypted, err := inference.NewEncryptedReasoningContent(signature)
	if err != nil {
		t.Fatalf("NewEncryptedReasoningContent() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIChatCompletions,
		Model:          "claude-opus-5",
		Messages: []inference.Message{mustMessage(
			t,
			inference.RoleAssistant,
			summary,
			encrypted,
			mustText(t, "历史回答"),
		)},
		MaxOutputTokens: 1024,
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-opus-5", false)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	var payload struct {
		Messages []struct {
			Content []struct {
				Type      string  `json:"type"`
				Thinking  *string `json:"thinking"`
				Signature string  `json:"signature"`
				Text      string  `json:"text"`
			} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if len(payload.Messages) != 1 || len(payload.Messages[0].Content) != 2 {
		t.Fatalf("messages = %#v", payload.Messages)
	}
	thinking := payload.Messages[0].Content[0]
	if thinking.Type != "thinking" ||
		thinking.Thinking == nil ||
		*thinking.Thinking != "先分析历史" ||
		thinking.Signature != signature ||
		payload.Messages[0].Content[1].Text != "历史回答" {
		t.Fatalf("projected content = %#v", payload.Messages[0].Content)
	}
}

// TestResponsesReasoningDropsIncompatibleSignature 验证 Codex/GPT opaque
// continuity 不会进入 Claude thinking，同时保留后续可见 assistant 历史。
func TestResponsesReasoningDropsIncompatibleSignature(t *testing.T) {
	t.Parallel()

	requestBody := []byte(`{
		"model":"claude-sonnet-4-6",
		"input":[
			{"type":"reasoning","summary":[{"type":"summary_text","text":"codex reasoning"}],"encrypted_content":"gAAAAABopenai-encrypted-content"},
			{"type":"message","role":"assistant","content":[{"type":"output_text","text":"visible answer"}]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}
		]
	}`)
	adapter, err := openairesponses.NewAdapter(time.Now)
	if err != nil {
		t.Fatalf("openairesponses.NewAdapter() error = %v", err)
	}
	request, err := adapter.Decode(requestBody)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-sonnet-4-6", false)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}

	var payload struct {
		Messages []struct {
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal(payload) error = %v", err)
	}
	if len(payload.Messages) != 2 ||
		payload.Messages[0].Role != "assistant" ||
		len(payload.Messages[0].Content) != 1 ||
		payload.Messages[0].Content[0].Type != "text" ||
		payload.Messages[0].Content[0].Text != "visible answer" ||
		payload.Messages[1].Role != "user" {
		t.Fatalf("incompatible reasoning projection = %#v payload=%s", payload.Messages, encoded.payload)
	}
}

// TestResponsesSignatureOnlyReasoningKeepsEmptyThinking 验证没有公开摘要时
// 仍保留 Claude 原生 signature，并显式发送空 thinking 字段。
func TestResponsesSignatureOnlyReasoningKeepsEmptyThinking(t *testing.T) {
	t.Parallel()

	signature := testClaudeThinkingSignature()
	requestBody, err := json.Marshal(map[string]any{
		"model": "claude-sonnet-4-6",
		"input": []map[string]any{
			{
				"type":              "reasoning",
				"summary":           []any{},
				"encrypted_content": signature,
			},
			{
				"type": "message",
				"role": "user",
				"content": []map[string]string{{
					"type": "input_text",
					"text": "continue",
				}},
			},
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	adapter, err := openairesponses.NewAdapter(time.Now)
	if err != nil {
		t.Fatalf("openairesponses.NewAdapter() error = %v", err)
	}
	request, err := adapter.Decode(requestBody)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-sonnet-4-6", false)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal(payload) error = %v", err)
	}
	messages := payload["messages"].([]any)
	thinking := messages[0].(map[string]any)["content"].([]any)[0].(map[string]any)
	value, exists := thinking["thinking"]
	if thinking["type"] != "thinking" ||
		thinking["signature"] != signature ||
		!exists ||
		value != "" {
		t.Fatalf("signature-only thinking = %#v payload=%s", thinking, encoded.payload)
	}
}

// TestClaudeThinkingSignatureRendersAsResponsesEncryptedContent 验证 Claude
// thinking 签名经 Canonical 事件流进入 Responses 后，只在终态
// reasoning item 中作为 encrypted_content 返回，不伪造签名增量事件。
func TestClaudeThinkingSignatureRendersAsResponsesEncryptedContent(t *testing.T) {
	t.Parallel()

	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          "claude-opus-5",
		Messages: []inference.Message{
			mustMessage(t, inference.RoleUser, mustText(t, "reply exactly")),
		},
		Stream:                    true,
		IncludeEncryptedReasoning: true,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	renderer := openairesponses.NewStreamRenderer(
		request,
		time.Unix(1_700_000_000, 0).UTC(),
	)
	var rendered []clientprotocol.RenderedEvent
	decoder, err := newResponseDecoder(
		"claude-opus-5",
		func(event inference.StreamEvent) error {
			frames, renderErr := renderer.Render(event)
			if renderErr != nil {
				return renderErr
			}
			rendered = append(rendered, frames...)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}

	const signature = "claude_signature_exact_1"
	upstreamFrames := []string{
		`{"type":"message_start","message":{"id":"msg_reasoning","type":"message","role":"assistant","model":"claude-opus-5","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"analyzed"}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"` + signature + `"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}`,
		`{"type":"message_stop"}`,
	}
	for index, frame := range upstreamFrames {
		if err := decoder.Apply("", []byte(frame)); err != nil {
			t.Fatalf("decoder.Apply(frame=%d) error = %v", index, err)
		}
	}

	assertReasoningEncryptedContent(t, rendered, "response.output_item.done", signature)
	assertReasoningEncryptedContent(t, rendered, "response.completed", signature)
	for _, frame := range rendered {
		if frame.Name() == "response.reasoning_signature.delta" {
			t.Fatalf("unexpected fabricated signature event: %s", frame.Data())
		}
	}
}

// assertReasoningEncryptedContent 在指定 Responses 事件中查找 reasoning
// 输出项，并校验 Claude 签名被原样保留。
func assertReasoningEncryptedContent(
	t *testing.T,
	frames []clientprotocol.RenderedEvent,
	eventName string,
	want string,
) {
	t.Helper()
	for _, frame := range frames {
		if frame.Name() != eventName {
			continue
		}
		var payload struct {
			Item struct {
				Type             string `json:"type"`
				EncryptedContent string `json:"encrypted_content"`
			} `json:"item"`
			Response struct {
				Output []struct {
					Type             string `json:"type"`
					EncryptedContent string `json:"encrypted_content"`
				} `json:"output"`
			} `json:"response"`
		}
		if err := json.Unmarshal(frame.Data(), &payload); err != nil {
			t.Fatalf("json.Unmarshal(%s) error = %v", eventName, err)
		}
		if payload.Item.Type == "reasoning" && payload.Item.EncryptedContent == want {
			return
		}
		for _, item := range payload.Response.Output {
			if item.Type == "reasoning" && item.EncryptedContent == want {
				return
			}
		}
	}
	t.Fatalf("%s missing reasoning encrypted_content %q", eventName, want)
}

// testClaudeThinkingSignature 创建与 CPA 源码测试相同结构的 Claude E-form 签名。
func testClaudeThinkingSignature() string {
	channel := appendTestProtoVarint(nil, 1, 12)
	channel = appendTestProtoVarint(channel, 2, 2)
	channel = appendTestProtoBytes(channel, 6, []byte("claude-sonnet-4-6"))
	container := appendTestProtoBytes(nil, 1, channel)
	payload := appendTestProtoBytes(nil, 2, container)
	payload = appendTestProtoVarint(payload, 3, 1)
	return base64.StdEncoding.EncodeToString(payload)
}

// appendTestProtoVarint 追加测试签名所需的 protobuf varint 字段。
func appendTestProtoVarint(output []byte, field uint64, value uint64) []byte {
	output = binary.AppendUvarint(output, field<<3)
	return binary.AppendUvarint(output, value)
}

// appendTestProtoBytes 追加测试签名所需的 protobuf bytes 字段。
func appendTestProtoBytes(output []byte, field uint64, value []byte) []byte {
	output = binary.AppendUvarint(output, field<<3|2)
	output = binary.AppendUvarint(output, uint64(len(value)))
	return append(output, value...)
}
