package responses

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
)

// TestEncodeRequestRoundTripsCodex0158ToolTurn 用 Codex CLI 0.158.0-alpha.2.1 对 gpt-6-astra
// 的真实第二轮请求验证：解码进 Canonical 再编码回上游后，与客户端原样发出的请求在
// 工具声明、freeform 调用/结果、reasoning 与 text 控制上逐项一致（Lite 形状）。
func TestEncodeRequestRoundTripsCodex0158ToolTurn(t *testing.T) {
	t.Parallel()

	original, err := os.ReadFile("../../clientprotocol/openairesponses/testdata/codex_0158_tool_turn.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	request := decodeResponsesRequest(t, string(original))
	payload, err := encodeRequest(
		request,
		"gpt-6-astra",
		codexauth.AuthKindOAuth,
		requestProfileForModel("gpt-6-astra"),
	)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	var want, got map[string]any
	if err := json.Unmarshal(original, &want); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}

	for _, key := range []string{"reasoning", "text", "parallel_tool_calls", "store", "stream", "include", "tool_choice", "prompt_cache_key", "client_metadata"} {
		if !reflect.DeepEqual(got[key], want[key]) {
			t.Fatalf("%s = %#v, want %#v", key, got[key], want[key])
		}
	}
	if _, found := got["tools"]; found {
		t.Fatalf("Lite request must not carry top-level tools")
	}

	wantInput := want["input"].([]any)
	gotInput := got["input"].([]any)
	if len(gotInput) != len(wantInput) {
		t.Fatalf("input len = %d, want %d", len(gotInput), len(wantInput))
	}
	for index := range wantInput {
		wantItem := wantInput[index].(map[string]any)
		gotItem := gotInput[index].(map[string]any)
		// 输出项 id / status 是客户端历史元数据，Canonical 不保留，其余字段必须一致。
		for _, volatile := range []string{"id", "status"} {
			delete(wantItem, volatile)
			delete(gotItem, volatile)
		}
		if wantItem["type"] == "reasoning" {
			// Canonical 不承载 reasoning.content=null。
			delete(wantItem, "content")
		}
		if !reflect.DeepEqual(gotItem, wantItem) {
			gotJSON, _ := json.Marshal(gotItem)
			wantJSON, _ := json.Marshal(wantItem)
			t.Fatalf("input[%d] mismatch\n got: %s\nwant: %s", index, gotJSON, wantJSON)
		}
	}
}

// TestEncodeRequestKeepsEmptyReasoningSummary 锁定回归：gpt-6-* 默认不生成 reasoning 摘要，
// 历史 reasoning 项只有 encrypted_content、summary 为空数组。省略 summary 会被上游以
// "上游拒绝当前请求参数"（400）拒绝，导致该会话之后每一轮都失败。
func TestEncodeRequestKeepsEmptyReasoningSummary(t *testing.T) {
	t.Parallel()

	request := decodeResponsesRequest(t, `{
		"model": "gpt-6-astra",
		"input": [
			{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},
			{"type":"reasoning","id":"rs_1","summary":[],"content":null,"encrypted_content":"ENC"},
			{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"done"}]}
		],
		"include": ["reasoning.encrypted_content"]
	}`)
	payload, err := encodeRequest(request, "gpt-6-astra", codexauth.AuthKindOAuth, requestProfileForModel("gpt-6-astra"))
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	var encoded struct {
		Input []map[string]json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(payload, &encoded); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	for _, item := range encoded.Input {
		if string(item["type"]) != `"reasoning"` {
			continue
		}
		if string(item["summary"]) != "[]" {
			t.Fatalf("reasoning summary = %s, want []", item["summary"])
		}
		return
	}
	t.Fatalf("reasoning item missing: %s", payload)
}

// TestEncodeRequestKeepsUndeclaredHistoricalCustomCall 回归：Codex 上下文压缩请求带着历史
// custom_tool_call（如 apply_patch）但不再声明该工具。解码后调用自带 freeform 标记，编码回
// 上游必须仍是 custom_tool_call / custom_tool_call_output，而不是改写成 function_call。
func TestEncodeRequestKeepsUndeclaredHistoricalCustomCall(t *testing.T) {
	t.Parallel()

	request := decodeResponsesRequest(t, `{"model":"gpt-5.6-sol","input":[
		{"type":"message","role":"user","content":[{"type":"input_text","text":"summarize"}]},
		{"type":"custom_tool_call","call_id":"call_patch","name":"apply_patch","input":"*** Begin Patch\n*** End Patch"},
		{"type":"custom_tool_call_output","call_id":"call_patch","output":"Done"}
	]}`)
	payload, err := encodeRequest(
		request,
		"gpt-5.6-sol",
		codexauth.AuthKindOAuth,
		requestProfileForModel("gpt-5.6-sol"),
	)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	var got struct {
		Input []map[string]any `json:"input"`
	}
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	// Lite 形状会在最前面放 additional_tools 项；按类型定位历史调用与结果。
	var call, output map[string]any
	for _, item := range got.Input {
		switch item["type"] {
		case "custom_tool_call", "function_call":
			call = item
		case "custom_tool_call_output", "function_call_output":
			output = item
		}
	}
	if call["type"] != "custom_tool_call" || call["name"] != "apply_patch" ||
		call["input"] != "*** Begin Patch\n*** End Patch" || call["call_id"] != "call_patch" {
		t.Fatalf("call = %#v", call)
	}
	if output["type"] != "custom_tool_call_output" || output["call_id"] != "call_patch" {
		t.Fatalf("output = %#v", output)
	}
}
