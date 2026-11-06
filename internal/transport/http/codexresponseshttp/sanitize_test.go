package codexresponseshttp

import (
	"encoding/json"
	"testing"
)

const legacyFcID = "fc_09aef7fede070f51016aecade7d4c887d0b2e3f5961824b8a7"

func decodeItems(t *testing.T, payload []byte) []map[string]json.RawMessage {
	t.Helper()
	var root struct {
		Input []map[string]json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(payload, &root); err != nil {
		t.Fatalf("decode input: %v", err)
	}
	return root.Input
}

func itemString(t *testing.T, item map[string]json.RawMessage, key string) string {
	t.Helper()
	raw, found := item[key]
	if !found {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("decode %s: %v", key, err)
	}
	return value
}

// 真机故障：custom_tool_call 携带上游的 fc_ id，上游按类型校验前缀直接 400。
func TestSanitizeNativePayloadDropsMismatchedItemID(t *testing.T) {
	payload := []byte(`{"model":"gpt-6.1-sol","input":[
		{"type":"message","role":"user","id":"msg_keep","content":[{"type":"input_text","text":"hi"}]},
		{"type":"custom_tool_call","id":"` + legacyFcID + `","call_id":"call_1","name":"shell","input":"ls"}
	]}`)
	sanitized := sanitizeNativePayload(payload)
	items := decodeItems(t, sanitized)
	if got := itemString(t, items[1], "id"); got != "" {
		t.Fatalf("custom_tool_call 的错误前缀 id 应被剥掉，实际 %q", got)
	}
	if got := itemString(t, items[1], "call_id"); got != "call_1" {
		t.Fatalf("call_id 必须保留，实际 %q", got)
	}
	if got := itemString(t, items[0], "id"); got != "msg_keep" {
		t.Fatalf("前缀匹配的 id 不应被改动，实际 %q", got)
	}
}

func TestSanitizeNativePayloadKeepsMatchingPrefix(t *testing.T) {
	payload := []byte(`{"input":[{"type":"function_call","id":"fc_ok","call_id":"call_1","name":"f","arguments":"{}"}]}`)
	items := decodeItems(t, sanitizeNativePayload(payload))
	if got := itemString(t, items[0], "id"); got != "fc_ok" {
		t.Fatalf("function_call 的 fc_ id 应保留，实际 %q", got)
	}
}

func TestSanitizeNativePayloadStoreFalseDropsAllIDs(t *testing.T) {
	payload := []byte(`{"store":false,"previous_response_id":"resp_prev","input":[
		{"type":"message","role":"user","id":"msg_keep","content":[{"type":"input_text","text":"hi"}]}
	]}`)
	sanitized := sanitizeNativePayload(payload)
	var root map[string]json.RawMessage
	if err := json.Unmarshal(sanitized, &root); err != nil {
		t.Fatalf("decode root: %v", err)
	}
	if _, found := root["previous_response_id"]; found {
		t.Fatal("store:false 时 previous_response_id 必须剥掉")
	}
	items := decodeItems(t, sanitized)
	if got := itemString(t, items[0], "id"); got != "" {
		t.Fatalf("store:false 时所有 item id 都应剥掉，实际 %q", got)
	}
}

func TestSanitizeNativePayloadDropsEncryptedReasoning(t *testing.T) {
	payload := []byte(`{"input":[{"type":"reasoning","id":"rs_ok","encrypted_content":"cipher","summary":[]}]}`)
	items := decodeItems(t, sanitizeNativePayload(payload))
	if _, found := items[0]["encrypted_content"]; found {
		t.Fatal("跨账号可解密的 encrypted_content 必须剥掉")
	}
	if got := itemString(t, items[0], "id"); got != "rs_ok" {
		t.Fatalf("reasoning 的 rs_ id 应保留，实际 %q", got)
	}
}

func TestSanitizeNativePayloadLeavesUnparsableBodyAlone(t *testing.T) {
	payload := []byte("not json")
	if string(sanitizeNativePayload(payload)) != string(payload) {
		t.Fatal("解析失败必须原样返回，不能把正常透传打坏")
	}
}

func TestSanitizeNativePayloadNoopKeepsBytes(t *testing.T) {
	payload := []byte(`{"input":[{"type":"message","role":"user","id":"msg_ok","content":[]}]}`)
	if string(sanitizeNativePayload(payload)) != string(payload) {
		t.Fatal("无需清洗的请求应逐字节保持不变")
	}
}
