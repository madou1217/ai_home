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
